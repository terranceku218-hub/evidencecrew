'use strict';
/**
 * harness-adapter.js - the ONLY module that talks to the Agent Harness.
 *
 * WHY A SINGLE CHOKEPOINT
 *   The harness is a frozen, verified component. If UI code shelled out to it directly, a
 *   change to its contract would have to be chased through the whole workbench, and nobody
 *   could answer "what can this UI actually do to my project?". Every harness read and every
 *   harness command goes through this file, so that question has one answer.
 *
 * WHAT IT DOES NOT DO
 *   It never edits the harness, never copies its logic, and never touches the ChatGPT DOM.
 *   The browser worker remains driven by harness -> driver -> chatgpt-worker. Git is read
 *   directly here because the harness exposes no git surface; that is a read-only addition
 *   at this layer, not a reimplementation of anything the harness owns.
 *
 * READ VS COMMAND IS EXPLICIT
 *   Read functions are marked READ; anything that changes state is marked COMMAND. The HTTP
 *   layer uses that distinction for the approval gate and for project isolation checks.
 *
 * ASCII-ONLY source: see the encoding note in the harness config.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// PUBLIC RELEASE CHANGE: one shared loader resolves every configured path against the repository root,
// so this file no longer assumes absolute paths recorded on the maintainer machine.
const { CONFIG } = require('../config.js');
const H = CONFIG.paths.harnessRoot;
const LIB = path.join(H, 'lib');

// The harness is consumed through its public module exports - no copying.
const registry = require(path.join(LIB, 'registry.js'));
const project = require(path.join(LIB, 'project.js'));
const workspaces = require(path.join(LIB, 'workspaces.js'));
const tasks = require(path.join(LIB, 'tasks.js'));
const workers = require(path.join(LIB, 'workers.js'));
const router = require(path.join(LIB, 'router.js'));
const packet = require(path.join(LIB, 'packet.js'));
const driver = require(path.join(LIB, 'driver.js'));
const session = require(path.join(LIB, 'worker-session.js'));

// ---------------------------------------------------------------------------
// git - read-only, and guarded against destructive verbs
// ---------------------------------------------------------------------------

/**
 * Run a read-only git command inside a project root.
 *
 * Destructive verbs are refused by name. The workbench must never be the thing that runs
 * `reset --hard` or a force push, whatever a caller asks for, so the refusal lives here
 * rather than in the UI.
 */
function git(projectRoot, args, opts = {}) {
  const joined = args.join(' ');
  for (const forbidden of CONFIG.safety.forbiddenGitCommands) {
    if (joined.includes(forbidden)) {
      return { ok: false, blocked: true, error: `refusing destructive git command: git ${joined}` };
    }
  }
  const res = spawnSync('git', ['-C', projectRoot, ...args], {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 30000,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) return { ok: false, error: res.error.message };
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

// ---------------------------------------------------------------------------
// READ
// ---------------------------------------------------------------------------

/** READ - every registered project, with liveness and worker counts. */
function listProjects() {
  return registry.listProjects().map((p) => {
    const exists = fs.existsSync(p.root_path);
    const projectWorkers = workers.list(p.project_id);
    return {
      project_id: p.project_id,
      name: p.name,
      type: p.project_type,
      root_path: p.root_path,
      status: p.status,
      git_enabled: p.git_enabled,
      last_opened: p.last_opened,
      root_exists: exists,
      workspace_count: exists ? workspaces.list(p).length : 0,
      task_count: fs.existsSync(registry.stateDirOf(p)) ? tasks.list(p).length : 0,
      worker_count: projectWorkers.length,
      active_workers: projectWorkers.filter((w) => w.status === 'ACTIVE').length,
    };
  });
}

/** READ - one project with workspaces, git state and worker summary. */
function getProject(projectId) {
  const record = registry.getProject(projectId);
  if (!record) return null;

  const cfg = registry.loadProjectConfig(record);
  const wsList = fs.existsSync(record.root_path) ? workspaces.list(record) : [];

  return {
    project_id: record.project_id,
    name: record.name,
    type: record.project_type,
    root_path: record.root_path,
    status: record.status,
    root_exists: fs.existsSync(record.root_path),
    config: cfg.ok ? cfg.config : null,
    config_error: cfg.ok ? null : cfg.error,
    git: gitState(record.root_path),
    workspaces: wsList.map((w) => workspaceSummary(record, w)),
    workers: workers.list(projectId).map(workerView),
  };
}

/** READ - compact git state. Never mutates. */
function gitState(projectRoot) {
  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    return { enabled: false, present: false, clean: null };
  }
  const branch = git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = git(projectRoot, ['rev-parse', '--short', 'HEAD']);
  const status = git(projectRoot, ['status', '--porcelain']);
  const lines = (status.stdout || '').split('\n').filter(Boolean);
  return {
    enabled: true,
    present: true,
    branch: (branch.stdout || '').trim(),
    head: (head.stdout || '').trim(),
    clean: lines.length === 0,
    changed_count: lines.length,
    changed: lines.slice(0, 200),
  };
}

/** READ - one workspace, including its current task and worker. */
function workspaceSummary(record, ws) {
  const wsTasks = tasks.list(record, { workspaceId: ws.workspace_id });
  const open = wsTasks.filter((t) => t.status !== 'DONE' && t.status !== 'CANCELLED');
  const current = open.find((t) => t.status === 'IN_PROGRESS')
    ?? open.find((t) => t.status === 'REVIEW')
    ?? open.find((t) => t.status === 'READY')
    ?? open.find((t) => t.status === 'BLOCKED')
    ?? null;
  const blocked = wsTasks.filter((t) => t.status === 'BLOCKED');
  const worker = workers.getForProject(record.project_id, { workspaceId: ws.workspace_id });

  const cfg = registry.loadProjectConfig(record);
  return {
    workspace_id: ws.workspace_id,
    name: ws.name,
    type: ws.type,
    status: ws.status,
    paths: ws.paths,
    implicit: ws.implicit === true,
    worker_role: cfg.ok ? workspaces.effectiveWorkerRole(cfg.config, ws) : null,
    permissions: cfg.ok ? workspaces.effectivePermissions(cfg.config, ws) : null,
    task_count: wsTasks.length,
    open_tasks: open.length,
    current_task: current ? { task_id: current.task_id, title: current.title, status: current.status } : null,
    blockers: blocked.map((t) => t.task_id),
    worker: worker ? workerView(worker) : null,
  };
}

/** READ - every workspace of a project (flat list). */
function listWorkspaces(projectId) {
  const record = registry.getProject(projectId);
  if (!record) return [];
  return workspaces.list(record).map((w) => workspaceSummary(record, w));
}

/** READ - worker view with the derived conversation state (H1 invariant). */
function workerView(w) {
  return {
    worker_id: w.worker_id,
    project_id: w.project_id,
    workspace_id: w.workspace_id ?? 'default',
    role: w.role,
    status: w.status,
    rounds: w.rounds,
    effective_rounds: workers.effectiveRounds(w),
    observed_user_turns: w.observed_user_turns ?? null,
    conversation_url: w.conversation_url,
    conversation_state: workers.conversationStateOf(w),
    conversation_resolved: workers.isResolved(w),
    rotation: workers.rotationCheck(w),
    created_at: w.created_at,
    last_used: w.last_used,
  };
}

/** READ - tasks, optionally filtered. */
function listTasks(projectId, opts = {}) {
  const record = registry.getProject(projectId);
  if (!record) return [];

  // The harness compares `includeClosed === false` by identity, so a query string reaching
  // here as the string "0" would be treated as TRUE and closed work would be shown anyway.
  // Coerce explicitly: a filter that silently ignores its argument is a filter nobody can
  // trust, and the UI asks for open-only by default.
  let includeClosed = true;
  if (opts.includeClosed === false || opts.includeClosed === 0) includeClosed = false;
  else if (typeof opts.includeClosed === 'string') {
    includeClosed = !['0', 'false', 'no'].includes(opts.includeClosed.toLowerCase());
  }

  return tasks.list(record, {
    workspaceId: opts.workspaceId,
    status: opts.status,
    includeClosed,
  }).map(taskView);
}

function taskView(t) {
  return {
    task_id: t.task_id,
    project_id: t.project_id,
    workspace_id: t.workspace_id,
    type: t.type,
    title: t.title,
    status: t.status,
    priority: t.priority,
    success_criteria: t.success_criteria ?? [],
    dependencies: t.dependencies ?? [],
    assigned_worker: t.assigned_worker ?? null,
    retry_count: t.retry_count ?? 0,
    created_at: t.created_at,
    started_at: t.started_at,
    completed_at: t.completed_at,
    updated_at: t.updated_at,
    history: t.history ?? [],
  };
}

/** READ - one task, resolved without needing to know its project. */
function getTask(taskId, projectId) {
  const loc = tasks.locate(taskId, { projectId });
  if (!loc.ok) return null;
  const t = taskView(loc.task);
  t.project_name = loc.record.name;
  t.project_root = loc.record.root_path;

  // The conversation URL for whichever worker owned the task, plus any commit recorded
  // against it, so Task Detail can show the full chain without extra round trips.
  const ws = workers.list().find((w) => w.worker_id === t.assigned_worker) ?? null;
  t.worker = ws ? workerView(ws) : null;
  return t;
}

/** READ - git diff for a project, optionally limited to certain files. */
function getDiff(projectId, opts = {}) {
  const record = registry.getProject(projectId);
  if (!record) return { ok: false, error: `no such project: ${projectId}` };
  if (!fs.existsSync(path.join(record.root_path, '.git'))) {
    return { ok: true, present: false, files: [], diff: '', note: 'project is not a git repository' };
  }

  const pathspec = opts.paths && opts.paths.length ? ['--', ...opts.paths] : [];
  const staged = opts.staged === true ? ['--cached'] : [];

  const names = git(record.root_path, ['diff', '--name-only', ...staged, ...pathspec]);
  const stat = git(record.root_path, ['diff', '--stat', ...staged, ...pathspec]);
  const full = git(record.root_path, ['diff', ...staged, ...pathspec], { timeoutMs: 60000 });
  const check = git(record.root_path, ['diff', '--check', ...staged, ...pathspec]);
  const lastCommit = git(record.root_path, ['log', '-1', '--stat', '--oneline']);

  const files = (names.stdout || '').split('\n').filter(Boolean);
  return {
    ok: true,
    present: true,
    clean: files.length === 0,
    files,
    stat: (stat.stdout || '').trim(),
    diff: full.stdout || '',
    whitespace_ok: check.status === 0,
    whitespace_output: (check.stdout || '').trim(),
    last_commit: (lastCommit.stdout || '').trim(),
    head: (git(record.root_path, ['rev-parse', '--short', 'HEAD']).stdout || '').trim(),
  };
}

/**
 * READ - one-time startup check, and the cheap repeat when a core file changed.
 *
 * WHY THIS IS NOT THE FREEZE VERIFICATION
 *   Checking freeze state used to mean spawning `freeze-manifest.js`, which re-hashes 28 harness
 *   files plus the adapter manifest - on every health request. Freeze state is a fact about a
 *   moment, not a per-request measurement, so it is read once at startup and only re-derived when
 *   a core file actually changed. The full verification remains available and is a RELEASE-tier
 *   concern (see policy/test-policy.js).
 *
 * It reads the manifests rather than recomputing them, so it costs two file reads.
 */
function startupCheck(opts = {}) {
  const out = { at: new Date().toISOString(), ok: true, checks: [], full_verification: 'available at RELEASE tier' };

  const freezeManifest = path.join(H, 'docs', 'FREEZE_MANIFEST.json');
  if (!fs.existsSync(freezeManifest)) {
    /**
     * ABSENT IS NOT DRIFT.
     *
     * This branch used to fall into the catch below, which set `ok: false`, which the header chip renders
     * as "frozen: DRIFT" - a claim that files have CHANGED. In a tree that has no freeze manifest at all,
     * nothing has changed; there is simply no baseline to compare against, and freezing is a concept of
     * the maintainer instance rather than of a clone. Reporting drift for a missing baseline is the same
     * class of error as a card rendering a tick for an unrecorded field: a strong statement about a fact
     * that was never recorded. Absent reports as "not tracked", which is what it is.
     */
    out.checks.push({
      id: 'harness.freeze',
      ok: true,
      frozen_at: null,
      tracked_files: 0,
      tracked: false,
      detail: 'no freeze manifest in this tree: baseline tracking is not enabled here',
    });
  } else {
    try {
      const m = JSON.parse(fs.readFileSync(freezeManifest, 'utf8'));
      out.checks.push({
        id: 'harness.freeze',
        ok: true,
        frozen_at: m.frozenAt,
        tracked: true,
        tracked_files: Object.keys(m.baseline ?? {}).length,
        detail: `harness freeze baseline recorded ${m.frozenAt}`,
      });
    } catch (e) {
      // A manifest that exists but cannot be read IS a problem, and stays a failure.
      out.ok = false;
      out.checks.push({ id: 'harness.freeze', ok: false, tracked: true, detail: `freeze manifest unreadable: ${e.message}` });
    }
  }

  try {
    const m = JSON.parse(fs.readFileSync(path.join(H, '..', 'chatgpt-worker', 'state', 'CHANGE_MANIFEST.json'), 'utf8'));
    out.checks.push({
      id: 'adapter.manifest',
      ok: true,
      recorded_at: m.recordedAt,
      tracked_files: Object.keys(m.baseline ?? {}).length,
      recorded_changes: (m.changes ?? []).length,
      detail: `adapter manifest: ${(m.changes ?? []).length} recorded change(s)`,
    });
  } catch (e) {
    // A missing adapter manifest is a note, not a failure: the adapter is not frozen, only recorded.
    out.checks.push({ id: 'adapter.manifest', ok: true, detail: `no adapter manifest (${e.message})` });
  }

  if (opts.recheck === true) {
    // Only when a core file changed: ask the harness's own verifier. One spawn, not per request.
    try {
      const r = spawnSync(process.execPath, [path.join(H, 'freeze-manifest.js'), '--json'], {
        encoding: 'utf8', timeout: 60000, windowsHide: true,
      });
      const parsed = JSON.parse((r.stdout || '{}').replace(/^\uFEFF/, '').trim().slice((r.stdout || '').indexOf('{')));
      out.checks.push({
        id: 'harness.freeze.verified',
        ok: parsed.ok === true,
        drift_count: parsed.driftCount ?? null,
        changed: parsed.changed ?? [],
        detail: parsed.ok === true ? 'no drift' : `DRIFT: ${parsed.driftCount} file(s)`,
      });
      if (parsed.ok !== true) out.ok = false;
    } catch (e) {
      out.checks.push({ id: 'harness.freeze.verified', ok: false, detail: `verification failed: ${e.message}` });
      out.ok = false;
    }
  }

  return out;
}

/** READ - harness + worker + git health for the header strip. */
function getHealth(opts = {}) {
  const out = {
    harness: { status: 'UNKNOWN', version: null, frozen: null },
    worker: { status: 'UNKNOWN', detail: null },
    git: { status: 'N/A', clean: null },
  };

  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(H, 'config.json'), 'utf8'));
    out.harness.version = cfg.harness.version;
    out.harness.status = 'READY';
  } catch (e) {
    out.harness.status = 'ERROR';
    out.harness.detail = e.message;
  }

  // Freeze state comes from the startup check, cached in-process. A full re-verification runs only
  // when the caller says a core file changed (opts.verifyFreeze), because re-hashing the tree on
  // every header refresh is exactly the cost this mode exists to remove.
  try {
    const sc = startupCheck({ recheck: opts.verifyFreeze === true });
    const freezeCheck = sc.checks.find((c) => c.id === 'harness.freeze');
    /**
     * `frozen` is a THREE-state value, not a boolean.
     *
     *   true  a baseline exists and, when re-verified, matches
     *   false a baseline exists and the tree does NOT match it - real drift, worth a red chip
     *   null  there is no baseline in this tree, so nothing can be said either way
     *
     * Collapsing null into false is how a clone with no manifest ended up displaying "frozen: DRIFT",
     * which reads as "files have changed here" and is not true. The UI renders null as "frozen: ?".
     */
    out.harness.frozen = freezeCheck && freezeCheck.tracked === false ? null : sc.ok;
    out.harness.startup = sc;
    const drift = sc.checks.find((c) => c.id === 'harness.freeze.verified');
    out.harness.drift = drift ? drift.drift_count : null;
    out.harness.frozen_at = freezeCheck?.frozen_at ?? null;
    out.harness.freeze_detail = freezeCheck?.detail ?? null;
  } catch (e) {
    out.harness.frozen = null;
    out.harness.detail = e.message;
  }

  // Worker health is a real browser probe and takes seconds; it is opt-in so the header
  // stays fast and the UI can refresh it on demand.
  if (opts.probeWorker === true) {
    try {
      const h = driver.healthCheck({});
      out.worker.status = h.ok ? (h.value?.status ?? 'UNKNOWN') : 'ERROR';
      out.worker.detail = h.value?.detail ?? h.error ?? null;
      out.worker.human_action = h.value?.humanAction ?? null;
      out.worker.state = h.value?.state ?? null;
    } catch (e) {
      out.worker.status = 'ERROR';
      out.worker.detail = e.message;
    }
  } else {
    out.worker.status = 'NOT_PROBED';
  }

  if (opts.projectId) {
    const record = registry.getProject(opts.projectId);
    if (record) {
      const g = gitState(record.root_path);
      out.git = { status: g.present ? (g.clean ? 'CLEAN' : 'DIRTY') : 'NO_REPO', clean: g.clean, branch: g.branch, head: g.head };
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// COMMAND
// ---------------------------------------------------------------------------

/** COMMAND - transition a task. */
function taskTransition(taskId, verb, opts = {}) {
  const loc = tasks.locate(taskId, { projectId: opts.projectId });
  if (!loc.ok) return { ok: false, error: loc.error };

  const map = {
    ready: tasks.STATUS.READY,
    start: tasks.STATUS.IN_PROGRESS,
    review: tasks.STATUS.REVIEW,
    block: tasks.STATUS.BLOCKED,
    unblock: tasks.STATUS.READY,
    retry: tasks.STATUS.IN_PROGRESS,
    done: tasks.STATUS.DONE,
    cancel: tasks.STATUS.CANCELLED,
  };
  const next = map[verb];
  if (!next) return { ok: false, error: `unknown task verb: ${verb}` };

  const r = tasks.transition(loc.record, taskId, next, {
    detail: opts.note,
    worker: opts.worker,
    verified: opts.verified === true,
  });
  if (r.ok) tasks.syncAllViews(loc.record);
  return r;
}

/** COMMAND - create a task. */
function createTask(projectId, spec) {
  const record = registry.getProject(projectId);
  if (!record) return { ok: false, error: `no such project: ${projectId}` };
  const r = tasks.add(record, {
    taskId: spec.taskId,
    workspaceId: spec.workspaceId,
    title: spec.title,
    description: spec.description,
    type: spec.type,
    priority: spec.priority,
    successCriteria: spec.successCriteria,
    dependencies: spec.dependencies,
    crossWorkspaceReads: spec.crossWorkspaceReads,
    assignedWorker: spec.assignedWorker,
  });
  if (r.ok) tasks.syncAllViews(record);
  return r;
}

/** COMMAND - record a rejection without deleting anything. */
function rejectTask(taskId, opts = {}) {
  const loc = tasks.locate(taskId, { projectId: opts.projectId });
  if (!loc.ok) return { ok: false, error: loc.error };

  const data = tasks.load(loc.record);
  const task = data.tasks[taskId];
  if (!task) return { ok: false, error: `no such task: ${taskId}` };

  task.history = task.history ?? [];
  task.history.push({
    n: task.history.length + 1,
    at: new Date().toISOString(),
    event: 'user_rejected',
    detail: String(opts.reason ?? 'rejected by user (no reason given)').slice(0, 500),
  });
  task.updated_at = new Date().toISOString();
  tasks.save(loc.record, data);
  tasks.syncAllViews(loc.record);
  return { ok: true, task_id: taskId, event: 'user_rejected', status: task.status };
}

/** COMMAND - create a worker bound to a project + workspace. */
function createWorker(projectId, spec = {}) {
  return workers.create(projectId, { role: spec.role ?? 'general', workspaceId: spec.workspaceId ?? null });
}

/** COMMAND - open a fresh ChatGPT conversation for a worker (H1 lifecycle). */
function openWorkerConversation(workerId) {
  return workers.openConversation(workerId);
}

/** COMMAND - rotate a worker to a new conversation. */
function rotateWorker(workerId, reason) {
  return workers.rotate(workerId, reason ?? 'rotation from workbench');
}

/**
 * COMMAND - start a turn to a worker. Returns IMMEDIATELY; the turn continues in the background.
 *
 * WHY NOTHING HERE WAITS
 *   The harness send path is synchronous (driver.sendAndWait -> spawnSync) and blocks for the
 *   whole duration of a ChatGPT turn - minutes. Two attempts to contain that failed, and both
 *   failures are worth recording because the obvious fixes are wrong:
 *
 *     1. Calling it inline in the server blocked the event loop. The API stopped answering
 *        mid-turn, so the UI could not distinguish "still working" from "server died", and a
 *        Pause request could not even be delivered.
 *     2. Moving it into a child process with spawnSync and pipe stdio STILL blocked the parent.
 *        The runner shells out again to the protected worker CLI, which drives playwright; that
 *        grandchild inherits the pipe handle, so the pipe does not close until the entire tree
 *        exits and spawnSync waits the whole time. Redirecting output to files fixed the pipe
 *        problem but not the waiting, because spawnSync waits by definition.
 *
 *   So the parent does not wait at all. spawn() is asynchronous, and this function returns a
 *   handle immediately; the caller polls. That is also the honest shape for this operation:
 *   a ChatGPT turn takes minutes, and pretending an HTTP request can sit on it is what produced
 *   the frozen UI in the first place.
 *
 * The result is written to a small JSON file under the workbench's own temp directory, so the
 * outcome survives even if the server restarts mid-turn.
 */
function startSendToWorker(workerId, text, opts = {}) {
  const { spawn } = require('node:child_process');
  const runner = path.join(__dirname, 'worker-runner.js');
  if (!fs.existsSync(runner)) return { ok: false, error: `not found: ${runner}` };

  const tmpDir = path.join(CONFIG.paths.workbenchRoot, 'temp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const sendId = `SEND-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const packetFile = path.join(tmpDir, `${sendId}.packet.txt`);
  const outFile = path.join(tmpDir, `${sendId}.out.json`);
  const errFile = path.join(tmpDir, `${sendId}.err.log`);
  fs.writeFileSync(packetFile, text, 'utf8');

  const args = [runner, workerId, packetFile];
  args.push(opts.baselineTurns !== undefined && opts.baselineTurns !== null ? String(opts.baselineTurns) : '');
  if (opts.resolveTimeoutMs) args.push(String(opts.resolveTimeoutMs));

  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');

  const child = spawn(process.execPath, args, {
    detached: false,
    windowsHide: true,
    stdio: ['ignore', outFd, errFd],
  });
  // The parent's own descriptors are no longer needed once the child owns them.
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  const state = {
    send_id: sendId,
    worker_id: workerId,
    project_id: opts.projectId ?? null,
    started_at: new Date().toISOString(),
    pid: child.pid ?? null,
    status: 'RUNNING',
    result: null,
    error: null,
    out_file: outFile,
    err_file: errFile,
    packet_file: packetFile,
    chars: text.length,
  };
  sendState.set(sendId, state);

  child.on('error', (e) => {
    state.status = 'ERROR';
    state.error = `could not start the send process: ${e.message}`;
  });

  child.on('exit', (code, signal) => {
    state.finished_at = new Date().toISOString();
    let stdout = '';
    let stderr = '';
    try { stdout = fs.readFileSync(outFile, 'utf8').trim(); } catch { /* not written */ }
    try { stderr = fs.readFileSync(errFile, 'utf8').trim(); } catch { /* not written */ }
    state.stderr_tail = stderr ? stderr.slice(-2000) : null;
    if (stderr) process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);

    let parsed = null;
    try { parsed = JSON.parse(stdout.replace(/^\uFEFF/, '')); } catch { /* handled below */ }
    if (parsed) {
      state.status = parsed.ok ? 'COMPLETE' : 'FAILED';
      state.result = parsed;
    } else {
      state.status = signal ? 'KILLED' : 'UNPARSED';
      state.error = signal
        ? `the send process was terminated (${signal}); the browser may still be mid-turn`
        : `the send process produced no JSON (exit ${code})`;
      state.raw = `${stdout}\n${stderr}`.trim().slice(0, 4000);
    }
    // The packet is dead weight once the child has read it.
    try { fs.unlinkSync(packetFile); } catch { /* best-effort */ }
  });

  return { ok: true, send_id: sendId, worker_id: workerId, status: 'RUNNING', chars: text.length };
}

/** In-process registry of started sends. Volatile by design: the files hold the truth. */
const sendState = new Map();

/** READ - the state of one started send. */
function getSend(sendId) {
  return sendState.get(sendId) ?? null;
}

/** READ - all sends started in this process, newest first. */
function listSends() {
  return [...sendState.values()].sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
}

/** COMMAND - send a turn and WAIT for it. Only for callers that are allowed to block. */
function sendToWorker(workerId, text, opts = {}) {
  const { spawnSync } = require('node:child_process');
  const runner = path.join(__dirname, 'worker-runner.js');
  if (!fs.existsSync(runner)) return { ok: false, outcome: 'RUNNER_MISSING', detail: `not found: ${runner}` };

  const tmpDir = path.join(CONFIG.paths.workbenchRoot, 'temp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const stamp = `${process.pid}-${Date.now()}`;
  const packetFile = path.join(tmpDir, `packet-${stamp}.txt`);
  const outFile = path.join(tmpDir, `runner-out-${stamp}.json`);
  const errFile = path.join(tmpDir, `runner-err-${stamp}.log`);
  fs.writeFileSync(packetFile, text, 'utf8');

  const args = [runner, workerId, packetFile];
  args.push(opts.baselineTurns !== undefined && opts.baselineTurns !== null ? String(opts.baselineTurns) : '');
  if (opts.resolveTimeoutMs) args.push(String(opts.resolveTimeoutMs));

  const started = Date.now();
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  try {
    const res = spawnSync(process.execPath, args, {
      timeout: opts.timeoutMs ?? 900000,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
    });
    fs.closeSync(outFd); fs.closeSync(errFd);
    const stdout = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '';
    const stderr = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8').trim() : '';
    if (stderr) process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);
    if (res.error) return { ok: false, outcome: 'RUNNER_SPAWN_FAILED', detail: res.error.message, elapsed_ms: Date.now() - started };
    let parsed = null;
    try { parsed = JSON.parse(stdout.replace(/^\uFEFF/, '')); } catch { /* handled below */ }
    if (!parsed) {
      return { ok: false, outcome: 'RUNNER_UNPARSED', detail: `no JSON (exit ${res.status})`,
               raw: `${stdout}\n${stderr}`.trim().slice(0, 4000), elapsed_ms: Date.now() - started };
    }
    return { ...parsed, elapsed_ms: Date.now() - started };
  } finally {
    try { fs.closeSync(outFd); } catch { /* already closed */ }
    try { fs.closeSync(errFd); } catch { /* already closed */ }
    for (const f of [packetFile, outFile, errFile]) { try { fs.unlinkSync(f); } catch { /* best-effort */ } }
  }
}

/** READ - read a completed turn's reply. */
function readWorkerReply(workerId, turnIndex) {
  return session.readTurn(workerId, turnIndex);
}

/**
 * READ - how many user turns the worker's conversation REALLY contains right now.
 *
 * This is the reconciliation signal for the send state machine. It is deliberately a live read of
 * the conversation rather than a recorded counter: the question being answered is "did the packet
 * actually land", and only the conversation can answer it.
 */
function countUserTurns(workerId) {
  const h = driver.healthCheck({});
  if (!h.ok || !h.value || h.value.status !== 'READY') {
    return { ok: false, count: null, error: h.value?.detail ?? h.error ?? 'worker not reachable' };
  }
  // The worker adapter owns the counting; this goes through its public CLI, never the DOM directly.
  return invokeWorkerJson(['user_turns'], null);
}

/**
 * READ - the same reconciliation read, ASYNCHRONOUSLY.
 *
 * WHY BOTH EXIST
 *   The synchronous version above drives the worker CLI through spawnSync, which blocks this
 *   process for the several seconds the browser probe takes. Calling it from the reconciliation
 *   timer therefore stalled the whole workbench: polling /api/state during a reconcile cycle
 *   measured 5-second response times and outright timeouts. A background safety net must not be
 *   able to freeze the UI it exists to protect, so the loop uses this version and the server keeps
 *   answering. The sync one remains for callers that are already blocking (the CLI, tests).
 *
 * @returns {Promise<{ok:boolean, user_turns:number|null, assistant_turns:number|null, error?:string}>}
 */
function countUserTurnsAsync(workerId) {
  const { spawn } = require('node:child_process');
  const workerCli = path.join(CONFIG.paths.harnessRoot, '..', 'chatgpt-worker', 'adapter', 'cw.js');
  if (!fs.existsSync(workerCli)) {
    return Promise.resolve({ ok: false, user_turns: null, assistant_turns: null, error: 'worker CLI not found' });
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerCli, 'user_turns'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 60000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, user_turns: null, assistant_turns: null, error: e.message }); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out.trim().replace(/^\uFEFF/, ''));
        resolve({ ok: parsed.ok !== false, ...parsed });
      } catch {
        resolve({ ok: false, user_turns: null, assistant_turns: null, error: (err || out || 'unparsed').slice(0, 300) });
      }
    });
  });
}

/**
 * COMMAND - count a user turn against the worker's rotation ledger.
 *
 * Used ONLY by reconciliation, after a user turn has been observed in the conversation. The
 * harness never rolls this back, which is the H2 rule: the conversation has already grown, so the
 * counter must reflect that regardless of what happened afterwards.
 */
function bumpWorkerRound(workerId, detail) {
  const r = workers.bumpRound(workerId, { detail: detail ?? 'round confirmed by reconciliation' });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, worker_id: workerId, rounds: r.worker.rounds, rotation: r.rotation };
}

/** Small helper: run the worker CLI and parse its JSON. */
function invokeWorkerJson(args, projectId) {
  const cli = CONFIG.paths.harnessCli;
  const workerCli = path.join(CONFIG.paths.harnessRoot, '..', 'chatgpt-worker', 'adapter', 'cw.js');
  const target = fs.existsSync(workerCli) ? workerCli : null;
  if (!target) return { ok: false, count: null, error: `worker CLI not found near ${CONFIG.paths.harnessRoot}` };
  const res = spawnSync(process.execPath, [target, ...args], {
    encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  const text = (res.stdout || '').trim();
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    return { ok: parsed.ok !== false, ...parsed };
  } catch {
    return { ok: false, count: null, error: (res.stderr || text || `exit ${res.status}`).slice(0, 300) };
  }
}

/** READ - route a natural-language goal without executing anything. */
function routeGoal(projectId, goalText) {
  const record = registry.getProject(projectId);
  if (!record) return { ok: false, error: `no such project: ${projectId}` };
  const cfg = registry.loadProjectConfig(record);
  if (!cfg.ok) return { ok: false, error: cfg.error };
  const wsList = workspaces.list(record);
  const decision = router.route(goalText, {
    projectId,
    projectType: cfg.config.type,
    webAvailable: cfg.config.permissions?.web === true,
    workspaces: wsList,
  });
  return { ok: true, routing: decision, workspaces: wsList.map((w) => w.workspace_id) };
}

/** READ - build the hierarchical packet for a task (no send). */
function buildTaskPacket(projectId, taskId, spec = {}) {
  const record = registry.getProject(projectId);
  if (!record) return { ok: false, error: `no such project: ${projectId}` };
  const task = tasks.get(record, taskId);
  if (!task) return { ok: false, error: `no such task: ${taskId}` };
  const ws = workspaces.get(record, task.workspace_id);
  if (!ws && task.workspace_id !== tasks.PROJECT_WORKSPACE) {
    return { ok: false, error: `task references a missing workspace: ${task.workspace_id}` };
  }

  const opened = project.open(projectId, { extraFiles: spec.files });
  if (!opened.ok) return opened;

  const statePath = ws ? workspaces.workspaceStatePath(record, task.workspace_id) : null;
  const workspaceState = statePath && fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null;

  return packet.buildWorkspaceTask({
    project: opened.project,
    workspace: ws ?? { workspace_id: tasks.PROJECT_WORKSPACE, name: 'Project Management', type: 'general', paths: [] },
    task,
    context: opened.context,
    workspaceState,
    relevantDecisions: spec.relevantDecisions,
    knownFacts: spec.knownFacts,
    doNotBreak: spec.doNotBreak,
    files: spec.files,
    request: spec.request,
    outputFormat: spec.outputFormat,
  });
}

/** READ - project open report, for the Project page. */
function openProject(projectId) {
  return project.open(projectId);
}

/** READ - the harness's own event log, tailed. */
function readHarnessLog(limit = 200) {
  const file = path.join(H, 'logs', 'harness.jsonl');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => {
    try { return JSON.parse(l); } catch { return { raw: l }; }
  }).reverse();
}

/** READ - adapter's own event log, tailed. */
function readWorkbenchLog(limit = 300) {
  const file = path.join(CONFIG.paths.logsDir, 'workbench.jsonl');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => {
    try { return JSON.parse(l); } catch { return { raw: l }; }
  }).reverse();
}

module.exports = {
  CONFIG,
  // read
  listProjects, getProject, listWorkspaces, listTasks, getTask, getDiff, getHealth, startupCheck,
  gitState, workspaceSummary, workerView, taskView, routeGoal, buildTaskPacket,
  openProject, readHarnessLog, readWorkbenchLog,
  // command
  taskTransition, createTask, rejectTask, createWorker, openWorkerConversation,
  rotateWorker, startSendToWorker, sendToWorker, getSend, listSends, readWorkerReply,
  countUserTurns, countUserTurnsAsync, bumpWorkerRound,
  // exposed for the job runner
  git,
};
