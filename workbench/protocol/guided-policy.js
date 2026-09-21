'use strict';
/**
 * guided-policy.js - turn a beginner's three choices into real Workbench policy.
 *
 * THE POINT OF THIS FILE
 *   A guided UI that only writes a friendlier prompt is a lie: the user believes they restricted the AI, and
 *   nothing enforces it. So the guided choices resolve HERE, into the same fields the protocol already uses -
 *   `write_scope`, `approval_required`, `codex_review_mode`, `autonomy_mode` and the loop limits - and this
 *   module is the single source of truth for that mapping. The UI renders it, the server applies it, and the
 *   tests assert it, so all three cannot drift apart.
 *
 * WHAT IS ENFORCED, AND WHERE
 *   `file_policy: read_only`   -> `write_scope: []` and a deny-all envelope. A worker cannot write because
 *                                 the envelope it is dispatched with has nothing writable in it, not because
 *                                 a sentence asked it not to.
 *   `file_policy: write`       -> the workspace/seat write scope is used unchanged. This is the ONLY policy
 *                                 that can change a file, and it is the one the UI labels as such.
 *   `file_policy: ask`         -> every path the workspace permits becomes `approval_required`, and the run
 *                                 stops for a human decision before a write rather than after it.
 *   `autonomy`                 -> the existing autonomy mode plus explicit, unchanged loop limits. Autonomy
 *                                 changes how much is asked, never how much is allowed.
 *   `review`                   -> the existing `codex_review_mode`. OFF never blocks a goal.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 *   It does not add a second orchestration system, a new protocol field, or a new provider. Every value it
 *   produces already existed; the contribution is deciding which values a beginner's choice corresponds to,
 *   in one place, and saying so out loud.
 */

const CODEX_MODE = { OFF: 'OFF', AUTO: 'AUTO', REQUIRED: 'REQUIRED' };
const FILE_POLICY = { READ_ONLY: 'read_only', WRITE: 'write', ASK: 'ask' };
const AUTONOMY_LEVEL = { GUIDED: 'guided', RECOMMENDED: 'recommended', AUTONOMOUS: 'autonomous' };
const REVIEW_POLICY = { SUPERVISOR: 'supervisor', CODEX_AUTO: 'codex_auto' };

/**
 * Execution intensity lives in its own module and is re-exported here.
 *
 * WHY A SEPARATE FILE, AND WHY IT IS SURFACED THROUGH THIS ONE. Intensity answers a different question from
 * everything above it: file policy says WHAT MAY BE TOUCHED, autonomy says HOW FAR THE RUN MAY GO ON ITS OWN,
 * and intensity says WHAT IT MAY SPEND. They are independent by design - `autonomy: autonomous` with
 * `intensity: FAST` is a legal and meaningful pair ("keep going by yourself, but keep it cheap"), and folding
 * the two into one control would make that combination impossible to express.
 *
 * The mapping is a pure function, so the UI renders it by ASKING the server for a resolve rather than
 * carrying a copy, exactly as it does for file policy and autonomy.
 */
const intensity = require('./intensity.js');


/**
 * The presets.
 *
 * Every field is policy, not prose: `goal_template` is the starting text a user edits, and everything else
 * is what the Workbench will actually do. `recommended_for` exists so the UI can put the most likely preset
 * first for a given situation without guessing at runtime.
 */
const PRESETS = [
  {
    id: 'inspect',
    icon: '\u25cb',
    title_key: 'preset.inspect.title',
    description_key: 'preset.inspect.desc',
    goal_template: 'preset.inspect.goal',
    file_policy: FILE_POLICY.READ_ONLY,
    autonomy: AUTONOMY_LEVEL.RECOMMENDED,
    review_policy: REVIEW_POLICY.SUPERVISOR,
    recommended_for: 'understanding a problem before changing anything',
    recommended_intensity: intensity.INTENSITY.FAST,
  },
  {
    id: 'bug_fix',
    icon: '\u2699',
    title_key: 'preset.bugFix.title',
    description_key: 'preset.bugFix.desc',
    goal_template: 'preset.bugFix.goal',
    file_policy: FILE_POLICY.ASK,
    autonomy: AUTONOMY_LEVEL.RECOMMENDED,
    review_policy: REVIEW_POLICY.SUPERVISOR,
    recommended_for: 'a reported defect whose root cause is not yet known',
    recommended_intensity: intensity.INTENSITY.BALANCED,
  },
  {
    id: 'feature',
    icon: '\u2726',
    title_key: 'preset.feature.title',
    description_key: 'preset.feature.desc',
    goal_template: 'preset.feature.goal',
    file_policy: FILE_POLICY.WRITE,
    autonomy: AUTONOMY_LEVEL.RECOMMENDED,
    review_policy: REVIEW_POLICY.SUPERVISOR,
    recommended_for: 'new behaviour that follows the existing architecture',
    recommended_intensity: intensity.INTENSITY.BALANCED,
  },
  {
    id: 'refactor',
    icon: '\u21bb',
    title_key: 'preset.refactor.title',
    description_key: 'preset.refactor.desc',
    goal_template: 'preset.refactor.goal',
    file_policy: FILE_POLICY.ASK,
    autonomy: AUTONOMY_LEVEL.RECOMMENDED,
    review_policy: REVIEW_POLICY.SUPERVISOR,
    recommended_for: 'maintainability work that must not change behaviour',
    recommended_intensity: intensity.INTENSITY.BALANCED,
  },
  {
    id: 'tests',
    icon: '\u2713',
    title_key: 'preset.tests.title',
    description_key: 'preset.tests.desc',
    goal_template: 'preset.tests.goal',
    file_policy: FILE_POLICY.WRITE,
    autonomy: AUTONOMY_LEVEL.RECOMMENDED,
    review_policy: REVIEW_POLICY.SUPERVISOR,
    recommended_for: 'adding coverage without changing behaviour',
    recommended_intensity: intensity.INTENSITY.BALANCED,
  },
  {
    id: 'docs',
    icon: '\u2261',
    title_key: 'preset.docs.title',
    description_key: 'preset.docs.desc',
    goal_template: 'preset.docs.goal',
    file_policy: FILE_POLICY.WRITE,
    autonomy: AUTONOMY_LEVEL.RECOMMENDED,
    review_policy: REVIEW_POLICY.SUPERVISOR,
    recommended_for: 'documentation that must match the code as it is',
    recommended_intensity: intensity.INTENSITY.FAST,
  },
  {
    id: 'health',
    icon: '\u2661',
    title_key: 'preset.health.title',
    description_key: 'preset.health.desc',
    goal_template: 'preset.health.goal',
    file_policy: FILE_POLICY.READ_ONLY,
    autonomy: AUTONOMY_LEVEL.RECOMMENDED,
    review_policy: REVIEW_POLICY.SUPERVISOR,
    recommended_for: 'deciding what to work on next, with evidence',
    recommended_intensity: intensity.INTENSITY.BALANCED,
  },
  {
    id: 'autonomous',
    icon: '\u25b6',
    title_key: 'preset.autonomous.title',
    description_key: 'preset.autonomous.desc',
    goal_template: 'preset.autonomous.goal',
    file_policy: FILE_POLICY.ASK,
    autonomy: AUTONOMY_LEVEL.AUTONOMOUS,
    review_policy: REVIEW_POLICY.CODEX_AUTO,
    recommended_for: 'a goal that needs several rounds of work to finish',
    recommended_intensity: intensity.INTENSITY.BALANCED,
  },
  {
    id: 'custom',
    icon: '\u270e',
    title_key: 'preset.custom.title',
    description_key: 'preset.custom.desc',
    goal_template: null,
    file_policy: FILE_POLICY.READ_ONLY,
    autonomy: AUTONOMY_LEVEL.RECOMMENDED,
    review_policy: REVIEW_POLICY.SUPERVISOR,
    recommended_for: 'anything the other presets do not fit',
    recommended_intensity: intensity.INTENSITY.BALANCED,
  },
];

/** The four example goals shown on the empty home screen. Clicking one fills the box; it never starts a run. */
const EXAMPLES = [
  { id: 'find-bug', goal: 'example.findBug', preset: 'inspect' },
  { id: 'fix-bug', goal: 'example.fixBug', preset: 'bug_fix' },
  { id: 'add-feature', goal: 'example.addFeature', preset: 'feature' },
  { id: 'keep-going', goal: 'example.keepGoing', preset: 'autonomous' },
];

/**
 * Loop limits per autonomy level.
 *
 * The numbers are the existing defaults, restated per level rather than reinvented: autonomy decides how
 * many rounds the Workbench will take on its own, and it never removes a limit. `guided` makes the loop ask
 * after every task; `autonomous` uses the full budget that already exists.
 */
const AUTONOMY_LIMITS = {
  guided: { max_task_retries: 1, max_goal_iterations: 3, no_progress_limit: 1, ask_after_each_task: true },
  recommended: { max_task_retries: 3, max_goal_iterations: 12, no_progress_limit: 2, ask_after_each_task: false },
  autonomous: { max_task_retries: 3, max_goal_iterations: 12, no_progress_limit: 2, ask_after_each_task: false },
};

/** Autonomy mode as the existing workbench already understands it. */
const AUTONOMY_MODE = { guided: 'ADVISOR', recommended: 'ADVISOR', autonomous: 'SAFE_AUTO' };

function presetById(id) {
  return PRESETS.find((p) => p.id === id) ?? null;
}

function normalizeChoice(value, allowed, fallback) {
  const v = String(value ?? '').toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

/**
 * Resolve guided choices into canonical policy.
 *
 * @param {{presetId?:string, filePolicy?:string, autonomy?:string, reviewPolicy?:string}} choices
 * @param {{workerSeatWriteScope?:string[]}} context
 * @returns {{ok:boolean, error?:string, preset, file_policy, autonomy, review_policy, permissions,
 *            codex_review_mode, autonomy_mode, limits, notes:string[]}}
 */
function resolveGuidedPolicy(choices = {}, context = {}) {
  const preset = choices.presetId ? presetById(choices.presetId) : null;
  if (choices.presetId && !preset) {
    return { ok: false, error: `unknown preset: ${choices.presetId}` };
  }

  const filePolicy = normalizeChoice(
    choices.filePolicy ?? preset?.file_policy,
    Object.values(FILE_POLICY),
    FILE_POLICY.READ_ONLY,
  );
  const autonomy = normalizeChoice(
    choices.autonomy ?? preset?.autonomy,
    Object.values(AUTONOMY_LEVEL),
    AUTONOMY_LEVEL.RECOMMENDED,
  );
  const reviewPolicy = normalizeChoice(
    choices.reviewPolicy ?? preset?.review_policy,
    Object.values(REVIEW_POLICY),
    REVIEW_POLICY.SUPERVISOR,
  );
  /**
   * Intensity, and the DEFAULT THAT MATTERS.
   *
   * It defaults to the PRESET's recommendation when the user has not chosen one, so picking "Fix something
   * broken" arrives with BALANCED already selected rather than with whatever a previous screen left behind. A
   * value the resolver does not recognise falls back to the global default (BALANCED) rather than to the
   * cheapest option: an unrecognised value must not quietly become a cost decision the user never made.
   */
  const requestedIntensity = choices.executionIntensity ?? preset?.recommended_intensity;
  const executionIntensity = intensity.normalizeIntensity(requestedIntensity);
  const intensityDetail = intensity.intensityById(executionIntensity);

  const seatScope = Array.isArray(context.workerSeatWriteScope) ? context.workerSeatWriteScope : [];
  const notes = [];

  let writeScope;
  let approvalRequired;
  if (filePolicy === FILE_POLICY.READ_ONLY) {
    writeScope = [];
    approvalRequired = [];
    notes.push('read_only: the envelope has an empty write scope, so a worker cannot write even if asked to.');
  } else if (filePolicy === FILE_POLICY.ASK) {
    writeScope = [...seatScope];
    approvalRequired = [...seatScope];
    notes.push(`ask_before_write: ${approvalRequired.length} permitted path(s) require approval before a write.`);
    if (!approvalRequired.length) {
      notes.push('ask_before_write was chosen but the workspace permits no writes, so nothing can be approved.');
    }
  } else {
    writeScope = [...seatScope];
    approvalRequired = [];
    notes.push(`write_allowed: the workspace write scope applies unchanged (${writeScope.length} path(s)).`);
  }

  /**
   * THE LIMITS ARE THE TIGHTER OF AUTONOMY AND INTENSITY, CLAMPED BY THE GLOBAL CEILING.
   *
   * The two controls answer different questions - autonomy asks how far the run may go unattended, intensity
   * asks what it may spend - and when they disagree the SAFER answer wins, in BOTH directions. So `guided`
   * autonomy cannot be loosened by choosing STRICT, and BALANCED cannot be loosened by choosing `autonomous`.
   * `clampBudgets` takes the minimum of all three, and its ceiling is `policy.js`'s own default budget, so no
   * combination of choices on this screen can raise a limit above what the system would have enforced without
   * any of them.
   */
  const autonomyLimitsRaw = AUTONOMY_LIMITS[autonomy] ?? AUTONOMY_LIMITS[AUTONOMY_LEVEL.RECOMMENDED];
  const limits = intensity.clampBudgets(executionIntensity, {
    max_task_retries: autonomyLimitsRaw.max_task_retries,
    max_goal_iterations: autonomyLimitsRaw.max_goal_iterations,
    no_progress_limit: autonomyLimitsRaw.no_progress_limit,
  }, intensity.GLOBAL_CEILING);
  limits.ask_after_each_task = autonomyLimitsRaw.ask_after_each_task;

  if (limits.max_task_retries < autonomyLimitsRaw.max_task_retries
    || limits.max_goal_iterations < autonomyLimitsRaw.max_goal_iterations
    || limits.no_progress_limit < autonomyLimitsRaw.no_progress_limit) {
    notes.push(`intensity ${executionIntensity} tightened the ${autonomy} budgets: `
      + `retries ${autonomyLimitsRaw.max_task_retries}->${limits.max_task_retries}, `
      + `iterations ${autonomyLimitsRaw.max_goal_iterations}->${limits.max_goal_iterations}, `
      + `no-progress ${autonomyLimitsRaw.no_progress_limit}->${limits.no_progress_limit}.`);
  }

  /**
   * CODEX `AUTO` IS SUBJECT TO INTENSITY; CODEX `REQUIRED` IS NOT.
   *
   * Choosing `codex_auto` means "ask an independent reviewer where a second opinion changes the outcome", and
   * AUTO already decides that per task. FAST narrows it further: an AUTO review is not requested at FAST, so a
   * user who asked to keep costs down is not billed for a second opinion they did not ask for by name.
   *
   * `REQUIRED` is deliberately EXEMPT. It is an explicit instruction, not a preference, and downgrading an
   * explicit choice because of a cost setting is the silent-inversion failure this file already has a
   * regression test for in `normalizeCodexMode` - where switching the reviewer ON returned OFF. A requirement
   * the user stated outranks a budget they also stated; the budget is reported, not enforced over it.
   */
  const codexMode = reviewPolicy === REVIEW_POLICY.CODEX_AUTO ? CODEX_MODE.AUTO : CODEX_MODE.OFF;
  const codexSuppressedByIntensity = codexMode === CODEX_MODE.AUTO && intensityDetail.codex_auto_eligible === false;
  if (codexSuppressedByIntensity) {
    notes.push(`codex_auto requested but ${executionIntensity} does not request an independent review; review `
      + 'stays with the supervisor. codex_review_mode is unchanged, so an explicit REQUIRED is still honoured.');
  }

  return {
    ok: true,
    preset,
    preset_id: preset?.id ?? null,
    file_policy: filePolicy,
    autonomy,
    review_policy: reviewPolicy,
    execution_intensity: executionIntensity,
    /** The requested value, so a caller can see that a fallback happened rather than having to guess. */
    execution_intensity_requested: requestedIntensity == null ? null : String(requestedIntensity),
    permissions: {
      write_scope: writeScope,
      approval_required: approvalRequired,
    },
    // Review policy maps onto the switch that already exists. OFF never blocks a goal, and AUTO only asks an
    // independent provider where a second opinion changes the outcome.
    codex_review_mode: codexMode,
    codex_auto_eligible: intensityDetail.codex_auto_eligible,
    codex_suppressed_by_intensity: codexSuppressedByIntensity,
    autonomy_mode: AUTONOMY_MODE[autonomy] ?? 'ADVISOR',
    limits,
    /** What this intensity will actually spend, as BANDS - never as an invented token count. */
    validation_tier: intensityDetail.validation_tier,
    allowed_validation_tiers: [...intensityDetail.allowed_validation_tiers],
    cost: intensity.describeCost(executionIntensity),
    subagents_require_justification: intensityDetail.subagents_require_justification,
    context_mode: intensityDetail.context,
    notes,
  };
}

/**
 * What the Workbench will do, in the plain words the preview panel shows.
 *
 * This is generated from the resolved policy rather than written by hand, so the preview cannot promise
 * something the policy does not do. That is the same rule the Evidence Card follows.
 *
 * WHY THE NEGATIVE LINES ARE RETURNED RATHER THAN FILTERED OUT
 *   An earlier version dropped every item whose state was `no`, which looked like tidying up and was actually
 *   a defect: the panel then showed only the things that WOULD happen, so "Codex will not be asked" and "you
 *   will not be asked before a write" silently vanished from the one place built to say so. A user reading
 *   four ticks cannot tell whether the fifth question was answered `no` or never asked. So every line is
 *   returned with its state and the panel renders `yes` with a tick and `no` with a dash - which is the
 *   documented contract, and the same convention the Evidence Card already uses for "not applicable".
 */
function describeGuidedPolicy(resolved) {
  if (!resolved?.ok) return [];
  return [
    { key: 'preview.readSource', state: 'yes' },
    { key: 'preview.splitTasks', state: 'yes' },
    { key: 'preview.supervisorReview', state: 'yes' },
    { key: 'preview.codexReview', state: resolved.codex_review_mode === CODEX_MODE.OFF ? 'no' : 'yes' },
    { key: 'preview.noWrite', state: resolved.file_policy === FILE_POLICY.READ_ONLY ? 'yes' : 'no' },
    { key: 'preview.writeScoped', state: resolved.file_policy === FILE_POLICY.WRITE ? 'yes' : 'no' },
    { key: 'preview.askBeforeWrite', state: resolved.file_policy === FILE_POLICY.ASK ? 'yes' : 'no' },
    { key: 'preview.stopLimits', state: resolved.autonomy === AUTONOMY_LEVEL.GUIDED ? 'yes' : 'no' },
    /**
     * The cost lines, which exist so that choosing an intensity shows its consequence BEFORE the run.
     *
     * These are derived from the resolved budget, not written by hand, and they carry BANDS rather than
     * figures. There is no reliable token accounting anywhere in this stack - the worker is driven through a
     * browser and no provider reports usage - so a line reading "about 12,000 tokens" would be an invented
     * number wearing the costume of a measurement. "Few / Moderate / Many AI calls" says what changes without
     * pretending to know what it costs.
     *
     * `vars.band` is the band NAME (`few`), which is what the resolver decided, and `vars.band_key` is the
     * CATALOGUE KEY for it (`band.few`). Both are carried because they answer different questions: the name is
     * the policy fact and must not be translated, while the key is what the panel looks up to display it. An
     * earlier version sent only the name, and the panel interpolated `few` verbatim into a Chinese sentence -
     * the raw band leaked into the UI because nothing told the client it was a value needing a lookup.
     */
    {
      key: 'preview.workerDispatches',
      state: 'yes',
      vars: { band: resolved.cost?.ai_calls ?? 'moderate', band_key: `band.${resolved.cost?.ai_calls ?? 'moderate'}` },
    },
    {
      key: 'preview.validationTier',
      state: 'yes',
      vars: { band: resolved.cost?.validation_strength ?? 'standard', band_key: `band.${resolved.cost?.validation_strength ?? 'standard'}` },
    },
  ];
}

/**
 * The cost summary printed for a goal that finished.
 *
 * WHAT IT REPORTS: turn counts and tiers, and it reports them ONLY when a counter exists. A missing counter
 * stays `null` and the panel omits the row, because a counter that was never incremented is not zero - it is
 * unknown, and printing `0 supervisor turns` for a goal the workbench did not count would be a fabricated
 * measurement. That is the same rule as tokens, applied to every field rather than only to the one everybody
 * remembers to be careful about.
 *
 * WHY THERE IS NO `token_usage`: no provider in this stack reports usage. The worker is a browser session and
 * the supervisor is this process's own model. A field named `token_usage` holding an estimate would be quoted
 * as a measurement by whoever reads it next, so the field is absent and the note says why.
 */
function describeCostReport(resolved, counters = {}) {
  const count = (v) => (Number.isFinite(v) ? v : null);
  const level = intensity.intensityById(resolved?.execution_intensity) ?? null;
  return {
    execution_intensity: resolved?.execution_intensity ?? null,
    /**
     * The catalogue key for the intensity LABEL, so the Advanced report can be read in the user's language
     * while the canonical `FAST`/`BALANCED`/`STRICT` value stays untranslated beside it. Translating the value
     * itself is the defect this codebase avoids everywhere else - a machine value must read the same in every
     * locale and in every log.
     */
    execution_intensity_label_key: level?.title_key ?? null,
    supervisor_turns: count(counters.supervisorTurns),
    worker_turns: count(counters.workerTurns),
    reviewer_turns: count(counters.reviewerTurns),
    subagents_used: count(counters.subagentsUsed),
    retries: count(counters.retries),
    worker_dispatch_count: count(counters.workerDispatches),
    supervisor_review_count: count(counters.supervisorReviews),
    validation_tier: counters.validationTier ?? resolved?.validation_tier ?? null,
    elapsed_ms: count(counters.elapsedMs),
    budgets: resolved?.limits ?? null,
    token_usage: null,
    token_usage_note: counters.tokenUsageAvailable === true
      ? 'the provider reported usage'
      : 'not measured: no provider in this stack reports token usage, so no estimate is shown',
  };
}

module.exports = {
  CODEX_MODE, FILE_POLICY, AUTONOMY_LEVEL, REVIEW_POLICY,
  PRESETS, EXAMPLES, AUTONOMY_LIMITS, AUTONOMY_MODE,
  presetById, resolveGuidedPolicy, describeGuidedPolicy, describeCostReport,
  intensity,
};
