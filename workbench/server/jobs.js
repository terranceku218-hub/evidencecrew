'use strict';
/**
 * jobs.js - the Goal orchestrator: checkpointed, resumable, pausable.
 *
 * WHY PAUSE LIVES HERE AND NOT IN THE HARNESS
 *   The user asked for Pause/Resume and explicitly said not to add it to the harness Task
 *   Engine. That is the right call: pausing is a UI-layer concern about *whether to start the
 *   next automatic step*, not a property of a task. So the workbench owns it.
 *
 * THE CHECKPOINT MODEL
 *   A goal runs as a sequence of discrete checkpoints. Pause is only honoured BETWEEN
 *   checkpoints, never mid-step. That matters concretely: while a ChatGPT turn is in flight,
 *   pausing must NOT abort it or kill the browser - the current atomic operation finishes and
 *   the job then stops before the next step. State is written after every checkpoint, so
 *   Resume continues from the last completed one rather than replaying from the start.
 *
 * SINGLE CONCURRENCY
 *   One job at a time, matching the harness's serialised model and the single shared browser.
 *
 * WHAT PLAN CREATION DOES
 *   It asks the project's worker to break the goal into candidate tasks and return them in a
 *   strict format, then PARSES that reply into real task records. The broker is explicit: the
 *   workbench does not invent the decomposition itself, and it does not execute anything the
 *   planner proposed without the approval gate allowing it.
 *
 * ASCII-ONLY source.
 */

const fs = require('node:fs');
const path = require('node:path');

// PUBLIC RELEASE CHANGE: one shared loader resolves every configured path against the repository root,
// so this file no longer assumes absolute paths recorded on the maintainer machine.
const { CONFIG } = require('../config.js');

const adapter = require(path.join(__dirname, '..', 'adapters', 'harness-adapter.js'));
const store = require('./store.js');
const events = require('./events.js');
const sendState = require('./send-state.js');

// ---------------------------------------------------------------------------
// job registry (in-process; a restart simply loses the volatile handle, not the goal state)
// ---------------------------------------------------------------------------

let current = null;

function snapshot() {
  if (!current) return { running: false, job: null };
  return {
    running: current.running === true,
    job: {
      goal_id: current.goal.goal_id,
      project_id: current.goal.project_id,
      workspace_id: current.goal.workspace_id,
      step: current.step,
      steps: current.steps,
      started_at: current.started_at,
      paused: current.paused,
      awaiting_approval: current.awaitingApproval === true,
      error: current.error ?? null,
    },
  };
}

/** Append a UI event to the workbench log (a projection source, not a truth store). */
function logEvent(event, detail, projectId) {
  try {
    fs.mkdirSync(CONFIG.paths.logsDir, { recursive: true });
    fs.appendFileSync(
      path.join(CONFIG.paths.logsDir, 'workbench.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), project_id: projectId ?? null, event, detail: detail ?? null }) + '\n',
      'utf8',
    );
  } catch { /* logging must never break the run */ }
}

// The send state machine logs through the same event stream as the job runner, so one timeline
// shows both the job's checkpoints and the send's lifecycle. Bound here, after logEvent exists.
sendState.setLogger((event, detail, projectId) => logEvent(event, detail, projectId));

// ---------------------------------------------------------------------------
// planner prompt
// ---------------------------------------------------------------------------

const PLANNER_PROMPT = `[ROLE]
你是本项目的 Planner。DeepSeek Supervisor 会审核你的输出，Workbench 只负责展示。
你不修改任何文件，也不执行任何任务，只产出任务拆解建议。

[CONTEXT]
项目：{{PROJECT}}
工作域：{{WORKSPACE}}
当前状态摘要：
{{STATE}}

[GOAL]
{{GOAL}}

[REQUEST]
把这个 Goal 拆解成 1 到 5 个候选 Task。要求：
- 每个 Task 边界清晰、可以独立验收
- 第一个 Task 应优先选择低风险、影响文件少的
- 明确哪些 Task 会修改文件、哪些只是分析
- 如果 Goal 信息不足，直接在「不确定项」中说明，不要编造

[OUTPUT FORMAT]
严格按以下格式输出，不要添加其它章节。每个 Task 一段：

TASK:
TITLE: <一行标题>
TYPE: <coding | review | research | writing | general>
MODIFIES_FILES: <yes | no>
PRIORITY: <low | normal | high | critical>
CRITERIA:
- <成功标准 1>
- <成功标准 2>

（重复以上 TASK 段落，最多 5 个）

NOTES:
<给 Supervisor 的补充说明，可留空>

[IMPORTANT]
- 不要修改任何文件。
- 不要调用外部工具。
- 信息不足必须写在 NOTES 中，不要猜测。`;

function buildPlannerPrompt(projectId, workspaceId, goalText) {
  const p = adapter.getProject(projectId);
  const ws = adapter.listWorkspaces(projectId).find((w) => w.workspace_id === workspaceId);
  const lines = [];
  lines.push(`- root: ${p.root_path}`);
  lines.push(`- type: ${p.type}`);
  lines.push(`- git: ${p.git.present ? `${p.git.branch} @ ${p.git.head} (${p.git.clean ? 'clean' : `${p.git.changed_count} changed`})` : 'no repository'}`);
  if (ws) {
    lines.push(`- workspace type: ${ws.type}`);
    lines.push(`- workspace paths: ${ws.paths && ws.paths.length ? ws.paths.join(', ') : '(whole project root)'}`);
    lines.push(`- open tasks: ${ws.open_tasks}`);
    lines.push(`- worker rounds: ${ws.worker ? `${ws.worker.rounds}/${ws.worker.rotation.threshold}` : 'no worker'}`);
  } else {
    lines.push('- workspace: (not resolved)');
  }

  return PLANNER_PROMPT
    .replace('{{PROJECT}}', `${p.name} (${p.project_id})`)
    .replace('{{WORKSPACE}}', ws ? `${ws.name} (${ws.workspace_id})` : workspaceId)
    .replace('{{STATE}}', lines.join('\n'))
    .replace('{{GOAL}}', goalText);
}

// ---------------------------------------------------------------------------
// plan parsing
// ---------------------------------------------------------------------------

/**
 * Parse the planner reply into candidate tasks.
 *
 * The format is strict so that a malformed reply produces an explicit parse warning rather
 * than silently zero tasks, which would look like "the planner found nothing to do".
 */
function parsePlan(replyText) {
  const tasks = [];
  const warnings = [];
  const notes = [];

  const notesMatch = replyText.match(/^NOTES:\s*([\s\S]*)$/m);
  if (notesMatch) {
    const n = notesMatch[1].trim();
    if (n) notes.push(n.slice(0, 800));
  }

  const blocks = replyText.split(/^TASK:\s*$/m).slice(1);
  if (!blocks.length) {
    warnings.push('planner reply contained no TASK: block; nothing could be created');
    return { tasks, warnings, notes };
  }

  for (const block of blocks.slice(0, 5)) {
    const body = block.split(/^NOTES:/m)[0];
    const title = (body.match(/^TITLE:\s*(.+)$/m) || [])[1];
    const type = (body.match(/^TYPE:\s*(.+)$/m) || [])[1];
    const modifies = (body.match(/^MODIFIES_FILES:\s*(.+)$/m) || [])[1];
    const priority = (body.match(/^PRIORITY:\s*(.+)$/m) || [])[1];

    // The criteria are a MULTI-LINE bullet list, so the block must be sliced to its end
    // rather than matched by a single-line pattern. Matching `^CRITERIA:[\s\S]*?` without the
    // m flag stops at the first newline and silently keeps only the first criterion - which
    // would drop acceptance criteria without any error, the worst kind of loss here.
    const critStart = body.search(/^CRITERIA:\s*$/m);
    let criteria = [];
    if (critStart >= 0) {
      let after = body.slice(critStart).replace(/^CRITERIA:\s*\n?/, '');
      const nextField = after.search(/^[A-Z_]+:/m);
      if (nextField >= 0) after = after.slice(0, nextField);
      criteria = after.split('\n')
        .map((l) => l.replace(/^\s*[-*\u2022]\s*/, '').trim())
        .filter((l) => l.length > 0);
    } else {
      // Tolerate CRITERIA: followed by content on the same line.
      const inline = (body.match(/^CRITERIA:\s*(.+)$/m) || [])[1];
      if (inline && inline.trim()) criteria = [inline.trim()];
    }

    if (!title) { warnings.push('a TASK block had no TITLE and was skipped'); continue; }
    if (!criteria.length) { warnings.push(`task "${title.trim()}" had no CRITERIA`); }

    tasks.push({
      title: title.trim().slice(0, 200),
      type: (type || 'general').trim().toLowerCase(),
      modifies_files: /^y/i.test((modifies || '').trim()),
      priority: (priority || 'normal').trim().toLowerCase(),
      successCriteria: criteria.slice(0, 12),
    });
  }

  return { tasks, warnings, notes };
}

// ---------------------------------------------------------------------------
// checkpoint helpers
// ---------------------------------------------------------------------------

function waitWhilePaused() {
  return new Promise((resolve) => {
    const tick = () => {
      if (!current || current.cancelled) return resolve();
      if (!current.paused) return resolve();
      setTimeout(tick, 400);
    };
    tick();
  });
}

/**
 * Watch for a send to be confirmed, CONCURRENTLY with the caller waiting for the full result.
 *
 * WHY A SEPARATE WATCHER
 *   The adapter's send call does not return until the whole round is done - send AND wait for the
 *   answer - which was measured at 308s. A UI parked in SUBMITTING for five minutes looks identical
 *   to a UI that has hung. So confirmation is discovered independently: this polls the conversation
 *   for the new user turn on a short interval and moves the state as soon as it appears, while the
 *   job keeps waiting for the reply in parallel.
 *
 * WHAT IT NEVER DOES
 *   It never sends. Only send-state.reconcileOnce reads, and only the original send call can post a
 *   message - which is what makes "no automatic retry" structural rather than a promise.
 *
 * It stops itself on any terminal state, and it is bounded by the send's own reconcile budget.
 */
function watchForConfirmation(sendStateId, projectId, intervalMs = 15000) {
  const started = Date.now();
  const timer = setInterval(async () => {
    try {
      const s = store.getSendState(sendStateId);
      if (!s || sendState.TERMINAL.includes(s.state)) { clearInterval(timer); return; }
      // Already confirmed by the adapter's own result: nothing left to watch.
      if (s.state === sendState.STATE.USER_TURN_CONFIRMED || s.state === sendState.STATE.ASSISTANT_PENDING) {
        clearInterval(timer);
        return;
      }
      const r = await sendState.reconcileOnce(sendStateId, adapter);
      const state = r.record?.state;
      if (state === sendState.STATE.USER_TURN_CONFIRMED || state === sendState.STATE.ASSISTANT_PENDING) {
        store.updateGoal(s.goal_id, {
          send_state: state,
          status: state === sendState.STATE.USER_TURN_CONFIRMED ? 'ASSISTANT_PENDING' : 'ASSISTANT_PENDING',
          pending_note: 'the packet is confirmed in the conversation; waiting for the answer',
        });
        logEvent('goal.send.confirmed', { goal_id: s.goal_id, send_state_id: sendStateId, observed: r.record.user_turns_after }, projectId);
        clearInterval(timer);
        return;
      }
      if (Date.now() - started > (s.reconcile_budget_ms ?? sendState.RECONCILE_BUDGET_MS)) {
        clearInterval(timer);
      }
    } catch (e) {
      logEvent('goal.send.watch.error', { send_state_id: sendStateId, error: String(e && e.message ? e.message : e) }, projectId);
    }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}
/**
 * Wait for a background send to finish, without ever blocking the event loop.
 *
 * This is the LONG wait: it returns when the adapter reports the whole round finished, which
 * includes waiting for the answer. That is why confirmation that the packet LANDED is discovered
 * separately and much sooner by watchForConfirmation() - otherwise the visible state would sit in
 * SUBMITTING for the entire turn, which is indistinguishable from a hang.
 *
 * The turn itself runs in its own process; this only polls the handle the adapter keeps, so the
 * server keeps answering status requests and can accept a Pause while the work is in flight.
 * A hard cap bounds the wait so a wedged browser surfaces as BLOCKED instead of hanging forever.
 */
function awaitSend(sendId, projectId) {
  const deadline = Date.now() + (CONFIG.jobs.turnTimeoutMs ?? 600000);
  return new Promise((resolve) => {
    const tick = () => {
      const s = adapter.getSend(sendId);
      if (!s) {
        return resolve({ ok: false, outcome: 'SEND_HANDLE_LOST',
                         error: 'the workbench lost track of this send',
                         detail: 'the send was started but its handle is gone; check the browser and the worker ledger before retrying' });
      }
      if (s.status !== 'RUNNING') {
        if (s.result) {
          return resolve({ ...s.result, elapsed_ms: Date.parse(s.finished_at ?? '') - Date.parse(s.started_at) || null, send_status: s.status });
        }
        return resolve({ ok: false, outcome: s.status, error: s.error, detail: s.stderr_tail ?? null, send_status: s.status });
      }
      if (Date.now() > deadline) {
        return resolve({
          ok: false,
          outcome: 'SEND_TIMEOUT',
          error: `no completion within ${Math.round((CONFIG.jobs.turnTimeoutMs ?? 600000) / 1000)}s`,
          detail: 'the send process is still running; the browser may be stuck. Check the ChatGPT window before retrying.',
        });
      }
      setTimeout(tick, 1000);
    };
    tick();
  });
}

/**
 * Record that a checkpoint has been reached.
 *
 * `status` is normally IN_PROGRESS, because reaching a checkpoint means work is under way. But two
 * checkpoints in this job are TERMINAL - the run stops there and the goal has a real final status.
 * Writing IN_PROGRESS at those points would overwrite the status written a line earlier and leave a
 * finished goal looking like it is still running.
 *
 * That is exactly what happened: `store.updateGoal({status: 'AWAITING_APPROVAL', ...})` was followed
 * by `checkpoint('AWAITING_APPROVAL')`, which wrote IN_PROGRESS straight back over it. The goal had
 * created its task and was waiting for approval while the UI showed it as still in progress. The bug
 * was invisible until a goal actually reached that checkpoint, because every goal before it was
 * blocked during planning.
 *
 * @param {string} name
 * @param {string|null} finalStatus status to write instead of IN_PROGRESS, for terminal checkpoints
 */
function checkpoint(name, finalStatus = null) {
  current.step = name;
  store.updateGoal(current.goal.goal_id, {
    status: finalStatus ?? (current.paused ? 'PAUSED' : 'IN_PROGRESS'),
    checkpoint: name,
  });
  logEvent('job.checkpoint', { goal_id: current.goal.goal_id, step: name }, current.goal.project_id);
}

// ---------------------------------------------------------------------------
// the goal run
// ---------------------------------------------------------------------------

/**
 * Run a goal to the point where it needs a human decision.
 *
 * @param {{projectId:string, workspaceId:string, text:string, createTasks:boolean}} req
 */
async function submitGoal(req) {
  if (current && current.running) {
    return { ok: false, error: `a goal is already running (${current.goal.goal_id}); only one job at a time in V0.1` };
  }
  if (!req.projectId || !req.text) {
    return { ok: false, error: 'projectId and text are required' };
  }
  if (store.isPaused(req.projectId)) {
    return { ok: false, error: `project ${req.projectId} is PAUSED; resume before submitting a goal` };
  }

  const project = adapter.getProject(req.projectId);
  if (!project) return { ok: false, error: `no such project: ${req.projectId}` };

  // Routing is advisory and comes from the harness router, which is also where the
  // WORKSPACE_REQUIRED refusal lives - so an ambiguous goal stops instead of guessing.
  const routing = adapter.routeGoal(req.projectId, req.text);
  if (!routing.ok) return routing;

  const workspaceId = req.workspaceId || routing.routing.workspace_id;
  if (!workspaceId) {
    return {
      ok: false,
      status: 'WORKSPACE_REQUIRED',
      error: `workspace could not be determined (${routing.routing.workspace_status}). ` +
             `Choose one of: ${(routing.routing.workspace_candidates ?? routing.workspaces).join(', ')}`,
      routing: routing.routing,
    };
  }

  const goal = store.addGoal({
    project_id: req.projectId,
    workspace_id: workspaceId,
    text: req.text,
    routing: routing.routing,
    status: 'SUBMITTED',
  });

  current = {
    goal,
    running: true,
    paused: false,
    cancelled: false,
    awaitingApproval: false,
    step: 'SUBMITTED',
    steps: ['ROUTED', 'PLANNING', 'PARSING_PLAN', 'TASKS_CREATED', 'AWAITING_APPROVAL'],
    started_at: new Date().toISOString(),
    error: null,
  };

  logEvent('goal.submitted', {
    goal_id: goal.goal_id, workspace: workspaceId, routing: routing.routing.task_type,
  }, req.projectId);

  // Run asynchronously so the HTTP response returns immediately and the UI can poll.
  runGoal(req, goal, workspaceId, routing).catch((e) => {
    current.error = String(e && e.message ? e.message : e);
    current.running = false;
    store.updateGoal(goal.goal_id, { status: 'BLOCKED', error: current.error });
    logEvent('goal.crashed', { goal_id: goal.goal_id, error: current.error }, req.projectId);
  });

  return { ok: true, goal_id: goal.goal_id, workspace_id: workspaceId, routing: routing.routing, status: 'SUBMITTED' };
}

async function runGoal(req, goal, workspaceId, routing) {
  const projectId = req.projectId;

  // ---- checkpoint ROUTED -------------------------------------------------
  checkpoint('ROUTED');
  store.updateGoal(goal.goal_id, { status: 'PLANNING' });
  await waitWhilePaused();
  if (current.cancelled) return;

  const worker = adapter.getProject(projectId)?.workers
    ?.find((w) => w.workspace_id === workspaceId && w.status === 'ACTIVE')
    ?? null;

  let reply = null;

  if (worker && worker.conversation_resolved) {
    // ---- checkpoint PLANNING --------------------------------------------
    checkpoint('PLANNING');
    const prompt = buildPlannerPrompt(projectId, workspaceId, req.text);
    logEvent('goal.planning.send', { goal_id: goal.goal_id, worker: worker.worker_id, chars: prompt.length }, projectId);

    // Capture the conversation baselines BEFORE sending: the user-turn baseline is what
    // reconciliation compares against, and the assistant baseline is the reply's index.
    const counts = adapter.countUserTurns(worker.worker_id);

    const ss = sendState.begin(projectId, workspaceId, worker.worker_id, goal.goal_id, {
      userTurnsBefore: counts.user_turns ?? null,
      assistantTurnsBefore: counts.assistant_turns ?? null,
    });
    store.updateGoal(goal.goal_id, { send_state_id: ss.send_state_id, send_state: sendState.STATE.SUBMITTING });

    const started = adapter.startSendToWorker(worker.worker_id, prompt, {
      projectId,
      // The fast window only decides whether this becomes SEND_PENDING. It does not have to
      // prove anything, so it stays short and the round does not sit here waiting.
      resolveTimeoutMs: sendState.FAST_WINDOW_MS,
    });
    if (!started.ok) {
      sendState.transition(ss.send_state_id, sendState.STATE.SEND_UNCERTAIN, `could not start the send: ${started.error}`);
      current.running = false;
      store.updateGoal(goal.goal_id, {
        status: 'BLOCKED',
        send_state: sendState.STATE.SEND_UNCERTAIN,
        error: `could not start the send: ${started.error}`,
      });
      return;
    }

    current.sendId = started.send_id;
    store.updateGoal(goal.goal_id, { send_id: started.send_id, status: 'IN_PROGRESS' });

    // Wait for the child to report. The adapter confirms the user turn itself and returns as soon
    // as the reply is readable, so this is bounded by the turn, not by a DOM vigil.
    const sent = await awaitSend(started.send_id, projectId, sendState.FAST_WINDOW_MS + 150000);
    logEvent('goal.planning.result', {
      goal_id: goal.goal_id,
      send_id: started.send_id,
      ok: sent.ok,
      outcome: sent.outcome ?? null,
      sent_confirmed: sent.sent_confirmed === true,
      rounds_after: sent.rounds_after ?? null,
      ms: sent.elapsed_ms ?? null,
    }, projectId);

    if (sent.ok && sent.outcome === 'ASSISTANT_COMPLETE') {
      sendState.transition(ss.send_state_id, sendState.STATE.USER_TURN_CONFIRMED,
        'adapter confirmed the user turn and the answer completed',
        { round_already_counted: true });
      sendState.transition(ss.send_state_id, sendState.STATE.COMPLETE, 'reply read');
      const read = adapter.readWorkerReply(worker.worker_id, sent.baseline_turns);
      if (read.ok) reply = read.text;
    } else if (sent.sent_confirmed === true) {
      // The user turn is in the conversation even though the round did not complete. Count it if
      // the adapter did not, then move on to waiting for the answer.
      sendState.transition(ss.send_state_id, sendState.STATE.USER_TURN_CONFIRMED,
        `adapter confirmed the user turn (${sent.outcome})`, { round_already_counted: true });
      sendState.transition(ss.send_state_id, sendState.STATE.ASSISTANT_PENDING,
        'packet landed; awaiting the answer');
    } else {
      // NOT a failure. Hand over to background reconciliation, which is the only permitted action.
      // There is deliberately no path from here back to a send call.
      sendState.transition(ss.send_state_id, sendState.STATE.SEND_PENDING,
        `send executed but no user turn observed within the fast window (${sent.outcome ?? 'no outcome'})`);
      // Reconciling is the ONLY permitted action from here. The watcher reads at a deliberately
      // long interval: the adapter's own send is still running against the same single browser, and
      // a fast poll here was measured competing with it (health checks every 8s, send starved).
      sendState.startReconciliation(ss.send_state_id, adapter);
      watchForConfirmation(ss.send_state_id, projectId);
      logEvent('goal.send.pending', {
        goal_id: goal.goal_id, send_state_id: ss.send_state_id, outcome: sent.outcome ?? null,
      }, projectId);

      current.running = false;
      store.updateGoal(goal.goal_id, {
        status: 'SEND_PENDING',
        send_state: sendState.STATE.SEND_PENDING,
        error: null,
        pending_note: 'the send was executed but the ChatGPT client has not shown the new turn yet. '
          + 'Reconciliation is running in the background. NOTHING WILL BE RE-SENT automatically.',
      });
      return;
    }

    if (!reply) {
      // The turn is confirmed; only the read failed. That is a different problem from a failed
      // send and must not be reported as one.
      current.running = false;
      const reason = 'the turn was confirmed in the conversation but its reply could not be read back'
        + (sent.baseline_turns !== null && sent.baseline_turns !== undefined
          ? ` (assistant turn index ${sent.baseline_turns})` : '');
      store.updateGoal(goal.goal_id, {
        status: 'BLOCKED', send_state: sendState.STATE.ASSISTANT_PENDING,
        error: reason,
      });
      logEvent('goal.blocked', { goal_id: goal.goal_id, reason }, projectId);
      return;
    }

    store.updateGoal(goal.goal_id, { planner_reply: reply.slice(0, 20000) });
  } else {
    // No usable worker: report it plainly rather than pretending to plan.
    const reason = worker
      ? `worker ${worker.worker_id} has no resolved conversation (state ${worker.conversation_state})`
      : `no ACTIVE worker in workspace ${workspaceId}`;
    current.running = false;
    store.updateGoal(goal.goal_id, {
      status: 'BLOCKED',
      error: `${reason}. Create and resolve a worker for this workspace first.`,
    });
    logEvent('goal.blocked', { goal_id: goal.goal_id, reason }, projectId);
    return;
  }

  await waitWhilePaused();
  if (current.cancelled) return;

  // ---- checkpoint PARSING_PLAN -------------------------------------------
  checkpoint('PARSING_PLAN');
  const parsed = parsePlan(reply);

  // ---- checkpoint TASKS_CREATED -----------------------------------------
  checkpoint('TASKS_CREATED');
  const created = [];
  if (req.createTasks !== false) {
    for (const t of parsed.tasks) {
      const r = adapter.createTask(projectId, {
        workspaceId,
        title: t.title,
        description: `${t.title}\n\n(From goal ${goal.goal_id}: ${req.text})`,
        type: t.type,
        priority: t.priority,
        successCriteria: t.successCriteria.length ? t.successCriteria : ['Supervisor must define acceptance criteria before this task starts'],
      });
      if (r.ok) {
        created.push({
          task_id: r.task.task_id,
          title: r.task.title,
          type: r.task.type,
          priority: r.task.priority,
          modifies_files: t.modifies_files,
          // NOTE: success_criteria is deliberately NOT stored here. The task registry owns it, and
          // copying it into the workbench state file would create a second copy that can drift -
          // this module's whole claim is that it is a pointer store, not a task database.
          status: r.task.status,
        });
      } else {
        parsed.warnings.push(`could not create task "${t.title}": ${r.error}`);
      }
    }
  }

  store.updateGoal(goal.goal_id, {
    status: 'AWAITING_APPROVAL',
    plan: created,
    plan_warnings: parsed.warnings,
    plan_notes: parsed.notes,
    task_count: created.length,
  });

  // ---- checkpoint AWAITING_APPROVAL -------------------------------------
  // Terminal checkpoint: the run stops here, so the status is preserved rather than reset.
  checkpoint('AWAITING_APPROVAL', 'AWAITING_APPROVAL');
  current.awaitingApproval = true;
  current.running = false;
  logEvent('goal.awaiting_approval', {
    goal_id: goal.goal_id, created: created.map((c) => c.task_id), warnings: parsed.warnings.length,
  }, projectId);
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

function pause(projectId) {
  const r = store.setPaused(projectId, true);
  if (current && current.goal.project_id === projectId) {
    current.paused = true;
    store.updateGoal(current.goal.goal_id, { status: 'PAUSED' });
  }
  logEvent('control.pause', { project_id: projectId, running_job: !!(current && current.running) }, projectId);
  return {
    ok: r.ok,
    paused: true,
    note: 'Pause takes effect between checkpoints. An in-flight ChatGPT turn is allowed to finish; the browser is never killed.',
    running_job: !!(current && current.running),
    current_step: current ? current.step : null,
  };
}

function resume(projectId) {
  const r = store.setPaused(projectId, false);
  let restored = null;
  if (current && current.goal.project_id === projectId) {
    current.paused = false;
    if (current.running) {
      // The job is mid-run and a checkpoint had parked it as PAUSED; put it back to work.
      store.updateGoal(current.goal.goal_id, { status: 'IN_PROGRESS' });
      restored = 'IN_PROGRESS';
    } else {
      // The job is not running. Resuming must NOT invent a status: the stored one is the truth
      // (AWAITING_APPROVAL, SEND_PENDING, BLOCKED, COMPLETE...), and overwriting it with a guess
      // would report a finished or blocked goal as waiting for approval.
      const g = store.getGoal(current.goal.goal_id);
      restored = g?.status ?? null;
    }
  }
  logEvent('control.resume', { project_id: projectId, restored_status: restored }, projectId);
  return { ok: r.ok, paused: false, resumed_from_step: current ? current.step : null, restored_status: restored };
}

function status() { return snapshot(); }

module.exports = {
  submitGoal, pause, resume, status,
  buildPlannerPrompt, parsePlan,
  sendState,
};
