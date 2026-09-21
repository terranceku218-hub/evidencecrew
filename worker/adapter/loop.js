'use strict';
/**
 * loop.js - PHASE 8: the DeepSeek -> ChatGPT -> Review closed loop.
 *
 * THE STATE MACHINE
 *
 *   build packet -> send -> wait_complete -> read_reply -> REVIEW
 *                                                          |- PASS    -> done, files may change
 *                                                          |- RETRY   -> correction packet, same URL
 *                                                          |- BLOCKED -> stop, report
 *
 * WHY THE CAP IS STRUCTURAL, NOT ADVISORY
 *   The failure this guards against is not an exception - it is two models politely
 *   agreeing to "optimize further" forever. So the attempt counter lives in the loop
 *   itself and the loop CANNOT exceed `maxRetryPerTask`: after the final permitted
 *   attempt the result is forced to BLOCKED regardless of what the review says. A review
 *   function that always returns RETRY therefore still terminates.
 *
 * WHY AN UNSPECIFIED RETRY IS REJECTED
 *   `validateReview` refuses a RETRY that does not name the unmet requirement, the
 *   correction, and the success criterion. Without that, the next round has no defined
 *   target and the retry budget is spent on noise.
 *
 * ASCII-ONLY: see the encoding note in lib.js.
 */

const { CONFIG } = require('./lib.js');
const W = require('./chatgpt-worker.js');
const packet = require('./packet.js');
const ledger = require('./ledger.js');

const VERDICT = { PASS: 'PASS', RETRY: 'RETRY', BLOCKED: 'BLOCKED' };

/**
 * Validate a review verdict before it is acted on.
 * @returns {{ok:boolean, error?:string}}
 */
function validateReview(verdict, review) {
  if (!Object.values(VERDICT).includes(verdict)) {
    return {
      ok: false,
      error: `verdict must be one of ${Object.values(VERDICT).join(' | ')}, got ${JSON.stringify(verdict)}`,
    };
  }
  if (verdict === VERDICT.RETRY) {
    const need = ['unmet', 'correction', 'criterion'];
    const absent = need.filter((k) => !review?.[k] || String(review[k]).trim().length === 0);
    if (absent.length) {
      return {
        ok: false,
        error: `RETRY must specify ${absent.join(', ')} - an unspecified retry is a loop with no target`,
      };
    }
  }
  return { ok: true };
}

/**
 * Send one packet and read the reply, with turn accounting.
 * @returns {Promise<{ok:boolean, reply?:string, error?:string, waitStatus?:string}>}
 */
async function oneRound(text) {
  const sent = await W.send_packet(text);
  if (!sent.ok) {
    return { ok: false, error: `send failed: ${sent.detail}`, sendStatus: sent.status,
             baselineTurns: sent.baselineTurns };
  }

  const done = await W.wait_complete(sent.baselineTurns);
  if (done.status !== 'COMPLETE') {
    // A partial answer must never be promoted to a result.
    return { ok: false, error: `generation did not complete: ${done.detail}`,
             waitStatus: done.status, baselineTurns: sent.baselineTurns };
  }

  const reply = W.read_reply(sent.baselineTurns);
  if (!reply.ok) {
    return { ok: false, error: `could not read reply: ${reply.detail}`, baselineTurns: sent.baselineTurns };
  }

  return { ok: true, reply: reply.text, baselineTurns: sent.baselineTurns, waitDetail: done.detail };
}

/**
 * Run the full supervised loop for one task.
 *
 * @param {object} opts
 * @param {object} opts.spec          packet spec (see packet.build)
 * @param {string} [opts.workerId]    ledger worker id to charge rounds against
 * @param {function} opts.review      (replyText, attempt) => {verdict, review}
 * @param {function} [opts.transport] test hook replacing the send/wait/read round.
 *                                    Exists so the termination guarantee can be tested
 *                                    WITHOUT a browser - the cap is protocol logic and
 *                                    must be provable offline, not merely observed.
 * @returns {Promise<object>} a full transcript of the loop outcome
 */
async function run(opts) {
  const spec = opts.spec;
  const maxRetry = CONFIG.limits.maxRetryPerTask;
  const history = [];
  const roundTrip = opts.transport ?? oneRound;

  const first = packet.build(spec);
  if (!first.ok) return { status: VERDICT.BLOCKED, reason: first.error, history };

  let packetText = first.text;
  const attachments = { included: first.included, missing: first.missing };

  // A task gets its FIRST attempt plus `maxRetry` corrections.
  for (let attempt = 0; attempt <= maxRetry; attempt += 1) {
    const round = await roundTrip(packetText, attempt);

    if (!round.ok) {
      history.push({ attempt, outcome: 'TRANSPORT', error: round.error });
      // Transport/blocking failures are not review failures. Retrying blindly would
      // burn the retry budget on an environment problem, so this stops immediately.
      return { status: VERDICT.BLOCKED, reason: round.error, attempt, history, attachments };
    }

    history.push({ attempt, outcome: 'REPLY', chars: round.reply.length });

    // The review function is injected so the supervisor's judgement stays in the
    // supervisor's hands - this module enforces the protocol, not the opinion.
    const decision = await opts.review(round.reply, attempt);

    const verdict = decision?.verdict;
    const check = validateReview(verdict, decision?.review);
    if (!check.ok) {
      history.push({ attempt, outcome: 'INVALID_REVIEW', error: check.error });
      return { status: VERDICT.BLOCKED, reason: check.error, attempt,
               reply: round.reply, history, attachments };
    }

    history.push({ attempt, outcome: 'REVIEW', verdict, review: decision.review ?? null });

    if (verdict === VERDICT.PASS) {
      if (opts.workerId) ledger.bumpRound(opts.workerId, { detail: `attempt ${attempt + 1} PASS` });
      if (opts.workerId) ledger.markSuccess(opts.workerId);
      return { status: VERDICT.PASS, attempt, attempts: attempt + 1,
               reply: round.reply, attachments, history };
    }

    if (verdict === VERDICT.BLOCKED) {
      if (opts.workerId) ledger.bumpRound(opts.workerId, { detail: `attempt ${attempt + 1} BLOCKED` });
      return { status: VERDICT.BLOCKED, reason: decision.review?.unmet ?? 'reviewed BLOCKED',
               attempt, reply: round.reply, attachments, history };
    }

    // verdict === RETRY
    if (attempt === maxRetry) {
      // The cap has been reached. Force termination rather than granting another round.
      const reason = `MAX_RETRY_PER_TASK (${maxRetry}) exhausted after ${attempt + 1} attempts; ` +
                     `last unmet requirement: ${decision.review.unmet}`;
      if (opts.workerId) ledger.bumpRound(opts.workerId, { detail: `attempt ${attempt + 1} RETRY-cap` });
      return { status: VERDICT.BLOCKED, reason, capReached: true,
               attempt, reply: round.reply, attachments, history };
    }

    const revised = packet.buildRevision(spec, decision.review);
    if (!revised.ok) {
      history.push({ attempt, outcome: 'INVALID_RETRY_PACKET', error: revised.error });
      return { status: VERDICT.BLOCKED, reason: revised.error, attempt, history, attachments };
    }
    if (opts.workerId) ledger.bumpRound(opts.workerId, { detail: `attempt ${attempt + 1} RETRY` });

    // The correction goes to the SAME conversation, which is the whole point of keeping
    // the worker URL in the ledger.
    packetText = revised.text;
  }

  // Unreachable: the loop returns on the final permitted attempt.
  return { status: VERDICT.BLOCKED, reason: 'loop exited without a verdict', history, attachments };
}

module.exports = { VERDICT, validateReview, oneRound, run };
