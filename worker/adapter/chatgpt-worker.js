'use strict';
/**
 * chatgpt-worker.js - the ChatGPT Web Worker adapter.
 *
 * Implements the atomic capabilities the DeepSeek Supervisor calls:
 *   health_check()        openWorker()          closeWorker()
 *   open_conversation()   new_conversation()    getConversationUrl()
 *   send_packet()         wait_complete()       read_reply()
 *   plus Phase 5/6 ledger and rotation helpers in ledger.js.
 *
 * HOW PAGE CODE IS BUILT
 *   Every DOM interaction goes through `compose(args, inner)` from lib.js, which emits
 *   a function whose INNER body is serialized and re-evaluated in the browser. Two
 *   consequences the code is written around:
 *     - `document`/`window` exist only inside the inner function.
 *     - Nothing from Node may be closed over; all data arrives via `args`.
 *   `selftest.js` pins both rules against the live page.
 *
 * WHY TURN ACCOUNTING EXISTS
 *   send_packet() records how many assistant turns existed BEFORE it sent, and
 *   read_reply() reads the turn at that index. Reading "the last assistant message"
 *   would silently return a PREVIOUS round's answer whenever a send failed or a retry
 *   was appended to the same conversation - the most dangerous failure mode in a review
 *   loop, because it looks like a valid, complete answer.
 *
 * ENCODING: comments here are ASCII-only (see lib.js). The Chinese strings below are
 * deliberate, user-facing handoff text that must be shown verbatim to the operator, and
 * they are written only through UTF-8-safe tooling.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  CONFIG, SELECTORS, TAG_GROUPS, RESOLVE_SRC, compose,
  cli, runCode, log, nowIso,
} = require('./lib.js');
const { STATE, detectState, requiresHuman, isBlocking } = require('./state.js');

/** Resolver source plus the tag groups pulled from `args`, for every composed body. */
const RESOLVE = `
  ${RESOLVE_SRC}
  const tagGroups = args.tagGroups;
`;

/** Locates the visible composer via the registry. No selector appears here. */
const FIND_COMPOSER = `
  const composerEls = resolve(args.inputCandidates, document, tagGroups);
  const composer = (() => {
    const vis = composerEls.filter(__CW.isVisible);
    return vis.length ? vis[vis.length - 1] : null;
  })();
  const composerText = (el) => !el ? '' : (el.tagName === 'TEXTAREA' ? el.value : (el.innerText || ''));
`;

// ---------------------------------------------------------------------------
// browser lifecycle
// ---------------------------------------------------------------------------

function listSessions() {
  return cli(['list', '--json']);
}

/**
 * Ensure a browser session exists on chatgpt.com.
 *
 * `open` is effectively idempotent: with a daemon already running the CLI reports that
 * and the adapter re-verifies state. Only with no session does a real Chrome window
 * launch. `--idle-timeout=0` keeps it alive across a human handoff.
 */
function openWorker(headed = CONFIG.worker.headed) {
  const args = [
    `-s=${CONFIG.worker.sessionName}`,
    'open', CONFIG.worker.baseUrl,
    `--browser=${CONFIG.worker.browserChannel}`,
    '--persistent',
    `--profile=${CONFIG.paths.profileDir}`,
    '--idle-timeout=0',
  ];
  if (headed) args.push('--headed');

  log('open_worker.begin', { headed, profile: CONFIG.paths.profileDir });
  const r = cli(args, { timeoutMs: 240000 });
  if (!r.ok) {
    log('open_worker.fail', { error: r.error });
    return { ok: false, launched: false, error: r.error };
  }
  log('open_worker.done', { raw: String(r.raw).slice(0, 300) });
  return { ok: true, launched: true };
}

/** Close the automation connection WITHOUT deleting the persistent profile. */
function closeWorker() {
  const r = cli([`-s=${CONFIG.worker.sessionName}`, 'close', '--json']);
  log('close_worker', { ok: r.ok });
  return { ok: r.ok, error: r.error };
}

/** Current page URL and whether it is a conversation. */
function getConversationUrl() {
  const r = runCode(compose({}, `
    return { url: __CW.url(), isConversation: __CW.isConversationUrl(), title: document.title };
  `));
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, ...(r.value ?? {}) };
}

// ---------------------------------------------------------------------------
// capability 1 - health_check
// ---------------------------------------------------------------------------

/**
 * Verify the worker is usable: browser reachable, signed in, composer present, no
 * captcha/blocking state, and the composer actually focusable.
 *
 * @returns {Promise<{status:'READY'|'BLOCKED'|'ERROR', state?:string, detail:string, url?:string}>}
 */
async function health_check() {
  log('health_check.begin', {});

  const sessions = listSessions();
  if (!sessions.ok) {
    return { status: 'ERROR', detail: `cannot enumerate browser sessions: ${sessions.error}` };
  }

  const state = await detectState();
  if (state.state === STATE.ERROR) {
    return { status: 'ERROR', state: state.state, detail: state.detail ?? 'probe failed', url: state.url };
  }
  if (requiresHuman(state.state)) {
    return {
      status: 'BLOCKED', state: state.state, url: state.url,
      detail: `${state.detail} - HUMAN ACTION REQUIRED`,
      humanAction: humanInstruction(state.state),
    };
  }
  if (isBlocking(state.state)) {
    return { status: 'BLOCKED', state: state.state, url: state.url, detail: state.detail ?? 'blocked' };
  }

  // A visible composer is not proof the composer WORKS. Probe focusability.
  const probe = runCode(compose({ inputCandidates: SELECTORS.input.candidates }, `
    ${RESOLVE}
    ${FIND_COMPOSER}
    if (!composer) return { fillable: false, reason: 'no visible composer matching any registry candidate' };
    try {
      composer.focus();
      const focused = document.activeElement === composer || composer.contains(document.activeElement);
      return { fillable: true, focused, hadContent: composerText(composer).length > 0,
               tag: composer.tagName, editable: composer.getAttribute('contenteditable') === 'true' };
    } catch (e) { return { fillable: false, reason: String(e) }; }
  `));

  if (!probe.ok) return { status: 'ERROR', detail: `composer probe failed: ${probe.error}` };
  if (!probe.value?.fillable) {
    return { status: 'BLOCKED', state: STATE.COMPOSER_MISSING, url: state.url,
             detail: `composer not usable: ${probe.value?.reason ?? 'unknown'}` };
  }

  log('health_check.ready', { url: state.url });
  return { status: 'READY', state: state.state, url: state.url,
           detail: 'browser reachable, signed in, composer usable',
           composer: probe.value };
}

/** Human-readable handoff text per blocking state. Shown verbatim to the operator. */
function humanInstruction(state) {
  if (state === STATE.LOGIN_REQUIRED) {
    return '请在弹出的 Chrome 窗口中完成 ChatGPT 登录（含 2FA / 安全确认）。完成后告诉我继续。适配器不会代填任何凭据。';
  }
  if (state === STATE.CAPTCHA) {
    return '页面出现人机验证 / 安全检查。请在浏览器窗口中人工完成后告诉我继续。适配器不会尝试绕过验证。';
  }
  return '需要人工处理该页面状态。';
}

// ---------------------------------------------------------------------------
// turn counting
// ---------------------------------------------------------------------------

/** Count rendered turns of a given author. Used for turn accounting. */
function countTurns(author) {
  const cands = author === 'user'
    ? SELECTORS.messages.userTurn.candidates
    : SELECTORS.messages.assistantTurn.candidates;
  const r = runCode(compose({ cands }, `
    ${RESOLVE}
    const els = resolve(args.cands, document, tagGroups);
    return { count: els.length, visible: els.filter(__CW.isVisible).length };
  `));
  if (!r.ok) return { ok: false, error: r.error, count: -1 };
  return { ok: true, count: r.value?.count ?? 0, visible: r.value?.visible ?? 0 };
}

function countAssistantTurns() { return countTurns('assistant'); }
function countUserTurns() { return countTurns('user'); }

/**
 * TEST SEAM for the turn-counting regression tests.
 *
 * WHY THIS EXISTS
 *   `countTurns(author)` calls the leaf functions above DIRECTLY. Replacing them on the module
 *   exports therefore has no effect on it, so a test that monkey-patched `exports.countUserTurns`
 *   would silently keep calling the real browser and appear to pass for the wrong reason. That
 *   exact class of mistake - a stub that is not actually in the code path - is how the original
 *   await regression in the harness survived its test suite, so it is not repeated here.
 *
 *   The seam is explicit and empty in production: `__testOverrides` is null, these are one
 *   comparison each, and nothing outside a test ever sets it. It is deliberately NOT a general
 *   dependency-injection refactor.
 */
let __testOverrides = null;

/** Test-only. Pass {userFn, assistantFn} to fake the counters, or null to restore. */
function __setTestCountOverrides(overrides) { __testOverrides = overrides; }

function countAssistantTurns() {
  if (__testOverrides && typeof __testOverrides.assistantFn === 'function') return __testOverrides.assistantFn();
  return countTurns('assistant');
}
function countUserTurns() {
  if (__testOverrides && typeof __testOverrides.userFn === 'function') return __testOverrides.userFn();
  return countTurns('user');
}

/**
 * Read the turn baseline, and do not accept it until it stops moving.
 *
 * WHY THIS IS NOT A SINGLE READ (measured, not theoretical)
 *   A single `countAssistantTurns()` immediately after navigation was observed returning 3 for a
 *   conversation that then held only 2 assistant turns. The consequence is not cosmetic: that
 *   number is BOTH the send-confirmation baseline AND the index `read_reply()` reads at, so a
 *   baseline that is one too high makes the reply unreadable - "assistant turn index 3 out of
 *   range (page has 3)" - even though the answer is sitting right there in the page.
 *
 *   A conversation that is still hydrating, or React mid-reconcile, can briefly report more turns
 *   than it settles on. Reading twice and requiring agreement is a cheap way to refuse a number
 *   that is still in motion, and it costs one extra page round-trip (~0.4s).
 *
 * If the counts never agree within the sampling budget, the LAST reading is returned with
 * `settled: false` rather than failing the send: a send is still worth attempting, and the flag
 * records that the index may need the caller's tolerance.
 *
 * @returns {Promise<{ok:boolean, assistant:number, user:number, settled:boolean, samples:number, error?:string}>}
 */
async function settledTurnBaseline(maxSamples = 4, gapMs = 400) {
  let prevAssistant = null;
  let prevUser = null;
  let samples = 0;
  let lastError = null;

  for (let i = 0; i < maxSamples; i += 1) {
    const a = countAssistantTurns();
    const u = countUserTurns();
    samples += 1;
    if (!a.ok || !u.ok) {
      lastError = a.error || u.error || 'count failed';
      await sleep(gapMs);
      continue;
    }
    if (prevAssistant !== null && a.count === prevAssistant && u.count === prevUser) {
      return { ok: true, assistant: a.count, user: u.count, settled: true, samples };
    }
    prevAssistant = a.count;
    prevUser = u.count;
    await sleep(gapMs);
  }

  if (prevAssistant === null) {
    return { ok: false, assistant: -1, user: -1, settled: false, samples, error: lastError ?? 'counts unavailable' };
  }
  return { ok: true, assistant: prevAssistant, user: prevUser, settled: false, samples };
}

// ---------------------------------------------------------------------------
// capability 2 / 3 - conversations
// ---------------------------------------------------------------------------

/** Create a fresh conversation; returns the URL for the ledger. */
async function new_conversation() {
  const health = await health_check();
  if (health.status !== 'READY') return { ok: false, ...health };

  // Prefer the real UI affordance; fall back to the base URL, which serves a new chat
  // for a signed-in user. Either way the outcome is VERIFIED, not assumed.
  const clicked = runCode(compose({ newChatCandidates: SELECTORS.newChat.candidates }, `
    ${RESOLVE}
    const els = resolve(args.newChatCandidates, document, tagGroups).filter(__CW.isVisible);
    if (!els.length) return { clicked: false };
    els[0].click();
    return { clicked: true };
  `));

  if (!clicked.ok || !clicked.value?.clicked) {
    const nav = cli([`-s=${CONFIG.worker.sessionName}`, 'goto', CONFIG.worker.baseUrl, '--json']);
    if (!nav.ok) return { ok: false, error: `new chat navigation failed: ${nav.error}` };
  }

  await sleep(1800);
  const url = getConversationUrl();
  if (!url.ok) return { ok: false, error: url.error };

  const state = await detectState();
  if (isBlocking(state.state)) {
    return { ok: false, status: 'BLOCKED', state: state.state, detail: state.detail,
             humanAction: requiresHuman(state.state) ? humanInstruction(state.state) : undefined };
  }
  log('new_conversation', { url: url.url });
  return { ok: true, url: url.url, isConversation: url.isConversation,
           note: url.isConversation
             ? 'url already carries a conversation id'
             : 'fresh chat; the conversation id is assigned on the first message' };
}

/**
 * Open a previously recorded conversation.
 * The URL is validated before navigating, so a bad ledger entry cannot silently drop
 * the worker onto an arbitrary page.
 */
async function open_conversation(url) {
  if (typeof url !== 'string' || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(url)) {
    return { ok: false, status: 'BLOCKED', detail: `refusing to open non-ChatGPT url: ${String(url).slice(0, 120)}` };
  }
  const nav = cli([`-s=${CONFIG.worker.sessionName}`, 'goto', url, '--json'], { timeoutMs: 180000 });
  if (!nav.ok) return { ok: false, status: 'ERROR', detail: `navigation failed: ${nav.error}` };

  // A conversation page hydrates its composer well after the navigation resolves. A
  // fixed sleep proved unreliable on a cold start after the browser was restarted: the
  // probe ran early, found no composer, and reported COMPOSER_MISSING for a page that
  // was in fact fine. Poll for readiness instead of guessing at a constant.
  const ready = await waitForComposer(CONFIG.limits.settleTimeoutMs);
  if (!ready.ok) {
    return { ok: false, status: 'BLOCKED', state: STATE.COMPOSER_MISSING, url,
             detail: `composer did not appear within ${CONFIG.limits.settleTimeoutMs}ms ` +
                     `after navigating to the conversation` };
  }

  const state = await detectState();
  if (isBlocking(state.state)) {
    return { ok: false, status: 'BLOCKED', state: state.state, detail: state.detail,
             humanAction: requiresHuman(state.state) ? humanInstruction(state.state) : undefined };
  }
  const turns = countAssistantTurns();
  log('open_conversation', { url, turns: turns.count });
  return { ok: true, url: state.url, assistantTurns: turns.count, waitedMs: ready.waitedMs };
}

/**
 * Poll until the composer is present and visible, or the budget expires.
 * @returns {Promise<{ok:boolean, waitedMs?:number}>}
 */
async function waitForComposer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const probe = compose({ inputCandidates: SELECTORS.input.candidates }, `
    ${RESOLVE}
    return { present: resolve(args.inputCandidates, document, tagGroups).filter(__CW.isVisible).length };
  `);
  while (Date.now() < deadline) {
    const r = runCode(probe);
    if (r.ok && (r.value?.present ?? 0) > 0) {
      return { ok: true, waitedMs: timeoutMs - (deadline - Date.now()) };
    }
    await sleep(600);
  }
  return { ok: false };
}

// ---------------------------------------------------------------------------
// capability 4 - send_packet
// ---------------------------------------------------------------------------

/**
 * Send one task packet into the current conversation.
 *
 * @param {string} text
 * @returns {Promise<{ok:boolean, status?:string, baselineTurns?:number, detail?:string}>}
 */
async function send_packet(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, status: 'BLOCKED', detail: 'empty packet' };
  }

  const health = await health_check();
  if (health.status !== 'READY') return { ok: false, ...health };

  const baseline = await settledTurnBaseline();
  if (!baseline.ok) {
    return { ok: false, status: 'ERROR', detail: `cannot read turn baseline: ${baseline.error}` };
  }
  // `baseline` is the settled reading of both counters. `count` is bound to the assistant count so
  // that every existing reference - baselineTurns, read_reply's index - keeps meaning what it did.
  baseline.count = baseline.assistant;
  const baselineUser = { ok: true, count: baseline.user, visible: baseline.user };
  log('send_packet.baseline', {
    assistant: baseline.assistant, user: baseline.user,
    settled: baseline.settled, samples: baseline.samples,
  });

  // Fill the composer, then CONFIRM the fill landed before sending. A silent fill
  // failure is the worst case: committing an empty composer does nothing, and the
  // adapter would then wait for a reply that was never requested.
  const filled = runCode(compose(
    { inputCandidates: SELECTORS.input.candidates, payload: text },
    `
    ${RESOLVE}
    ${FIND_COMPOSER}
    if (!composer) return { filled: false, reason: 'no composer' };
    const payload = args.payload;
    composer.focus();
    if (composer.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(composer, payload);
    } else {
      composer.innerHTML = '';
      for (const para of payload.split('\\n')) {
        const p = document.createElement('p');
        p.textContent = para.length ? para : '\\u200b';
        composer.appendChild(p);
      }
    }
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true,
                                                     inputType: 'insertText', data: payload }));
    await new Promise(r => setTimeout(r, 300));
    const now = composerText(composer);
    return { filled: now.trim().length > 0, length: now.trim().length,
             expected: payload.trim().length };
  `));

  if (!filled.ok) return { ok: false, status: 'ERROR', detail: `composer fill call failed: ${filled.error}` };
  if (!filled.value?.filled) {
    return { ok: false, status: 'BLOCKED', detail: `composer still empty after fill: ${JSON.stringify(filled.value)}` };
  }

  // Commit via the send control. Enter is deliberately NOT the primary path: on some
  // composer revisions Enter inserts a newline, which would silently split the packet
  // into a partial first message.
  const sent = runCode(compose({ sendCandidates: SELECTORS.sendButton.candidates }, `
    ${RESOLVE}
    const els = resolve(args.sendCandidates, document, tagGroups).filter(__CW.isVisible);
    const enabled = els.filter(b => !b.disabled);
    if (!enabled.length) return { used: null, seen: els.length };
    enabled[enabled.length - 1].click();
    return { used: true, seen: els.length };
  `));

  if (!sent.ok || !sent.value?.used) {
    return { ok: false, status: 'BLOCKED',
             detail: `no enabled send control found (${JSON.stringify(sent.value ?? sent.error)}) - ` +
                     `the packet is still in the composer and was NOT sent` };
  }

  // VERIFY the packet landed. Confirmation is the appearance of a NEW USER turn, which is the
  // direct structural evidence that the click committed. Waiting for the assistant here as well
  // would make send confirmation a race against model latency and produce a false
  // SEND_NOT_CONFIRMED for a turn that was in fact received - see waitForTurnGrowth.
  const appeared = await waitForTurnGrowth(baselineUser.count, baseline.count, CONFIG.limits.sendTimeoutMs);
  if (!appeared.ok) {
    // Say which kind of failure this actually is. "No user turn appeared" is a claim about the
    // conversation; a counter that errored is a claim about the measurement. Reporting the second
    // as the first is what made the original false negative so hard to read.
    const measurementFailure = appeared.counterErrors > 0 && appeared.polls === appeared.counterErrors;
    // A turn that appeared and then went away is NOT the same as a turn that never appeared. The
    // first is evidence the message landed; the second is evidence it did not. Reporting them with
    // the same sentence is what made the original false negative unreadable.
    const sawThenLost = appeared.peakUser !== null && appeared.peakUser > baselineUser.count;
    const detail = measurementFailure
      ? `the turn counter failed on all ${appeared.polls} polls (last error: ` +
        `${String(appeared.lastError).slice(0, 160)}) - this is a MEASUREMENT failure, so it does ` +
        `NOT prove the packet was not committed. Check the conversation before retrying.`
      : sawThenLost
        ? `a new user turn WAS observed (peak ${appeared.peakUser}, baseline ${baselineUser.count}) but ` +
          `was no longer present at the end of the ${CONFIG.limits.sendTimeoutMs}ms window, so the ` +
          `send cannot be confirmed from a stable reading. This most likely means the message DID ` +
          `commit and the page re-rendered; CHECK THE CONVERSATION before retrying, because a retry ` +
          `would post a second packet.`
        : appeared.counterErrors > 0
          ? `no new user turn within ${CONFIG.limits.sendTimeoutMs}ms; the counter also failed on ` +
            `${appeared.counterErrors} of ${appeared.polls} polls, so this result is unreliable. ` +
            `Last counter error: ${String(appeared.lastError).slice(0, 160)}`
          : `no new user turn appeared within ${CONFIG.limits.sendTimeoutMs}ms (user stayed at ` +
            `${appeared.lastUser ?? 'unknown'}, baseline ${baselineUser.count}) - refusing to wait ` +
            `for a reply that was never requested`;

    return { ok: false, status: 'TIMEOUT', baselineTurns: baseline.count,
             detail,
             observed: appeared.observed,
             polls: appeared.polls,
             elapsedMs: appeared.elapsedMs,
             firstUser: appeared.firstUser,
             lastUser: appeared.lastUser,
             peakUser: appeared.peakUser,
             peakAssistant: appeared.peakAssistant,
             saw_user_turn: sawThenLost,
             counterErrors: appeared.counterErrors,
             measurement_failure: measurementFailure,
             baseline: { assistant: baseline.assistant, user: baseline.user, settled: baseline.settled },
             pollHistory: appeared.history };
  }

  // A confirmed user turn is the whole of the send verdict. The assistant's state is carried
  // through for diagnosis, and deliberately does NOT gate this result: whether the answer has
  // finished is wait_complete's question, and it is asked there.
  log('send_packet.ok', {
    baselineTurns: baseline.count, chars: text.length,
    confirmedBy: appeared.confirmedBy,
    userTurns: appeared.lastUser, assistantTurns: appeared.lastAssistant,
    assistantAlreadyGrown: appeared.assistantGrew, polls: appeared.polls,
  });
  return { ok: true, status: 'SENT', baselineTurns: baseline.count,
           baselineUserTurns: baselineUser.count,
           confirmedBy: appeared.confirmedBy,
           userTurnsAfter: appeared.lastUser,
           assistantTurnsAfter: appeared.lastAssistant,
           assistantGrew: appeared.assistantGrew };
}

/**
 * Confirm a send with a SHORT window, then return - regardless of whether the answer finished.
 *
 * WHY THIS EXISTS SEPARATELY FROM send_packet
 *   send_packet() owns the whole round: send, and wait for the answer (up to completeTimeoutMs).
 *   That is correct for a blocking CLI caller, but it is the wrong shape for an orchestrator that
 *   needs to know SOON whether the click committed, so it can move out of SUBMITTING and stop
 *   holding a UI in a state that looks like nothing is happening. Measured: a confirmed send kept
 *   the caller in SUBMITTING for 308s because the reply took that long.
 *
 * WHAT IT DOES NOT DO
 *   It never sends. The caller must already have started a send_packet. This only looks.
 *   That separation is deliberate: a "confirm" that could send is a "confirm" that can duplicate.
 *
 * @param {number} userTurnsBefore user turns counted before the send
 * @param {number} [windowMs] how long to look before giving up and reporting PENDING
 * @returns {Promise<{ok:boolean, outcome:string, confirmed:boolean, userTurns:number|null,
 *                    polls:number, elapsedMs:number, detail?:string}>}
 */
async function confirm_send(userTurnsBefore, windowMs = 12000) {
  const started = Date.now();
  const deadline = started + windowMs;
  let polls = 0;
  let last = null;
  let counterErrors = 0;

  while (Date.now() < deadline) {
    const u = countUserTurns();
    polls += 1;
    if (!u.ok) counterErrors += 1;
    else {
      last = u.count;
      if (u.count > userTurnsBefore) {
        return {
          ok: true,
          outcome: 'USER_TURN_CONFIRMED',
          confirmed: true,
          userTurns: u.count,
          userTurnsBefore,
          polls,
          elapsedMs: Date.now() - started,
        };
      }
    }
    await sleep(700);
  }

  // Not seen YET. That is PENDING, not failure - the ChatGPT client has been measured rendering
  // new turns minutes late, so absence inside this window proves nothing.
  return {
    ok: false,
    outcome: counterErrors === polls && polls > 0 ? 'MEASUREMENT_UNAVAILABLE' : 'SEND_PENDING',
    confirmed: false,
    userTurns: last,
    userTurnsBefore,
    polls,
    counterErrors,
    elapsedMs: Date.now() - started,
    detail: counterErrors === polls && polls > 0
      ? 'the turn counter failed on every poll, so this is a measurement failure and NOT evidence that the packet was not committed'
      : `no user turn observed within ${windowMs}ms; the packet may still commit - check the conversation before sending anything again`,
  };
}

/**
 * Poll until a NEW user turn appears - i.e. until the packet is confirmed to have landed.
 *
 * ROOT CAUSE FIXED HERE (2026-09-20, "turn-growth false negative")
 *   This function used to require BOTH the user AND the assistant count to grow past their
 *   baselines before reporting success. That conflated two questions the adapter is built to keep
 *   separate:
 *
 *       did the packet land?          -> answered by a new USER turn
 *       did the assistant finish?     -> answered by wait_complete()
 *
 *   The consequence was a false negative with real observed evidence. On a live conversation
 *   whose real state was user=2 / assistant=3 (verified independently against the DOM), a send
 *   produced user 2->3 while the assistant reply was still generating, so the assistant count
 *   never reached 4. After the 90s window this returned SEND_NOT_CONFIRMED, whose detail read
 *   "packet committed but no user turn appeared" - a message that was simply false, since the
 *   user turn count had risen. The caller then skipped round accounting, marked the Goal BLOCKED,
 *   and reported failure for a turn ChatGPT had received and answered.
 *
 * WHY USER GROWTH IS THE RIGHT AND SUFFICIENT CONFIRMATION
 *   A user turn is the direct, structural evidence that the click committed: it is a new
 *   role="user" element carrying its own data-message-id. It does not depend on model latency,
 *   which is exactly why gating on the assistant count made the check a race against the model.
 *   The assistant question is NOT dropped - it is reported here and adjudicated by wait_complete,
 *   where it belongs.
 *
 * A FAILED COUNT IS NOT A COUNT OF ZERO
 *   countTurns() returns -1 when the page evaluation itself fails. Comparing -1 against a
 *   baseline can never succeed, so a single transient shell error would have doomed the whole
 *   wait and been reported as "the message never arrived". Failures are now counted separately,
 *   and the caller is told when a timeout was a MEASUREMENT failure - which proves nothing about
 *   whether the packet was committed - rather than a missing message.
 *
 * @returns {Promise<{ok:boolean, observed:object, polls:number, elapsedMs:number,
 *                    firstUser:number|null, lastUser:number|null, counterErrors:number,
 *                    userGrew:boolean, assistantGrew:boolean}>}
 */
async function waitForTurnGrowth(userBaseline, assistantBaseline, timeoutMs) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let observed = null;
  let polls = 0;
  let counterErrors = 0;
  let firstUser = null;
  let lastUser = null;
  let lastAssistant = null;
  let lastError = null;

  // Full poll history. When this reports a failure, the question is always the same one - did the
  // message not land, or did the measurement miss it? A final value cannot answer that; the
  // sequence can. This is the evidence that makes the difference between those two causes visible
  // instead of arguable, and it is why the history is kept rather than just the last sample.
  const history = [];
  const HISTORY_CAP = 40;
  let peakUser = null;
  let peakAssistant = null;

  while (Date.now() < deadline) {
    const u = countUserTurns();
    const a = countAssistantTurns();
    polls += 1;

    if (!u.ok || !a.ok) {
      counterErrors += 1;
      lastError = u.error || a.error || 'count failed';
    } else {
      if (firstUser === null) firstUser = u.count;
      lastUser = u.count;
      lastAssistant = a.count;
    }

    const sample = {
      n: polls, ms: Date.now() - started,
      user: u.count, assistant: a.count, userOk: u.ok, assistantOk: a.ok,
    };
    if (history.length < HISTORY_CAP) history.push(sample);

    // The PEAK matters as much as the last value. A user turn that appears and then disappears
    // (React replacing the node during a reconcile, a virtualised list re-rendering) would be
    // invisible to a last-value-only check yet prove the message did land. Tracking the peak makes
    // that case visible instead of turning it into a plain "nothing landed".
    if (u.ok && (peakUser === null || u.count > peakUser)) peakUser = u.count;
    if (a.ok && (peakAssistant === null || a.count > peakAssistant)) peakAssistant = a.count;

    const userGrew = u.ok && u.count > userBaseline;
    observed = {
      user: u.count, assistant: a.count,
      wantUser: userBaseline + 1,
      // Kept in the payload for diagnosis only. The assistant baseline is NOT a send criterion;
      // it is the index read_reply() reads at, so a change is reported, never required.
      wantAssistant: assistantBaseline + 1,
      userBaseline, assistantBaseline,
      userOk: u.ok, assistantOk: a.ok,
      userGrew,
      at: new Date().toISOString(),
    };

    // CONFIRMED: the user turn is really in the conversation.
    if (userGrew) {
      return {
        ok: true, confirmedBy: 'user_turn', observed, polls, elapsedMs: Date.now() - started,
        firstUser, lastUser, lastAssistant, counterErrors, history,
        userGrew: true, assistantGrew: a.ok && a.count > assistantBaseline,
      };
    }
    await sleep(700);
  }

  return {
    ok: false, confirmedBy: null, observed, polls, elapsedMs: Date.now() - started,
    firstUser, lastUser, lastAssistant, counterErrors, lastError, history,
    peakUser, peakAssistant,
    userGrew: false, assistantGrew: lastAssistant !== null && lastAssistant > assistantBaseline,
  };
}

// ---------------------------------------------------------------------------
// capability 5 - wait_complete
// ---------------------------------------------------------------------------

/**
 * Wait for the CURRENT turn to finish generating, using independent signals.
 *
 *   A  a new assistant turn exists beyond the baseline
 *   B  no stop/streaming control is present
 *   C  that turn's text length is unchanged across `stableSamples` consecutive polls
 *   D  no FATAL error surface on the page
 *   E  an absolute ceiling; on expiry the result is TIMEOUT, never a partial read
 *
 * Condition D uses the strict `errorFatal` list. An earlier revision used the broad
 * `error` copy and a healthy live run was aborted by the single word meaning "retry",
 * which ChatGPT also renders in ordinary chrome. Aborting a good answer is a worse
 * failure than missing a rare error, so the abort trigger stays narrow.
 *
 * @param {number} baselineTurns assistant turns counted before the send
 */
async function wait_complete(baselineTurns) {
  const { pollIntervalMs, completeTimeoutMs, stableSamples } = CONFIG.limits;
  const deadline = Date.now() + completeTimeoutMs;
  const samples = [];

  let lastLength = -1;
  let stableCount = 0;
  let sawTurn = false;

  const probe = compose({
    assistantCandidates: SELECTORS.messages.assistantTurn.candidates,
    stopCandidates: SELECTORS.stopButton.candidates,
    hintCandidates: SELECTORS.streamingHint.candidates,
    bodyCandidates: SELECTORS.assistantBody.candidates,
    errorPatterns: SELECTORS.blockingStateText.errorFatal.patterns,
    captchaPatterns: SELECTORS.blockingStateText.captcha.patterns,
    ratePatterns: SELECTORS.blockingStateText.rateLimit.patterns,
  }, `
    ${RESOLVE}
    const turns = resolve(args.assistantCandidates, document, tagGroups);
    const stops = resolve(args.stopCandidates, document, tagGroups).filter(__CW.isVisible);
    const hints = resolve(args.hintCandidates, document, tagGroups).filter(__CW.isVisible);
    const last = __CW.last(turns);

    let bodyLength = 0;
    if (last) {
      const bodies = resolve(args.bodyCandidates, last, tagGroups);
      if (bodies.length) bodyLength = __CW.structuredText(bodies[0]).length;
    }

    const txt = __CW.visibleText().toLowerCase();
    const hit = (arr) => arr.filter(p => txt.includes(p.toLowerCase()));

    return {
      turnCount: turns.length,
      stopVisible: stops.length,
      streamHints: hints.length,
      bodyLength,
      errors: hit(args.errorPatterns),
      captcha: hit(args.captchaPatterns),
      rateLimit: hit(args.ratePatterns),
    };
  `);

  while (Date.now() < deadline) {
    const r = runCode(probe);

    if (!r.ok) {
      samples.push({ at: nowIso(), error: r.error });
      await sleep(pollIntervalMs);
      continue;
    }

    const v = r.value ?? {};
    samples.push({ at: nowIso(), ...v });

    // Hard stops outrank every completion heuristic.
    if (v.captcha?.length) {
      return { status: 'BLOCKED',
               detail: `human verification appeared mid-generation - ${humanInstruction(STATE.CAPTCHA)}`,
               samples };
    }
    if (v.rateLimit?.length) {
      return { status: 'BLOCKED', detail: `usage limit reached mid-generation: ${v.rateLimit.join(', ')}`, samples };
    }
    if (v.errors?.length) {
      return { status: 'ERROR', detail: `fatal error surface during generation: ${v.errors.join(', ')}`, samples };
    }

    // Condition A
    if ((v.turnCount ?? 0) > (baselineTurns ?? 0)) sawTurn = true;

    // Condition C - stability of the newest turn's text.
    if (Number.isFinite(v.bodyLength) && v.bodyLength > 0 && v.bodyLength === lastLength) {
      stableCount += 1;
    } else {
      stableCount = 0;
      lastLength = v.bodyLength;
    }

    // Condition B - no stop control AND no redundant streaming hint.
    const notStreaming = (v.stopVisible ?? 0) === 0 && (v.streamHints ?? 0) === 0;

    if (sawTurn && notStreaming && stableCount >= stableSamples) {
      return { status: 'COMPLETE',
               detail: `turn settled: new turn present, no streaming control, ` +
                       `length stable across ${stableSamples} consecutive samples`,
               bodyLength: lastLength, samples };
    }

    await sleep(pollIntervalMs);
  }

  return { status: 'TIMEOUT',
           detail: `no completion within ${completeTimeoutMs}ms - a partial answer is NOT reported as a result`,
           samples: samples.slice(-6) };
}

// ---------------------------------------------------------------------------
// capability 6 - read_reply
// ---------------------------------------------------------------------------

/**
 * Read ONLY the assistant turn at `index`.
 *
 * Scoped to that turn's markdown body so toolbars, copy buttons and menu text cannot
 * leak into the transcript. Hidden reasoning is never read or requested.
 *
 * @param {number} index zero-based assistant-turn index
 */
function read_reply(index) {
  const r = runCode(compose({
    assistantCandidates: SELECTORS.messages.assistantTurn.candidates,
    bodyCandidates: SELECTORS.assistantBody.candidates,
    stripSelector: SELECTORS.stripFromBody.tagGroup,
    index: Number(index),
  }, `
    ${RESOLVE}
    const turns = resolve(args.assistantCandidates, document, tagGroups);
    const idx = args.index;
    if (!turns.length) return { error: 'no assistant turns found on the page' };
    if (!Number.isFinite(idx) || idx < 0 || idx >= turns.length) {
      return { error: 'assistant turn index ' + idx + ' out of range (page has ' + turns.length + ')' };
    }

    const turn = turns[idx];
    const bodies = resolve(args.bodyCandidates, turn, tagGroups);
    if (!bodies.length) return { error: 'no markdown body inside assistant turn ' + idx };

    // The body is scoped, but interactive chrome can still sit inside it in some UI
    // revisions; strip it before extracting text. The tag set lives in the registry.
    const clone = bodies[0].cloneNode(true);
    clone.querySelectorAll(args.stripSelector).forEach(n => n.remove());

    return { text: __CW.structuredText(clone), rawLength: (clone.innerText || '').length,
             index: idx, turnCount: turns.length };
  `));

  if (!r.ok) return { ok: false, detail: r.error };
  if (r.value?.error) return { ok: false, detail: r.value.error };
  const text = String(r.value?.text ?? '');
  if (!text.trim()) return { ok: false, detail: 'assistant turn is present but its body is empty' };
  return { ok: true, text, index, turnCount: r.value?.turnCount };
}

// ---------------------------------------------------------------------------
// utilities
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  health_check, openWorker, closeWorker, listSessions,
  new_conversation, open_conversation, getConversationUrl,
  send_packet, wait_complete, read_reply,
  countAssistantTurns, countUserTurns, countTurns, detectState, humanInstruction, sleep,
  STATE, requiresHuman, isBlocking,
  // Exported for the turn-growth regression tests: the detection itself has to be testable
  // without driving a browser, and a test that reimplements it would test the wrong thing.
  waitForTurnGrowth,
  settledTurnBaseline,
  __setTestCountOverrides,
};
