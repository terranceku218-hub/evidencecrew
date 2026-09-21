'use strict';
/**
 * cli.js - the Agent Harness command line.
 *
 * INVOCATION
 *   node <repo>/runtime/harness\cli.js <command> [args]
 *
 * A global `harness` shim is provided by bin/harness.ps1, but the CLI is deliberately
 * usable without one: a framework that cannot run until it is installed globally is a
 * framework that cannot be debugged.
 *
 * OUTPUT CONTRACT
 *   Human-readable text by default; `--json` switches every command to a single JSON
 *   object on stdout, which is what the Supervisor consumes.
 *
 * ASCII-ONLY source: see the encoding note in config.json.
 */

const path = require('node:path');
const fs = require('node:fs');

const { CONFIG, HARNESS_ROOT } = require('./lib/paths.js');
const registry = require('./lib/registry.js');
const project = require('./lib/project.js');
const workers = require('./lib/workers.js');
const router = require('./lib/router.js');
const packet = require('./lib/packet.js');
const driver = require('./lib/driver.js');
const workspaces = require('./lib/workspaces.js');
const tasks = require('./lib/tasks.js');

const VERSION = CONFIG.harness.version;

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------

const JSON_MODE = process.argv.includes('--json');

function out(obj) {
  if (JSON_MODE) return; // collected by finish()
  process.stdout.write(text(obj) + '\n');
}

function text(obj) {
  if (typeof obj === 'string') return obj;
  return JSON.stringify(obj, null, 2);
}

/** Strip flags so positional parsing stays simple. */
function positional() {
  return process.argv.slice(3).filter((a) => !a.startsWith('--'));
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

const COMMANDS = {};

COMMANDS.help = () => {
  out([
    `Agent Harness v${VERSION}`,
    '',
    'Usage: node cli.js <command> [args] [--json]',
    '',
    '  projects                       list registered projects',
    '  register <path> [--name N] [--type T] [--id I] [--scaffold] [--approve-root]',
    '                                 register a project directory',
    '  remove <project_id>            remove a REGISTRATION only (never deletes files)',
    '  open <project_id>              load project state, git, worker binding',
    '  status [project_id]            compact status for one or all projects',
    '',
    '  V2 - Workspace layer:',
    '  workspace list <project_id>              list workspaces (creates implicit default)',
    '  workspace add <project_id> <ws_id> [--name N] [--type T] [--path P]... [--role R]',
    '  workspace status <project_id> <ws_id>    workspace detail, worker, task counts',
    '  workspace open <project_id> <ws_id>      same, and records last_used',
    '  workspace remove <project_id> <ws_id> [--archive] [--force]',
    '                                           refuses while tasks/workers are active',
    '',
    '  V2 - Task registry:',
    '  task list <project_id> [--workspace W] [--status S] [--open]',
    '  task add <project_id> --workspace W --title "..." [--criteria C]...',
    '                         [--priority P] [--depends D]... [--cross-read W]...',
    '  task show <task_id>                      detail for one task',
    '  task start|ready|review|block|unblock|retry|done|cancel <task_id> [--note N]',
    '  task sync <project_id>                   regenerate the Markdown views',
    '',
    '  task <project_id> "<free text>"          route a task (V1 behaviour, kept)',
    '  route "<task text>" [--project-id P]     routing decision only',
    '',
    '  worker list [project_id] [--workspace W] list workers',
    '  worker new <project_id> [--role R] [--workspace W]',
    '  worker open-conversation <worker_id>   create a new ChatGPT conversation',
    '  worker focus <worker_id>       point the browser at the worker conversation',
    '  worker archive <worker_id> [reason]',
    '  worker rotate <worker_id> [--reason R]',
    '  worker rounds <worker_id> <n> [note]   reconcile the round counter',
    '  packet init <project_id> [--worker W]  build the initialization packet',
    '  packet task <project_id> <spec.json>   build a task packet (V1 shape)',
    '  packet wstask <project_id> <task_id> <spec.json>  hierarchical packet (V2)',
    '  health                         ChatGPT Web Worker health check',
    '  verify                         run the protected worker verification suite',
    '  types                          show project types and their permissions',
    '',
    'Project types: ' + registry.PROJECT_TYPES.join(', '),
    'Workspace types: ' + workspaces.WORKSPACE_TYPES.join(', '),
    'Worker roles:  ' + workers.ROLES.join(', '),
    'Task status:   ' + Object.keys(tasks.STATUS).join(', '),
    'Task pseudo-workspace: ' + tasks.PROJECT_WORKSPACE + '  (project-level tasks)',
  ].join('\n'));
};

COMMANDS.projects = () => {
  const list = registry.listProjects();
  return {
    ok: true,
    count: list.length,
    registry: CONFIG.paths.projectRegistry,
    projects: list.map((p) => ({
      project_id: p.project_id,
      name: p.name,
      type: p.project_type,
      root_path: p.root_path,
      status: p.status,
      git_enabled: p.git_enabled,
      last_opened: p.last_opened,
      exists: fs.existsSync(p.root_path),
    })),
  };
};

COMMANDS.register = () => {
  const [root] = positional();
  if (!root) return { ok: false, error: 'usage: register <path> [--name N] [--type T] [--id I] [--scaffold]' };
  const typeIdx = process.argv.indexOf('--type');
  const nameIdx = process.argv.indexOf('--name');
  const idIdx = process.argv.indexOf('--id');
  return registry.register({
    root,
    name: nameIdx >= 0 ? process.argv[nameIdx + 1] : undefined,
    type: typeIdx >= 0 ? process.argv[typeIdx + 1] : 'general',
    projectId: idIdx >= 0 ? process.argv[idIdx + 1] : undefined,
    approveRoot: flag('approve-root'),
    scaffold: flag('scaffold'),
  });
};

COMMANDS.remove = () => {
  const [id] = positional();
  if (!id) return { ok: false, error: 'usage: remove <project_id>' };
  return registry.remove(id);
};

COMMANDS.open = () => {
  const [id] = positional();
  if (!id) return { ok: false, error: 'usage: open <project_id>' };
  return project.open(id);
};

COMMANDS.status = () => {
  const [id] = positional();
  if (id) return project.status(id);
  const list = registry.listProjects();
  return {
    ok: true,
    harness: { version: VERSION, root: HARNESS_ROOT },
    count: list.length,
    projects: list.map((p) => {
      const s = project.status(p.project_id);
      return s.ok
        ? { project_id: p.project_id, name: p.name, type: p.project_type, root: p.root_path,
            state: 'READY', git: s.git.clean === undefined ? null : (s.git.clean ? 'clean' : 'dirty'),
            worker: s.worker?.worker_id ?? null, warnings: s.warnings }
        : { project_id: p.project_id, name: p.name, state: s.status ?? 'ERROR', error: s.error };
    }),
  };
};

// ---------------------------------------------------------------------------
// V2: workspace commands
// ---------------------------------------------------------------------------

/** Resolve a project or return a well-formed failure. */
function requireProject(projectId) {
  const record = registry.getProject(projectId);
  if (!record) return { ok: false, error: `no such project: ${projectId}` };
  return { ok: true, record };
}

/** Read a flag's value, e.g. --workspace story */
function flagValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Collect a repeatable flag, e.g. --path a --path b */
function flagValues(name) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
}

COMMANDS.workspace = () => {
  const sub = positional()[0];
  const rest = positional().slice(1);

  switch (sub) {
    case 'list': {
      const [projectId] = rest;
      const r = requireProject(projectId ?? '');
      if (!r.ok) return r;
      const list = workspaces.list(r.record);
      // A V1 project has no workspaces.json; ensureDefault runs inside list() so what the
      // caller sees is a project that already has its implicit workspace.
      const rows = list.map((w) => {
        const open = tasks.list(r.record, { workspaceId: w.workspace_id, includeClosed: false });
        return {
          workspace_id: w.workspace_id,
          name: w.name,
          type: w.type,
          status: w.status,
          paths: w.paths,
          default_worker_role: w.default_worker_role,
          open_tasks: open.length,
          implicit: w.implicit === true,
        };
      });
      return { ok: true, project_id: r.record.project_id, count: rows.length, registry: workspaces.registryFile(r.record), workspaces: rows };
    }

    case 'add': {
      const [projectId, workspaceId] = rest;
      if (!projectId || !workspaceId) {
        return { ok: false, error: 'usage: workspace add <project_id> <workspace_id> [--name N] [--type T] [--path P]... [--role R]' };
      }
      const r = requireProject(projectId);
      if (!r.ok) return r;
      return workspaces.add(r.record, {
        workspaceId,
        name: flagValue('name'),
        type: flagValue('type') ?? 'general',
        paths: flagValues('path'),
        keywords: flagValues('keyword'),
        defaultWorkerRole: flagValue('role'),
      });
    }

    case 'status': {
      const [projectId, workspaceId] = rest;
      const r = requireProject(projectId ?? '');
      if (!r.ok) return r;
      if (!workspaceId) return { ok: false, error: 'usage: workspace status <project_id> <workspace_id>' };
      return workspaceStatus(r.record, workspaceId);
    }

    case 'open': {
      const [projectId, workspaceId] = rest;
      const r = requireProject(projectId ?? '');
      if (!r.ok) return r;
      if (!workspaceId) return { ok: false, error: 'usage: workspace open <project_id> <workspace_id>' };
      const status = workspaceStatus(r.record, workspaceId);
      if (!status.ok) return status;
      // Record usage so last_used reflects reality.
      const data = { workspaces: {} };
      const ws = workspaces.get(r.record, workspaceId);
      ws.last_used = new Date().toISOString();
      const raw = JSON.parse(require('node:fs').readFileSync(workspaces.registryFile(r.record), 'utf8'));
      raw.workspaces[workspaceId] = ws;
      require('./lib/paths.js').writeJsonAtomic(workspaces.registryFile(r.record), raw);
      return status;
    }

    case 'remove': {
      const [projectId, workspaceId] = rest;
      const r = requireProject(projectId ?? '');
      if (!r.ok) return r;
      if (!workspaceId) {
        return { ok: false, error: 'usage: workspace remove <project_id> <workspace_id> [--archive] [--force]' };
      }
      const open = tasks.openTasksIn(r.record, workspaceId);
      return workspaces.remove(r.record, workspaceId, {
        archive: flag('archive'),
        force: flag('force'),
        tasks: open,
        reason: flagValue('reason'),
      });
    }

    default:
      return {
        ok: false,
        error: `unknown workspace subcommand: ${sub ?? '(none)'}; try list | add | status | open | remove`,
      };
  }
};

/** Shared status body for `workspace status` and `workspace open`. */
function workspaceStatus(record, workspaceId) {
  const ws = workspaces.get(record, workspaceId);
  if (!ws) return { ok: false, error: `no such workspace in project ${record.project_id}: ${workspaceId}` };

  const cfg = registry.loadProjectConfig(record);
  if (!cfg.ok) return { ok: false, error: cfg.error };

  const statePath = workspaces.workspaceStatePath(record, workspaceId);
  const fs = require('node:fs');
  const stateText = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null;

  const worker = workers.getForProject(record.project_id, { workspaceId });
  const wsTasks = tasks.list(record, { workspaceId });

  return {
    ok: true,
    project_id: record.project_id,
    workspace: {
      workspace_id: ws.workspace_id,
      name: ws.name,
      type: ws.type,
      status: ws.status,
      paths: ws.paths,
      permissions: workspaces.effectivePermissions(cfg.config, ws),
      worker_role: workspaces.effectiveWorkerRole(cfg.config, ws),
      implicit: ws.implicit === true,
    },
    state: {
      state_file: statePath,
      present: stateText !== null,
      bytes: stateText ? stateText.length : 0,
      registry_file: workspaces.registryFile(record),
    },
    worker: worker
      ? { worker_id: worker.worker_id, role: worker.role, rounds: worker.rounds,
          conversation_url: worker.conversation_url, rotation: workers.rotationCheck(worker) }
      : null,
    tasks: {
      total: wsTasks.length,
      open: wsTasks.filter((t) => t.status !== 'DONE' && t.status !== 'CANCELLED').length,
      by_status: wsTasks.reduce((acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc; }, {}),
    },
  };
}

// ---------------------------------------------------------------------------
// V2: task commands
// ---------------------------------------------------------------------------

COMMANDS.task = () => {
  // V1 behaviour preserved: `task <project_id> "<text>"` routes free text.
  // V2 adds `task <subcommand> ...` for registry operations.
  const first = positional()[0];
  const KNOWN = ['list', 'add', 'show', 'start', 'block', 'review', 'done', 'cancel', 'retry', 'unblock', 'ready', 'sync', 'route'];

  if (!KNOWN.includes(first)) return routeTaskText();
  if (first === 'route') return routeTaskText();

  const rest = positional().slice(1);
  const fs = require('node:fs');

  switch (first) {
    case 'list': {
      const [projectId] = rest;
      const r = requireProject(projectId ?? '');
      if (!r.ok) return r;
      const wsFilter = flagValue('workspace');
      const list = tasks.list(r.record, {
        workspaceId: wsFilter,
        status: flagValue('status'),
        includeClosed: !flag('open'),
      });
      return {
        ok: true,
        project_id: r.record.project_id,
        registry: tasks.registryFile(r.record),
        count: list.length,
        tasks: list.map((t) => ({
          task_id: t.task_id,
          workspace_id: t.workspace_id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          retry_count: t.retry_count,
          dependencies: t.dependencies,
          assigned_worker: t.assigned_worker,
        })),
      };
    }

    case 'add': {
      const [projectId] = rest;
      const r = requireProject(projectId ?? '');
      if (!r.ok) return r;
      const title = flagValue('title');
      if (!title) return { ok: false, error: 'usage: task add <project_id> --workspace W --title "..." [--criteria C]... [--priority P] [--depends D]...' };
      const result = tasks.add(r.record, {
        workspaceId: flagValue('workspace') ?? workspaces.DEFAULT_WORKSPACE_ID,
        title,
        description: flagValue('description'),
        type: flagValue('type'),
        priority: flagValue('priority') ?? 'normal',
        successCriteria: flagValues('criteria'),
        dependencies: flagValues('depends'),
        crossWorkspaceReads: flagValues('cross-read'),
        crossWorkspaceWrites: flagValues('cross-write'),
        assignedWorker: flagValue('worker'),
      });
      if (result.ok) tasks.syncAllViews(r.record);
      return result;
    }

    case 'show': {
      const [taskId] = rest;
      if (!taskId) return { ok: false, error: 'usage: task show <task_id> [--project P]' };
      const loc = tasks.locate(taskId, { projectId: flagValue('project') });
      if (!loc.ok) return loc;
      return { ok: true, task: loc.task, registry: tasks.registryFile(loc.record) };
    }

    case 'sync': {
      const [projectId] = rest;
      const r = requireProject(projectId ?? '');
      if (!r.ok) return r;
      return tasks.syncAllViews(r.record);
    }

    default: {
      // Lifecycle transitions: start | ready | review | block | unblock | retry | done | cancel
      const [taskId] = rest;
      if (!taskId) return { ok: false, error: `usage: task ${first} <task_id>` };
      const loc = tasks.locate(taskId, { projectId: flagValue('project') });
      if (!loc.ok) return loc;

      const map = {
        start: tasks.STATUS.IN_PROGRESS,
        ready: tasks.STATUS.READY,
        review: tasks.STATUS.REVIEW,
        block: tasks.STATUS.BLOCKED,
        unblock: tasks.STATUS.READY,
        retry: tasks.STATUS.IN_PROGRESS,
        done: tasks.STATUS.DONE,
        cancel: tasks.STATUS.CANCELLED,
      };
      const next = map[first];
      const result = tasks.transition(loc.record, taskId, next, {
        detail: flagValue('note'),
        worker: flagValue('worker'),
        verified: flag('verified'),
      });
      if (result.ok) tasks.syncAllViews(loc.record);
      return result;
    }
  }
};

/** V1 routing behaviour, kept intact. */
function routeTaskText() {
  const [id, ...rest] = positional();
  const taskText = rest.join(' ');
  if (!id || !taskText) {
    return { ok: false, error: 'usage: task <project_id> "<task text>"  |  task <list|add|show|start|done|...> ...' };
  }

  const r = requireProject(id);
  if (!r.ok) return r;
  const record = r.record;

  const cfg = registry.loadProjectConfig(record);
  if (!cfg.ok) return { ok: false, error: cfg.error };

  const wsList = workspaces.list(record);
  const webAvailable = cfg.config.permissions?.web === true;

  const decision = router.route(taskText, {
    projectId: record.project_id,
    projectType: cfg.config.type,
    webAvailable,
    workspaces: wsList,
    workspaceId: flagValue('workspace'),
  });

  // A workspace is required before anything can be delegated: without it the worker
  // would receive the wrong context, which is worse than waiting.
  const workspaceRequired = decision.workspace_id === null;
  const worker = decision.workspace_id
    ? workers.getForProject(record.project_id, { workspaceId: decision.workspace_id, role: decision.worker_role })
    : null;
  const canDelegate = !workspaceRequired && decision.delegate && worker && worker.conversation_url;

  let nextStep;
  if (workspaceRequired) {
    nextStep = `workspace not determinable (${decision.workspace_status}). ` +
               `Re-run with --workspace <id>, choosing from: ${(decision.workspace_candidates ?? wsList.map((w) => w.workspace_id)).join(', ')}`;
  } else if (canDelegate) {
    nextStep = `build the packet for ${decision.workspace_id} and delegate to ${worker.worker_id}`;
  } else if (decision.delegate) {
    nextStep = `delegation wanted but no ready worker in workspace ${decision.workspace_id}; ` +
               `run: worker new ${record.project_id} --workspace ${decision.workspace_id} --role ${decision.worker_role}`;
  } else {
    nextStep = 'supervisor handles this directly';
  }

  return {
    ok: true,
    project_id: record.project_id,
    task: taskText,
    routing: decision,
    workspace_required: workspaceRequired,
    worker: worker
      ? { worker_id: worker.worker_id, role: worker.role, workspace_id: workers.workspaceOf(worker),
          rounds: worker.rounds, conversation_url: worker.conversation_url }
      : null,
    recommended_action: canDelegate
      ? `delegate to ${worker.worker_id} (role ${decision.worker_role}, workspace ${decision.workspace_id})`
      : decision.delegate ? 'delegation wanted but not yet possible' : 'supervisor handles this directly',
    next_step: nextStep,
  };
}

COMMANDS.route = () => {
  const taskText = positional().join(' ');
  if (!taskText) return { ok: false, error: 'usage: route "<task text>" [--project-id P]' };
  const pidIdx = process.argv.indexOf('--project-id');
  let projectType;
  if (pidIdx >= 0) {
    const rec = registry.getProject(process.argv[pidIdx + 1]);
    if (rec) {
      const cfg = registry.loadProjectConfig(rec);
      if (cfg.ok) projectType = cfg.config.type;
    }
  }
  return { ok: true, task: taskText, routing: router.route(taskText, { projectType }) };
};

COMMANDS.worker = () => {
  const sub = positional()[0];
  const rest = positional().slice(1);

  switch (sub) {
    case 'list':
      return { ok: true, pool: CONFIG.paths.workerPool, ...workers.listView(rest[0], { workspaceId: flagValue('workspace') }) };

    case 'new': {
      const [projectId] = rest;
      if (!projectId) return { ok: false, error: 'usage: worker new <project_id> [--role R] [--workspace W]' };
      const roleIdx = process.argv.indexOf('--role');
      const role = roleIdx >= 0 ? process.argv[roleIdx + 1] : 'general';
      const workspaceId = flagValue('workspace');
      return workers.create(projectId, { role, workspaceId: workspaceId ?? null });
    }

    case 'open-conversation': {
      const [workerId] = rest;
      if (!workerId) return { ok: false, error: 'usage: worker open-conversation <worker_id>' };
      return workers.openConversation(workerId);
    }

    case 'focus': {
      const [workerId] = rest;
      if (!workerId) return { ok: false, error: 'usage: worker focus <worker_id>' };
      return workers.focusConversation(workerId);
    }

    case 'archive': {
      const [workerId, ...reasonParts] = rest;
      if (!workerId) return { ok: false, error: 'usage: worker archive <worker_id> [reason]' };
      return workers.archive(workerId, reasonParts.join(' ') || 'manual');
    }

    case 'rotate': {
      const [workerId] = rest;
      if (!workerId) return { ok: false, error: 'usage: worker rotate <worker_id> [--reason R]' };
      const rIdx = process.argv.indexOf('--reason');
      const reason = rIdx >= 0 ? process.argv[rIdx + 1] : 'rotation';
      return workers.rotate(workerId, reason);
    }

    case 'rounds': {
      // Reconcile the counter with what the conversation actually contains. Rounds that
      // happened outside the adapter, or before a browser restart, are invisible to the
      // automatic counter - so the supervisor must be able to correct it.
      const [workerId, n, ...note] = rest;
      if (!workerId || n === undefined) return { ok: false, error: 'usage: worker rounds <worker_id> <n> [note]' };
      const data = workers.load();
      const w = data.workers.find((x) => x.worker_id === workerId);
      if (!w) return { ok: false, error: `no such worker: ${workerId}` };
      const previous = w.rounds;
      w.rounds = Number(n);
      w.history = w.history ?? [];
      w.history.push({ n: w.history.length + 1, at: new Date().toISOString(), event: 'rounds.reconciled',
                       detail: `recorded ${previous} -> ${w.rounds}${note.length ? ` (${note.join(' ')})` : ''}` });
      workers.save(data);
      return { ok: true, worker_id: workerId, previous, rounds: w.rounds, rotation: workers.rotationCheck(w) };
    }

    default:
      return { ok: false, error: `unknown worker subcommand: ${sub ?? '(none)'}; try list | new | open-conversation | focus | archive | rotate | rounds` };
  }
};

COMMANDS.packet = () => {
  const sub = positional()[0];
  const rest = positional().slice(1);

  if (sub === 'init') {
    const [projectId] = rest;
    if (!projectId) return { ok: false, error: 'usage: packet init <project_id> [--worker W]' };
    const opened = project.open(projectId);
    if (!opened.ok) return opened;
    const wIdx = process.argv.indexOf('--worker');
    const workerId = wIdx >= 0 ? process.argv[wIdx + 1] : opened.worker?.worker_id;
    const p = packet.buildInit({ project: opened.project, context: opened.context, workerId });
    return p.ok ? { ok: true, bytes: p.text.length, text: p.text } : p;
  }

  if (sub === 'task') {
    const [projectId, specFile] = rest;
    if (!projectId || !specFile) return { ok: false, error: 'usage: packet task <project_id> <spec.json>' };
    if (!fs.existsSync(specFile)) return { ok: false, error: `spec file not found: ${specFile}` };
    const opened = project.open(projectId);
    if (!opened.ok) return opened;
    const spec = JSON.parse(fs.readFileSync(specFile, 'utf8').replace(/^\uFEFF/, ''));
    const p = packet.buildTask({
      project: opened.project,
      context: opened.context,
      task: spec.task,
      request: spec.request,
      successCriteria: spec.successCriteria,
      doNotBreak: spec.doNotBreak,
      knownFacts: spec.knownFacts,
      files: spec.files,
      revisionNote: spec.revisionNote,
      outputFormat: spec.outputFormat,
    });
    return p.ok ? { ok: true, bytes: p.text.length, text: p.text } : p;
  }

  if (sub === 'wstask') {
    // V2 hierarchical packet: Project -> Workspace -> Task.
    const [projectId, taskId, specFile] = rest;
    if (!projectId || !taskId) {
      return { ok: false, error: 'usage: packet wstask <project_id> <task_id> [spec.json]' };
    }
    const r = requireProject(projectId);
    if (!r.ok) return r;
    const record = r.record;

    const task = tasks.get(record, taskId);
    if (!task) return { ok: false, error: `no such task in project ${record.project_id}: ${taskId}` };

    const ws = workspaces.get(record, task.workspace_id);
    if (!ws && task.workspace_id !== tasks.PROJECT_WORKSPACE) {
      return { ok: false, error: `task ${taskId} references a workspace that does not exist: ${task.workspace_id}` };
    }

    const cfg = registry.loadProjectConfig(record);
    if (!cfg.ok) return { ok: false, error: cfg.error };

    const fs = require('node:fs');
    const statePath = ws ? workspaces.workspaceStatePath(record, task.workspace_id) : null;
    const workspaceState = statePath && fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null;

    const spec = specFile && fs.existsSync(specFile)
      ? JSON.parse(fs.readFileSync(specFile, 'utf8').replace(/^\uFEFF/, ''))
      : {};

    const opened = project.open(record.project_id, { extraFiles: spec.files });
    if (!opened.ok) return opened;

    const p = packet.buildWorkspaceTask({
      project: opened.project,
      workspace: ws ?? { workspace_id: tasks.PROJECT_WORKSPACE, name: 'Project Management', type: 'general', paths: [] },
      task,
      context: opened.context,
      workspaceState,
      relevantDecisions: spec.relevantDecisions,
      knownFacts: spec.knownFacts,
      doNotBreak: spec.doNotBreak,
      workspaceDoNotBreak: spec.workspaceDoNotBreak,
      files: spec.files,
      request: spec.request,
      outputFormat: spec.outputFormat,
      revisionNote: spec.revisionNote,
    });
    return p.ok ? { ok: true, task_id: p.task_id, workspace_id: p.workspace_id, bytes: p.text.length, text: p.text } : p;
  }

  return { ok: false, error: `unknown packet subcommand: ${sub ?? '(none)'}; try init | task | wstask` };
};

COMMANDS.health = () => {
  const r = driver.healthCheck({});
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, worker: r.value };
};

COMMANDS.verify = () => {
  const verifyScript = CONFIG.paths.workerVerify;
  if (!fs.existsSync(verifyScript)) return { ok: false, error: `verify script not found: ${verifyScript}` };
  const { run } = require('./lib/paths.js');
  const res = run('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', verifyScript],
    { timeoutMs: 900000 });
  const stdout = res.stdout || '';
  const passed = /(\d+)\/(\d+) passed/.exec(stdout);
  return {
    ok: res.status === 0,
    exit_code: res.status,
    summary: passed ? `${passed[1]}/${passed[2]} passed` : 'unparsed',
    tail: stdout.trim().split('\n').slice(-16).join('\n'),
  };
};

COMMANDS.types = () => {
  const rows = Object.entries(registry.TYPE_POLICY).map(([type, p]) => ({
    type,
    allow: p.allow,
    deny: p.deny,
    note: p.note,
  }));
  return { ok: true, types: rows };
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === 'help' || flag('help')) {
    process.stdout.write(text(COMMANDS.help()) + '\n');
    process.exit(0);
  }

  const handler = COMMANDS[cmd];
  if (!handler) {
    const result = { ok: false, error: `unknown command: ${cmd}`, hint: 'node cli.js help' };
    process.stdout.write(text(result) + '\n');
    process.exit(2);
  }

  let result;
  try {
    result = await handler();
  } catch (e) {
    result = { ok: false, error: `unhandled: ${e && e.stack ? e.stack : String(e)}` };
  }

  if (JSON_MODE) {
    process.stdout.write(text(result) + '\n');
  } else if (result !== undefined) {
    process.stdout.write(text(result) + '\n');
  }

  process.exit(result && result.ok === false ? 1 : 0);
}

main();
