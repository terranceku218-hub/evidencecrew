'use strict';
/**
 * supervisor.js - the Supervisor Seat's work: turn a Goal into an envelope, and review the result.
 *
 * WHAT A SUPERVISOR SEAT ACTUALLY DOES
 *   1. Read a natural-language goal.
 *   2. Decide whether a worker is needed at all, or whether this is answerable directly.
 *   3. Produce a VERIFIED TASK ENVELOPE: scope, permissions, success criteria, review requirements.
 *   4. Later, REVIEW the worker's reply against those criteria and return a verdict.
 *
 * WHERE THIS SITS IN THE ABSTRACTION
 *   This module talks to a SEAT. It never asks what provider is behind it. The only thing it adapts to
 *   is `capabilities` - for example, a seat that cannot deliver synchronously needs its reply observed
 *   rather than read immediately. If a provider name ever appears here as a condition, the abstraction
 *   has failed, and that is asserted by test.
 *
 * STRUCTURED OUTPUT WITHOUT A PROVIDER FEATURE
 *   The supervisor needs to emit a machine-readable plan, not prose. Rather than depend on a
 *   provider's structured-output mode - which would be a provider-specific dependency - it is asked
 *   for JSON and the reply is parsed tolerantly. Parsing is strict about the FIELDS and forgiving
 *   about the packaging (code fences, leading prose), because models add packaging.
 */

const protocol = require('./protocol.js');

/** Extract the first JSON object from a reply that may be wrapped in prose or a code fence. */
function extractJson(text) {
  const s = String(text ?? '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(s.slice(first, last + 1));
  candidates.push(s);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, value: parsed };
    } catch { /* try the next shape */ }
  }
  return { ok: false, error: 'no JSON object found in the reply', raw: s.slice(0, 400) };
}

/**
 * The supervisor's planning instruction.
 *
 * The ack requirement is stated in the SAME form the protocol expects, so the correlation check has
 * something real to verify. It is not decoration: a plan whose ack does not match is unusable.
 */
function planPrompt(goal, context) {
  return [
    '[ROLE]',
    'You are the SUPERVISOR seat. You plan work and you review results. You do not write code.',
    'Your reply will be machine-parsed, so it must end with a single JSON object and nothing after it.',
    '',
    '[GOAL]',
    goal,
    '',
    '[AVAILABLE CONTEXT]',
    context.sourceSummary || '(no source files are bound to this goal)',
    context.taskSummary || '(no task registry information available)',
    '',
    ...(context.progress
      ? [
        '[PROGRESS SO FAR]',
        context.progress,
        '',
        'You are being consulted again after the tasks above were completed and reviewed.',
        'If the goal is now satisfied, answer with needs_worker=false and put the closing',
        'statement in direct_answer. If real work remains, define exactly ONE next task.',
        'Do not invent work to stay busy: an unnecessary task is a defect, not diligence.',
        '',
      ]
      : []),
    '[YOUR DECISION]',
    'Decide whether this goal needs a WORKER or is answerable directly from the context above.',
    'A worker is warranted when the goal needs reading files, code reasoning, or an independent',
    'second opinion. It is NOT warranted for questions the context already answers.',
    '',
    '[OUTPUT FORMAT]',
    'Reply with a JSON object in exactly this shape:',
    '{',
    '  "needs_worker": true | false,',
    '  "reasoning": "<one or two sentences>",',
    '  "task_title": "<short title for the worker task, or null>",',
    '  "request": "<the instruction you would dispatch to the worker, or null>",',
    '  "success_criteria": ["<criterion>", "..."],',
    '  "source_files": ["<relative path the worker should read>", "..."],',
    '  "review_requirements": { "required": true, "independent_provider": true },',
    '  "direct_answer": "<your answer if needs_worker is false, else null>"',
    '}',
    '',
    '[ACKNOWLEDGEMENT]',
    'Begin your reply with these two lines verbatim, before anything else:',
    `RUN_ID_ACK: ${context.runId}`,
    `SOURCE_HASH_ACK: ${context.sourceSetHash}`,
    '',
    'These lines are compared against the dispatch record. Do not alter them.',
  ].join('\n');
}

/** Review instruction. Same acknowledgement discipline, because the review is also a correlated reply. */
/**
 * How much of a worker reply the reviewer is shown.
 *
 * MEASURED DEFECT, and why this is no longer a bare slice(): the reply was cut at 8000 characters with
 * nothing said about it, and the reviewer then failed a task for "not stating that runtime testing was
 * unavailable" when that statement was simply past the cut. The supervisor cannot judge what it was
 * never shown, and a silent cut is indistinguishable from a worker that stopped mid-sentence - so the
 * reviewer scores a harness limitation as a worker failure and the loop retries work that was already
 * done. The cut is now generous AND declared in the prompt.
 */
const WORKER_REPLY_CHAR_LIMIT = 24000;

function reviewPrompt(envelope, workerReply, context) {
  const full = String(workerReply ?? '');
  const truncated = full.length > WORKER_REPLY_CHAR_LIMIT;
  const shown = truncated ? full.slice(0, WORKER_REPLY_CHAR_LIMIT) : full;
  return [
    '[ROLE]',
    'You are the SUPERVISOR seat reviewing a WORKER\'s result. Be skeptical and specific.',
    'Your reply will be machine-parsed, so it must end with a single JSON object.',
    '',
    '[THE TASK YOU DISPATCHED]',
    `task: ${envelope.task_id}`,
    `request: ${envelope.request ?? '(none)'}`,
    '',
    '[SUCCESS CRITERIA]',
    ...(envelope.success_criteria ?? []).map((c, i) => `${i + 1}. ${c}`),
    '',
    ...(truncated
      ? [
        '[TRUNCATION NOTICE - READ THIS BEFORE JUDGING]',
        `The worker reply is ${full.length} characters long. This harness truncated it to the first`,
        `${WORKER_REPLY_CHAR_LIMIT} characters, and the final ${full.length - WORKER_REPLY_CHAR_LIMIT} characters are NOT shown to you.`,
        'The cut is a limitation of this harness, not evidence about the worker. Therefore:',
        '  - judge every criterion only on the text shown below;',
        '  - if a criterion is not addressed in the text shown, record it as "partial" (not',
        '    "not_addressed") and say in the evidence that it may lie beyond the cut;',
        '  - add the concern "reply_truncated_by_harness" so the truncation is visible in the record;',
        '  - never fail the task solely because the shown text ends mid-sentence.',
        '',
      ]
      : []),
    '[WORKER REPLY]',
    shown,
    ...(truncated ? ['', `[END OF SHOWN TEXT - ${full.length - WORKER_REPLY_CHAR_LIMIT} trailing characters withheld by the harness]`] : []),
    '',
    '[WHAT YOU MUST JUDGE]',
    'For each success criterion, state whether the reply actually satisfies it, citing what the',
    'worker said. Distinguish "satisfied", "partially satisfied" and "not addressed". Do not accept',
    'a claim merely because it is confidently worded. If the worker asserted something it could not',
    'have known, say so.',
    '',
    '[OUTPUT FORMAT]',
    '{',
    '  "verdict": "PASS" | "RETRY" | "BLOCKED",',
    '  "criteria_results": [ { "criterion": "<text>", "result": "satisfied"|"partial"|"not_addressed", "evidence": "<what in the reply shows this>" } ],',
    '  "concerns": ["<anything the worker got wrong, overclaimed, or left ambiguous>"],',
    '  "summary": "<two or three sentences for the Evidence Record>"',
    '}',
    '',
    '[ACKNOWLEDGEMENT]',
    'Begin your reply with these two lines verbatim:',
    `RUN_ID_ACK: ${context.runId}`,
    `SOURCE_HASH_ACK: ${context.sourceSetHash}`,
  ].join('\n');
}

/**
 * Run one supervisor turn: render a prompt, dispatch it through the SEAT, correlate the answer.
 *
 * WHY EACH TURN GETS ITS OWN ENVELOPE
 *   A seat refuses a second dispatch while a run is in flight, because that refusal is what stops a
 *   duplicate message. A supervisor legitimately takes TWO turns on one goal - it plans, and later it
 *   reviews - and those are genuinely different runs with different work. Giving each its own envelope
 *   and run id satisfies the guard honestly instead of weakening it: the seat is never asked to carry
 *   two things at once, and each turn is separately correlated.
 *
 *   That is also why the task id is qualified (`...-PLAN` / `...-REVIEW`): two turns that shared an
 *   identifier would be indistinguishable in the Evidence Record.
 *
 * Every provider difference is handled by reading `capabilities`, never by reading `provider`:
 * if the seat cannot deliver synchronously, this observes until it settles instead of reading straight
 * away. That branch is about the TRANSPORT's behaviour, which is what capabilities describe.
 */
async function runSupervisorTurn(seatModule, seat, prompt, runId, sourceSetHash, turnKind = 'TURN') {
  /**
   * A turn without a run id cannot be correlated, so it must not be attempted.
   *
   * This guard exists because the absence produced a confusing error three layers away: an empty
   * `run_id` reached `protocol.validateEnvelope`, which reported only "run_id must be a non-empty
   * string" - with no hint that the SUPERVISOR turn was the caller that supplied it. Failing here,
   * naming the turn kind, turns a puzzle into a one-line diagnosis.
   */
  if (typeof runId !== 'string' || !runId) {
    return {
      ok: false,
      refused: true,
      error: `the supervisor ${turnKind} turn was dispatched without a run id (got ${JSON.stringify(runId)}); `
        + 'a turn that cannot be correlated must not be sent',
    };
  }

  const envelope = {
    protocol_version: protocol.PROTOCOL_VERSION,
    run_id: runId,
    task_id: `SUPERVISOR-${turnKind}`,
    project_id: seat.project_id,
    workspace_id: seat.workspace_id,
    seat_id: seat.seat_id,
    source_files: [],
    permissions: { read_scope: [], write_scope: [], deny: [], approval_required: [] },
    success_criteria: [],
    expected_output: 'a single JSON object',
    review_requirements: { required: false, independent_provider: false, min_reviewers: 0 },
    created_at: new Date().toISOString(),
  };

  const started = Date.now();
  const dispatched = await seatModule.dispatch(seat, envelope, {
    renderer: 'structured',
    // The supervisor's packet IS the prompt, so it is passed through rather than generated from the
    // envelope fields. This is the one place where a caller supplies text: the supervisor is the thing
    // that generates envelopes, so it cannot be handed one describing its own work.
    rawPacket: prompt,
  });

  if (dispatched.refused) return { ok: false, refused: true, error: dispatched.error };

  /**
   * Keep THIS turn's run id on the envelope.
   *
   * A seat binds a run and may rewrite `envelope.run_id` in the process. That is fine for a worker
   * envelope, which the seat owns - but a supervisor turn is dispatched with `rawPacket`, so the
   * envelope handed to the seat is the caller's. When the seat rewrote it, the caller's envelope lost
   * its id and a later protocol call rejected it with "run_id must be a non-empty string".
   *
   * Restoring it is not a workaround: the id is what the prompt told DeepSeek to echo, and the whole
   * point of the turn is that the echo is checkable against it.
   */
  envelope.run_id = runId;
  /**
   * The envelope object itself is handed to the transport, so a malformed one fails inside `dispatch`
   * and surfaces as a bare "no readable reply". Re-validating HERE names the turn, the field and the
   * value, which is the difference between a one-line diagnosis and an afternoon.
   */
  const shape = protocol.validateEnvelope(envelope);
  if (!shape.ok) {
    return {
      ok: false,
      refused: true,
      error: `the supervisor ${turnKind} turn built an invalid envelope: ${shape.problems.join('; ')} `
        + `[run_id=${JSON.stringify(envelope.run_id)} task_id=${JSON.stringify(envelope.task_id)} seat_id=${JSON.stringify(envelope.seat_id)}]`,
    };
  }

  // Adapt to the TRANSPORT's capability, not to a provider name.
  let replyText = null;
  const caps = seat.capabilities ?? {};
  if (caps.can_deliver_synchronously && caps.supports_readback) {
    const read = await seatModule.read(seat, envelope);
    if (read.ok) replyText = read.text;
  } else {
    const obs = await seatModule.observe(seat, envelope);
    if (obs.confirmed) {
      const read = await seatModule.read(seat, envelope);
      if (read.ok) replyText = read.text;
    }
  }

  /**
   * A BOUNDED RETRY, AND WHY IT IS SAFE HERE BUT NOWHERE ELSE
   *
   * Measured: the review turn occasionally came back in 1-2ms with `SEND_UNCERTAIN` - a local
   * transport failure immediately after a 260-second browser dispatch, not a model failure. The turn
   * was then dropped and the run ended without a review, which looked exactly like a supervisor refusal.
   *
   * SEND_UNCERTAIN is precisely the state that says "we cannot say whether this reached the provider",
   * and this transport's own capabilities settle whether re-sending is safe: a SYNCHRONOUS transport
   * returns one answer per request and holds no conversation state, so a request that failed locally
   * cannot have queued a duplicate. That is a different situation from the browser transport, where
   * `mayRedispatch()` refuses a retry because a second message WOULD be a second message.
   *
   * So the retry is gated on capability, not on provider name, and it is capped at one. A capability
   * that is absent means no retry, which keeps the browser path's prohibition intact by default.
   */
  let retried = false;
  if (!replyText && dispatched.delivery_state === 'SEND_UNCERTAIN' && caps.can_deliver_synchronously === true) {
    retried = true;
    // The seat must be released first: the failed attempt left a run bound, and the guard would
    // otherwise refuse the retry as a duplicate dispatch.
    seatModule.completeTurn(seat, `${turnKind} turn failed at the transport level; retrying once`);
    const again = await seatModule.dispatch(seat, envelope, { renderer: 'structured', rawPacket: prompt });
    if (!again.refused) {
      const read2 = await seatModule.read(seat, envelope);
      if (read2.ok) replyText = read2.text;
    }
  }

  return {
    ok: !!replyText,
    reply: replyText,
    latency_ms: Date.now() - started,
    delivery_state: dispatched.delivery_state,
    retried,
    // The transport's own explanation, carried out rather than discarded: without it an empty reply is
    // indistinguishable from a refusal, and this exact ambiguity cost a full debugging cycle.
    transport_detail: dispatched.detail ?? null,
    transport_evidence: dispatched.transport_evidence ?? null,
    correlated: protocol.checkCorrelation(envelope, replyText ?? '', { expectedSourceHash: sourceSetHash }),
    envelope,
    // The turn is over once its reply has been read, so the seat is released for the supervisor's NEXT
    // turn (plan, then review). This is what keeps the anti-duplicate guard from deadlocking a seat that
    // legitimately takes sequential turns - see completeTurn for why it cannot escape a pending state.
    turn_closed: replyText ? seatModule.completeTurn(seat, `${turnKind} turn completed`) : { ok: false, error: 'no reply, turn left open' },
  };
}

/**
 * Ask the supervisor to plan a goal.
 *
 * @returns {{ok, needs_worker, plan, reply, latency_ms, correlation}}
 */
async function plan(seatModule, seat, goal, context) {
  const prompt = planPrompt(goal, context);
  const turn = await runSupervisorTurn(seatModule, seat, prompt, context.runId, context.sourceSetHash, 'PLAN');
  if (!turn.ok) return { ok: false, error: 'the supervisor seat produced no readable reply', turn };

  const parsed = extractJson(turn.reply);
  if (!parsed.ok) {
    return { ok: false, error: `the supervisor reply was not machine-readable: ${parsed.error}`, raw: parsed.raw, turn };
  }
  const p = parsed.value;
  if (typeof p.needs_worker !== 'boolean') {
    return { ok: false, error: 'the supervisor reply omitted needs_worker', plan: p, turn };
  }

  return {
    ok: true,
    needs_worker: p.needs_worker,
    plan: {
      reasoning: p.reasoning ?? null,
      task_title: p.task_title ?? null,
      request: p.request ?? null,
      success_criteria: Array.isArray(p.success_criteria) ? p.success_criteria : [],
      source_files: Array.isArray(p.source_files) ? p.source_files : [],
      review_requirements: p.review_requirements ?? { required: true, independent_provider: true },
      direct_answer: p.direct_answer ?? null,
    },
    reply: turn.reply,
    latency_ms: turn.latency_ms,
    correlation: turn.correlated,
  };
}

/** Ask the supervisor to review a worker's result against the criteria it wrote. */
async function review(seatModule, seat, envelope, workerReply, context) {
  const prompt = reviewPrompt(envelope, workerReply, context);
  const turn = await runSupervisorTurn(seatModule, seat, prompt, context.runId, context.sourceSetHash, 'REVIEW');
  if (!turn.ok) return { ok: false, error: 'the supervisor seat produced no readable review', turn };

  const parsed = extractJson(turn.reply);
  if (!parsed.ok) {
    return { ok: false, error: `the review was not machine-readable: ${parsed.error}`, raw: parsed.raw, review: null, turn };
  }
  const r = parsed.value;
  if (!['PASS', 'RETRY', 'BLOCKED'].includes(r.verdict)) {
    return { ok: false, error: `the review carried an unusable verdict: ${r.verdict}`, review: r, turn };
  }
  return {
    ok: true,
    review: {
      verdict: r.verdict,
      criteria_results: Array.isArray(r.criteria_results) ? r.criteria_results : [],
      concerns: Array.isArray(r.concerns) ? r.concerns : [],
      summary: r.summary ?? null,
    },
    reply: turn.reply,
    latency_ms: turn.latency_ms,
    correlation: turn.correlated,
  };
}

module.exports = { plan, review, extractJson, planPrompt, reviewPrompt };
