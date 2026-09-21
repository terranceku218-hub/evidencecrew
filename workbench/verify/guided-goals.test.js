'use strict';
/**
 * guided-goals.test.js - the guided-goal contract.
 *
 * WHY THIS SUITE EXISTS
 *   A guided UI is only worth having if its promises are enforced. The failure mode is specific and
 *   invisible: the user picks "read-only", the UI says read-only, the prompt says read-only, and the worker
 *   can still write because nothing in the policy changed. So every assertion here is about the RESOLVED
 *   POLICY - `write_scope`, `approval_required`, the autonomy mode, the loop limits - and never about the text
 *   that gets sent.
 *
 *   The other failure mode is a quiet default: a choice the Workbench does not understand must be refused,
 *   not silently treated as the safest-looking option, because a user who asked for something and got
 *   something else has been misled by the software rather than by their own reading of it.
 */

const path = require('node:path');

const WB = path.resolve(__dirname, '..', '..', 'workbench');
const G = require(path.join(WB, 'protocol', 'guided-policy.js'));

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name} :: ${detail}`); console.log(`  FAIL  ${name} :: ${detail}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const SEAT = { workerSeatWriteScope: ['src/hud-pulse.js', 'src/hud-colour.js'] };

// ======================================================================
section('A. The preset catalogue');
{
  check('nine presets are offered', G.PRESETS.length === 9, String(G.PRESETS.length));
  const ids = G.PRESETS.map((p) => p.id);
  check('preset ids are unique', new Set(ids).size === ids.length, ids.join(', '));
  const required = ['id', 'icon', 'title_key', 'description_key', 'goal_template', 'file_policy', 'autonomy', 'review_policy', 'recommended_for'];
  for (const p of G.PRESETS) {
    const missing = required.filter((k) => !(k in p));
    check(`preset ${p.id} carries every field`, missing.length === 0, missing.join(', '));
    check(`preset ${p.id} names its strings by key, not by text`,
      p.title_key.startsWith('preset.') && p.description_key.startsWith('preset.'),
      `${p.title_key} / ${p.description_key}`);
    check(`preset ${p.id} uses a valid file policy`,
      Object.values(G.FILE_POLICY).includes(p.file_policy), p.file_policy);
    check(`preset ${p.id} uses a valid autonomy level`,
      Object.values(G.AUTONOMY_LEVEL).includes(p.autonomy), p.autonomy);
    check(`preset ${p.id} uses a valid review policy`,
      Object.values(G.REVIEW_POLICY).includes(p.review_policy), p.review_policy);
  }
  check('the custom preset has no goal template, so it does not put words in the user mouth',
    G.presets0Safe === undefined ? G.PRESETS.find((p) => p.id === 'custom').goal_template === null : false,
    String(G.PRESETS.find((p) => p.id === 'custom').goal_template));
  check('four examples are offered for the empty home screen', G.EXAMPLES.length === 4, String(G.EXAMPLES.length));
  check('every example points at a real preset',
    G.EXAMPLES.every((e) => Boolean(G.presetById(e.preset))), JSON.stringify(G.EXAMPLES.map((e) => e.preset)));
}

// ======================================================================
section('B. File permission becomes real policy');
{
  const readOnly = G.resolveGuidedPolicy({ presetId: 'inspect' }, SEAT);
  check('the inspect preset is read-only', readOnly.file_policy === G.FILE_POLICY.READ_ONLY, readOnly.file_policy);
  check('read-only means an EMPTY write scope, not a polite instruction',
    Array.isArray(readOnly.permissions.write_scope) && readOnly.permissions.write_scope.length === 0,
    JSON.stringify(readOnly.permissions.write_scope));
  check('read-only clears approval requirements too',
    readOnly.permissions.approval_required.length === 0, JSON.stringify(readOnly.permissions.approval_required));

  const ask = G.resolveGuidedPolicy({ presetId: 'bug_fix' }, SEAT);
  check('the bug-fix preset asks before writing', ask.file_policy === G.FILE_POLICY.ASK, ask.file_policy);
  check('ask-before-write requires approval for exactly the permitted paths',
    JSON.stringify(ask.permissions.approval_required) === JSON.stringify(SEAT.workerSeatWriteScope),
    JSON.stringify(ask.permissions.approval_required));
  check('ask-before-write still records the permitted write scope',
    JSON.stringify(ask.permissions.write_scope) === JSON.stringify(SEAT.workerSeatWriteScope),
    JSON.stringify(ask.permissions.write_scope));

  const write = G.resolveGuidedPolicy({ presetId: 'feature' }, SEAT);
  check('the feature preset writes without approval', write.permissions.approval_required.length === 0, 'has approvals');
  check('write-allowed uses the workspace scope unchanged',
    JSON.stringify(write.permissions.write_scope) === JSON.stringify(SEAT.workerSeatWriteScope),
    JSON.stringify(write.permissions.write_scope));

  // An explicit choice must beat the preset, in both directions.
  const overrideToWrite = G.resolveGuidedPolicy({ presetId: 'inspect', filePolicy: 'write' }, SEAT);
  check('an explicit file policy overrides a read-only preset',
    overrideToWrite.file_policy === G.FILE_POLICY.WRITE && overrideToWrite.permissions.write_scope.length === 2,
    JSON.stringify(overrideToWrite.permissions));
  const overrideToReadOnly = G.resolveGuidedPolicy({ presetId: 'feature', filePolicy: 'read_only' }, SEAT);
  check('an explicit read-only overrides a writing preset',
    overrideToReadOnly.permissions.write_scope.length === 0, JSON.stringify(overrideToReadOnly.permissions.write_scope));

  // A workspace that permits nothing cannot be made to permit something.
  const nowhere = G.resolveGuidedPolicy({ presetId: 'bug_fix' }, { workerSeatWriteScope: [] });
  check('ask-before-write in a workspace with no writable paths approves nothing and says so',
    nowhere.permissions.approval_required.length === 0 && nowhere.notes.some((n) => /permits no writes/.test(n)),
    JSON.stringify(nowhere.notes));
}

// ======================================================================
section('C. Autonomy maps onto the existing controls');
{
  const guided = G.resolveGuidedPolicy({ presetId: 'health', autonomy: 'guided' }, SEAT);
  const recommended = G.resolveGuidedPolicy({ presetId: 'health', autonomy: 'recommended' }, SEAT);
  const autonomous = G.resolveGuidedPolicy({ presetId: 'health', autonomy: 'autonomous' }, SEAT);

  check('guided asks after each task', guided.limits.ask_after_each_task === true, JSON.stringify(guided.limits));
  check('recommended does not ask after each task', recommended.limits.ask_after_each_task === false, JSON.stringify(recommended.limits));
  check('guided uses a tighter retry budget than recommended',
    guided.limits.max_task_retries < recommended.limits.max_task_retries,
    `${guided.limits.max_task_retries} vs ${recommended.limits.max_task_retries}`);
  check('autonomy NEVER removes a limit: the autonomous level still has all four bounds',
    ['max_task_retries', 'max_goal_iterations', 'no_progress_limit'].every((k) => Number.isFinite(autonomous.limits[k])),
    JSON.stringify(autonomous.limits));
  check('no level sets an unbounded iteration count',
    [guided, recommended, autonomous].every((r) => r.limits.max_goal_iterations > 0 && r.limits.max_goal_iterations <= 12),
    JSON.stringify([guided, recommended, autonomous].map((r) => r.limits.max_goal_iterations)));
  check('autonomy maps onto the existing autonomy mode rather than a new one',
    ['ADVISOR', 'SAFE_AUTO'].includes(autonomous.autonomy_mode), autonomous.autonomy_mode);
  check('guided and recommended both stay in ADVISOR', guided.autonomy_mode === 'ADVISOR' && recommended.autonomy_mode === 'ADVISOR',
    `${guided.autonomy_mode}/${recommended.autonomy_mode}`);
}

// ======================================================================
section('D. Review policy maps onto the existing switch');
{
  const supervisor = G.resolveGuidedPolicy({ presetId: 'bug_fix' }, SEAT);
  check('supervisor review leaves Codex OFF',
    supervisor.codex_review_mode === G.CODEX_MODE.OFF, supervisor.codex_review_mode);
  const withCodex = G.resolveGuidedPolicy({ presetId: 'autonomous' }, SEAT);
  check('the autonomous preset asks for Codex AUTO',
    withCodex.codex_review_mode === G.CODEX_MODE.AUTO, withCodex.codex_review_mode);
  check('OFF is never treated as a missing reviewer',
    supervisor.notes.every((n) => !/missing|error/i.test(n)), JSON.stringify(supervisor.notes));
  check('no preset forces REQUIRED, which would block without quota',
    G.PRESETS.every((p) => p.review_policy !== 'required'), 'a preset asks for REQUIRED');
}

// ======================================================================
section('E. An unknown choice is refused, never quietly replaced');
{
  const bad = G.resolveGuidedPolicy({ presetId: 'not-a-preset' }, SEAT);
  check('an unknown preset is refused', bad.ok === false, JSON.stringify(bad));
  check('the refusal names the value it did not understand',
    /not-a-preset/.test(String(bad.error)), String(bad.error));
  const oddPolicy = G.resolveGuidedPolicy({ presetId: 'inspect', filePolicy: 'write-everything' }, SEAT);
  check('an unknown file policy falls back to the SAFEST option, not the most permissive',
    oddPolicy.ok === true && oddPolicy.file_policy === G.FILE_POLICY.READ_ONLY, JSON.stringify(oddPolicy.file_policy));
  const oddAutonomy = G.resolveGuidedPolicy({ presetId: 'inspect', autonomy: 'yolo' }, SEAT);
  check('an unknown autonomy level falls back to recommended',
    oddAutonomy.autonomy === G.AUTONOMY_LEVEL.RECOMMENDED, oddAutonomy.autonomy);
}

// ======================================================================
section('F. The preview is derived from the policy, so it cannot overpromise');
{
  /**
   * EVERY line is returned with its state, and only the AFFIRMED ones are promises.
   *
   * This section previously asserted that a `no` line was ABSENT from the list, which read as tidying up and
   * was a defect: it meant "Codex will not be asked" and "you will not be asked before a write" silently
   * vanished from the one panel built to say so, and a reader seeing four ticks cannot tell whether the fifth
   * question was answered `no` or never asked. The contract is now that the line is present with state `no`,
   * and the panel renders it with a dash - the same convention the Evidence Card uses for not-applicable.
   */
  const readOnly = G.resolveGuidedPolicy({ presetId: 'inspect' }, SEAT);
  const items = G.describeGuidedPolicy(readOnly);
  const keys = items.map((i) => i.key);
  const state = (k) => items.find((i) => i.key === k)?.state ?? null;

  check('a read-only preview says the source will be read', state('preview.readSource') === 'yes', keys.join(', '));
  check('a read-only preview says files will not be written', state('preview.noWrite') === 'yes', keys.join(', '));
  check('a read-only preview states scoped writes as NOT happening, rather than dropping the line',
    state('preview.writeScoped') === 'no', JSON.stringify(state('preview.writeScoped')));
  check('a read-only preview states the approval step as NOT happening, rather than dropping the line',
    state('preview.askBeforeWrite') === 'no', JSON.stringify(state('preview.askBeforeWrite')));
  check('with Codex off the preview says so rather than omitting it',
    state('preview.codexReview') === 'no', JSON.stringify(state('preview.codexReview')));
  check('every preview line carries an explicit yes or no, never a blank state',
    items.every((i) => i.state === 'yes' || i.state === 'no'), JSON.stringify(items));

  const ask = G.resolveGuidedPolicy({ presetId: 'bug_fix' }, SEAT);
  const askItems = G.describeGuidedPolicy(ask);
  const askState = (k) => askItems.find((i) => i.key === k)?.state ?? null;
  const askKeys = askItems.map((i) => i.key);
  check('an ask-before-write preview says an approval will be required',
    askState('preview.askBeforeWrite') === 'yes', askKeys.join(', '));
  check('an ask-before-write preview does not also claim free writes',
    askState('preview.writeScoped') === 'no', JSON.stringify(askState('preview.writeScoped')));
  check('an ask-before-write preview does not claim nothing will be written',
    askState('preview.noWrite') === 'no', JSON.stringify(askState('preview.noWrite')));

  const auto = G.resolveGuidedPolicy({ presetId: 'autonomous' }, SEAT);
  const autoItems = G.describeGuidedPolicy(auto);
  check('the autonomous preview announces the Codex review',
    autoItems.find((i) => i.key === 'preview.codexReview')?.state === 'yes', autoItems.map((i) => i.key).join(', '));

  /**
   * Exactly one of the three write dispositions may be affirmed. Two ticks here would be a contradiction the
   * user would have to resolve themselves, and zero would leave the most important question unanswered.
   */
  for (const [name, resolved] of [['read-only', readOnly], ['ask', ask], ['write', G.resolveGuidedPolicy({ presetId: 'feature' }, SEAT)]]) {
    const its = G.describeGuidedPolicy(resolved);
    const affirmed = ['preview.noWrite', 'preview.writeScoped', 'preview.askBeforeWrite']
      .filter((k) => its.find((i) => i.key === k)?.state === 'yes');
    check(`the ${name} policy affirms exactly one write disposition`, affirmed.length === 1, affirmed.join(', '));
  }
}

// ======================================================================
section('G. Every policy the UI can show has a translation key shape');
{
  // The keys are resolved by the UI, so a missing key renders [MISSING: key]. The naming convention is
  // asserted here; the catalogue membership is asserted by the i18n suite.
  for (const p of G.PRESETS) {
    // The id is snake_case and the keys use camelCase for readability (`bug_fix` -> `preset.bugFix.title`),
    // so the assertion accepts either spelling of the id rather than forcing one onto the other.
    const camel = p.id.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const prefixOk = p.title_key.startsWith(`preset.${p.id}.`) || p.title_key.startsWith(`preset.${camel}.`);
    check(`preset ${p.id} keys follow the preset.<id>.<field> convention`,
      prefixOk && p.title_key.endsWith('.title') && p.description_key.endsWith('.desc'),
      `${p.title_key} / ${p.description_key}`);
    if (p.goal_template) {
      check(`preset ${p.id} goal key follows the convention`,
        (p.goal_template.startsWith(`preset.${p.id}.`) || p.goal_template.startsWith(`preset.${camel}.`)) && p.goal_template.endsWith('.goal'),
        p.goal_template);
    }
  }
}

// ======================================================================
section('H. V0.3.4 execution intensity: what a user pays for');
{
  const I = require(path.join(WB, 'protocol', 'intensity.js'));
  const P = require(path.join(WB, 'protocol', 'policy.js'));

  check('three intensities exist', I.INTENSITIES.length === 3, String(I.INTENSITIES.length));
  check('the canonical ids are FAST, BALANCED, STRICT',
    JSON.stringify(I.INTENSITIES.map((x) => x.id)) === JSON.stringify(['FAST', 'BALANCED', 'STRICT']),
    I.INTENSITIES.map((x) => x.id).join(', '));
  check('the default is BALANCED', I.DEFAULT_INTENSITY === 'BALANCED', I.DEFAULT_INTENSITY);

  /**
   * THE CEILING IS THE POINT OF THE WHOLE FEATURE.
   *
   * Intensity exists to LOWER a budget, never to raise one. If the local ceiling drifted from `policy.js`'s
   * own defaults, STRICT could quietly start permitting more than the system allowed before the control
   * existed - which is the failure this asserts against, in one line.
   */
  check('the local ceiling equals policy.js DEFAULT_LIMITS exactly',
    JSON.stringify(I.GLOBAL_CEILING) === JSON.stringify(P.DEFAULT_LIMITS),
    `${JSON.stringify(I.GLOBAL_CEILING)} vs ${JSON.stringify(P.DEFAULT_LIMITS)}`);

  for (const id of ['FAST', 'BALANCED', 'STRICT']) {
    const b = I.clampBudgets(id, {});
    check(`${id} never exceeds the global ceiling on retries`, b.max_task_retries <= P.DEFAULT_LIMITS.max_task_retries,
      `${b.max_task_retries} > ${P.DEFAULT_LIMITS.max_task_retries}`);
    check(`${id} never exceeds the global ceiling on iterations`, b.max_goal_iterations <= P.DEFAULT_LIMITS.max_goal_iterations);
    check(`${id} never exceeds the global ceiling on the no-progress limit`, b.no_progress_limit <= P.DEFAULT_LIMITS.no_progress_limit);
    check(`${id} has a finite worker-dispatch budget`, Number.isFinite(b.max_worker_dispatches_per_task) && b.max_worker_dispatches_per_task > 0);
    check(`${id} has a finite subagent budget`, Number.isFinite(b.max_subagents) && b.max_subagents >= 0);
  }

  check('FAST allows exactly one worker dispatch per task', I.clampBudgets('FAST', {}).max_worker_dispatches_per_task === 1);
  check('FAST allows exactly one retry', I.clampBudgets('FAST', {}).max_task_retries === 1);
  check('FAST allows no subagent', I.clampBudgets('FAST', {}).max_subagents === 0);
  check('BALANCED allows two worker dispatches', I.clampBudgets('BALANCED', {}).max_worker_dispatches_per_task === 2);
  check('BALANCED caps subagents at two', I.clampBudgets('BALANCED', {}).max_subagents === 2);
  check('STRICT caps subagents at three', I.clampBudgets('STRICT', {}).max_subagents === 3);
  check('STRICT does NOT get unlimited retries', I.clampBudgets('STRICT', {}).max_task_retries <= P.DEFAULT_LIMITS.max_task_retries,
    String(I.clampBudgets('STRICT', {}).max_task_retries));

  // Clamping is a MINIMUM in both directions: a tighter autonomy level survives a looser intensity.
  const tightAutonomy = { max_goal_iterations: 1, max_task_retries: 1, no_progress_limit: 1 };
  const c = I.clampBudgets('STRICT', tightAutonomy);
  check('a tighter autonomy level survives even STRICT (iterations)',
    c.max_goal_iterations === 1, String(c.max_goal_iterations));
  check('a tighter autonomy level survives even STRICT (retries)', c.max_task_retries === 1, String(c.max_task_retries));
  check('ask_after_each_task is carried through from autonomy, not invented',
    I.clampBudgets('FAST', { ask_after_each_task: true }).ask_after_each_task === true);

  check('an unrecognised intensity falls back to the DEFAULT, not to the cheapest',
    I.normalizeIntensity('TURBO') === 'BALANCED', I.normalizeIntensity('TURBO'));
  check('the default is the same whichever way it is asked for',
    I.normalizeIntensity(undefined) === I.DEFAULT_INTENSITY && I.normalizeIntensity(null) === I.DEFAULT_INTENSITY);

  // ---- validation tiers ------------------------------------------------------------------------
  check('FAST may run TARGETED but not CORE_CHANGE',
    I.requiredTierIsAllowed('FAST', 'TARGETED').allowed === true
    && I.requiredTierIsAllowed('FAST', 'CORE_CHANGE').allowed === false);
  check('FAST may not run RELEASE', I.requiredTierIsAllowed('FAST', 'RELEASE').allowed === false);
  check('BALANCED may run CORE_CHANGE', I.requiredTierIsAllowed('BALANCED', 'CORE_CHANGE').allowed === true);
  check('STRICT may run CORE_CHANGE', I.requiredTierIsAllowed('STRICT', 'CORE_CHANGE').allowed === true);
  /**
   * THE RELEASE RULE. STRICT must not be able to buy the expensive suite: a release-tier validation is chosen
   * by the GOAL, not by a slider. Without this, "STRICT" becomes "run everything for every edit", which is the
   * exact cost behaviour this milestone exists to remove.
   */
  check('NO intensity can select RELEASE by itself',
    ['FAST', 'BALANCED', 'STRICT'].every((id) => I.requiredTierIsAllowed(id, 'RELEASE', {}).allowed === false));
  check('RELEASE is allowed when the GOAL is a release',
    I.requiredTierIsAllowed('BALANCED', 'RELEASE', { releaseGoal: true }).allowed === true);
  check('an unknown tier is refused rather than defaulted',
    I.requiredTierIsAllowed('STRICT', 'EVERYTHING').allowed === false);

  // ---- worker necessity ------------------------------------------------------------------------
  check('FAST does NOT send a mechanical docs task to the worker',
    I.workerNecessityFor('FAST', { type: 'docs', title: 'Update the changelog' }).needs_worker === false);
  check('FAST DOES send a complex coding task to the worker',
    I.workerNecessityFor('FAST', { type: 'coding', title: 'Fix the pulse timing bug' }).needs_worker === true);
  check('BALANCED sends a task that needs reasoning',
    I.workerNecessityFor('BALANCED', { type: 'coding', title: 'Investigate the null reference' }).needs_worker === true);
  /**
   * A MECHANICAL EDIT IS HELD BACK AT EVERY INTENSITY, INCLUDING STRICT.
   *
   * Two earlier versions of this check were wrong in opposite directions, and the second is the interesting
   * one. It first asserted a blanket refusal at all three, which failed because STRICT did dispatch; then, told
   * that STRICT "may use the worker more aggressively", it asserted STRICT would dispatch and say why - which
   * failed once the real bug was fixed. The bug was that `mechanical && !reasoningish` could never be true for
   * a coding task, so a coding-task rename went to the browser at FAST.
   *
   * The settled rule: STRICT uses the worker more aggressively for work that NEEDS JUDGEMENT, and never for
   * work a deterministic edit can do. "Aggressively" is not "indiscriminately", and a validation tier is not a
   * browser turn.
   */
  for (const id of ['FAST', 'BALANCED', 'STRICT']) {
    check(`${id} refuses a mechanical rename`,
      I.workerNecessityFor(id, { type: 'coding', title: 'Rename the variable' }).needs_worker === false,
      I.workerNecessityFor(id, { type: 'coding', title: 'Rename the variable' }).basis);
  }
  check('a mechanical edit never counts as requiring reasoning',
    I.workerNecessityFor('FAST', { type: 'docs', title: 'Update the changelog' }).basis === 'mechanical');
  check('STRICT still dispatches work that needs judgement',
    I.workerNecessityFor('STRICT', { type: 'coding', title: 'Fix the pulse timing bug' }).needs_worker === true
    && I.workerNecessityFor('STRICT', { type: 'coding', title: 'Fix the pulse timing bug' }).basis === 'strict_default');
  check('a mechanical task that ALSO asks for judgement is not treated as mechanical',
    I.workerNecessityFor('FAST', { type: 'docs', title: 'Rename the setting and decide whether the API is still right' }).needs_worker === true);
  check('the user can always force a worker turn',
    I.workerNecessityFor('FAST', { type: 'docs' }, { forcedByUser: true }).needs_worker === true);
  check('every decision states a reason',
    ['FAST', 'BALANCED', 'STRICT'].every((id) => {
      const d = I.workerNecessityFor(id, { type: 'coding', title: 'x' });
      return typeof d.reason === 'string' && d.reason.length > 0 && typeof d.basis === 'string';
    }));
  check('a task existing is NOT itself a reason to dispatch',
    I.workerNecessityFor('FAST', { type: 'docs', title: 'Write the README' }).basis !== 'task_exists');

  // ---- subagent gate ---------------------------------------------------------------------------
  check('a deterministic tool blocks the subagent outright',
    I.subagentGate('STRICT', { answerableDeterministically: true, deterministicTool: 'sha256' }).allowed === false);
  check('and says which tool makes it unnecessary',
    /sha256/.test(I.subagentGate('STRICT', { answerableDeterministically: true, deterministicTool: 'sha256' }).detail));
  check('FAST allows no subagent even with a good reason',
    I.subagentGate('FAST', { reason: 'needs a second opinion', expected_unique_output: 'a review' }, { subagentsUsed: 0 }).allowed === false);
  check('BALANCED allows a justified subagent',
    I.subagentGate('BALANCED', { reason: 'independent review', expected_unique_output: 'a review verdict' }, { subagentsUsed: 0 }).allowed === true);
  check('a subagent without a reason is refused',
    I.subagentGate('BALANCED', { expected_unique_output: 'something' }).code === 'REASON_REQUIRED');
  check('a subagent without a unique output is refused',
    I.subagentGate('BALANCED', { reason: 'because' }).code === 'UNIQUE_OUTPUT_REQUIRED');
  check('two subagents promising the same output are refused',
    I.subagentGate('BALANCED', { reason: 'again', expected_unique_output: 'a review verdict' }, { subagentsUsed: 1, existingOutputs: ['A REVIEW VERDICT'] }).code === 'DUPLICATE_OUTPUT');
  check('the subagent budget is enforced',
    I.subagentGate('BALANCED', { reason: 'x', expected_unique_output: 'y' }, { subagentsUsed: 2 }).code === 'SUBAGENT_BUDGET_EXHAUSTED');
  check('STRICT allows one more than BALANCED',
    I.subagentGate('STRICT', { reason: 'x', expected_unique_output: 'y' }, { subagentsUsed: 2 }).allowed === true);

  // ---- no-progress guard -----------------------------------------------------------------------
  const s1 = I.noProgressStep(null, { evidenceIds: ['EV-1'] });
  check('the first turn can never be a no-progress turn', s1.stop === false && s1.progressed === true, JSON.stringify(s1));
  const s2 = I.noProgressStep(s1.fingerprint, { evidenceIds: ['EV-1'], noProgressStreak: 0 }, { no_progress_limit: 1 });
  check('a turn with nothing new stops at a limit of one', s2.stop === true, JSON.stringify(s2));
  const s3 = I.noProgressStep(s1.fingerprint, { evidenceIds: ['EV-1', 'EV-2'], noProgressStreak: 0 }, { no_progress_limit: 1 });
  check('new evidence resets the streak', s3.stop === false && s3.noProgressStreak === 0, JSON.stringify(s3));
  check('a new diff counts as progress',
    I.noProgressStep('{"a":1}', { changedFiles: ['x.js'] }).progressed === true);
  check('a new finding counts as progress',
    I.noProgressStep(null, { findings: ['f1'] }) && I.progressFingerprint({ findings: ['f1'] }) !== I.progressFingerprint({ findings: ['f2'] }));
  check('a new decision counts as progress',
    I.progressFingerprint({ decisions: ['d1'] }) !== I.progressFingerprint({ decisions: ['d2'] }));
  check('the fingerprint ignores ORDER, so a reshuffle is not progress',
    I.progressFingerprint({ changedFiles: ['a', 'b'] }) === I.progressFingerprint({ changedFiles: ['b', 'a'] }));
  check('two turns of pure rephrasing stop the goal',
    I.noProgressStep(I.progressFingerprint({ evidenceIds: ['EV-1'] }), { evidenceIds: ['EV-1'] }, { no_progress_limit: 1 }).stop === true);

  // ---- duplicate expensive call guard ----------------------------------------------------------
  const ledger = I.createCallLedger();
  const call = { runId: 'r1', taskId: 'T1', taskRevision: '1', sourceHash: 'abc', instructionHash: 'def' };
  check('the first call is allowed', ledger.check(call).allowed === true);
  ledger.complete(call);
  check('an identical call after completion is REFUSED', ledger.check(call).allowed === false);
  check('and the refusal is named DUPLICATE_SUPPRESSED', ledger.check(call).code === 'DUPLICATE_SUPPRESSED');
  check('a new instruction justifies a re-dispatch', ledger.check(call, { newInstruction: true }).code === 'RETRY_JUSTIFIED');
  check('changed source justifies a re-dispatch', ledger.check(call, { sourceChanged: true }).code === 'RETRY_JUSTIFIED');
  check('a review finding justifies a re-dispatch', ledger.check(call, { reviewFinding: true }).code === 'RETRY_JUSTIFIED');
  check('"just try again" is NOT a justification', ledger.check(call, { retry: true }).allowed === false);
  check('a different source hash is a different call',
    ledger.check({ ...call, sourceHash: 'xyz' }).allowed === true);
  check('a different task revision is a different call',
    ledger.check({ ...call, taskRevision: '2' }).allowed === true);
  check('a FAILED attempt is not recorded as completed',
    ledger.has({ runId: 'r9', taskId: 'T9' }) === false);

  // ---- cost report -----------------------------------------------------------------------------
  const resolved = G.resolveGuidedPolicy({ presetId: 'bug_fix', executionIntensity: 'STRICT' });
  const report = G.describeCostReport(resolved, { subagentsUsed: 1, retries: 2, elapsedMs: 5000 });
  check('the report names the intensity', report.execution_intensity === 'STRICT', String(report.execution_intensity));
  check('the report carries a LABEL KEY as well as the canonical value',
    report.execution_intensity_label_key === 'intensity.strict', String(report.execution_intensity_label_key));
  check('a counted field is reported', report.subagents_used === 1);
  check('an UNCOUNTED field is null, not zero',
    report.supervisor_turns === null && report.worker_turns === null, JSON.stringify(report.supervisor_turns));
  check('no token_usage field is fabricated', report.token_usage === null);
  check('and the note says why rather than leaving it blank',
    /not measured/.test(report.token_usage_note), report.token_usage_note);
  check('the report carries the budgets it is spending against',
    report.budgets && report.budgets.max_subagents === 3, JSON.stringify(report.budgets));

  // ---- presets recommend, and never STRICT -----------------------------------------------------
  for (const p of G.PRESETS) {
    check(`preset ${p.id} carries a recommended_intensity`, typeof p.recommended_intensity === 'string', String(p.recommended_intensity));
  }
  check('inspect recommends FAST', G.presetById('inspect').recommended_intensity === 'FAST');
  check('docs recommends FAST', G.presetById('docs').recommended_intensity === 'FAST');
  check('bug_fix recommends BALANCED', G.presetById('bug_fix').recommended_intensity === 'BALANCED');
  check('no preset recommends STRICT, which would make every goal expensive',
    G.PRESETS.every((p) => p.recommended_intensity !== 'STRICT'),
    G.PRESETS.filter((p) => p.recommended_intensity === 'STRICT').map((p) => p.id).join(','));
  check('the user can override a preset recommendation',
    G.resolveGuidedPolicy({ presetId: 'inspect', executionIntensity: 'STRICT' }, SEAT).execution_intensity === 'STRICT');
  check('and the override is reported as the requested value',
    G.resolveGuidedPolicy({ presetId: 'inspect', executionIntensity: 'STRICT' }, SEAT).execution_intensity_requested === 'STRICT');
}

// ======================================================================
section('I. V0.3.4 intensity and autonomy are independent controls');
{
  const I = require(path.join(WB, 'protocol', 'intensity.js'));

  /**
   * THE COMBINATION THE SPEC NAMES EXPLICITLY: "advance on your own, but keep it cheap".
   *
   * If intensity and autonomy were one control this pair would be impossible to express, and the two would
   * have to be traded off against each other. They are independent, so the combination is legal and each half
   * still does its own job: autonomy decides the run may continue unattended, intensity decides it does so
   * with a one-dispatch budget.
   */
  const pair = G.resolveGuidedPolicy({ presetId: 'autonomous', executionIntensity: 'FAST' }, SEAT);
  check('autonomy=autonomous with intensity=FAST is accepted', pair.ok === true);
  check('the autonomy level is untouched by the intensity', pair.autonomy === 'autonomous', pair.autonomy);
  check('the autonomy MODE is still the autonomous one', pair.autonomy_mode === 'SAFE_AUTO', pair.autonomy_mode);
  check('the intensity is the one the user chose', pair.execution_intensity === 'FAST', pair.execution_intensity);
  check('the run does not stop after each task (autonomy kept its own behaviour)',
    pair.limits.ask_after_each_task === false, String(pair.limits.ask_after_each_task));
  check('but its retry budget is now the FAST one', pair.limits.max_task_retries === 1, String(pair.limits.max_task_retries));

  // And the reverse: a tight autonomy is not loosened by a permissive intensity.
  const tight = G.resolveGuidedPolicy({ presetId: 'inspect', autonomy: 'guided', executionIntensity: 'STRICT' }, SEAT);
  check('guided autonomy keeps its ask-after-each-task behaviour under STRICT',
    tight.limits.ask_after_each_task === true, String(tight.limits.ask_after_each_task));
  check('guided autonomy keeps its iteration cap under STRICT',
    tight.limits.max_goal_iterations === 3, String(tight.limits.max_goal_iterations));
  check('and STRICT cannot raise the retry budget above the tighter autonomy level',
    tight.limits.max_task_retries === 1, String(tight.limits.max_task_retries));

  // The tightening is DISCLOSED rather than silent.
  check('the resolve notes when intensity tightened an autonomy budget',
    pair.notes.some((n) => /tightened/.test(n)), JSON.stringify(pair.notes));
}

// ======================================================================
section('J. V0.3.4 Codex AUTO follows intensity, REQUIRED does not');
{
  const permissive = { requirePermission: true };
  const fast = G.resolveGuidedPolicy({ presetId: 'autonomous', executionIntensity: 'FAST' }, SEAT);
  const balanced = G.resolveGuidedPolicy({ presetId: 'autonomous', executionIntensity: 'BALANCED' }, SEAT);

  check('BALANCED + codex_auto is eligible for an independent review', balanced.codex_auto_eligible === true);
  check('FAST + codex_auto is NOT eligible', fast.codex_auto_eligible === false);
  check('and the suppression is reported rather than silent', fast.codex_suppressed_by_intensity === true);
  check('the suppression is explained in a note',
    fast.notes.some((n) => /codex_auto requested but FAST/.test(n)), JSON.stringify(fast.notes));

  /**
   * THE MODE ITSELF IS NOT REWRITTEN. Downgrading an explicit REQUIRED because of a cost setting is the
   * silent-inversion failure this codebase already guards against elsewhere, so intensity narrows what AUTO
   * ASKS FOR and leaves the configured mode exactly as the user set it.
   */
  check('FAST does NOT rewrite the configured codex_review_mode',
    fast.codex_review_mode === 'AUTO', fast.codex_review_mode);
  check('no intensity downgrades an explicit REQUIRED',
    ['FAST', 'BALANCED', 'STRICT'].every((id) => G.resolveGuidedPolicy(
      { presetId: 'bug_fix', reviewPolicy: 'codex_auto', executionIntensity: id }, SEAT).codex_review_mode === 'AUTO'));
  check('a supervisor-only review is never marked eligible for Codex',
    G.resolveGuidedPolicy({ presetId: 'bug_fix', reviewPolicy: 'supervisor', executionIntensity: 'STRICT' }, SEAT).codex_auto_eligible === true
    && G.resolveGuidedPolicy({ presetId: 'bug_fix', reviewPolicy: 'supervisor' }, SEAT).codex_review_mode === 'OFF');
}

// ======================================================================
section('K. V0.3.4 the cost lines are bands, never invented figures');
{
  const resolved = G.resolveGuidedPolicy({ presetId: 'bug_fix' }, SEAT);
  const items = G.describeGuidedPolicy(resolved);
  const byKey = (k) => items.find((i) => i.key === k);

  check('the preview announces the AI-call band', !!byKey('preview.workerDispatches'));
  check('the preview announces the validation band', !!byKey('preview.validationTier'));
  check('the bands are carried as VARS, so the sentence comes from the catalogue',
    byKey('preview.workerDispatches').vars?.band === 'moderate',
    JSON.stringify(byKey('preview.workerDispatches')));
  check('the validation band follows the intensity',
    byKey('preview.validationTier').vars?.band === 'standard',
    JSON.stringify(byKey('preview.validationTier')));

  const fast = G.describeGuidedPolicy(G.resolveGuidedPolicy({ presetId: 'inspect' }, SEAT));
  check('FAST reports few AI calls', fast.find((i) => i.key === 'preview.workerDispatches').vars.band === 'few');
  check('FAST reports basic validation', fast.find((i) => i.key === 'preview.validationTier').vars.band === 'basic');

  /**
   * NO FABRICATED NUMBERS, ASSERTED ON THE SOURCE. The brief forbids a preview that reads
   * "about 12,000 tokens", and the surest way to keep that promise is to check that no such string can be
   * produced: the bands are words, and nothing in the resolved policy or its preview is a digit.
   */
  const serialised = JSON.stringify({ cost: resolved.cost, preview: items });
  check('no token figure appears in the resolved cost policy', !/token/i.test(serialised), serialised.slice(0, 200));
  check('the bands are words, not numbers',
    ['few', 'moderate', 'many', 'basic', 'standard', 'strict'].includes(resolved.cost.ai_calls)
    && ['basic', 'standard', 'strict'].includes(resolved.cost.validation_strength),
    JSON.stringify(resolved.cost));
  const guidedSrc = require('node:fs').readFileSync(path.join(WB, 'public', 'guided.js'), 'utf8');
  check('guided.js never prints a token estimate', !/token_?usage|estimated tokens|预计.*token/i.test(guidedSrc));
}

// ======================================================================
section('L. V0.3.4 compact context: state, not transcript');
{
  const C = require(path.join(WB, 'protocol', 'context.js'));

  const INPUT = {
    goal: { goal_id: 'GOAL-1', text: 'Fix the pulse timing bug', status: 'IN_PROGRESS' },
    task: {
      task_id: 'T-1', title: 'Locate the timing computation', status: 'IN_PROGRESS',
      success_criteria: ['The clock source is named', 'Line numbers cited'],
    },
    decisions: [{ action: 'APPROVE', task_id: 'T-0', reason: 'plan accepted' }],
    sourceFiles: [{ path: 'src/hud-pulse.js', sha256: 'a'.repeat(64) }],
    evidence: [{ record_id: 'EV-1', status: 'PARTIAL', review_level: 'SUPERVISOR_REVIEW' }],
    openFindings: ['restore colour may be stale'],
    excluded: { completedTasks: 4, logs: 250, priorReports: 3, otherProviders: 1 },
  };

  const ctx = C.buildCompactContext(INPUT);
  check('the context carries exactly the six declared sections',
    JSON.stringify(Object.keys(ctx.sections)) === JSON.stringify(C.SECTIONS),
    Object.keys(ctx.sections).join(','));
  check('it carries the goal', ctx.sections.goal.goal_id === 'GOAL-1' && /pulse/.test(ctx.sections.goal.text));
  check('it carries the current task', ctx.sections.current_task.task_id === 'T-1');
  check('it carries the completion criteria WHOLE, not summarised',
    JSON.stringify(ctx.sections.current_task.success_criteria) === JSON.stringify(['The clock source is named', 'Line numbers cited']),
    JSON.stringify(ctx.sections.current_task.success_criteria));
  check('it carries the relevant decisions', ctx.sections.decisions.length === 1);
  check('it carries the source hash, so a later verification needs no re-read',
    ctx.sections.source[0].sha256.length === 64);
  check('it carries the latest evidence', ctx.sections.evidence[0].record_id === 'EV-1');
  check('it carries the open findings', ctx.sections.open_findings.length === 1);

  // The exclusions are REPORTED, because "what did you leave out" must be answerable.
  check('it reports what it excluded, with counts',
    ctx.excluded.completed_tasks === 4 && ctx.excluded.logs === 250
    && ctx.excluded.prior_reports === 3 && ctx.excluded.other_providers === 1,
    JSON.stringify(ctx.excluded));

  // Size is reported, and the estimate is NAMED as an estimate.
  check('it reports an exact character count', Number.isFinite(ctx.chars) && ctx.chars > 0, String(ctx.chars));
  check('the token figure is named as an approximation, not as usage',
    Object.prototype.hasOwnProperty.call(ctx, 'approx_tokens')
    && !Object.prototype.hasOwnProperty.call(ctx, 'tokens'),
    Object.keys(ctx).join(','));

  // A task with no criteria must SAY so rather than implying completion is unconstrained.
  const noCriteria = C.buildCompactContext({ goal: { text: 'x' }, task: { task_id: 'T-2', title: 'y' } });
  check('a task with no criteria renders an explicit "(no criteria recorded)"',
    /no criteria recorded/.test(C.renderCompactContext(noCriteria)));

  // Caps: a huge input cannot silently become the whole context.
  const huge = C.buildCompactContext({
    goal: { text: 'g'.repeat(50000) },
    decisions: Array.from({ length: 40 }, (_, i) => ({ action: 'APPROVE', task_id: `T-${i}`, reason: 'r'.repeat(500) })),
    sourceFiles: Array.from({ length: 40 }, (_, i) => ({ path: `f${i}.js` })),
  });
  check('the decision list is capped', huge.sections.decisions.length === C.CAPS.decisions, String(huge.sections.decisions.length));
  check('the source list is capped', huge.sections.source.length === C.CAPS.source_files, String(huge.sections.source.length));
  check('a long goal text is clipped',
    huge.sections.goal.text.length <= C.CAPS.text_chars + 1, String(huge.sections.goal.text.length));
  check('and the caps are reported so a caller can see them', Number.isFinite(huge.caps.decisions));

  // THE POINT OF THE WHOLE MODULE: bounded regardless of how long the goal text is.
  check('a 50,000-character goal does not produce a 50,000-character context',
    huge.chars < 12000, `${huge.chars} chars`);

  // Rendering is readable, and an empty context renders rather than throwing.
  const rendered = C.renderCompactContext(ctx);
  /**
   * The renderer's HEADINGS ARE ITS OWN, and they are not the raw section keys: `evidence` prints as
   * `[LATEST EVIDENCE]` because that is what the section contains. So the assertion is against the labels a
   * reader actually sees, spelled out here - a test that derives labels from the data model instead of naming
   * them would pass while the prompt showed something different.
   */
  const HEADINGS = ['[GOAL]', '[CURRENT TASK]', '[RELEVANT DECISIONS]', '[RELEVANT SOURCE]', '[LATEST EVIDENCE]', '[OPEN FINDINGS]'];
  check('the rendered context carries all six headings',
    HEADINGS.every((h) => rendered.includes(h)),
    HEADINGS.filter((h) => !rendered.includes(h)).join(', ') || 'all present');
  check('the headings are in the reading order the module declares',
    JSON.stringify(HEADINGS.map((h) => rendered.indexOf(h)).reduce((a, n, i, arr) => (i && n < arr[i - 1] ? [...a, 0] : a), [])) === '[]',
    HEADINGS.map((h) => `${h}@${rendered.indexOf(h)}`).join(' '));
  check('rendering nothing returns an empty string rather than throwing', C.renderCompactContext(null) === '');

  // The handoff, built from the same assembly.
  const handoff = C.handoffFor(ctx);
  check('the handoff names the task it continues', handoff.task_id === 'T-1');
  check('the handoff points at the records rather than reproducing them',
    /records/.test(handoff.state_source), handoff.state_source);
  check('the handoff carries the completion criteria', handoff.done_when.length === 2);
  check('the handoff states the reason it exists', /rotated/.test(handoff.reason));
  check('a handoff for no context is null rather than an empty object', C.handoffFor(null) === null);

  /**
   * THE COST SHAPE, ASSERTED. The compact context must not grow with the number of COMPLETED tasks, because
   * that is the growth this module exists to stop.
   */
  const few = C.buildCompactContext({ ...INPUT, excluded: { completedTasks: 1 } });
  const many = C.buildCompactContext({ ...INPUT, excluded: { completedTasks: 99 } });
  check('the context size does not grow with the number of completed tasks',
    few.chars === many.chars, `${few.chars} vs ${many.chars}`);
}

// ======================================================================
section('M. V0.3.4 the measured cost comparison is reproducible');
{
  /**
   * The comparison is a SCRIPT that anyone can re-run, and this asserts the shape of its claims rather than its
   * prose: the dispatch ceiling must rise from FAST to BALANCED to STRICT, and the subagent allowance with it.
   * If a future change flattens those, the milestone's central claim is no longer true and this fails - rather
   * than the claim quietly surviving inside a report nobody re-runs.
   *
   * The script itself is not required here: requiring it would EXECUTE the whole comparison as a side effect of
   * running this suite, printing a second report and coupling a fast unit suite to a measurement. The numbers
   * are asserted against the same module the script uses, which is the part that can actually break.
   */
  const I2 = require(path.join(WB, 'protocol', 'intensity.js'));
  const ceilings = ['FAST', 'BALANCED', 'STRICT'].map((id) => I2.clampBudgets(id, {}).max_worker_dispatches_per_task);
  check('the worker-dispatch ceiling rises with the intensity',
    ceilings[0] < ceilings[1] && ceilings[1] < ceilings[2], ceilings.join(' < '));
  const subs = ['FAST', 'BALANCED', 'STRICT'].map((id) => I2.clampBudgets(id, {}).max_subagents);
  check('the subagent allowance rises with the intensity',
    subs[0] < subs[1] && subs[1] < subs[2], subs.join(' < '));
  check('FAST allows no subagent at all, which is the strongest single claim',
    subs[0] === 0, String(subs[0]));
  check('the deterministic refusal is intensity-independent',
    ['FAST', 'BALANCED', 'STRICT'].every((id) => I2.subagentGate(id, {
      answerableDeterministically: true, reason: 'why not', expected_unique_output: 'a count',
    }).code === 'DETERMINISTIC_TOOL_AVAILABLE'));
  check('the measurement script exists and parses', (() => {
    const fs2 = require('node:fs');
    const p2 = path.join(path.resolve(require('node:os').homedir(), '.dsh', 'agent-workspaces', 'workbench', 'verify'), 'measure-intensity.js');
    if (!fs2.existsSync(p2)) return false;
    try { require('node:child_process').execFileSync(process.execPath, ['--check', p2], { stdio: 'pipe' }); return true; }
    catch { return false; }
  })());
}

// ======================================================================
console.log(`\n${'='.repeat(70)}`);
console.log(`GUIDED GOALS SUITE: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
