'use strict';
/**
 * worker-session.js - the guarded send path for a Worker conversation.
 *
 * WHY THIS MODULE EXISTS (HOTFIX 2.0.1)
 *   Bugs H1 and H2 were not inside `driver` or `workers` individually - they were in the
 *   ORDER and ACCOUNTING of the steps a caller has to perform, which previously lived in an
 *   ad-hoc script outside the harness. Every caller therefore had to remember, unaided:
 *
 *     1. resolve the real /c/<id> url before any later focus (H1)
 *     2. count the round as soon as the user turn is confirmed, even if the completion
 *        check then fails (H2)
 *     3. never roll the counter back, because the conversation has already grown
 *
 *   `sendTurn()` performs those steps in the correct order, so the correct behaviour is the
 *   DEFAULT rather than something each caller must reimplement. It adds no new capability:
 *   it sequences existing driver and worker operations.
 *
 * SCOPE: this is the H1/H2 hotfix only. It does not touch routing, workspaces, task
 * lifecycle, the registry, or the ChatGPT selector layer.
 *
 * ASCII-ONLY source: see the encoding note in config.json.
 */

const workers = require('./workers.js');
const driver = require('./driver.js');

/** Resolution budget after the first message; the id normally appears within seconds. */
const URL_RESOLVE_TIMEOUT_MS = 30000;
const URL_POLL_INTERVAL_MS = 1000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Wait until the browser reports a real conversation url, then settle it on the worker.
 *
 * @returns {Promise<{ok:boolean, state:string, conversation_url?:string, detail?:string}>}
 */
async function resolveConversation(workerId, timeoutMs = URL_RESOLVE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = workers.resolveConversationUrl(workerId);
    if (r.ok) return r;
    last = r;
    await sleep(URL_POLL_INTERVAL_MS);
  }
  workers.blockConversation(workerId,
    `conversation url still unresolved after ${timeoutMs}ms: ${last?.detail ?? 'no detail'}`);
  return {
    ok: false,
    state: workers.CONVERSATION_STATE.BLOCKED,
    detail: `CONVERSATION_URL_UNRESOLVED after ${timeoutMs}ms (${last?.detail ?? 'no detail'}). ` +
            `Refusing to continue: a second round must not run against an unknown conversation.`,
  };
}

/**
 * Send one turn to a worker's conversation and account for it correctly.
 *
 * @param {string} workerId
 * @param {string} text
 * @param {{projectId?:string, resolveTimeoutMs?:number}} [opts]
 * @returns {Promise<object>} a structured, reviewable outcome
 */
async function sendTurn(workerId, text, opts = {}) {
  const worker = workers.load().workers.find((w) => w.worker_id === workerId);
  if (!worker) return { ok: false, outcome: 'NO_SUCH_WORKER', detail: `no such worker: ${workerId}` };
  if (worker.status !== workers.STATUS.ACTIVE) {
    return { ok: false, outcome: 'WORKER_NOT_ACTIVE', detail: `worker ${workerId} is ${worker.status}` };
  }

  const state = workers.conversationStateOf(worker);

  // A BLOCKED conversation must not receive a second round.
  if (state === workers.CONVERSATION_STATE.BLOCKED) {
    return {
      ok: false,
      outcome: 'CONVERSATION_BLOCKED',
      detail: `worker ${workerId} conversation is BLOCKED; resolve it before sending again`,
    };
  }

  // Focus only a RESOLVED conversation. Focusing an unresolved one would navigate to the
  // base url and silently move the message into a different chat (bug H1).
  if (state === workers.CONVERSATION_STATE.RESOLVED) {
    const focus = workers.focusConversation(workerId);
    if (!focus.ok) {
      return { ok: false, outcome: 'FOCUS_FAILED', detail: focus.error ?? focus.detail, state: focus.state };
    }
  } else {
    // NEW or UNRESOLVED: ensure the browser is on a fresh chat for this worker's first turn.
    const opened = workers.openConversation(workerId);
    if (!opened.ok) {
      return { ok: false, outcome: 'OPEN_FAILED', detail: opened.detail ?? opened.error,
               status: opened.status, humanAction: opened.humanAction };
    }
  }

  const projectId = worker.project_id;

  // REGRESSION FIXED 2026-09-20 - THIS `await` IS LOAD-BEARING, DO NOT DROP IT AS SPURIOUS.
  // driver.sendAndWait is synchronous, so an `await` in front of it looks redundant and reads
  // like something a linter would flag. It was omitted when this module was written, which made
  // `sent` a pending promise: `outcome`, `sentConfirmed`, `baselineTurns` and `detail` were all
  // undefined, and H2 round accounting never ran - inside the very module written to guarantee
  // it. (No error was raised, because `undefined.x` is legal JS; every downstream field just
  // came back undefined and the caller reported "SEND_FAILED: no detail".)
  //
  // It went unnoticed because hotfix-201.test.js stubs driver.sendAndWait and then calls it
  // directly, with `void sendTurn` beside it; nothing exercised sendTurn's own body. The silent
  // cost was round drift: the rotation counter would have lagged behind real conversation growth.
  // Re-verified against a stubbed driver (18 checks) and live (rounds 1 -> 2 on a real turn).
  const sent = await driver.sendAndWait(text, { projectId });

  const result = {
    worker_id: workerId,
    project_id: projectId,
    workspace_id: workers.workspaceOf(worker),
    outcome: sent.outcome,
    sent_confirmed: sent.sentConfirmed === true,
    wait_status: sent.waitStatus ?? null,
    baseline_turns: sent.baselineTurns ?? null,
    detail: sent.detail ?? null,
    rounds_before: worker.rounds,
  };

  // ---- H2: a round is a user turn that really appeared --------------------
  // Counted here, before any later step can fail, and never rolled back: the ChatGPT
  // conversation has already grown, so the rotation counter must reflect that.
  if (sent.sentConfirmed === true) {
    const bumped = workers.bumpRound(workerId, { detail: `outcome ${sent.outcome}` });
    result.rounds_after = bumped.worker.rounds;
    result.rotation = bumped.rotation;
  } else {
    result.rounds_after = worker.rounds;
    result.rotation = workers.rotationCheck(worker);
  }

  // ---- H1: settle the real conversation url ------------------------------
  // Only needed while unresolved, and only once a message has actually landed - that is the
  // moment a conversation id comes into existence.
  if (!workers.isResolved(workers.load().workers.find((w) => w.worker_id === workerId))) {
    if (sent.sentConfirmed !== true) {
      result.conversation = {
        ok: false,
        state: workers.conversationStateOf(worker),
        detail: 'no message landed, so no conversation id can exist yet',
      };
      return { ...result, ok: false };
    }
    const resolved = await resolveConversation(workerId, opts.resolveTimeoutMs);
    result.conversation = resolved;
    if (!resolved.ok) {
      // BLOCKED, not a fallback to the base url, and not a guessed conversation.
      return { ...result, ok: false, outcome: 'CONVERSATION_URL_UNRESOLVED' };
    }
    result.conversation_url = resolved.conversation_url;
  } else {
    const w = workers.load().workers.find((x) => x.worker_id === workerId);
    result.conversation = { ok: true, state: workers.CONVERSATION_STATE.RESOLVED,
                            conversation_url: w.conversation_url };
    result.conversation_url = w.conversation_url;
  }

  return { ...result, ok: sent.ok === true };
}

/**
 * Read a completed turn's reply.
 * Kept separate from sendTurn so reading a transcript is never a side effect of sending.
 */
function readTurn(workerId, turnIndex) {
  const worker = workers.load().workers.find((w) => w.worker_id === workerId);
  if (!worker) return { ok: false, error: `no such worker: ${workerId}` };
  if (!workers.isResolved(worker)) {
    return { ok: false, error: `worker ${workerId} has no resolved conversation` };
  }
  const r = driver.readReply(turnIndex, { projectId: worker.project_id });
  if (!r.ok || !r.value?.ok) {
    return { ok: false, error: r.value?.detail ?? r.error ?? 'read failed' };
  }
  return { ok: true, text: r.value.text, index: turnIndex };
}

/**
 * Reconcile a worker's round counter against an OBSERVED user-turn count.
 *
 * The observation is supplied by the caller because reading the page requires the worker
 * adapter's page-probe layer, which this harness deliberately does not import - the adapter
 * is a protected component driven through its CLI surface, not a library to reach into.
 *
 * The moments worth checking are: cold resume, immediately before a rotation decision, and
 * after any anomalous send. A normal successful round needs no scan.
 */
function reconcileWith(workerId, observedUserTurns) {
  return workers.reconcileRounds(workerId, observedUserTurns);
}

module.exports = {
  sendTurn,
  readTurn,
  resolveConversation,
  reconcileWith,
  URL_RESOLVE_TIMEOUT_MS,
};
