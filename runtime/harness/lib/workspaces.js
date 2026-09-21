'use strict';
/**
 * workspaces.js - the Workspace layer: logical work domains inside a project.
 *
 * WHY WORKSPACES EXIST
 *   A project like a visual novel has a story domain, a code domain, an art domain. They
 *   have different goals, different files, different rules, and - critically - different
 *   CONTEXT. Sending the story's design notes to the worker fixing a null reference is
 *   pure noise, and noise is what makes a long-running agent loop degrade. A Workspace is
 *   therefore first of all a CONTEXT boundary, and only incidentally a path mapping.
 *
 * A WORKSPACE IS NOT A DIRECTORY
 *   `paths` is a list of project-relative directories or files that the workspace may
 *   touch. It may be empty (a pure context domain), one directory, or several. The
 *   abstraction is the boundary, not the folder.
 *
 * BACKWARD COMPATIBILITY
 *   A V1 project has no workspaces. `ensureDefault()` materialises a `default` workspace
 *   so every V1 project becomes Project -> default Workspace -> Task without any
 *   migration step and without the user noticing.
 *
 * ASCII-ONLY source: see the encoding note in config.json.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  CONFIG, readJsonIfExists, writeJsonAtomic, ensureDir, logEvent, nowIso,
} = require('./paths.js');
const registry = require('./registry.js');

/** Workspace types mirror project types so their permission defaults compose. */
const WORKSPACE_TYPES = ['coding', 'writing', 'research', 'art', 'audio', 'testing', 'production', 'general'];
const STATUS = { ACTIVE: 'ACTIVE', PAUSED: 'PAUSED', ARCHIVED: 'ARCHIVED' };

/** The workspace every V1 project is implicitly given. */
const DEFAULT_WORKSPACE_ID = 'default';

// ---------------------------------------------------------------------------
// paths + persistence
// ---------------------------------------------------------------------------

function stateDirOf(record) {
  return registry.stateDirOf(record);
}

function registryFile(record) {
  return path.join(stateDirOf(record), 'workspaces.json');
}

function workspaceDir(record, workspaceId) {
  return path.join(stateDirOf(record), 'workspaces', workspaceId);
}

function workspaceConfigPath(record, workspaceId) {
  return path.join(workspaceDir(record, workspaceId), 'WORKSPACE.yaml');
}

function workspaceStatePath(record, workspaceId) {
  return path.join(workspaceDir(record, workspaceId), 'WORKSPACE_STATE.md');
}

function workspaceTasksPath(record, workspaceId) {
  return path.join(workspaceDir(record, workspaceId), 'TASKS.md');
}

function emptyRegistry() {
  return { version: 2, seq: 0, workspaces: {} };
}

function loadRaw(record) {
  const data = readJsonIfExists(registryFile(record), emptyRegistry());
  if (!data.workspaces || typeof data.workspaces !== 'object') return emptyRegistry();
  return data;
}

function save(record, data) {
  ensureDir(stateDirOf(record));
  return writeJsonAtomic(registryFile(record), data);
}

// ---------------------------------------------------------------------------
// workspace_id validation
// ---------------------------------------------------------------------------

/**
 * A workspace id becomes a directory name, so anything that could escape the state
 * directory is rejected outright rather than sanitised into something surprising.
 */
function validateWorkspaceId(workspaceId) {
  if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
    return { ok: false, error: 'workspace_id is required' };
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(workspaceId)) {
    return { ok: false, error: `invalid workspace_id "${workspaceId}"; use lowercase letters, digits, hyphens or underscores` };
  }
  if (workspaceId.includes('..') || workspaceId.includes('/') || workspaceId.includes('\\')) {
    return { ok: false, error: `workspace_id must not contain path separators: "${workspaceId}"` };
  }
  if (workspaceId.length > 64) {
    return { ok: false, error: 'workspace_id is too long (max 64)' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// default workspace (V1 compatibility)
// ---------------------------------------------------------------------------

/**
 * Materialise the implicit `default` workspace for a project that has none.
 *
 * This is what makes V1 projects work unchanged: the caller sees a normal workspace and
 * no migration is required. It is idempotent and never overwrites an existing definition.
 */
function ensureDefault(record) {
  if (!record) return { ok: false, error: 'project record is required' };
  const data = loadRaw(record);
  if (data.workspaces[DEFAULT_WORKSPACE_ID]) {
    return { ok: true, created: false, workspace: data.workspaces[DEFAULT_WORKSPACE_ID] };
  }

  data.workspaces[DEFAULT_WORKSPACE_ID] = {
    workspace_id: DEFAULT_WORKSPACE_ID,
    name: 'Default Workspace',
    type: (record.project_type && record.project_type !== 'general') ? record.project_type : 'general',
    status: STATUS.ACTIVE,
    // An empty path list means "the whole project root". That is the correct semantic for
    // a legacy project whose work was never partitioned.
    paths: [],
    permissions: null,
    default_worker_role: null,
    state_dir: `workspaces/${DEFAULT_WORKSPACE_ID}`,
    created_at: nowIso(),
    last_used: null,
    implicit: true,
    note: 'Auto-created for a project that predates the Workspace layer. V1 projects map here automatically.',
  };
  save(record, data);
  logEvent('workspace.default.created', {}, record.project_id);
  return { ok: true, created: true, workspace: data.workspaces[DEFAULT_WORKSPACE_ID] };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function list(record, opts = {}) {
  ensureDefault(record);
  const data = loadRaw(record);
  const all = Object.values(data.workspaces);
  const filtered = opts.includeArchived === false
    ? all.filter((w) => w.status !== STATUS.ARCHIVED)
    : all;
  return filtered.sort((a, b) => a.workspace_id.localeCompare(b.workspace_id));
}

function get(record, workspaceId) {
  ensureDefault(record);
  const data = loadRaw(record);
  return data.workspaces[workspaceId] ?? null;
}

/**
 * Register a workspace.
 *
 * Scaffolds its state directory, but NEVER overwrites an existing file there.
 */
function add(record, opts) {
  const check = validateWorkspaceId(opts.workspaceId);
  if (!check.ok) return check;

  const type = opts.type ?? 'general';
  if (!WORKSPACE_TYPES.includes(type)) {
    return { ok: false, error: `unknown workspace type "${type}"; expected one of ${WORKSPACE_TYPES.join(', ')}` };
  }

  ensureDefault(record);
  const data = loadRaw(record);
  if (data.workspaces[opts.workspaceId]) {
    return { ok: false, error: `workspace already exists in project ${record.project_id}: ${opts.workspaceId}` };
  }

  // Paths are validated against the project root here so a bad declaration is caught at
  // registration rather than at the first read.
  const paths = normalisePaths(record, opts.paths ?? []);
  if (!paths.ok) return paths;

  const worker = opts.worker ?? {};
  const workspace = {
    workspace_id: opts.workspaceId,
    name: opts.name ?? opts.workspaceId,
    type,
    status: STATUS.ACTIVE,
    paths: paths.paths,
    // Project-declared routing vocabulary. The router consumes it so that project-specific
    // wording ("combat", "立绘", "天台") can select a workspace without the router itself
    // having to know any project's domain language.
    keywords: Array.isArray(opts.keywords) ? opts.keywords.filter((k) => typeof k === 'string' && k.trim()) : [],
    permissions: opts.permissions ?? null,
    default_worker_role: worker.default_role ?? opts.defaultWorkerRole ?? null,
    state_dir: `workspaces/${opts.workspaceId}`,
    created_at: nowIso(),
    last_used: null,
  };

  data.workspaces[opts.workspaceId] = workspace;
  save(record, data);

  const scaffolded = scaffold(record, opts.workspaceId);
  logEvent('workspace.add', { type, paths: workspace.paths }, record.project_id);
  return { ok: true, workspace, scaffolded };
}

/**
 * Remove a workspace REGISTRATION.
 *
 * Default behaviour is archive, precisely because the alternative - deleting a directory
 * tree that a user considers their work - is irreversible. Refuses while the workspace is
 * still in use.
 *
 * @param {object} record
 * @param {string} workspaceId
 * @param {{archive?:boolean, force?:boolean, tasks?:Array}} opts
 *        `tasks` is injected by the caller (the CLI) to avoid a module cycle with tasks.js.
 */
function remove(record, workspaceId, opts = {}) {
  const check = validateWorkspaceId(workspaceId);
  if (!check.ok) return check;
  if (workspaceId === DEFAULT_WORKSPACE_ID) {
    return { ok: false, error: 'the implicit "default" workspace cannot be removed; every project must have one' };
  }

  ensureDefault(record);
  const data = loadRaw(record);
  const ws = data.workspaces[workspaceId];
  if (!ws) return { ok: false, error: `no such workspace in project ${record.project_id}: ${workspaceId}` };

  // --- in-use guards -----------------------------------------------------
  //
  // An explicit `--archive` bypasses these guards, and that is correct rather than a
  // loophole: archiving PRESERVES everything - tasks, state files, worker records. The
  // guards exist to stop an UNREGISTER that would make the workspace disappear from the
  // registry while work is still live in it. Blocking the safe operation while allowing
  // the unsafe one would be exactly backwards.
  const archiveRequested = opts.archive === true;
  const blockers = [];

  if (!archiveRequested) {
    if (opts.tasks && opts.tasks.length) {
      const open = opts.tasks.filter((t) => t.status !== 'DONE' && t.status !== 'CANCELLED');
      if (open.length) {
        blockers.push(`${open.length} unfinished task(s): ${open.slice(0, 5).map((t) => `${t.task_id}(${t.status})`).join(', ')}${open.length > 5 ? ', ...' : ''}`);
      }
    }

    const workers = require('./workers.js');
    const active = workers.list().filter(
      (w) => w.project_id === record.project_id && w.workspace_id === workspaceId && w.status === 'ACTIVE',
    );
    if (active.length) {
      blockers.push(`${active.length} ACTIVE worker(s): ${active.map((w) => w.worker_id).join(', ')}`);
    }

    if (blockers.length && opts.force !== true) {
      return {
        ok: false,
        status: 'IN_USE',
        error: `refusing to unregister workspace "${workspaceId}" while it is in use. Blockers: ${blockers.join('; ')}. ` +
               `Finish or cancel the tasks, archive the workers, or pass --archive to archive the workspace instead ` +
               `(which preserves all tasks, state and worker records).`,
        blockers,
      };
    }
  }

  // --- archive (preferred) or retire the registration ---------------------
  if (archiveRequested || opts.force === true) {
    ws.status = STATUS.ARCHIVED;
    ws.archived_at = nowIso();
    ws.archive_reason = opts.reason ?? 'archived';
    data.workspaces[workspaceId] = ws;
    save(record, data);
    logEvent('workspace.archive', { reason: ws.archive_reason, blockers }, record.project_id);
    return {
      ok: true,
      action: 'ARCHIVED',
      workspace_id: workspaceId,
      state_dir_left_intact: workspaceDir(record, workspaceId),
      note: 'Workspace archived. Tasks, state files and worker ledger records were all preserved. No files were deleted.',
      blockers,
    };
  }

  // Retire the registration but KEEP the state directory on disk: the registry entry is
  // harness bookkeeping, whereas the state directory is the user's work.
  delete data.workspaces[workspaceId];
  save(record, data);
  logEvent('workspace.remove', { stateDirKept: workspaceDir(record, workspaceId) }, record.project_id);
  return {
    ok: true,
    action: 'UNREGISTERED',
    workspace_id: workspaceId,
    state_dir_left_intact: workspaceDir(record, workspaceId),
    note: 'Registration removed only. The workspace state directory was left on disk, untouched. ' +
          'No project files were deleted.',
  };
}

// ---------------------------------------------------------------------------
// path boundary
// ---------------------------------------------------------------------------

/**
 * Normalise and validate declared workspace paths.
 * Paths must stay inside the project root; anything else is refused.
 */
function normalisePaths(record, paths) {
  const root = path.resolve(record.root_path);
  const out = [];
  for (const p of paths) {
    if (typeof p !== 'string' || !p.trim()) continue;
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, error: `workspace path escapes the project root: ${p} (resolved ${abs})` };
    }
    out.push(rel.split(path.sep).join('/'));
  }
  return { ok: true, paths: out };
}

/**
 * Is this path inside the workspace's declared paths?
 *
 * An empty `paths` list means the whole project root - the legacy semantic. That is a
 * deliberate widening, not an oversight: a V1 project never partitioned its work, so
 * pretending it has a narrower boundary would break it.
 */
function pathAllowed(record, workspace, targetPath) {
  if (!workspace.paths || workspace.paths.length === 0) return { ok: true, reason: 'workspace declares no paths; whole project root allowed' };

  const root = path.resolve(record.root_path);
  const abs = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(root, targetPath);
  const rel = path.relative(root, abs).split(path.sep).join('/');

  for (const declared of workspace.paths) {
    const d = declared.replace(/\/+$/, '');
    if (rel === d || rel.startsWith(d + '/')) {
      return { ok: true, matched: declared };
    }
  }
  return {
    ok: false,
    error: `path "${targetPath}" is outside workspace "${workspace.workspace_id}" (declared paths: ${workspace.paths.join(', ') || '(none)'})`,
  };
}

// ---------------------------------------------------------------------------
// scaffolding
// ---------------------------------------------------------------------------

/**
 * Create the workspace's state directory and files.
 * NEVER overwrites: an existing WORKSPACE_STATE.md is the workspace's memory.
 */
function scaffold(record, workspaceId) {
  const ws = get(record, workspaceId);
  if (!ws) return { ok: false, error: `no such workspace: ${workspaceId}` };

  const dir = workspaceDir(record, workspaceId);
  ensureDir(dir);

  const files = [
    ['WORKSPACE.yaml', renderWorkspaceYaml(record, ws)],
    ['WORKSPACE_STATE.md', renderWorkspaceState(record, ws)],
    ['TASKS.md', renderWorkspaceTasks(record, ws)],
  ];

  const created = [];
  const skipped = [];
  for (const [name, body] of files) {
    const dest = path.join(dir, name);
    if (fs.existsSync(dest)) { skipped.push(name); continue; }
    fs.writeFileSync(dest, body, 'utf8');
    created.push(name);
  }
  return { ok: true, stateDir: dir, created, skipped };
}

function renderWorkspaceYaml(record, ws) {
  const yaml = require('./mini-yaml.js');
  return yaml.stringify({
    workspace_id: ws.workspace_id,
    name: ws.name,
    type: ws.type,
    project_id: record.project_id,
    status: ws.status,
    paths: ws.paths,
    keywords: ws.keywords ?? [],
    default_worker_role: ws.default_worker_role,
    permissions: ws.permissions,
    created_at: ws.created_at,
  });
}

function renderWorkspaceState(record, ws) {
  return [
    `# Workspace State - ${ws.name}`,
    '',
    `> Workspace \`${ws.workspace_id}\` of project \`${record.project_id}\`.`,
    '> This file holds THIS workspace\'s detail. The project-level PROJECT_STATE.md holds only a summary.',
    '',
    '## Workspace Goal',
    '',
    '(TODO)',
    '',
    '## Current State',
    '',
    '(TODO)',
    '',
    '## Completed',
    '',
    '(none yet)',
    '',
    '## In Progress',
    '',
    '(none)',
    '',
    '## Key Files',
    '',
    ...(ws.paths.length ? ws.paths.map((p) => `- \`${p}\``) : ['- (whole project root)']),
    '',
    '## Known Issues',
    '',
    '(none)',
    '',
    '## Next Steps',
    '',
    '(TODO)',
    '',
    '## Last Updated',
    '',
    nowIso(),
    '',
  ].join('\n');
}

function renderWorkspaceTasks(record, ws) {
  return [
    `# Tasks - ${ws.name}`,
    '',
    '> GENERATED VIEW. The machine source of truth is `.ai/tasks.json`.',
    '> Edits here are overwritten on the next sync.',
    '',
    '## Current',
    '',
    '(none)',
    '',
    '## Pending',
    '',
    '(none)',
    '',
    '## Blocked',
    '',
    '(none)',
    '',
    '## Done',
    '',
    '(none)',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// permissions
// ---------------------------------------------------------------------------

/**
 * Effective permissions for a workspace: project defaults, then workspace overrides.
 * A workspace may narrow permissions; it may also widen them, but only explicitly, so the
 * widening is visible in WORKSPACE.yaml rather than implied.
 */
function effectivePermissions(projectConfig, workspace) {
  const base = { ...(projectConfig?.permissions ?? {}) };
  if (workspace?.permissions && typeof workspace.permissions === 'object') {
    return { ...base, ...workspace.permissions };
  }
  return base;
}

/**
 * Effective worker role: the workspace's declared default, else the project's, else the
 * workspace type itself when that is a meaningful role.
 */
function effectiveWorkerRole(projectConfig, workspace) {
  if (workspace?.default_worker_role) return workspace.default_worker_role;
  if (projectConfig?.worker?.role) return projectConfig.worker.role;
  if (['coding', 'writing', 'research'].includes(workspace?.type)) return workspace.type;
  return 'general';
}

module.exports = {
  WORKSPACE_TYPES,
  STATUS,
  DEFAULT_WORKSPACE_ID,
  registryFile,
  workspaceDir,
  workspaceConfigPath,
  workspaceStatePath,
  workspaceTasksPath,
  validateWorkspaceId,
  ensureDefault,
  list,
  get,
  add,
  remove,
  scaffold,
  normalisePaths,
  pathAllowed,
  effectivePermissions,
  effectiveWorkerRole,
  renderWorkspaceState,
  renderWorkspaceTasks,
};
