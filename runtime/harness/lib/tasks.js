'use strict';
/**
 * tasks.js - the Task Registry: the machine source of truth for work.
 *
 * WHY JSON AND NOT MARKDOWN
 *   `TASKS.md` is for a human to read. It is a poor machine record: position and heading
 *   are the only identity it has, so renaming a task silently changes what it is, and two
 *   tasks with the same title are indistinguishable. A task needs a STABLE ID, a status a
 *   program can trust, and dependencies it can resolve. That is what this registry is for.
 *   The Markdown views are generated from here, never the other way round.
 *
 * BACKWARD COMPATIBILITY
 *   A V1 project has no tasks registry. `load()` returns an empty registry and the first
 *   write creates one. Nothing needs migrating, and a V1 project keeps working exactly as
 *   before through the project-level `TASKS.md`.
 *
 * ASCII-ONLY source: see the encoding note in config.json.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  readJsonIfExists, writeJsonAtomic, ensureDir, logEvent, nowIso,
} = require('./paths.js');
const registry = require('./registry.js');
const workspaces = require('./workspaces.js');

/** Task lifecycle. Transitions are validated, not merely documented. */
const STATUS = {
  TODO: 'TODO',
  READY: 'READY',
  IN_PROGRESS: 'IN_PROGRESS',
  REVIEW: 'REVIEW',
  BLOCKED: 'BLOCKED',
  DONE: 'DONE',
  CANCELLED: 'CANCELLED',
};

/**
 * Allowed transitions.
 * RETRY is not a status: a failed review moves REVIEW -> IN_PROGRESS and increments
 * retry_count. Making it a status would let a task sit in "RETRY" forever.
 */
const TRANSITIONS = {
  TODO: ['READY', 'BLOCKED', 'CANCELLED'],
  READY: ['IN_PROGRESS', 'BLOCKED', 'TODO', 'CANCELLED'],
  IN_PROGRESS: ['REVIEW', 'BLOCKED', 'READY', 'CANCELLED'],
  REVIEW: ['DONE', 'IN_PROGRESS', 'BLOCKED', 'CANCELLED'],
  BLOCKED: ['TODO', 'READY', 'IN_PROGRESS', 'CANCELLED'],
  DONE: [],
  CANCELLED: ['TODO'],
};

const PRIORITIES = ['low', 'normal', 'high', 'critical'];
const MAX_RETRY = 3;

/** The pseudo-workspace that holds project-level tasks. */
const PROJECT_WORKSPACE = 'project';

const CLOSED = [STATUS.DONE, STATUS.CANCELLED];

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

function stateDirOf(record) { return registry.stateDirOf(record); }

function registryFile(record) { return path.join(stateDirOf(record), 'tasks.json'); }

function emptyRegistry() { return { version: 2, seq: {}, tasks: {} }; }

function load(record) {
  const data = readJsonIfExists(registryFile(record), emptyRegistry());
  if (!data.tasks || typeof data.tasks !== 'object') return emptyRegistry();
  if (!data.seq || typeof data.seq !== 'object') data.seq = {};
  return data;
}

function save(record, data) {
  ensureDir(stateDirOf(record));
  return writeJsonAtomic(registryFile(record), data);
}

// ---------------------------------------------------------------------------
// task ids
// ---------------------------------------------------------------------------

/**
 * Short project prefix used in task ids, e.g. "visual-novel" -> "VN".
 * Falls back to the first alphanumeric characters of the project id.
 */
function projectPrefix(record) {
  const words = String(record.project_id).split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length >= 2) {
    const initials = words.map((w) => w[0]).join('').toUpperCase();
    if (initials.length >= 2) return initials.slice(0, 4);
  }
  return String(record.project_id).replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase() || 'TSK';
}

function workspaceToken(workspaceId) {
  return String(workspaceId).replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 8) || 'GEN';
}

/**
 * Mint a stable task id: <PROJECT_PREFIX>-<WORKSPACE>-<NNN>, e.g. VN-STORY-001.
 * The sequence is per project+workspace, so ids stay readable and never collide.
 */
function nextTaskId(record, data, workspaceId) {
  const prefix = projectPrefix(record);
  const token = workspaceToken(workspaceId);
  const key = `${prefix}-${token}`;
  data.seq[key] = (data.seq[key] ?? 0) + 1;
  return `${key}-${String(data.seq[key]).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------
// lookup across projects
// ---------------------------------------------------------------------------

/**
 * Find which project owns a task id.
 * Task ids are only unique WITHIN a project, so the project must be resolvable before the
 * task can be trusted - returning a task without its project would make isolation
 * unverifiable.
 */
function locate(taskId, opts = {}) {
  const candidates = opts.projectId
    ? [registry.getProject(opts.projectId)].filter(Boolean)
    : registry.listProjects();

  for (const record of candidates) {
    const data = load(record);
    if (data.tasks[taskId]) return { ok: true, record, data, task: data.tasks[taskId] };
  }
  return { ok: false, error: `no such task: ${taskId}${opts.projectId ? ` in project ${opts.projectId}` : ''}` };
}

// ---------------------------------------------------------------------------
// dependencies
// ---------------------------------------------------------------------------

/**
 * Resolve a dependency set: existence, completion, and cycles.
 *
 * Only these three checks exist deliberately. A full DAG scheduler would add machinery
 * that this problem does not have, and the failure this guards against - a task starting
 * before its prerequisite - is fully covered by them.
 *
 * @returns {{ok:boolean, missing:string[], incomplete:string[], cycle?:string[]}}
 */
function inspectDependencies(data, dependencies, selfId) {
  const missing = [];
  const incomplete = [];

  for (const dep of dependencies ?? []) {
    if (dep === selfId) return { ok: false, missing: [], incomplete: [], cycle: [selfId, selfId] };
    const t = data.tasks[dep];
    if (!t) { missing.push(dep); continue; }
    if (t.status !== STATUS.DONE) incomplete.push(`${dep}(${t.status})`);
  }

  // Cycle detection: walk each dependency's transitive closure looking for selfId.
  const cycle = findCycle(data, selfId, dependencies ?? []);
  if (cycle) return { ok: false, missing, incomplete, cycle };

  return { ok: true, missing, incomplete };
}

/** Depth-first search for a dependency path that returns to `selfId`. */
function findCycle(data, selfId, dependencies) {
  const seen = new Set();
  const stack = [];

  const walk = (id) => {
    if (id === selfId && stack.length > 0) return [...stack, id];
    if (seen.has(id)) return null;
    seen.add(id);
    stack.push(id);
    const node = data.tasks[id];
    if (node) {
      for (const dep of node.dependencies ?? []) {
        const found = walk(dep);
        if (found) return found;
      }
    }
    stack.pop();
    return null;
  };

  for (const dep of dependencies) {
    seen.clear();
    stack.length = 0;
    stack.push(selfId);
    const found = walk(dep);
    if (found) return found;
    stack.pop();
  }
  return null;
}

/** True when every dependency is DONE, so the task may become READY. */
function dependenciesSatisfied(data, task) {
  for (const dep of task.dependencies ?? []) {
    const t = data.tasks[dep];
    if (!t || t.status !== STATUS.DONE) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Create a task.
 *
 * A task MUST belong to a project and a workspace. The `project` pseudo-workspace exists
 * so project-level work (a release, a cross-workspace integration) has a legitimate home
 * without inventing a fake domain.
 */
function add(record, opts) {
  const workspaceId = opts.workspaceId ?? workspaces.DEFAULT_WORKSPACE_ID;

  // Validate the workspace, allowing the project-management pseudo-workspace.
  if (workspaceId !== PROJECT_WORKSPACE) {
    const ws = workspaces.get(record, workspaceId);
    if (!ws) {
      return { ok: false, error: `no such workspace in project ${record.project_id}: ${workspaceId}. ` +
                                 `Create it first, or use --workspace ${PROJECT_WORKSPACE} for project-level work.` };
    }
    if (ws.status === workspaces.STATUS.ARCHIVED) {
      return { ok: false, error: `workspace "${workspaceId}" is ARCHIVED; tasks cannot be added to it` };
    }
  }

  if (!opts.title || !String(opts.title).trim()) {
    return { ok: false, error: 'task title is required' };
  }
  const priority = opts.priority ?? 'normal';
  if (!PRIORITIES.includes(priority)) {
    return { ok: false, error: `unknown priority "${priority}"; expected one of ${PRIORITIES.join(', ')}` };
  }

  const data = load(record);
  const taskId = opts.taskId ?? nextTaskId(record, data, workspaceId);

  if (data.tasks[taskId]) {
    return { ok: false, error: `task_id already exists: ${taskId}` };
  }

  const dependencies = Array.isArray(opts.dependencies) ? [...opts.dependencies] : [];
  const depsCheck = inspectDependencies(data, dependencies, taskId);
  if (depsCheck.missing.length) {
    return { ok: false, error: `dependencies do not exist: ${depsCheck.missing.join(', ')}` };
  }
  if (depsCheck.cycle) {
    return { ok: false, status: STATUS.BLOCKED,
             error: `circular dependency detected: ${depsCheck.cycle.join(' -> ')}` };
  }

  const crossReads = Array.isArray(opts.crossWorkspaceReads) ? [...opts.crossWorkspaceReads] : [];
  for (const other of crossReads) {
    if (other === workspaceId) {
      return { ok: false, error: `cross_workspace_reads lists the task's own workspace (${other})` };
    }
    if (other !== PROJECT_WORKSPACE && !workspaces.get(record, other)) {
      return { ok: false, error: `cross_workspace_reads references an unknown workspace: ${other}` };
    }
  }

  const task = {
    task_id: taskId,
    project_id: record.project_id,
    workspace_id: workspaceId,
    type: opts.type ?? null,
    title: String(opts.title).trim(),
    description: opts.description ?? '',
    priority,
    status: STATUS.TODO,
    success_criteria: Array.isArray(opts.successCriteria) ? [...opts.successCriteria] : [],
    dependencies,
    cross_workspace_reads: crossReads,
    cross_workspace_writes: Array.isArray(opts.crossWorkspaceWrites) ? [...opts.crossWorkspaceWrites] : [],
    assigned_worker: opts.assignedWorker ?? null,
    retry_count: 0,
    created_at: nowIso(),
    started_at: null,
    completed_at: null,
    updated_at: nowIso(),
    history: [{ n: 1, at: nowIso(), event: 'created', detail: '' }],
  };

  data.tasks[taskId] = task;
  save(record, data);
  logEvent('task.add', { taskId, workspaceId, priority }, record.project_id);
  return { ok: true, task };
}

/**
 * Append a lifecycle event to a task's history.
 *
 * Named `recordEvent`, not `record`: `transition(record, ...)` takes the PROJECT record as
 * its first parameter, and a same-named local helper silently shadowed it. The failure was
 * a runtime "record is not a function" on every transition, which the acceptance suite
 * would have caught only because it exercises the real lifecycle.
 */
function recordEvent(task, event, detail) {
  task.history = task.history ?? [];
  task.history.push({ n: task.history.length + 1, at: nowIso(), event, detail: String(detail ?? '') });
}

/**
 * Move a task to a new status, validating the transition.
 *
 * @param {object} record
 * @param {string} taskId
 * @param {string} next
 * @param {{detail?:string, worker?:string, review?:object}} [opts]
 */
function transition(record, taskId, next, opts = {}) {
  const data = load(record);
  const task = data.tasks[taskId];
  if (!task) return { ok: false, error: `no such task: ${taskId}` };

  const allowed = TRANSITIONS[task.status] ?? [];
  if (!allowed.includes(next)) {
    return {
      ok: false,
      error: `illegal transition ${task.status} -> ${next} for ${taskId}. Allowed from ${task.status}: ${allowed.join(', ') || '(terminal)'}`,
    };
  }

  // --- guards that apply regardless of the transition ---------------------
  if (next === STATUS.READY) {
    if (!task.success_criteria || task.success_criteria.length === 0) {
      return { ok: false, error: `${taskId} cannot become READY without success_criteria; completion would be unverifiable` };
    }
    if (!dependenciesSatisfied(data, task)) {
      const blockers = (task.dependencies ?? []).map((d) => `${d}(${data.tasks[d]?.status ?? 'missing'})`);
      return { ok: false, status: STATUS.BLOCKED,
               error: `${taskId} has unfinished dependencies: ${blockers.join(', ')}` };
    }
  }

  if (next === STATUS.DONE) {
    if (!task.success_criteria || task.success_criteria.length === 0) {
      return { ok: false, error: `${taskId} has no success_criteria and cannot be marked DONE` };
    }
    if (opts.detail === undefined && !opts.verified) {
      // Completion must carry evidence. A worker returning text is not evidence.
      return { ok: false, error: `${taskId} cannot be marked DONE without a verification note (pass detail or verified:true)` };
    }
  }

  if (next === STATUS.IN_PROGRESS && task.status === STATUS.REVIEW) {
    // This is the RETRY path.
    if (task.retry_count >= MAX_RETRY) {
      task.status = STATUS.BLOCKED;
      recordEvent(task, 'retry.cap', `retry_count ${task.retry_count} >= ${MAX_RETRY}; forced BLOCKED`);
      task.updated_at = nowIso();
      save(record, data);
      logEvent('task.retry.cap', { taskId }, record.project_id);
      return {
        ok: false,
        status: STATUS.BLOCKED,
        error: `${taskId} exceeded MAX_RETRY (${MAX_RETRY}); moved to BLOCKED instead of retrying again`,
        task,
      };
    }
    task.retry_count += 1;
    recordEvent(task, 'retry', `retry ${task.retry_count}/${MAX_RETRY}${opts.detail ? ` - ${opts.detail}` : ''}`);
  }

  const previous = task.status;
  task.status = next;
  task.updated_at = nowIso();

  if (next === STATUS.IN_PROGRESS && !task.started_at) task.started_at = nowIso();
  if (next === STATUS.DONE || next === STATUS.CANCELLED) task.completed_at = nowIso();
  if (next === STATUS.TODO) { task.completed_at = null; }
  if (opts.worker) task.assigned_worker = opts.worker;

  recordEvent(task, 'transition', `${previous} -> ${next}${opts.detail ? ` - ${opts.detail}` : ''}`);
  save(record, data);
  logEvent('task.transition', { taskId, from: previous, to: next }, record.project_id);

  return { ok: true, task, from: previous, to: next };
}

function list(record, opts = {}) {
  const data = load(record);
  let all = Object.values(data.tasks);
  if (opts.workspaceId) all = all.filter((t) => t.workspace_id === opts.workspaceId);
  if (opts.status) all = all.filter((t) => t.status === opts.status);
  if (opts.includeClosed === false) all = all.filter((t) => !CLOSED.includes(t.status));

  const rank = { critical: 0, high: 1, normal: 2, low: 3 };
  return all.sort((a, b) => {
    const byStatus = (CLOSED.includes(a.status) ? 1 : 0) - (CLOSED.includes(b.status) ? 1 : 0);
    if (byStatus !== 0) return byStatus;
    const byPriority = (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9);
    if (byPriority !== 0) return byPriority;
    return a.created_at.localeCompare(b.created_at);
  });
}

function get(record, taskId) {
  return load(record).tasks[taskId] ?? null;
}

/** Tasks that would block removing this workspace. */
function openTasksIn(record, workspaceId) {
  return list(record, { workspaceId, includeClosed: false });
}

// ---------------------------------------------------------------------------
// markdown views
// ---------------------------------------------------------------------------

/**
 * Render a task list as Markdown.
 * Generated only - the JSON registry is authoritative, and these views say so.
 */
function renderTasksMarkdown(title, tasks) {
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push('> GENERATED VIEW. The machine source of truth is `.ai/tasks.json`.');
  lines.push('> Edits here are overwritten on the next sync.');
  lines.push('');
  if (!tasks.length) {
    lines.push('(no tasks)');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('| Task | Title | Status | Priority | Retries | Worker |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const t of tasks) {
    lines.push(`| ${t.task_id} | ${String(t.title).replace(/\|/g, '\\|')} | ${t.status} | ${t.priority} | ${t.retry_count} | ${t.assigned_worker ?? '-'} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Write a workspace's TASKS.md view. */
function syncWorkspaceView(record, workspaceId) {
  const ws = workspaces.get(record, workspaceId);
  const dir = workspaces.workspaceDir(record, workspaceId);
  if (!ws || !fs.existsSync(dir)) return { ok: false, error: `workspace ${workspaceId} has no state directory` };
  const tasks = list(record, { workspaceId });
  fs.writeFileSync(path.join(dir, 'TASKS.md'), renderTasksMarkdown(`Tasks - ${ws.name}`, tasks), 'utf8');
  return { ok: true, path: path.join(dir, 'TASKS.md'), count: tasks.length };
}

/** Write the project-level PROJECT_TASKS.md view (all workspaces). */
function syncProjectView(record) {
  const tasks = list(record);
  const file = path.join(stateDirOf(record), 'PROJECT_TASKS.md');
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, renderTasksMarkdown(`Project Tasks - ${record.name}`, tasks), 'utf8');
  return { ok: true, path: file, count: tasks.length };
}

/** Sync every view for a project. */
function syncAllViews(record) {
  const out = { project: syncProjectView(record), workspaces: [] };
  for (const ws of workspaces.list(record)) {
    if (ws.status === workspaces.STATUS.ARCHIVED) continue;
    const r = syncWorkspaceView(record, ws.workspace_id);
    if (r.ok) out.workspaces.push({ workspace_id: ws.workspace_id, count: r.count });
  }
  return { ok: true, ...out };
}

// ---------------------------------------------------------------------------
// per-workspace summary for PROJECT_STATE.md
// ---------------------------------------------------------------------------

/**
 * A compact per-workspace summary for the project-level state file.
 * The project layer holds only this: the full detail stays in each WORKSPACE_STATE.md.
 */
function workspaceSummary(record) {
  const rows = [];
  for (const ws of workspaces.list(record)) {
    if (ws.status === workspaces.STATUS.ARCHIVED) {
      rows.push({ workspace_id: ws.workspace_id, status: 'archived', current_task: '-', blockers: '-' });
      continue;
    }
    const tasks = list(record, { workspaceId: ws.workspace_id, includeClosed: false });
    const active = tasks.find((t) => t.status === STATUS.IN_PROGRESS)
      ?? tasks.find((t) => t.status === STATUS.REVIEW)
      ?? tasks.find((t) => t.status === STATUS.READY);
    const blocked = tasks.filter((t) => t.status === STATUS.BLOCKED);
    rows.push({
      workspace_id: ws.workspace_id,
      status: ws.status.toLowerCase(),
      current_task: active ? `${active.task_id} (${active.status})` : '-',
      blockers: blocked.length ? blocked.map((t) => t.task_id).join(', ') : 'none',
      open_tasks: tasks.length,
    });
  }
  return rows;
}

function renderWorkspaceSummaryTable(rows) {
  const lines = [];
  lines.push('| Workspace | Status | Current Task | Blockers | Open |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of rows) {
    lines.push(`| ${r.workspace_id} | ${r.status} | ${r.current_task} | ${r.blockers} | ${r.open_tasks ?? '-'} |`);
  }
  if (!rows.length) lines.push('| _(none)_ | | | | |');
  return lines.join('\n');
}

module.exports = {
  STATUS,
  TRANSITIONS,
  PRIORITIES,
  MAX_RETRY,
  PROJECT_WORKSPACE,
  registryFile,
  load,
  save,
  projectPrefix,
  nextTaskId,
  locate,
  inspectDependencies,
  dependenciesSatisfied,
  add,
  transition,
  list,
  get,
  openTasksIn,
  renderTasksMarkdown,
  syncWorkspaceView,
  syncProjectView,
  syncAllViews,
  workspaceSummary,
  renderWorkspaceSummaryTable,
};
