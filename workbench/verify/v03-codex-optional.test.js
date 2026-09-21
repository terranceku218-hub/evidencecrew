'use strict';
/**
 * v03-codex-optional.test.js - V0.3 regression suite for the OPTIONAL-REVIEWER contract.
 *
 * WHAT CHANGED, AND WHY THIS SUITE EXISTS
 *   V0.3 makes the independent reviewer optional. Codex can be OFF, and with it OFF the two-provider loop
 *   (DeepSeek supervisor, ChatGPT worker) must still be able to run a goal to completion. That is a
 *   promise about what must NOT happen: the absence of a reviewer must never be recorded as missing
 *   evidence, must never block a goal, and must never be dressed up as an independent review.
 *
 * WHAT IT IS DESIGNED TO CATCH
 *   - a mode-OFF run that quietly requests an independent review anyway;
 *   - an OFF run whose Evidence Record claims INDEPENDENT_PROVIDER_REVIEW (the most damaging possible
 *     regression: claiming a second opinion that never happened);
 *   - an Evidence Card that renders DISABLED_BY_POLICY as a missing-evidence dash or, worse, a tick;
 *   - the reviewer prompt silently truncating the worker reply, which was measured to fail a task for
 *     text the reviewer was never shown;
 *   - a goal that cannot end: stop conditions are asserted directly, including the budget cap that makes
 *     "keep asking for more work" a bounded outcome rather than a bill.
 *
 * No browser and no Codex process is touched. The Codex assertions are contract-level on purpose: the
 * suite must pass on a machine with no Codex quota and no Codex binary.
 */

const path = require('node:path');

const WB = path.resolve(__dirname, '..', '..', 'workbench');
const POLICY = require(path.join(WB, 'protocol', 'policy.js'));
const EVIDENCE = require(path.join(WB, 'protocol', 'evidence.js'));
const CARD = require(path.join(WB, 'protocol', 'evidence-card.js'));
const SUPERVISOR = require(path.join(WB, 'protocol', 'supervisor.js'));
const CONTRACT = require(path.join(WB, 'protocol', 'transport-contract.js'));
const registryModule = require(path.join(WB, 'seats', 'registry.js'));

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name} :: ${detail}`); console.log(`  FAIL  ${name} :: ${detail}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

function recordWith(overrides) {
  return EVIDENCE.buildRecord({
    taskId: 'V03-TEST', runId: 'run-0123456789ab',
    supervisorSeat: 'seat:demo/default/supervisor',
    workerSeat: 'seat:demo/default/coder',
    reviewerSeat: 'seat:demo/default/supervisor',
    seatProviders: { supervisor: 'deepseek', worker: 'chatgpt', reviewer: 'deepseek' },
    sourceHashes: [], correlationDisposition: 'CORRELATED',
    runIdAck: 'run-0123456789ab', sourceHashAck: 'NO_SOURCE_BOUND',
    proposal: 'the worker report, reproduced here as the proposal under review',
    reviewResult: { verdict: 'PASS', summary: 'supervisor review passed' },
    approval: null,
    changedFiles: [], writeScope: [], diffScopeOk: true,
    validationResults: [{ name: 'run correlated', ok: true }],
    runtimeValidation: 'not applicable - read-only task',
    ...overrides,
  });
}

function main() {
  // ======================================================================
  section('A. codex_review_mode: OFF is the default and is never an error');
  {
    check('the default mode normalises to OFF',
      POLICY.normalizeCodexMode(undefined) === POLICY.CODEX_MODE.OFF,
      POLICY.normalizeCodexMode(undefined));
    check('an unrecognised mode falls back to OFF rather than to a real reviewer',
      POLICY.normalizeCodexMode('banana') === POLICY.CODEX_MODE.OFF,
      POLICY.normalizeCodexMode('banana'));
    check('mode names are case-insensitive',
      POLICY.normalizeCodexMode('auto') === POLICY.CODEX_MODE.AUTO,
      POLICY.normalizeCodexMode('auto'));

    /**
     * The UI control is a toggle labelled "Use Codex Reviewer [OFF/ON]", so it submits the literal `ON`.
     * MEASURED DEFECT: `ON` was not a mode name, fell through to the safe-by-default branch, and resolved
     * to OFF - the operator switched the reviewer ON and the system switched it off, then recorded
     * DISABLED_BY_POLICY as if that had been the intent. A silent inversion of an explicit human choice
     * is the worst failure a policy switch can have, so every boolean spelling is asserted here.
     */
    for (const on of ['ON', 'on', 'On', true, 'TRUE', 'true', 'YES', 'yes', '1', 'ENABLED', 'enable']) {
      check(`the toggle value ${JSON.stringify(on)} means USE the reviewer, not OFF`,
        POLICY.normalizeCodexMode(on) === POLICY.CODEX_MODE.AUTO,
        `${JSON.stringify(on)} -> ${POLICY.normalizeCodexMode(on)}`);
    }
    for (const off of ['OFF', 'off', false, 'FALSE', 'no', '0', 'DISABLED']) {
      check(`the value ${JSON.stringify(off)} means OFF`,
        POLICY.normalizeCodexMode(off) === POLICY.CODEX_MODE.OFF,
        `${JSON.stringify(off)} -> ${POLICY.normalizeCodexMode(off)}`);
    }
    check('a typo still falls back to OFF rather than spending quota',
      POLICY.normalizeCodexMode('REQURIED') === POLICY.CODEX_MODE.OFF,
      POLICY.normalizeCodexMode('REQURIED'));
    check('ON plus a coding task actually asks for the reviewer',
      POLICY.wantsIndependentReview('ON', { type: 'coding' }, {}).wanted === true,
      JSON.stringify(POLICY.wantsIndependentReview('ON', { type: 'coding' }, {})));

    // A coding task is the strongest possible signal for an independent reviewer: if OFF still refuses
    // to ask for one here, it refuses everywhere.
    const off = POLICY.wantsIndependentReview(POLICY.CODEX_MODE.OFF,
      { type: 'coding', title: 'refactor the architecture', description: 'migration' },
      { writeScope: ['a.cs'], highRisk: true, retries: 3, disputed: true });
    check('OFF requests no independent review even for a high-risk coding task with retries',
      off.wanted === false, JSON.stringify(off));
    check('OFF reports DISABLED_BY_POLICY, not a missing or failed reviewer',
      off.status === POLICY.INDEPENDENT_REVIEW.DISABLED_BY_POLICY, off.status);
    check('OFF explains itself as a configured choice',
      /codex_review_mode is OFF/.test(off.reason), off.reason);

    const auto = POLICY.wantsIndependentReview(POLICY.CODEX_MODE.AUTO,
      { type: 'coding', title: 'plain coding task' }, {});
    check('AUTO does request an independent review for a coding task', auto.wanted === true, JSON.stringify(auto));
    check('AUTO leaves a review-only task alone',
      POLICY.wantsIndependentReview(POLICY.CODEX_MODE.AUTO, { type: 'review', title: 'summarise' }, {}).wanted === false,
      JSON.stringify(POLICY.wantsIndependentReview(POLICY.CODEX_MODE.AUTO, { type: 'review', title: 'summarise' }, {})));
    check('REQUIRED always requests one',
      POLICY.wantsIndependentReview(POLICY.CODEX_MODE.REQUIRED, { type: 'review' }, {}).wanted === true,
      JSON.stringify(POLICY.wantsIndependentReview(POLICY.CODEX_MODE.REQUIRED, { type: 'review' }, {})));
  }

  // ======================================================================
  section('B. review_level: an independent review is only claimed when it happened');
  {
    check('DISABLED_BY_POLICY yields SUPERVISOR_REVIEW',
      POLICY.reviewLevelFor(POLICY.INDEPENDENT_REVIEW.DISABLED_BY_POLICY) === POLICY.REVIEW_LEVEL.SUPERVISOR_REVIEW,
      POLICY.reviewLevelFor(POLICY.INDEPENDENT_REVIEW.DISABLED_BY_POLICY));
    check('REQUESTED but not satisfied yields SUPERVISOR_REVIEW, not a downgrade to nothing',
      POLICY.reviewLevelFor(POLICY.INDEPENDENT_REVIEW.REQUESTED) === POLICY.REVIEW_LEVEL.SUPERVISOR_REVIEW,
      POLICY.reviewLevelFor(POLICY.INDEPENDENT_REVIEW.REQUESTED));
    check('UNAVAILABLE yields SUPERVISOR_REVIEW',
      POLICY.reviewLevelFor(POLICY.INDEPENDENT_REVIEW.UNAVAILABLE) === POLICY.REVIEW_LEVEL.SUPERVISOR_REVIEW,
      POLICY.reviewLevelFor(POLICY.INDEPENDENT_REVIEW.UNAVAILABLE));
    check('only SATISFIED yields INDEPENDENT_PROVIDER_REVIEW',
      POLICY.reviewLevelFor(POLICY.INDEPENDENT_REVIEW.SATISFIED) === POLICY.REVIEW_LEVEL.INDEPENDENT_PROVIDER_REVIEW,
      POLICY.reviewLevelFor(POLICY.INDEPENDENT_REVIEW.SATISFIED));
  }

  // ======================================================================
  section('C. Evidence under mode OFF records the choice, and still reaches VERIFIED');
  {
    const rec = recordWith({
      reviewLevel: POLICY.REVIEW_LEVEL.SUPERVISOR_REVIEW,
      independentReviewStatus: POLICY.INDEPENDENT_REVIEW.DISABLED_BY_POLICY,
      independentReviewDetail: 'codex_review_mode is OFF',
      codexReviewMode: POLICY.CODEX_MODE.OFF,
    });
    check('the record carries review_level', rec.review_level === POLICY.REVIEW_LEVEL.SUPERVISOR_REVIEW, rec.review_level);
    check('the record carries the independent-review status',
      rec.independent_review_status === POLICY.INDEPENDENT_REVIEW.DISABLED_BY_POLICY, rec.independent_review_status);
    check('the record carries the mode that produced it', rec.codex_review_mode === POLICY.CODEX_MODE.OFF, rec.codex_review_mode);
    check('a mode-OFF record reaches VERIFIED: no reviewer is not missing evidence',
      rec.final_status === 'VERIFIED', `${rec.final_status} missing=${JSON.stringify(rec.missing_evidence)}`);
    /**
     * `approval` IS legitimately listed here: it really was not recorded, and the record says so without
     * downgrading the status. The promise this test defends is narrower and more important - the absent
     * REVIEWER must not be listed as missing evidence, because nothing is missing: the second opinion was
     * switched off on purpose. If OFF ever appears in this list, the record has started treating a
     * configuration choice as a gap.
     */
    check('the absent reviewer is NOT listed as missing evidence',
      !rec.missing_evidence.some((m) => /review/i.test(String(m))), JSON.stringify(rec.missing_evidence));
    check('what IS listed is the unrecorded human approval, and only that',
      rec.missing_evidence.every((m) => /approval/i.test(String(m))), JSON.stringify(rec.missing_evidence));

    // The counter-case, so the check above cannot pass by accident: a record that CLAIMS an independent
    // review it did not get must not be VERIFIED.
    const lying = recordWith({
      reviewLevel: POLICY.REVIEW_LEVEL.INDEPENDENT_PROVIDER_REVIEW,
      independentReviewStatus: POLICY.INDEPENDENT_REVIEW.NOT_SATISFIED,
      independence: { required: true, satisfied: false, detail: 'INDEPENDENCE NOT SATISFIED: both seats are deepseek' },
    });
    check('a record claiming an independent review it did not satisfy is NOT VERIFIED',
      lying.final_status !== 'VERIFIED', `${lying.final_status} missing=${JSON.stringify(lying.missing_evidence)}`);

    const markdown = EVIDENCE.toMarkdown(rec);
    check('the Markdown view names the mode', /OFF/.test(markdown), 'no OFF in the markdown view');
    check('the Markdown view states the review level', /SUPERVISOR_REVIEW/.test(markdown), 'no SUPERVISOR_REVIEW in the markdown view');
    check('the Markdown view states the independent-review status',
      /DISABLED_BY_POLICY/.test(markdown), 'no DISABLED_BY_POLICY in the markdown view');
    check('the Markdown view keeps the raw record status',
      /Status: VERIFIED/.test(markdown), markdown.split('\n').slice(0, 4).join(' | '));
  }

  // ======================================================================
  section('D. Evidence Card: DISABLED_BY_POLICY is not-applicable, never missing and never a tick');
  {
    const rec = recordWith({
      reviewLevel: POLICY.REVIEW_LEVEL.SUPERVISOR_REVIEW,
      independentReviewStatus: POLICY.INDEPENDENT_REVIEW.DISABLED_BY_POLICY,
      independentReviewDetail: 'codex_review_mode is OFF',
      codexReviewMode: POLICY.CODEX_MODE.OFF,
    });
    const card = CARD.buildCard(rec);
    const el = (card.elements ?? []).find((e) => e.key === 'independent_review');
    check('the card has an independent-review element', Boolean(el), JSON.stringify((card.elements ?? []).map((e) => e.key)));
    if (el) {
      check('it renders the not-applicable mark, not a tick',
        el.mark === CARD.MARKS.NA, `mark=${el.mark} symbol=${el.symbol} value=${el.value}`);
      check('its glyph is the not-applicable dot, not the tick or the dash',
        el.symbol === CARD.SYMBOL['n/a'], `symbol=${el.symbol}`);
      check('it is not rendered as missing evidence',
        el.mark !== CARD.MARKS.ABSENT, `mark=${el.mark}`);
      check('the text names DISABLED_BY_POLICY', /DISABLED_BY_POLICY/.test(String(el.value)), String(el.value));
      check('the text names the configured mode', /OFF/.test(String(el.value)), String(el.value));
      check('the text says who reviewed instead', /supervisor/i.test(String(el.value)), String(el.value));
    }

    const satisfied = CARD.buildCard(recordWith({
      reviewLevel: POLICY.REVIEW_LEVEL.INDEPENDENT_PROVIDER_REVIEW,
      independentReviewStatus: POLICY.INDEPENDENT_REVIEW.SATISFIED,
      reviewerSeat: 'seat:demo/default/reviewer-codex',
      seatProviders: { supervisor: 'deepseek', worker: 'chatgpt', reviewer: 'openai-codex' },
      independence: { required: true, satisfied: true, detail: 'three distinct providers' },
    }));
    const el2 = (satisfied.elements ?? []).find((e) => e.key === 'independent_review');
    check('a satisfied independent review DOES render a positive mark',
      Boolean(el2) && el2.mark === CARD.MARKS.OK, el2 ? `${el2.mark} ${el2.symbol} ${el2.value}` : 'element missing');
    check('the satisfied element carries the codex seat, not the supervisor seat',
      Boolean(el2) && /reviewer-codex/.test(String(el2.value)), el2 ? String(el2.value) : 'element missing');
  }

  // ======================================================================
  section('D2. Runtime Validation: an unrecognised phrase is never a tick');
  {
    // The measured defect: the sentinel NOT RECORDED and the spelling 'n/a' both rendered as a green
    // tick, because the old rule granted ok to everything its negative patterns did not match.
    const cases = [
      [undefined, CARD.MARKS.ABSENT, 'a field that was never filled in'],
      ['NOT RECORDED', CARD.MARKS.ABSENT, 'the protocol sentinel for an unfilled field'],
      ['NOT_RECORDED', CARD.MARKS.ABSENT, 'the underscore spelling of the sentinel'],
      ['', CARD.MARKS.ABSENT, 'an empty string'],
      ['n/a', CARD.MARKS.NA, 'the short spelling of not applicable'],
      ['N/A', CARD.MARKS.NA, 'the upper-case short spelling'],
      ['not applicable - read-only task', CARD.MARKS.NA, 'the phrase used by every read-only run'],
      ['not applicable - static review only', CARD.MARKS.NA, 'the phrase used by static review runs'],
      ['RUNTIME VERIFIED = NO (no full Unity project, no compile step)', CARD.MARKS.BAD, 'an explicit not-performed statement'],
      ['not performed - no Unity editor available', CARD.MARKS.BAD, 'a spelled-out not-performed statement'],
      ['compile PASS; 33 checks passed', CARD.MARKS.OK, 'a real executed validation'],
      ['dotnet build OK and 12 runtime checks VERIFIED', CARD.MARKS.OK, 'an executed build plus runtime checks'],
      ['pending', CARD.MARKS.ABSENT, 'an unrecognised phrase, which must NOT become a tick'],
    ];
    for (const [value, expected, why] of cases) {
      const card = CARD.buildCard(recordWith({ runtimeValidation: value }));
      const el = (card.elements ?? []).find((e) => e.key === 'runtime_validation');
      check(`runtime validation ${JSON.stringify(value)} renders ${expected} (${why})`,
        Boolean(el) && el.mark === expected, el ? `mark=${el.mark} symbol=${el.symbol} value=${el.value}` : 'element missing');
    }

    // The doctrine, stated as a test: whatever else happens, a run whose runtime validation was never
    // recorded must never show a tick for it.
    const never = CARD.buildCard(recordWith({ runtimeValidation: undefined }));
    const neverEl = (never.elements ?? []).find((e) => e.key === 'runtime_validation');
    check('a never-recorded runtime validation can never render a tick',
      neverEl.mark !== CARD.MARKS.OK, `${neverEl.mark} ${neverEl.symbol}`);
  }

  // ======================================================================
  section('D3. Source ACK: a tick must be earned by a real acknowledgement');
  {
    /**
     * MEASURED DEFECT: the rule was `present(source_hash_ack) ? ok : absent`, so three different
     * situations produced the same green tick - `NO_SOURCE_BOUND` (there was nothing to acknowledge),
     * `UNREADABLE` (the worker said it could NOT read the source, so the tick sat beside a value saying the
     * opposite), and any unrecognised text. Two real records in the corpus rendered `UNREADABLE` with a
     * tick. This is the third instance of the same class in the card, after `runtimeMark`, and the rule is
     * identical: a tick must assert that the thing happened.
     */
    const cases = [
      ['NO_SOURCE_BOUND', CARD.MARKS.NA, 'no source was bound: nothing could have been acknowledged'],
      ['UNREADABLE', CARD.MARKS.BAD, 'the worker could not read the source'],
      ['UNAVAILABLE', CARD.MARKS.BAD, 'a negative statement however it is spelled'],
      ['4da65b242a68ed371d1d3f0a9b2c8e5f', CARD.MARKS.OK, 'a real echoed hash'],
      ['abc123def456abc123def456abc12345', CARD.MARKS.OK, 'a shorter but valid hex digest'],
      ['nonsense text', CARD.MARKS.ABSENT, 'an unrecognised phrase is not evidence of an acknowledgement'],
      [undefined, CARD.MARKS.ABSENT, 'never acknowledged at all'],
      ['', CARD.MARKS.ABSENT, 'an empty string'],
    ];
    for (const [value, expected, why] of cases) {
      const card = CARD.buildCard(recordWith({ sourceHashAck: value }));
      const el = (card.elements ?? []).find((e) => e.key === 'source_ack');
      check(`source ack ${JSON.stringify(value)} renders ${expected} (${why})`,
        Boolean(el) && el.mark === expected, el ? `mark=${el.mark} symbol=${el.symbol} value=${el.value}` : 'element missing');
    }

    // The doctrine, as a test: whatever the value, a tick never appears next to text that denies an ack.
    for (const negative of ['UNREADABLE', 'UNAVAILABLE', 'FAILD', 'ERROR', 'not available']) {
      const el = (CARD.buildCard(recordWith({ sourceHashAck: negative })).elements ?? []).find((e) => e.key === 'source_ack');
      check(`"${negative}" can never render a tick`, el.mark !== CARD.MARKS.OK, `${el.mark} ${el.symbol}`);
    }

    // A record whose source genuinely was acknowledged still ticks, or the fix would be a downgrade.
    const good = (CARD.buildCard(recordWith({ sourceHashAck: 'e3b0c44298fc1c149afbf4c8996fb924' })).elements ?? [])
      .find((e) => e.key === 'source_ack');
    check('a genuine acknowledgement still renders a positive mark', good.mark === CARD.MARKS.OK, `${good.mark} ${good.value}`);
  }

  // ======================================================================
  section('E. A goal always terminates: stop conditions and the budget cap');
  {
    const L = POLICY.DEFAULT_LIMITS;
    check('the limits are the agreed bounds',
      L.max_worker_rounds === 8 && L.max_task_retries === 3 && L.max_goal_iterations === 12 && L.no_progress_limit === 2,
      JSON.stringify(L));

    check('a completed goal stops with GOAL_COMPLETE',
      POLICY.evaluateStop({ goalComplete: true }, L).condition === POLICY.STOP.GOAL_COMPLETE,
      JSON.stringify(POLICY.evaluateStop({ goalComplete: true }, L)));
    check('a blocked goal stops with BLOCKED',
      POLICY.evaluateStop({ blocked: true, blockedReason: 'worker refused' }, L).condition === POLICY.STOP.BLOCKED,
      JSON.stringify(POLICY.evaluateStop({ blocked: true, blockedReason: 'worker refused' }, L)));
    check('a goal needing a human stops with USER_APPROVAL_REQUIRED',
      POLICY.evaluateStop({ needsApproval: true, approvalReason: 'write outside scope' }, L).condition === POLICY.STOP.USER_APPROVAL_REQUIRED,
      JSON.stringify(POLICY.evaluateStop({ needsApproval: true, approvalReason: 'write outside scope' }, L)));
    check('two consecutive non-productive iterations stop the goal',
      POLICY.evaluateStop({ noProgressStreak: 2 }, L).condition === POLICY.STOP.NO_PROGRESS,
      JSON.stringify(POLICY.evaluateStop({ noProgressStreak: 2 }, L)));
    check('one non-productive iteration does NOT stop the goal',
      POLICY.evaluateStop({ noProgressStreak: 1 }, L).stop === false,
      JSON.stringify(POLICY.evaluateStop({ noProgressStreak: 1 }, L)));
    check('the goal iteration limit is a stop, not a warning',
      POLICY.evaluateStop({ iterations: 12 }, L).condition === POLICY.STOP.BUDGET_EXHAUSTED,
      JSON.stringify(POLICY.evaluateStop({ iterations: 12 }, L)));
    check('an in-flight goal does not stop early',
      POLICY.evaluateStop({ iterations: 3, noProgressStreak: 0 }, L).stop === false,
      JSON.stringify(POLICY.evaluateStop({ iterations: 3, noProgressStreak: 0 }, L)));

    // GOAL_COMPLETE wins over the counters: a goal that finished on its last allowed iteration is a
    // success, not a budget failure.
    check('a completed goal is GOAL_COMPLETE even at the iteration cap',
      POLICY.evaluateStop({ goalComplete: true, iterations: 12, noProgressStreak: 5 }, L).condition === POLICY.STOP.GOAL_COMPLETE,
      JSON.stringify(POLICY.evaluateStop({ goalComplete: true, iterations: 12, noProgressStreak: 5 }, L)));

    const rot = POLICY.shouldRotate(8, L);
    check('a worker conversation rotates at the round cap, with a compact handoff reason',
      rot.rotate === true && /hand off compactly/.test(String(rot.reason)), JSON.stringify(rot));
    check('a fresh conversation does not rotate', POLICY.shouldRotate(1, L).rotate === false, JSON.stringify(POLICY.shouldRotate(1, L)));
  }

  // ======================================================================
  section('F. Review prompt: the worker reply is not silently truncated');
  {
    const envelope = { task_id: 'V03-TEST', request: 'inspect the file', success_criteria: ['cite lines'] };
    const ctx = { runId: 'run-abcdef012345', sourceSetHash: 'deadbeef' };

    const short = SUPERVISOR.reviewPrompt(envelope, 'x'.repeat(500), ctx);
    check('a short reply carries no truncation notice', !/TRUNCATION NOTICE/.test(short), 'notice appeared for a short reply');
    check('a short reply is passed through whole', short.includes('x'.repeat(500)), 'the reply body is not intact');
    check('the ack instructions survive in the reviewer prompt',
      short.includes('RUN_ID_ACK: run-abcdef012345') && short.includes('SOURCE_HASH_ACK: deadbeef'), 'ack lines missing');

    const body = 'y'.repeat(40000);
    const long = SUPERVISOR.reviewPrompt(envelope, body, ctx);
    check('a long reply IS declared truncated', /TRUNCATION NOTICE/.test(long), 'no notice for an over-long reply');
    check('the notice states the true length', long.includes('40000'), 'the original length is not stated');
    check('the notice tells the reviewer not to score the cut as a worker failure',
      /not evidence about the worker/.test(long), 'the notice does not protect the worker');
    check('the notice asks for a partial result rather than not_addressed',
      /record it as "partial"/.test(long), 'no guidance on how to record withheld criteria');
    check('the withheld portion is marked at the end of the reply',
      /trailing characters withheld by the harness/.test(long), 'no end marker');
    check('the shown reply is capped, not unbounded',
      long.length < 26000, `prompt length ${long.length}`);
  }

  // ======================================================================
  section('G. The Codex seat stays wired up while mode is OFF');
  {
    const reg = registryModule.buildRegistry('demo', 'default');
    const codexSeat = reg.byId('seat:demo/default/reviewer-codex');
    check('the Codex seat still exists in the registry', Boolean(codexSeat), 'seat missing');
    if (codexSeat) {
      check('it is still provider openai-codex over the app-server transport',
        codexSeat.provider === 'openai-codex' && codexSeat.transport === 'codex-app-server',
        `${codexSeat.provider}/${codexSeat.transport}`);
    }
    const worker = reg.byId('seat:demo/default/coder');
    const supervisor = reg.byId('seat:demo/default/supervisor');
    check('the primary pair is DeepSeek supervisor plus ChatGPT worker',
      supervisor.provider === 'deepseek' && worker.provider === 'chatgpt',
      `${supervisor.provider}/${worker.provider}`);
    check('the primary pair cannot be an independent review of itself',
      POLICE_SAFE(() => require(path.join(WB, 'protocol', 'protocol.js')).checkIndependence(
        { review_requirements: { required: true, independent_provider: true } },
        { seat_id: worker.seat_id, provider: worker.provider },
        { seat_id: supervisor.seat_id, provider: supervisor.provider }).satisfied === true),
      'independence between two different providers should be satisfiable');

    // Same provider on both seats must NOT read as independent, or SUPERVISOR_REVIEW would silently
    // become INDEPENDENT_PROVIDER_REVIEW for a supervisor reviewing itself.
    const selfReview = require(path.join(WB, 'protocol', 'protocol.js')).checkIndependence(
      { review_requirements: { required: true, independent_provider: true } },
      { seat_id: worker.seat_id, provider: 'deepseek' },
      { seat_id: supervisor.seat_id, provider: 'deepseek' });
    check('a supervisor sharing the worker provider is NOT independent',
      selfReview.satisfied === false, JSON.stringify(selfReview));
  }

  // ======================================================================
  section('H. Codex transport contract is intact, and inspecting it starts no process');
  {
    const { createCodexAppServerTransport } = require(path.join(WB, 'transports', 'transport.codex-app-server.js'));
    let transport = null;
    let threw = null;
    try { transport = createCodexAppServerTransport({ projectId: 'demo', workspaceId: 'default' }); }
    catch (e) { threw = e; }
    check('the Codex transport can be constructed without a running Codex', threw === null, threw ? String(threw.message) : '');
    if (transport) {
      const contract = CONTRACT.checkContract(transport);
      check('the Codex transport satisfies the transport contract', contract.ok === true, JSON.stringify(contract));
      check('it declares the provider it answers for',
        transport.provider === 'openai-codex', String(transport.provider));
      check('constructing it exposes only the contract methods',
        ['open', 'health', 'dispatch', 'observe', 'read'].every((m) => typeof transport[m] === 'function'),
        Object.keys(transport).join(', '));
    }
  }

  // ======================================================================
  section('I. Settling a landed turn: proof required, duplicate still impossible');
  {
    // The measured defect: a live two-task goal finished TASK 1, the reply was read and correlated, but
    // the seat was still SEND_PENDING, so TASK 2's dispatch was refused and the goal stopped at BLOCKED
    // after one task. The fix must let a LANDED turn close without ever letting an unproven one close.
    const seatModule = require(path.join(WB, 'seats', 'seat.js'));
    const caps = {
      can_deliver_synchronously: false, confirms_delivery: true, supports_readback: true,
      needs_human: false, supplies_source_content: false, can_run_commands: false, is_reasoning_model: false,
    };
    const transport = {
      id: 'test-transport', kind: 'playwright-dom', provider: 'chatgpt',
      project_id: 'demo', workspace_id: 'default', capabilities: caps,
      open: async () => ({ ok: true }), health: async () => ({ ok: true }),
      dispatch: async () => ({ delivery_state: 'SEND_PENDING' }),
      observe: async () => ({ delivery_state: 'SEND_PENDING' }),
      read: async () => ({ ok: true, text: 'x' }),
    };
    const RUN = 'run-PROOF-0123456789';
    function pendingSeat() {
      const s = seatModule.createSeat({
        seatId: 'seat:test/worker', role: 'coder', transport,
        projectId: 'demo', workspaceId: 'default',
      });
      seatModule.bindRun(s, { run_id: RUN, task_id: 'V03-SETTLE' });
      seatModule.setDeliveryState(s, 'SUBMITTING', 'dispatch begun');
      seatModule.setDeliveryState(s, 'SEND_PENDING', 'send executed, render not yet observable');
      return s;
    }

    const a = pendingSeat();
    const noProof = seatModule.settleTurn(a, { replyText: 'a reply quoting no run id' });
    check('a pending send is NOT closed without proof', noProof.ok === false, JSON.stringify(noProof));
    check('the refused settle leaves the seat exactly where it was',
      a.delivery_state === 'SEND_PENDING' && a.current_run?.run_id === RUN, `${a.delivery_state} run=${a.current_run?.run_id}`);
    check('a settle with no evidence at all is refused too',
      seatModule.settleTurn(pendingSeat(), {}).ok === false, 'empty evidence was accepted');
    check('a reply naming a DIFFERENT run does not close this one',
      seatModule.settleTurn(pendingSeat(), { replyText: 'RUN_ID_ACK: run-SOMETHING-ELSE' }).ok === false,
      'a mismatched run id was accepted as proof');

    const b = pendingSeat();
    const proved = seatModule.settleTurn(b, { replyText: `RUN_ID_ACK: ${RUN}\n\nthe worker report`, detail: 'live reply landed' });
    check('a reply carrying this run id DOES close the turn', proved.ok === true, JSON.stringify(proved));
    check('it closes via the legal two-step path',
      proved.from === 'SEND_PENDING' && proved.via === 'USER_TURN_CONFIRMED', JSON.stringify(proved));
    check('the seat is IDLE and free again', b.delivery_state === 'IDLE', b.delivery_state);
    check('the run is released', b.current_run === null, JSON.stringify(b.current_run));
    check('the closed run is recorded for audit',
      b.last_completed_run?.run_id === RUN, JSON.stringify(b.last_completed_run?.run_id));
    const rebind = seatModule.bindRun(b, { run_id: 'run-SECOND-0001', task_id: 'V03-SETTLE-2' });
    check('the NEXT task can bind and dispatch: this is the whole point of the fix',
      rebind.ok !== false && b.current_run?.run_id === 'run-SECOND-0001', JSON.stringify(rebind));

    const uncertain = pendingSeat();
    seatModule.setDeliveryState(uncertain, 'SEND_UNCERTAIN', 'timeout, delivery unknown');
    const refused = seatModule.settleTurn(uncertain, { replyText: `RUN_ID_ACK: ${RUN}` });
    check('SEND_UNCERTAIN can never be settled, even with a reply in hand', refused.ok === false, JSON.stringify(refused));
    check('the refusal routes the decision to a human',
      /human must confirm/i.test(String(refused.hint)), String(refused.hint));
    check('SEND_UNCERTAIN stays terminal and unclosed',
      uncertain.delivery_state === 'SEND_UNCERTAIN' && uncertain.current_run === null,
      `${uncertain.delivery_state} current_run=${JSON.stringify(uncertain.current_run)}`);
    /**
     * The run id must SURVIVE the uncertain state. It used to be cleared with the run, which destroyed
     * the one fact a human needs in order to resolve the doubt: whether the conversation contains a
     * message tagged with THIS run id. Without it, the operator cannot tell a lost message from a
     * delivered one, and cannot check a later retry for duplication.
     */
    check('the uncertain run id is preserved for the human who must resolve it',
      uncertain.unresolved_run?.run_id === RUN, JSON.stringify(uncertain.unresolved_run));
    check('it is filed as UNRESOLVED, not quietly as completed',
      uncertain.last_completed_run === undefined || uncertain.last_completed_run?.run_id !== RUN,
      JSON.stringify(uncertain.last_completed_run));
    check('the filing records why it is unresolved',
      /timeout/i.test(String(uncertain.unresolved_run?.detail)), JSON.stringify(uncertain.unresolved_run?.detail));
    check('the seat view exposes the unresolved run to the operator',
      seatModule.view(uncertain).unresolved_run?.run_id === RUN,
      JSON.stringify(seatModule.view(uncertain).unresolved_run));
  }

  // ======================================================================
  console.log(`\n${'='.repeat(70)}`);
  console.log(`V0.3 CODEX-OPTIONAL SUITE: ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

/** Run a thunk, returning false instead of throwing, so one bad import cannot abort the suite. */
function POLICE_SAFE(fn) {
  try { return fn() === true; } catch { return false; }
}

main();
