'use strict';
/**
 * registry.js - the global project registry.
 *
 * WHAT THIS OWNS
 *   registry/projects.json : the index of every project the harness knows about.
 *
 * WHAT IT MUST NEVER DO
 *   Delete project files. `remove` retires a REGISTRATION only. This is enforced by
 *   construction: the only filesystem writes in this module target the registry and the
 *   project's own state directory, and no call ever passes a project root to a recursive
 *   delete.
 *
 * WHY ROOT VALIDATION IS CODE, NOT PROSE
 *   "Do not point a project at the Desktop root" is the kind of rule that survives right
 *   up until someone is in a hurry. `validateRoot` refuses dangerous roots outright and
 *   requires an explicit, recorded approval to override - so the decision is visible in
 *   the registry afterwards rather than lost in a chat log.
 *
 * ASCII-ONLY source: see the encoding note in ../config.json.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  CONFIG, readJsonIfExists, writeJsonAtomic, ensureDir, logEvent, nowIso,
} = require('./paths.js');
const yaml = require('./mini-yaml.js');

const PROJECT_TYPES = ['coding', 'writing', 'research', 'general'];

/** Per-type default permissions. Conservative by default; a project may override. */
const TYPE_POLICY = {
  coding: {
    allow: ['file_read', 'file_write', 'shell', 'git', 'test'],
    deny: [],
    note: 'Full development capability. Review and diff gates still apply.',
  },
  writing: {
    allow: ['file_read', 'file_write'],
    deny: ['shell', 'git', 'test'],
    note: 'Documents only. No shell and no automatic git operations.',
  },
  research: {
    allow: ['file_read', 'web'],
    deny: ['file_write', 'shell', 'git', 'test'],
    note: 'Read and search only. Project files must not be modified automatically.',
  },
  general: {
    allow: ['file_read'],
    deny: ['file_write', 'shell', 'git', 'test', 'web'],
    note: 'Conservative default: read-only until a project opts in explicitly.',
  },
};

// ---------------------------------------------------------------------------
// root validation
// ---------------------------------------------------------------------------

/**
 * Reject project roots that would make the harness dangerous.
 *
 * @param {string} root  candidate absolute path
 * @param {boolean} [approved]  an explicit, user-granted override
 * @returns {{ok:boolean, root?:string, error?:string, warning?:string}}
 */
function validateRoot(root, approved) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    return { ok: false, error: 'root path is required' };
  }

  const resolved = path.resolve(root);
  const normalized = resolved.replace(/[\\/]+$/, '') || resolved;

  if (!path.isAbsolute(resolved)) {
    return { ok: false, error: `root must be an absolute path, got ${root}` };
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: `root does not exist: ${resolved}` };
  }

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (e) {
    return { ok: false, error: `root is not readable: ${e.message}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `root is not a directory: ${resolved}` };
  }

  const forbidden = CONFIG.safety.forbiddenRoots.map((f) => path.resolve(f).replace(/[\\/]+$/, ''));
  const hit = forbidden.find((f) => normalized.toLowerCase() === f.toLowerCase());
  if (hit) {
    if (approved) {
      return { ok: true, root: resolved, warning: `root ${normalized} is on the forbidden list but was explicitly approved` };
    }
    return {
      ok: false,
      error: `refusing dangerous project root: ${normalized}. ` +
             `A project root must not be a drive root, a user profile, or the Desktop/Documents root. ` +
             `Create a dedicated directory for the project, or re-run with --approve-root to override deliberately.`,
    };
  }

  // A root ABOVE a forbidden path is equally dangerous (e.g. C:\Users).
  const above = forbidden.find((f) => f.toLowerCase().startsWith(normalized.toLowerCase() + path.sep));
  if (above && !approved) {
    return {
      ok: false,
      error: `refusing project root ${normalized}: it is an ancestor of the protected path ${above}. ` +
             `Choose a directory that contains only this project.`,
    };
  }

  return { ok: true, root: resolved };
}

// ---------------------------------------------------------------------------
// registry persistence
// ---------------------------------------------------------------------------

function emptyRegistry() {
  return { version: 1, projects: {} };
}

function loadRegistry() {
  const data = readJsonIfExists(CONFIG.paths.projectRegistry, emptyRegistry());
  if (!data.projects || typeof data.projects !== 'object') return emptyRegistry();
  return data;
}

function saveRegistry(data) {
  ensureDir(CONFIG.paths.registry);
  return writeJsonAtomic(CONFIG.paths.projectRegistry, data);
}

function listProjects() {
  const data = loadRegistry();
  return Object.values(data.projects).sort((a, b) => a.project_id.localeCompare(b.project_id));
}

function getProject(projectId) {
  const data = loadRegistry();
  return data.projects[projectId] ?? null;
}

/**
 * Derive a stable, filesystem-safe project id from a name or path basename.
 */
function deriveProjectId(source) {
  const base = String(source).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'project';
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'project';
}

/**
 * Register (or update) a project.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.root
 * @param {string} [opts.type]      one of PROJECT_TYPES
 * @param {string} [opts.projectId]
 * @param {boolean} [opts.approveRoot]
 * @param {boolean} [opts.scaffold] create missing state files from the type template
 */
function register(opts) {
  const check = validateRoot(opts.root, opts.approveRoot === true);
  if (!check.ok) return { ok: false, error: check.error };

  const root = check.root;
  const type = opts.type ?? 'general';
  if (!PROJECT_TYPES.includes(type)) {
    return { ok: false, error: `unknown project type "${type}"; expected one of ${PROJECT_TYPES.join(', ')}` };
  }

  const projectId = opts.projectId ?? deriveProjectId(opts.name ?? root);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(projectId)) {
    return { ok: false, error: `invalid project_id "${projectId}"; use lowercase letters, digits and hyphens` };
  }

  const data = loadRegistry();
  if (data.projects[projectId] && data.projects[projectId].root_path !== root) {
    return {
      ok: false,
      error: `project_id "${projectId}" is already registered to a different root: ` +
             `${data.projects[projectId].root_path}. Choose another id to avoid silently re-pointing a project.`,
    };
  }

  // One root may back only one project: two ids over the same directory would let two
  // "projects" write the same files while believing they are isolated.
  const clash = Object.values(data.projects).find(
    (p) => p.project_id !== projectId && path.resolve(p.root_path).toLowerCase() === root.toLowerCase(),
  );
  if (clash) {
    return { ok: false, error: `root ${root} is already registered as project "${clash.project_id}"` };
  }

  const stateDir = path.join(root, opts.stateDirName ?? CONFIG.projectDefaults.stateDirName);
  const gitEnabled = fs.existsSync(path.join(root, '.git'));

  const existing = data.projects[projectId];
  const record = {
    project_id: projectId,
    name: opts.name ?? existing?.name ?? projectId,
    root_path: root,
    project_type: type,
    status: 'ACTIVE',
    git_enabled: gitEnabled,
    default_worker: existing?.default_worker ?? null,
    state_dir: stateDir,
    created_at: existing?.created_at ?? nowIso(),
    last_opened: existing?.last_opened ?? null,
  };

  data.projects[projectId] = record;
  saveRegistry(data);
  logEvent('project.register', { root, type, created: !existing }, projectId);

  let scaffolded = null;
  if (opts.scaffold === true) scaffolded = scaffoldState(projectId);

  return { ok: true, project: record, scaffolded, warning: check.warning ?? null };
}

/**
 * Remove a REGISTRATION. Never deletes project files.
 *
 * The guard is explicit rather than implied: this function performs no filesystem
 * deletion at all, so there is no code path through which a mis-called remove could
 * destroy a project.
 *
 * It DOES retire the project's workers. Leaving them would strand conversations pointing
 * at a project that no longer exists, and if the id were ever reused the new project would
 * inherit conversations carrying another project's context - a direct violation of the
 * isolation invariant. Archiving keeps the history without keeping the binding.
 *
 * @param {string} projectId
 * @param {{keepWorkers?:boolean}} [opts]
 */
function remove(projectId, opts = {}) {
  const data = loadRegistry();
  const record = data.projects[projectId];
  if (!record) return { ok: false, error: `no such project: ${projectId}` };

  if (record.root_path && fs.existsSync(record.root_path) && opts.keepStateFiles !== true) {
    // Purely informational: confirm the files are still there and left alone.
    logEvent('project.remove.registration-only', { root: record.root_path }, projectId);
  }

  // Late require: workers.js depends on this module for the root check, so importing at
  // load time would create a cycle.
  let retired = [];
  if (opts.keepWorkers !== true) {
    const workers = require('./workers.js');
    for (const w of workers.list(projectId)) {
      if (w.status === 'ACTIVE') {
        workers.archive(w.worker_id, `project ${projectId} registration removed`);
        retired.push(w.worker_id);
      }
    }
  }

  delete data.projects[projectId];
  saveRegistry(data);
  logEvent('project.remove', { root: record.root_path, retired_workers: retired }, projectId);

  return {
    ok: true,
    removed_registration: projectId,
    retired_workers: retired,
    root_path_left_intact: record.root_path,
    note: 'Registration removed only. No project files were read for deletion, moved, or deleted. ' +
          (retired.length ? `Archived ${retired.length} worker(s) so no conversation is orphaned.` : 'No workers were bound.'),
  };
}

// ---------------------------------------------------------------------------
// project config (.ai/PROJECT.yaml) + state scaffolding
// ---------------------------------------------------------------------------

function stateDirOf(record) {
  return record?.state_dir ?? path.join(record.root_path, CONFIG.projectDefaults.stateDirName);
}

function projectConfigPath(record) {
  return path.join(stateDirOf(record), 'PROJECT.yaml');
}

function defaultsFor(type) {
  const policy = TYPE_POLICY[type] ?? TYPE_POLICY.general;
  return {
    worker: { ...CONFIG.projectDefaults.worker },
    git: { ...CONFIG.projectDefaults.git },
    permissions: {
      file_read: policy.allow.includes('file_read'),
      file_write: policy.allow.includes('file_write'),
      shell: policy.allow.includes('shell'),
      git: policy.allow.includes('git'),
      test: policy.allow.includes('test'),
      web: policy.allow.includes('web'),
    },
    validation: {
      require_review_before_write: true,
      require_diff_after_write: true,
    },
  };
}

/**
 * Create any missing state files from the project's type template.
 * NEVER overwrites an existing file - an existing PROJECT_STATE.md is the project's
 * memory and replacing it would destroy exactly what this harness exists to protect.
 */
function scaffoldState(projectId) {
  const record = getProject(projectId);
  if (!record) return { ok: false, error: `no such project: ${projectId}` };

  const dir = stateDirOf(record);
  ensureDir(dir);

  const templateDir = path.join(CONFIG.paths.templatesDir, record.project_type);
  const wanted = [
    'PROJECT_STATE.md',
    'TASKS.md',
    'DECISIONS.md',
    'KNOWN_ISSUES.md',
    'HANDOFF.md',
    'PROJECT.yaml',
  ];

  const created = [];
  const skipped = [];

  for (const file of wanted) {
    const dest = path.join(dir, file);
    if (fs.existsSync(dest)) { skipped.push(file); continue; }

    const src = path.join(templateDir, file);
    let body;
    if (fs.existsSync(src)) {
      body = fs.readFileSync(src, 'utf8');
    } else {
      body = renderInlineTemplate(file, record);
    }
    // Substitute the placeholders the templates rely on.
    body = body
      .replace(/\{\{PROJECT_NAME\}\}/g, record.name)
      .replace(/\{\{PROJECT_ID\}\}/g, record.project_id)
      .replace(/\{\{PROJECT_TYPE\}\}/g, record.project_type)
      .replace(/\{\{ROOT_PATH\}\}/g, record.root_path)
      .replace(/\{\{CREATED_AT\}\}/g, nowIso());

    fs.writeFileSync(dest, body, 'utf8');
    created.push(file);
  }

  return { ok: true, stateDir: dir, created, skipped, templateDir };
}

/** Minimal fallback content when a type template omits a file. */
function renderInlineTemplate(file, record) {
  if (file === 'PROJECT.yaml') {
    const d = defaultsFor(record.project_type);
    return yaml.stringify({
      name: record.name,
      project_id: record.project_id,
      type: record.project_type,
      root: record.root_path,
      state_files: {
        project_state: 'PROJECT_STATE.md',
        tasks: 'TASKS.md',
        decisions: 'DECISIONS.md',
        known_issues: 'KNOWN_ISSUES.md',
        handoff: 'HANDOFF.md',
      },
      worker: d.worker,
      git: d.git,
      permissions: d.permissions,
      validation: d.validation,
    });
  }
  if (file === 'PROJECT_STATE.md') {
    return `# Project State - ${record.name}\n\n> Long-term memory, not a chat log.\n\n## Project Goal\n\n(TODO)\n\n## Current State\n\n(TODO)\n\n## Completed\n\n(none yet)\n\n## In Progress\n\n(none)\n\n## Known Issues\n\n(none)\n\n## Next Steps\n\n(TODO)\n\n## Last Updated\n\n${nowIso()}\n`;
  }
  if (file === 'TASKS.md') return `# Tasks - ${record.name}\n\n## Current\n\n(none)\n\n## Pending\n\n(none)\n\n## Blocked\n\n(none)\n\n## Done\n\n(none)\n`;
  if (file === 'DECISIONS.md') return `# Decisions - ${record.name}\n\n## Confirmed Design\n\n(none yet)\n\n## Open Questions\n\n(none)\n`;
  if (file === 'KNOWN_ISSUES.md') return `# Known Issues - ${record.name}\n\n(none)\n`;
  if (file === 'HANDOFF.md') return `# Handoff - ${record.name}\n\n(none)\n`;
  return '';
}

/** Load and resolve a project's effective config: defaults, then PROJECT.yaml overrides. */
function loadProjectConfig(record) {
  const base = defaultsFor(record.project_type);
  const file = projectConfigPath(record);
  let parsed = {};
  if (fs.existsSync(file)) {
    try {
      parsed = yaml.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return { ok: false, error: `PROJECT.yaml is invalid (${file}): ${e.message}` };
    }
  }

  const merged = {
    name: parsed.name ?? record.name,
    project_id: parsed.project_id ?? record.project_id,
    type: parsed.type ?? record.project_type,
    root: parsed.root ?? record.root_path,
    state_files: parsed.state_files ?? {
      project_state: 'PROJECT_STATE.md',
      tasks: 'TASKS.md',
      decisions: 'DECISIONS.md',
      known_issues: 'KNOWN_ISSUES.md',
      handoff: 'HANDOFF.md',
    },
    worker: { ...base.worker, ...(parsed.worker ?? {}) },
    git: { ...base.git, ...(parsed.git ?? {}) },
    permissions: { ...base.permissions, ...(parsed.permissions ?? {}) },
    validation: { ...base.validation, ...(parsed.validation ?? {}) },
  };

  if (merged.root !== record.root_path) {
    return {
      ok: false,
      error: `PROJECT.yaml root (${merged.root}) disagrees with the registry root (${record.root_path}). ` +
             `The registry is authoritative for location; fix PROJECT.yaml rather than moving the project.`,
    };
  }
  return { ok: true, config: merged, file, existed: fs.existsSync(file) };
}

function markOpened(projectId) {
  const data = loadRegistry();
  if (!data.projects[projectId]) return null;
  data.projects[projectId].last_opened = nowIso();
  saveRegistry(data);
  return data.projects[projectId];
}

module.exports = {
  PROJECT_TYPES,
  TYPE_POLICY,
  validateRoot,
  loadRegistry,
  saveRegistry,
  listProjects,
  getProject,
  register,
  remove,
  scaffoldState,
  stateDirOf,
  projectConfigPath,
  loadProjectConfig,
  defaultsFor,
  deriveProjectId,
  markOpened,
};
