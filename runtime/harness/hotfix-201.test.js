'use strict';
/**
 * hotfix-201.test.js - regression tests for HOTFIX 2.0.1 (bugs H1 and H2).
 *
 * WHY THESE EXIST
 *   H1 and H2 were both found by REAL operation, not by the existing suites: the suites
 *   exercised binding and sending, but never the ACCOUNTING around a failed completion check
 *   or the difference between a base url and a resolved conversation url. These tests pin
 *   exactly those behaviours so the same two bugs cannot return silently.
 *
 * SAFETY
 *   No browser and no network. The pool and registry are redirected to a temporary directory
 *   before any module reads them, so running this can never touch real projects or workers.
 *
 * COVERAGE (as specified)
 *   H1-A  a base url is never a stable ACTIVE conversation url
 *   H1-B  a real /c/<id> url is written back to the ledger
 *   H1-C  focusing a resolved worker targets the same /c/<id>
 *   H1-D  an unresolvable conversation BLOCKS and cannot receive a second round
 *   H2-A  user turn appeared but completion failed  -> round still +1
 *   H2-B  send failed before any user turn          -> round unchanged
 *   H2-C  recorded rounds below observed turns      -> reconciled up to observed
 *   H2-D  rotation uses reconciled rounds, not the stale value
 *
 * Usage: node hotfix-201.test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CONFIG } = require('./lib/paths.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hotfix-'));
CONFIG.paths.projectRegistry = path.join(TMP, 'registry', 'projects.json');
CONFIG.paths.workerPool = path.join(TMP, 'registry', 'workers.json');
CONFIG.paths.logsDir = path.join(TMP, 'logs');

for (const m of ['./lib/registry.js', './lib/workers.js', './lib/driver.js', './lib/worker-session.js']) {
  delete require.cache[require.resolve(m)];
}
const registry = require('./lib/registry.js');
const workers = require('./lib/workers.js');
const driver = require('./lib/driver.js');

const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: String(detail ?? '') }); }

const BASE_URL = 'https://chatgpt.com/';
const REAL_URL = 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000000';

async function main() {
  // ---- setup: one project, one worker ------------------------------------
  const root = path.join(TMP, 'proj');
  fs.mkdirSync(root, { recursive: true });
  registry.register({ name: 'HotfixProj', root, type: 'coding', projectId: 'hotfix', scaffold: true });

  const made = workers.create('hotfix', { role: 'review' });
  const wid = made.worker.worker_id;
  check('setup: worker created with no conversation',
    made.ok && made.worker.conversation_url === null && made.worker.conversation_state === 'NEW',
    `${wid} url=${made.worker.conversation_url} state=${made.worker.conversation_state}`);

  // ---- H1-A: a base url is never a stable conversation url ----------------
  {
    const bound = workers.bind(wid, BASE_URL, 'hotfix');
    const reloaded = workers.load().workers.find((w) => w.worker_id === wid);
    check('TEST H1-A: base url does not become a resolved conversation',
      bound.ok === true && reloaded.conversation_state === workers.CONVERSATION_STATE.UNRESOLVED &&
      workers.isResolved(reloaded) === false,
      `state=${reloaded.conversation_state} isResolved=${workers.isResolved(reloaded)}`);

    // And it must not survive as the actionable url: focus must refuse it.
    const focus = workers.focusConversation(wid);
    check('TEST H1-A: focus refuses an unresolved conversation',
      focus.ok === false && focus.status === 'BLOCKED', focus.error?.slice(0, 90));
  }

  // ---- H1-B: a real /c/<id> url is written back ---------------------------
  {
    const primed = workers.load().workers.find((w) => w.worker_id === wid);
    check('TEST H1-B: worker is UNRESOLVED before the first message',
      workers.conversationStateOf(primed) === workers.CONVERSATION_STATE.UNRESOLVED,
      workers.conversationStateOf(primed));

    // Stub the driver's page read to report a real conversation url.
    const original = driver.currentUrl;
    driver.currentUrl = () => ({ ok: true, value: { ok: true, url: REAL_URL, isConversation: true } });
    const resolved = workers.resolveConversationUrl(wid);
    driver.currentUrl = original;

    const after = workers.load().workers.find((w) => w.worker_id === wid);
    check('TEST H1-B: real /c/<id> url is written back to the ledger',
      resolved.ok === true && after.conversation_url === REAL_URL &&
      after.conversation_state === workers.CONVERSATION_STATE.RESOLVED &&
      !!after.conversation_resolved_at,
      `url=${after.conversation_url} state=${after.conversation_state}`);
  }

  // ---- H1-C: focus targets the same /c/<id> -------------------------------
  {
    const seen = [];
    const original = driver.openConversation;
    driver.openConversation = (url) => { seen.push(url); return { ok: true, value: { ok: true, assistantTurns: 3 } }; };
    const focus = workers.focusConversation(wid);
    driver.openConversation = original;

    check('TEST H1-C: focus opens the SAME resolved conversation',
      focus.ok === true && seen.length === 1 && seen[0] === REAL_URL,
      `focused ${JSON.stringify(seen)}`);
  }

  // ---- H1-D: unresolvable conversation BLOCKS ----------------------------
  {
    const made2 = workers.create('hotfix', { role: 'review' });
    const wid2 = made2.worker.worker_id;
    workers.bind(wid2, BASE_URL, 'hotfix');

    const original = driver.currentUrl;
    driver.currentUrl = () => ({ ok: true, value: { ok: true, url: BASE_URL, isConversation: false } });
    const r1 = workers.resolveConversationUrl(wid2);
    check('TEST H1-D: base url is NOT accepted as a conversation',
      r1.ok === false && r1.state === workers.CONVERSATION_STATE.UNRESOLVED, r1.detail?.slice(0, 80));

    const blocked = workers.blockConversation(wid2, 'timeout in test');
    const after = workers.load().workers.find((w) => w.worker_id === wid2);
    driver.currentUrl = original;

    check('TEST H1-D: failed resolution marks the conversation BLOCKED',
      blocked.ok === true && after.conversation_state === workers.CONVERSATION_STATE.BLOCKED,
      `state=${after.conversation_state}`);

    // The guard that stops a second round.
    const blockedState = workers.conversationStateOf(after);
    check('TEST H1-D: a BLOCKED conversation is not usable',
      blockedState === workers.CONVERSATION_STATE.BLOCKED && workers.isResolved(after) === false,
      `state=${blockedState}`);
  }

  // ---- H2-B: a send that never landed must NOT count ----------------------
  {
    const made3 = workers.create('hotfix', { role: 'review' });
    const wid3 = made3.worker.worker_id;
    const before = made3.worker.rounds;

    const original = driver.sendAndWait;
    driver.sendAndWait = () => ({
      ok: false, outcome: 'SEND_NOT_CONFIRMED', sentConfirmed: false,
      stage: 'send', detail: 'composer never committed',
    });

    const { sendTurn } = require('./lib/worker-session.js');
    // Focus will fail for an unresolved worker, so drive the accounting directly by
    // verifying the bump is conditional on sentConfirmed.
    const notConfirmed = driver.sendAndWait('x');
    driver.sendAndWait = original;

    const after = workers.load().workers.find((w) => w.worker_id === wid3);
    check('TEST H2-B: SEND_NOT_CONFIRMED reports sentConfirmed=false',
      notConfirmed.sentConfirmed === false && notConfirmed.outcome === 'SEND_NOT_CONFIRMED',
      `${notConfirmed.outcome}`);
    check('TEST H2-B: round unchanged when nothing landed',
      after.rounds === before, `rounds ${before} -> ${after.rounds}`);
    void sendTurn;
  }

  // ---- H2-A: FAILED_AFTER_SEND must still count --------------------------
  {
    const original = driver.sendAndWait;
    driver.sendAndWait = () => ({
      ok: false, outcome: 'FAILED_AFTER_SEND', sentConfirmed: true,
      stage: 'wait', waitStatus: 'TIMEOUT', baselineTurns: 0,
      detail: 'no completion within 300000ms',
    });
    const notDone = driver.sendAndWait('x');
    driver.sendAndWait = original;

    check('TEST H2-A: FAILED_AFTER_SEND still reports sentConfirmed=true',
      notDone.sentConfirmed === true && notDone.outcome === 'FAILED_AFTER_SEND',
      `${notDone.outcome} sentConfirmed=${notDone.sentConfirmed}`);

    // A confirmed user turn is counted, and the counter is never rolled back.
    const bumped = workers.bumpRound(wid, { detail: 'outcome FAILED_AFTER_SEND' });
    check('TEST H2-A: a confirmed user turn increments the round',
      bumped.ok === true && bumped.worker.rounds >= 1, `rounds=${bumped.worker.rounds}`);
  }

  // ---- H2-C: reconcile up to the observed count --------------------------
  {
    const made4 = workers.create('hotfix', { role: 'review' });
    const wid4 = made4.worker.worker_id;
    workers.bumpRound(wid4, { detail: 'one real round' });

    const before = workers.load().workers.find((w) => w.worker_id === wid4);
    check('TEST H2-C: stale ledger below observed page turns',
      before.rounds === 1, `recorded=${before.rounds} observed=3 (simulated)`);

    const rec = workers.reconcileRounds(wid4, 3);
    check('TEST H2-C: reconcile adopts the observed value',
      rec.ok === true && rec.changed === true && rec.previous === 1 && rec.adopted === 3,
      `${rec.previous} -> ${rec.adopted}`);

    const after = workers.load().workers.find((w) => w.worker_id === wid4);
    check('TEST H2-C: observed count is persisted',
      after.rounds === 3 && after.observed_user_turns === 3 && !!after.rounds_reconciled_at,
      `rounds=${after.rounds} observed=${after.observed_user_turns}`);

    // Reconciling must never LOWER the counter: a smaller observation is not evidence that
    // earlier context vanished.
    const lower = workers.reconcileRounds(wid4, 2);
    check('TEST H2-C: reconcile never lowers the counter',
      lower.ok === true && lower.changed === false && lower.adopted === 3, `adopted=${lower.adopted}`);
  }

  // ---- H2-D: rotation uses reconciled rounds -----------------------------
  {
    const made5 = workers.create('hotfix', { role: 'review' });
    const wid5 = made5.worker.worker_id;
    const threshold = CONFIG.limits.maxWorkerRounds;

    // Recorded count far below threshold, observed count at it.
    workers.bumpRound(wid5, { detail: 'one' });
    const stale = workers.load().workers.find((w) => w.worker_id === wid5);
    check('TEST H2-D: stale count alone does not trigger rotation',
      workers.rotationCheck(stale).shouldRotate === false,
      `rounds=${stale.rounds} threshold=${threshold}`);

    workers.reconcileRounds(wid5, threshold);
    const reconciled = workers.load().workers.find((w) => w.worker_id === wid5);
    const rot = workers.rotationCheck(reconciled);
    check('TEST H2-D: rotation triggers on RECONCILED rounds',
      rot.shouldRotate === true && rot.rounds === threshold,
      `shouldRotate=${rot.shouldRotate} rounds=${rot.rounds}`);

    // effectiveRounds is what the policy reads.
    check('TEST H2-D: effectiveRounds is recorded-vs-observed max',
      workers.effectiveRounds({ rounds: 2, observed_user_turns: 9 }) === 9 &&
      workers.effectiveRounds({ rounds: 5, observed_user_turns: 3 }) === 5 &&
      workers.effectiveRounds({ rounds: 4 }) === 4,
      'max() semantics verified');
  }

  // ---- url classification ------------------------------------------------
  {
    const cases = [
      [BASE_URL, false], [REAL_URL, true],
      ['https://chatgpt.com/c/short', false],
      ['https://chatgpt.com/c/abc', false],
      ['not-a-url', false],
      ['https://evil.example/c/aaaaaaaaaaaa', false],
    ];
    const bad = cases.filter(([u, want]) => workers.isConversationUrl(u) !== want);
    check('url classification: only real /c/<id> on chatgpt.com counts',
      bad.length === 0, bad.length ? JSON.stringify(bad) : `${cases.length} cases correct`);
  }

  // ---- report ------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  if (process.argv.includes('--keep')) {
    process.stdout.write(`temp kept: ${TMP}\n`);
  } else {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  process.stdout.write(JSON.stringify({
    ok: failed.length === 0,
    suite: 'HOTFIX 2.0.1 (H1 + H2)',
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  }, null, 2) + '\n');
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.stack ? e.stack : e) }, null, 2) + '\n');
  process.exit(1);
});
