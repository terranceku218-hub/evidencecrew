'use strict';
/**
 * worker-runner.js - sends one turn and reports JSON, in its OWN process.
 *
 * WHY THIS IS A SEPARATE PROCESS
 *   The harness's send path is synchronous: driver.sendAndWait() calls spawnSync, which blocks
 *   the event loop for the whole duration of a ChatGPT turn - minutes. Running that inline in the
 *   server meant the API stopped answering while a turn was in flight, so the UI could not learn
 *   that the work was progressing. Observed directly: an /api/job request went unanswered for
 *   over 8 seconds mid-turn. Pause was unusable, because a pause request could not be received,
 *   and the page could not tell "still working" from "server died".
 *
 *   The blocker is inside a frozen component, so the fix belongs here: isolate it in a child
 *   process. The child blocks; the server does not. Same code path, same contract, different
 *   process boundary.
 *
 * CONTRACT
 *   stdout is exactly one JSON object and nothing else. Progress logging goes to stderr, which
 *   the parent relays to its own stderr so nothing is swallowed.
 *
 * STDOUT DISCIPLINE
 *   The harness, the worker adapter and the CLI all print to stdout. Every one of those is
 *   redirected to stderr here, because a single stray line on stdout would make the parent's
 *   JSON.parse fail and turn a successful send into a mystery failure.
 *
 * USAGE
 *   node worker-runner.js <workerId> <packetFile> <baselineTurns> <resolveTimeoutMs>
 *
 * ASCII-ONLY source.
 */

const path = require('node:path');
const fs = require('node:fs');

const HARNESS = path.resolve(__dirname, '..', '..', 'runtime', 'harness');
const LIB = path.join(HARNESS, 'lib');

/**
 * Sleep without spinning.
 *
 * Atomics.wait on a throwaway buffer is used rather than a promise, because this file is
 * deliberately synchronous end to end: main() is called once, at top level, and the process is
 * short-lived. Keeping it sync means a crash is always reported through the single out() path
 * instead of escaping as an unhandled rejection after the process has already printed nothing.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

// Keep stdout clean. console.log is rerouted to stderr so that anything logged underneath -
// by the harness, the adapter or this file - cannot join the JSON result and turn a successful
// send into a parse failure in the parent. process.stdout.write itself is left alone, because
// out() uses it and it is called exactly once.
console.log = (...a) => process.stderr.write(`[runner] ${a.join(' ')}\n`);
console.info = console.log;
console.warn = console.log;
console.error = (...a) => process.stderr.write(`[runner] ${a.join(' ')}\n`);

// Must be async: this function awaits driver.sendAndWait below. Without the keyword the file does not
// PARSE, and harness-adapter.js spawns it as a child process and reads its JSON - which is why the goal
// pipeline reported "RUNNER_UNPARSED: the send process produced no JSON". Backported from the public
// release, where the same two-word fix was applied.
async function main() {
  const [workerId, packetFile, baselineArg, resolveArg] = process.argv.slice(2);
  if (!workerId || !packetFile) out({ ok: false, outcome: 'BAD_ARGS', detail: 'usage: worker-runner.js <workerId> <packetFile> [baselineTurns] [resolveTimeoutMs]' });
  if (!fs.existsSync(packetFile)) out({ ok: false, outcome: 'PACKET_MISSING', detail: `no such packet file: ${packetFile}` });

  const text = fs.readFileSync(packetFile, 'utf8');
  if (!text.trim()) out({ ok: false, outcome: 'PACKET_EMPTY', detail: 'the packet file is empty' });

  const baseline = Number.isFinite(Number(baselineArg)) && baselineArg !== undefined && baselineArg !== ''
    ? Number(baselineArg)
    : null;
  const resolveTimeoutMs = Number.isFinite(Number(resolveArg)) && resolveArg ? Number(resolveArg) : undefined;

  const workers = require(path.join(LIB, 'workers.js'));
  const driver = require(path.join(LIB, 'driver.js'));

  const worker = workers.load().workers.find((w) => w.worker_id === workerId);
  if (!worker) out({ ok: false, outcome: 'NO_SUCH_WORKER', detail: `no such worker: ${workerId}` });
  if (worker.status !== 'ACTIVE') out({ ok: false, outcome: 'WORKER_NOT_ACTIVE', detail: `worker ${workerId} is ${worker.status}` });

  const state = workers.conversationStateOf(worker);
  if (state === workers.CONVERSATION_STATE.BLOCKED) {
    out({ ok: false, outcome: 'CONVERSATION_BLOCKED', detail: `worker ${workerId} conversation is BLOCKED; resolve it before sending again` });
  }

  // Focus only a RESOLVED conversation. Focusing an unresolved one would navigate to the base
  // url and silently move the message into a different chat (bug H1).
  if (state === workers.CONVERSATION_STATE.RESOLVED) {
    process.stderr.write(`[runner] focusing ${worker.conversation_url}\n`);
    const focus = workers.focusConversation(workerId);
    if (!focus.ok) {
      out({ ok: false, outcome: 'FOCUS_FAILED', detail: focus.error ?? focus.detail, state: focus.state });
    }
  } else {
    process.stderr.write('[runner] opening a fresh conversation\n');
    const opened = workers.openConversation(workerId);
    if (!opened.ok) {
      out({ ok: false, outcome: 'OPEN_FAILED', detail: opened.detail ?? opened.error, status: opened.status, humanAction: opened.humanAction });
    }
  }

  process.stderr.write('[runner] sending\n');
  const sent = await driver.sendAndWait(text, {
    projectId: worker.project_id,
    ...(baseline !== null ? { baselineTurns: baseline } : {}),
  });
  process.stderr.write(`[runner] send result: outcome=${sent.outcome} sentConfirmed=${sent.sentConfirmed} baseline=${sent.baselineTurns}\n`);

  const result = {
    worker_id: workerId,
    project_id: worker.project_id,
    workspace_id: workers.workspaceOf(worker),
    outcome: sent.outcome ?? null,
    sent_confirmed: sent.sentConfirmed === true,
    wait_status: sent.waitStatus ?? null,
    baseline_turns: sent.baselineTurns ?? null,
    detail: sent.detail ?? null,
    stage: sent.stage ?? null,
    rounds_before: worker.rounds,
  };

  // ---- H2: a round is a user turn that really appeared --------------------
  // Counted before any later step can fail, and never rolled back: the conversation has already
  // grown, so the rotation counter must reflect that.
  if (sent.sentConfirmed === true) {
    const bumped = workers.bumpRound(workerId, { detail: `outcome ${sent.outcome}` });
    result.rounds_after = bumped.worker.rounds;
    result.rotation = bumped.rotation;
  } else {
    result.rounds_after = worker.rounds;
    result.rotation = workers.rotationCheck(worker);
  }

  // ---- H1: settle the real conversation url ------------------------------
  if (!workers.isResolved(workers.load().workers.find((w) => w.worker_id === workerId))) {
    if (sent.sentConfirmed !== true) {
      result.conversation = { ok: false, state: workers.conversationStateOf(worker), detail: 'no message landed, so no conversation id can exist yet' };
      out({ ...result, ok: false });
    }
    // Poll for the real /c/<id> without blocking the parent: this process is allowed to sleep.
    const deadline = Date.now() + (resolveTimeoutMs ?? 30000);
    let last = null;
    while (Date.now() < deadline) {
      const r = workers.resolveConversationUrl(workerId);
      if (r.ok) { result.conversation = r; result.conversation_url = r.conversation_url; break; }
      last = r;
      sleepSync(1000);
    }
    if (!result.conversation?.ok) {
      workers.blockConversation(workerId, `conversation url still unresolved after ${resolveTimeoutMs ?? 30000}ms: ${last?.detail ?? 'no detail'}`);
      result.conversation = { ok: false, state: 'BLOCKED', detail: 'CONVERSATION_URL_UNRESOLVED' };
      out({ ...result, ok: false, outcome: 'CONVERSATION_URL_UNRESOLVED' });
    }
  } else {
    const w = workers.load().workers.find((x) => x.worker_id === workerId);
    result.conversation = { ok: true, state: workers.CONVERSATION_STATE.RESOLVED, conversation_url: w.conversation_url };
    result.conversation_url = w.conversation_url;
  }

  out({ ...result, ok: sent.ok === true });
}

// A rejected promise is not a synchronous throw, so the try/catch that used to wrap main() could never
// have caught anything. Attach the handler to the promise instead. Same fix as the public release.
main().catch((e) => {
  out({ ok: false, outcome: 'RUNNER_CRASHED', detail: String(e && e.stack ? e.stack : e).slice(0, 2000) });
});
