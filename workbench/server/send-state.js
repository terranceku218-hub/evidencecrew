'use strict';
/**
 * send-state.js - the lifecycle of one send, with SEND_PENDING as a FIRST-CLASS state.
 *
 * THE FAILURE THIS REPLACES
 *   send_packet() had two outcomes: confirmed, or SEND_NOT_CONFIRMED. That forced a binary on a
 *   genuinely three-valued situation. Measured on a real conversation, the ChatGPT web client
 *   renders new turns very late - a 29-character packet was invisible in the DOM for the entire
 *   wait window and plainly present afterwards, with its reply. So "not confirmed yet" was being
 *   reported as "failed", and a caller that believed it would send the packet AGAIN. Two such
 *   duplicates were observed in a real conversation.
 *
 * THE STATES
 *   SUBMITTING            the composer is being filled and the send control clicked.
 *   SEND_PENDING          the click went out; no user turn observed yet. NOT success, NOT failure.
 *   USER_TURN_CONFIRMED   a new user turn is really in the conversation. The round is counted here.
 *   ASSISTANT_PENDING     the packet landed; the answer is still being generated.
 *   COMPLETE              the reply has been read back.
 *   SEND_UNCERTAIN        no verifiable evidence within the budget. Automatic processing STOPS and
 *                         the decision goes to the user.
 *
 * THE ONE RULE THAT MATTERS MOST
 *   SEND_PENDING never triggers another send. There is no code path from SEND_PENDING back to a
 *   send call - only to a reconciliation read. A retry while pending is the single way to post a
 *   duplicate message, so the prohibition is structural rather than a convention.
 *
 * WHY RECONCILIATION BRANCHES ON roundAlreadyCounted
 *   The adapter counts the round itself whenever it observes the user turn, whether or not it
 *   managed to return success. A workbench-side reconciliation would therefore double-count a
 *   turn the adapter already recorded. The guard makes the workbench count only what nobody
 *   counted; if in doubt it does NOT count, because over-counting rotates a worker early while
 *   under-counting is corrected by the harness's own reconcile.
 *
 * ASCII-ONLY source.
 */

const fs = require('node:fs');
const path = require('node:path');

const store = require('./store.js');

const STATE = {
  SUBMITTING: 'SUBMITTING',
  SEND_PENDING: 'SEND_PENDING',
  USER_TURN_CONFIRMED: 'USER_TURN_CONFIRMED',
  ASSISTANT_PENDING: 'ASSISTANT_PENDING',
  COMPLETE: 'COMPLETE',
  SEND_UNCERTAIN: 'SEND_UNCERTAIN',
};

/** Terminal states: nothing further happens automatically. */
const TERMINAL = [STATE.COMPLETE, STATE.SEND_UNCERTAIN];

/**
 * How long the FAST path waits for a user turn before handing over to background reconciliation.
 *
 * This is the whole point of the split: a round must not sit in an HTTP request or a UI overlay
 * for minutes. Past this window the answer is not "failed" - it is "pending".
 */
const FAST_WINDOW_MS = 12000;

/** How long reconciliation keeps looking before declaring SEND_UNCERTAIN. */
const RECONCILE_BUDGET_MS = 15 * 60 * 1000;

/**
 * How often reconciliation reads the conversation.
 *
 * Deliberately slow. Each read drives the single shared browser through the worker CLI, and the
 * adapter's own send is usually still running against that same browser - a 3s interval was
 * measured starving it (health checks firing every 8s while a send was in flight). Reconciliation
 * is a background safety net, not a hot loop, so it is tuned to be cheap rather than prompt.
 */
const RECONCILE_INTERVAL_MS = 20000;

/** In-process registry of live reconciliations. Volatile; the store holds the durable view. */
const active = new Map();

let logEvent = () => {};
function setLogger(fn) { logEvent = fn; }

// ---------------------------------------------------------------------------
// creation
// ---------------------------------------------------------------------------

/**
 * Create a send record in SUBMITTING.
 *
 * @returns {{send_state_id:string, state:string}}
 */
function begin(projectId, workspaceId, workerId, goalId, opts = {}) {
  const id = `SS-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const record = {
    send_state_id: id,
    project_id: projectId,
    workspace_id: workspaceId ?? null,
    worker_id: workerId,
    goal_id: goalId ?? null,
    task_id: opts.taskId ?? null,
    state: STATE.SUBMITTING,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    // Baselines captured BEFORE the send. userTurnsBefore is what reconciliation compares against;
    // assistantTurnsBefore is the index the reply will be read at.
    user_turns_before: opts.userTurnsBefore ?? null,
    assistant_turns_before: opts.assistantTurnsBefore ?? null,
    fast_window_ms: FAST_WINDOW_MS,
    reconcile_budget_ms: RECONCILE_BUDGET_MS,
    round_already_counted: opts.roundAlreadyCounted === true,
    round_counted_by_workbench: false,
    retries_attempted: 0,
    history: [{ at: new Date().toISOString(), from: null, to: STATE.SUBMITTING, detail: 'send submitted' }],
    evidence: [],
  };
  store.upsertSendState(record);
  return record;
}

/** Move a send record to a new state, recording why. */
function transition(sendStateId, to, detail, patch = {}) {
  const s = store.getSendState(sendStateId);
  if (!s) return { ok: false, error: `no such send state: ${sendStateId}` };
  if (s.state === to) return { ok: true, record: s, unchanged: true };

  const from = s.state;
  const next = {
    ...s,
    ...patch,
    state: to,
    updated_at: new Date().toISOString(),
  };
  next.history = [...(s.history ?? []), { at: next.updated_at, from, to, detail: detail ?? null }];
  store.upsertSendState(next);
  logEvent('send.state', { send_state_id: sendStateId, from, to, detail: detail ?? null }, s.project_id);
  return { ok: true, record: next };
}

function get(sendStateId) {
  const s = store.getSendState(sendStateId);
  if (!s) return null;
  const live = active.get(sendStateId);
  return { ...s, reconciliation_live: !!live, no_auto_retry: true };
}

function listForProject(projectId, limit = 20) {
  return store.listSendStates(projectId, limit);
}

// ---------------------------------------------------------------------------
// reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconcile one send that is in SEND_PENDING.
 *
 * ONE STEP PER CALL, never a loop, never a send. It reads the conversation and decides:
 *   - a new user turn exists                  -> USER_TURN_CONFIRMED (count the round if nobody did)
 *   - no new user turn, budget still open     -> stays SEND_PENDING
 *   - no new user turn, budget exhausted      -> SEND_UNCERTAIN, and stop
 *
 * @param {object} adapter the harness adapter (injected to keep this module testable)
 */
async function reconcileOnce(sendStateId, adapter) {
  const s = store.getSendState(sendStateId);
  if (!s) return { ok: false, error: `no such send state: ${sendStateId}` };
  if (TERMINAL.includes(s.state)) return { ok: true, record: s, terminal: true };

  const counts = await adapter.countUserTurnsAsync(s.worker_id);
  const evidence = {
    at: new Date().toISOString(),
    user_turns: counts.user_turns ?? counts.count ?? null,
    assistant_turns: counts.assistant_turns ?? null,
    ok: counts.ok === true,
    error: counts.error ?? null,
  };

  const before = s.user_turns_before;
  const observed = evidence.user_turns;
  const grew = evidence.ok && before !== null && observed !== null && observed > before;

  const patch = { evidence: [...(s.evidence ?? []), evidence].slice(-40) };

  if (grew) {
    // The packet landed. Count the round exactly once, and only if the adapter did not.
    let roundResult = { counted: false, reason: s.round_already_counted ? 'adapter already counted it' : 'unknown' };
    if (!s.round_already_counted && !s.round_counted_by_workbench) {
      const bumped = adapter.bumpWorkerRound(s.worker_id, `round confirmed by reconciliation (user turns ${before} -> ${observed})`);
      roundResult = bumped.ok
        ? { counted: true, rounds: bumped.rounds }
        : { counted: false, reason: bumped.error };
    }
    return transition(sendStateId, STATE.USER_TURN_CONFIRMED,
      `user turn observed (${before} -> ${observed})`,
      { ...patch, user_turns_after: observed, round_counted_by_workbench: roundResult.counted, round_result: roundResult });
  }

  // Not yet. Is the budget still open?
  const age = Date.now() - Date.parse(s.created_at);
  if (age > (s.reconcile_budget_ms ?? RECONCILE_BUDGET_MS)) {
    return transition(sendStateId, STATE.SEND_UNCERTAIN,
      `no verifiable evidence after ${Math.round(age / 1000)}s; automatic processing stopped`,
      { ...patch, stopped_at: new Date().toISOString() });
  }

  // Still pending. Record the reading, change no state.
  const next = { ...s, ...patch, updated_at: new Date().toISOString() };
  store.upsertSendState(next);
  return { ok: true, record: next, still: STATE.SEND_PENDING };
}

/**
 * Start background reconciliation for a SEND_PENDING send.
 *
 * The loop is async and never touches an HTTP request, so the workbench keeps answering while the
 * ChatGPT client takes its time. It stops at the first terminal state.
 */
function startReconciliation(sendStateId, adapter, opts = {}) {
  if (active.has(sendStateId)) return { ok: true, already_running: true };
  const intervalMs = opts.intervalMs ?? RECONCILE_INTERVAL_MS;

  const timer = setInterval(async () => {
    try {
      const r = await reconcileOnce(sendStateId, adapter);
      const state = r.record?.state;
      if (TERMINAL.includes(state)) {
        clearInterval(timer);
        active.delete(sendStateId);
        logEvent('send.reconcile.finished', { send_state_id: sendStateId, state }, r.record?.project_id);
      }
    } catch (e) {
      // A reconciliation error must not stop reconciliation: it is a read, and reads fail.
      logEvent('send.reconcile.error', { send_state_id: sendStateId, error: String(e && e.message ? e.message : e) });
    }
  }, intervalMs);

  if (timer.unref) timer.unref();
  active.set(sendStateId, { timer, started_at: new Date().toISOString(), intervalMs });
  logEvent('send.reconcile.started', { send_state_id: sendStateId, interval_ms: intervalMs });
  return { ok: true, started: true, interval_ms: intervalMs };
}

function stopReconciliation(sendStateId) {
  const live = active.get(sendStateId);
  if (!live) return { ok: true, was_running: false };
  clearInterval(live.timer);
  active.delete(sendStateId);
  return { ok: true, was_running: true };
}

function liveReconciliations() {
  return [...active.entries()].map(([id, v]) => ({ send_state_id: id, started_at: v.started_at, interval_ms: v.interval_ms }));
}

/**
 * The refusal that keeps duplicates impossible.
 *
 * Any caller asking to resend a packet that is pending or uncertain gets this, not a send.
 */
function refuseRetry(sendStateId) {
  const s = store.getSendState(sendStateId);
  if (!s) return { refused: false, error: `no such send state: ${sendStateId}` };
  const blocking = [STATE.SUBMITTING, STATE.SEND_PENDING, STATE.ASSISTANT_PENDING, STATE.SEND_UNCERTAIN];
  if (!blocking.includes(s.state)) return { refused: false, state: s.state };
  return {
    refused: true,
    state: s.state,
    reason: `a packet for this send is already ${s.state}; sending again would post a SECOND message `
      + `into the same conversation. Reconciliation is the only permitted action; `
      + (s.state === STATE.SEND_UNCERTAIN
        ? 'the decision to send anything further belongs to the user.'
        : 'wait for evidence or for the budget to expire.'),
  };
}

module.exports = {
  STATE, TERMINAL, FAST_WINDOW_MS, RECONCILE_BUDGET_MS, RECONCILE_INTERVAL_MS,
  begin, transition, get, listForProject,
  reconcileOnce, startReconciliation, stopReconciliation, liveReconciliations,
  refuseRetry, setLogger,
};
