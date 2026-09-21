'use strict';
/**
 * project.js - load a registered project and assemble its context.
 *
 * THE ISOLATION RULE, ENFORCED BY CONSTRUCTION
 *   Context for a task is read from exactly one project directory: the one being opened.
 *   There is no code path that accepts a list of projects, so project A's state cannot
 *   reach project B's packet by accident - only by someone deliberately passing another
 *   project's state file as a `--file`, which is an explicit act.
 *
 * FACT PRECEDENCE
 *   The real files on disk are the source of truth. State files are a MEMORY of the
 *   project and go stale; when they disagree with the tree, the harness records the
 *   disagreement instead of silently trusting the document.
 *
 * ASCII-ONLY source: see the encoding note in ../config.json.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  CONFIG, ensureDir, logEvent, nowIso, run,
} = require('./paths.js');
const registry = require('./registry.js');
const workers = require('./workers.js');

/** Resolve a state file path inside the project's state dir. */
function stateFile(record, config, key) {
  const dir = registry.stateDirOf(record);
  const name = config.state_files?.[key];
  return name ? path.join(dir, name) : null;
}

/**
 * Read one state file.
 * A missing file is reported as missing rather than as empty, because "no TASKS.md" and
 * "an empty TASKS.md" mean different things to whoever reads this next.
 */
function readStateFile(record, config, key) {
  const file = stateFile(record, config, key);
  if (!file) return { key, present: false, reason: 'not configured' };
  if (!fs.existsSync(file)) return { key, present: false, path: file, reason: 'file does not exist' };
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { key, present: true, path: file, bytes: text.length, text };
  } catch (e) {
    return { key, present: false, path: file, reason: `unreadable: ${e.message}` };
  }
}

/** Git state, read-only. Never runs a mutating git command. */
function gitState(record, config) {
  const root = record.root_path;
  const hasGit = fs.existsSync(path.join(root, '.git'));
  const enabled = config.git?.enabled === true || hasGit;

  if (!enabled) return { enabled: false, present: hasGit, note: 'git not enabled for this project' };
  if (!hasGit) {
    return { enabled: true, present: false,
             note: 'git is enabled in config but this directory is not a repository' };
  }

  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeoutMs: 20000 });
  const status = run('git', ['status', '--porcelain'], { cwd: root, timeoutMs: 30000 });
  const head = run('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, timeoutMs: 20000 });

  const dirty = (status.stdout || '').trim();
  const changed = dirty ? dirty.split('\n').filter(Boolean) : [];

  return {
    enabled: true,
    present: true,
    branch: (branch.stdout || '').trim() || '(unknown)',
    head: (head.stdout || '').trim() || '(no commits yet)',
    clean: changed.length === 0,
    uncommitted_count: changed.length,
    uncommitted: changed.slice(0, 40),
    note: changed.length
      ? 'pre-existing uncommitted changes are recorded so they are never mistaken for AI edits later'
      : 'working tree clean',
  };
}

/**
 * Assemble the context for a task packet.
 *
 * @param {object} record   registry record
 * @param {object} config   resolved project config
 * @param {object} opts
 * @param {Array<{path:string, note?:string}>} [opts.extraFiles] explicit additional files
 * @returns {{ok:boolean, context?:object, error?:string}}
 */
function buildContext(record, config, opts = {}) {
  const wanted = opts.include ?? ['project_state', 'tasks', 'decisions', 'known_issues'];
  const files = {};
  const missing = [];

  for (const key of wanted) {
    const r = readStateFile(record, config, key);
    files[key] = r;
    if (!r.present) missing.push(`${key} (${r.path ?? 'unconfigured'})`);
  }

  // Real files, read from THIS project only.
  const extra = [];
  for (const f of opts.extraFiles ?? []) {
    const abs = path.isAbsolute(f.path) ? f.path : path.join(record.root_path, f.path);

    // Guard against a caller accidentally pulling another project's file in.
    const containment = containCheck(abs, record.root_path);
    if (!containment.ok) {
      return { ok: false, error: containment.error };
    }

    let text = null;
    let reason = null;
    try {
      text = fs.readFileSync(abs, 'utf8');
      const cap = f.maxChars ?? 60000;
      if (text.length > cap) {
        text = text.slice(0, cap) +
          `\n\n[... TRUNCATED at ${cap} of ${text.length} characters; the remainder was NOT provided.]`;
      }
    } catch (e) {
      reason = e.message;
    }
    extra.push({ path: abs, note: f.note ?? null, present: text !== null, text, reason });
    if (text === null) missing.push(`${abs} (${reason})`);
  }

  return {
    ok: true,
    context: {
      project_id: record.project_id,
      name: config.name,
      type: config.type,
      root: record.root_path,
      state_files: files,
      extra_files: extra,
      missing,
      git: gitState(record, config),
      loaded_at: nowIso(),
    },
  };
}

/**
 * Refuse to read outside the project root.
 * Cross-project access is a deliberate act requiring explicit approval, never a side
 * effect of a relative path resolving somewhere unexpected.
 */
function containCheck(absPath, rootPath) {
  const root = path.resolve(rootPath);
  const abs = path.resolve(absPath);
  const rel = path.relative(root, abs);
  const outside = rel.startsWith('..') || path.isAbsolute(rel);
  if (outside) {
    return {
      ok: false,
      error: `refusing to read ${abs}: it is outside the project root ${root}. ` +
             `Cross-project reads require explicit user approval.`,
    };
  }
  return { ok: true };
}

/**
 * Full project open sequence.
 *
 *   1. read PROJECT.yaml            5. read DECISIONS if present
 *   2. validate root still exists   6. inspect the real project tree
 *   3. read PROJECT_STATE           7. read git state (if enabled)
 *   4. read TASKS                   8. locate the project's Worker
 *
 * @returns {object} a report the Supervisor can act on
 */
function open(projectId, opts = {}) {
  const record = registry.getProject(projectId);
  if (!record) {
    return { ok: false, status: 'NOT_REGISTERED', error: `no such project: ${projectId}` };
  }

  // 2. re-validate the root every time: a project can be moved or a drive can disappear
  //    between sessions, and a stale registry should fail loudly rather than half-work.
  const rootCheck = registry.validateRoot(record.root_path, true);
  if (!rootCheck.ok) {
    return { ok: false, status: 'ROOT_INVALID', error: rootCheck.error, project_id: projectId };
  }

  // 1. PROJECT.yaml
  const cfg = registry.loadProjectConfig(record);
  if (!cfg.ok) {
    return { ok: false, status: 'CONFIG_INVALID', error: cfg.error, project_id: projectId };
  }
  const config = cfg.config;

  // 3-5. state files
  const ctx = buildContext(record, config, { extraFiles: opts.extraFiles });
  if (!ctx.ok) return { ok: false, status: 'CONTEXT_FAILED', error: ctx.error, project_id: projectId };

  // 6. the real tree (shallow, so a huge project does not stall the open)
  let topLevel = [];
  try {
    topLevel = fs.readdirSync(record.root_path, { withFileTypes: true })
      .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
      .slice(0, 60)
      .map((e) => ({ name: e.name, dir: e.isDirectory() }));
  } catch (e) {
    return { ok: false, status: 'ROOT_UNREADABLE', error: e.message, project_id: projectId };
  }

  // 7. git (already inside ctx.context.git)

  // 8. the project's worker
  const worker = workers.getForProject(projectId);
  let rotation = null;
  if (worker) rotation = workers.rotationCheck(worker);

  registry.markOpened(projectId);
  logEvent('project.open', { worker: worker?.worker_id ?? null, missing: ctx.context.missing }, projectId);

  const warnings = [];
  if (ctx.context.missing.length) {
    warnings.push(`state files missing: ${ctx.context.missing.join('; ')}`);
  }
  if (!worker) {
    warnings.push('no worker bound to this project; create one before delegating');
  }
  if (worker && !worker.conversation_url) {
    warnings.push(`worker ${worker.worker_id} has no conversation yet; open one before delegating`);
  }
  if (rotation?.shouldRotate) {
    warnings.push(`worker ${worker.worker_id} reached rotation threshold: ${rotation.reasons.join('; ')}`);
  }
  if (ctx.context.git.enabled && ctx.context.git.present && !ctx.context.git.clean) {
    warnings.push(`git working tree has ${ctx.context.git.uncommitted_count} pre-existing uncommitted change(s)`);
  }

  return {
    ok: true,
    status: 'READY',
    project: record,
    config,
    context: ctx.context,
    top_level: topLevel,
    worker: worker
      ? { worker_id: worker.worker_id, role: worker.role, rounds: worker.rounds,
          conversation_url: worker.conversation_url, rotation }
      : null,
    warnings,
    facts_precedence: 'Real files on disk are authoritative. If a state file disagrees with the tree, the tree wins and the state file must be corrected.',
  };
}

/** Human-readable status summary for `harness status`. */
function status(projectId) {
  const r = open(projectId);
  if (!r.ok) return r;
  return {
    ok: true,
    project_id: r.project.project_id,
    name: r.project.name,
    type: r.project.project_type,
    root: r.project.root_path,
    status: r.status,
    git: r.context.git,
    worker: r.worker,
    state_files: Object.fromEntries(
      Object.entries(r.context.state_files).map(([k, v]) => [k, v.present ? `${v.bytes} bytes` : `MISSING (${v.reason ?? 'n/a'})`]),
    ),
    warnings: r.warnings,
  };
}

module.exports = {
  open,
  status,
  buildContext,
  readStateFile,
  stateFile,
  gitState,
  containCheck,
};
