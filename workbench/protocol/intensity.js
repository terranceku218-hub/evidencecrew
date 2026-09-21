'use strict';
/**
 * intensity.js - what a user pays for, expressed as policy rather than as prose.
 *
 * THE POINT OF THIS FILE
 *   A user who picks "Fast" is not asking for a friendlier sentence. They are asking for FEWER agent calls,
 *   fewer retries, less review and a smaller validation bill - and if the only thing that changes is the text
 *   of a prompt, then the screen is lying about the cost. So the three intensities resolve HERE, into numbers
 *   the rest of the system already understands, and this module is the single source of truth for the mapping.
 *
 * THE ONE RULE THAT MATTERS MOST
 *   INTENSITY CAN ONLY TIGHTEN. It is a filter applied ON TOP of the existing budgets, never a way around
 *   them. `clampBudgets` takes the minimum of what the intensity wants, what the autonomy level allows and
 *   what the global ceiling permits - so `STRICT` cannot buy unlimited retries, and no combination of choices
 *   can raise a budget above `policy.js`'s `DEFAULT_LIMITS`. A knob that can only lower a limit cannot be used
 *   to spend more than the system was willing to spend without it.
 *
 * WHAT IT DOES NOT DO
 *   It does not add a provider, a seat, a protocol field or an orchestration loop. Every value it produces is
 *   consumed by code that already existed: `evaluateStop` for the stop conditions, `shouldRotate` for the
 *   worker conversation, `wantsIndependentReview` for the reviewer. The contribution is deciding which numbers
 *   a user's choice corresponds to, in one place, and saying so out loud.
 */

const INTENSITY = { FAST: 'FAST', BALANCED: 'BALANCED', STRICT: 'STRICT' };

/**
 * The global ceiling. INTENSITY IS CLAMPED TO THIS AND CANNOT EXCEED IT.
 *
 * These are copies of `protocol/policy.js`'s `DEFAULT_LIMITS`, kept here as the ceiling rather than imported,
 * so that a change to the default budgets cannot silently widen what an intensity is allowed to permit. The
 * test suite asserts the two agree, so drift is a failing test rather than a quiet widening.
 */
const GLOBAL_CEILING = {
  max_worker_rounds: 8,
  max_task_retries: 3,
  max_goal_iterations: 12,
  no_progress_limit: 2,
};

/**
 * The three intensities.
 *
 * `worker_necessity` is the default answer to "should this go to the worker at all" before the supervisor has
 * seen the task. It is a DEFAULT, not a veto: the supervisor may still justify a dispatch, which is the whole
 * point of the necessity decision in `workerNecessityFor`.
 *
 * `allowed_validation_tiers` is an ALLOW-list, not a preference. FAST listing only TARGETED is what makes
 * "no full CORE_CHANGE for a typo" enforceable rather than advisory.
 */
const INTENSITIES = [
  {
    id: INTENSITY.FAST,
    icon: '\u26a1',
    title_key: 'intensity.fast',
    description_key: 'intensity.fast.desc',
    /** Budgets. Every one of these is a ceiling; `clampBudgets` lowers them further if autonomy is tighter. */
    budgets: {
      max_worker_dispatches_per_task: 1,
      max_task_retries: 1,
      max_supervisor_reviews: 1,
      max_subagents: 0,
      max_goal_iterations: 3,
      no_progress_limit: 1,
    },
    /** The strongest validation this intensity may run without an explicit higher-tier reason. */
    validation_tier: 'TARGETED',
    allowed_validation_tiers: ['NONE', 'TARGETED'],
    /** Whether AUTO review may be requested at all. REQUIRED is honoured regardless - see wantsCodexReviewFor. */
    codex_auto_eligible: false,
    /** May a subagent be created at all? FAST says no unless the supervisor proves one agent cannot do it. */
    subagents_require_justification: true,
    /** How much conversation is carried into a worker or supervisor turn. */
    context: 'COMPACT',
  },
  {
    id: INTENSITY.BALANCED,
    icon: '\u2696',
    title_key: 'intensity.balanced',
    description_key: 'intensity.balanced.desc',
    budgets: {
      max_worker_dispatches_per_task: 2,
      max_task_retries: 2,
      max_supervisor_reviews: 2,
      max_subagents: 2,
      max_goal_iterations: 12,
      no_progress_limit: 2,
    },
    validation_tier: 'AFFECTED',
    allowed_validation_tiers: ['NONE', 'TARGETED', 'AFFECTED', 'CORE_CHANGE'],
    codex_auto_eligible: true,
    subagents_require_justification: true,
    context: 'COMPACT',
  },
  {
    id: INTENSITY.STRICT,
    icon: '\ud83d\udee1',
    title_key: 'intensity.strict',
    description_key: 'intensity.strict.desc',
    budgets: {
      // STRICT obeys the existing worker-round budget rather than removing it: it may use the full allowance,
      // and the allowance is still finite.
      max_worker_dispatches_per_task: 8,
      max_task_retries: 3,
      max_supervisor_reviews: 4,
      max_subagents: 3,
      max_goal_iterations: 12,
      no_progress_limit: 2,
    },
    validation_tier: 'CORE_CHANGE',
    // RELEASE is NOT on this list on purpose. A release-tier validation is chosen by the GOAL, not bought by a
    // slider: `allowed_validation_tiers` is what an ordinary task may reach, and RELEASE requires an explicit
    // release goal. See `requiredTierIsAllowed`.
    allowed_validation_tiers: ['NONE', 'TARGETED', 'AFFECTED', 'CORE_CHANGE'],
    codex_auto_eligible: true,
    subagents_require_justification: true,
    context: 'COMPACT',
  },
];

const VALIDATION_TIER = {
  NONE: 'NONE',
  TARGETED: 'TARGETED',
  AFFECTED: 'AFFECTED',
  CORE_CHANGE: 'CORE_CHANGE',
  RELEASE: 'RELEASE',
};

/** Ordered cheapest-first, so "at least this strong" is a comparison rather than a lookup table. */
const TIER_ORDER = [VALIDATION_TIER.NONE, VALIDATION_TIER.TARGETED, VALIDATION_TIER.AFFECTED, VALIDATION_TIER.CORE_CHANGE, VALIDATION_TIER.RELEASE];

const DEFAULT_INTENSITY = INTENSITY.BALANCED;

function intensityById(id) {
  const s = String(id ?? '').trim().toUpperCase();
  return INTENSITIES.find((i) => i.id === s) ?? null;
}

/** An unrecognised value falls back to the DEFAULT, not to the cheapest - see the note in `resolveIntensity`. */
function normalizeIntensity(value) {
  const found = intensityById(value);
  return found ? found.id : DEFAULT_INTENSITY;
}

/**
 * Clamp an intensity's budgets against the autonomy limits and the global ceiling.
 *
 * MINIMUM, NOT OVERRIDE. Every field is the smallest of the three, so:
 *   - intensity cannot exceed the global ceiling (`STRICT` cannot buy unlimited retries);
 *   - intensity cannot exceed what the autonomy level already allows (`FAST` under `guided` autonomy keeps
 *     guided's tighter iteration cap rather than raising it);
 *   - and an autonomy level cannot exceed what the intensity wants either, which is what makes the choice
 *     meaningful in both directions when they disagree.
 *
 * A field the ceiling does not bound is passed through from the intensity, so adding a budget does not
 * silently become unlimited.
 */
function clampBudgets(intensityId, autonomyLimits = {}, ceiling = GLOBAL_CEILING) {
  const found = intensityById(intensityId) ?? intensityById(DEFAULT_INTENSITY);
  const out = {};
  for (const [field, wanted] of Object.entries(found.budgets)) {
    const fromAutonomy = Number.isFinite(autonomyLimits[field]) ? autonomyLimits[field] : Infinity;
    const fromCeiling = Number.isFinite(ceiling[field]) ? ceiling[field] : Infinity;
    const value = Math.min(wanted, fromAutonomy, fromCeiling);
    out[field] = Number.isFinite(value) ? value : wanted;
  }
  // `ask_after_each_task` is autonomy's business, not intensity's; it is carried through when present so the
  // caller receives one complete limit object rather than two half-objects it has to merge itself.
  if (typeof autonomyLimits.ask_after_each_task === 'boolean') out.ask_after_each_task = autonomyLimits.ask_after_each_task;
  return out;
}

/**
 * What will this intensity actually cost, in words?
 *
 * THE THREE LABELS ARE BANDS, NOT NUMBERS, AND THAT IS DELIBERATE. There is no reliable token accounting in
 * this stack - the ChatGPT worker is driven through a browser and no provider reports usage back - so a
 * "predicted token count" would be an invented number presented as a measurement. The band says what changes
 * and leaves the arithmetic out.
 */
function describeCost(intensityId) {
  const found = intensityById(intensityId) ?? intensityById(DEFAULT_INTENSITY);
  const callBand = found.id === INTENSITY.FAST ? 'few' : found.id === INTENSITY.STRICT ? 'many' : 'moderate';
  const validationBand = found.validation_tier === 'TARGETED' ? 'basic'
    : found.validation_tier === 'CORE_CHANGE' ? 'strict' : 'standard';
  return {
    ai_calls: callBand,
    validation_strength: validationBand,
    independent_review: found.codex_auto_eligible ? 'per_codex_policy' : 'only_if_required',
    validation_tier: found.validation_tier,
  };
}

/**
 * May a validation of this tier run, given the intensity and the GOAL?
 *
 * THE RELEASE RULE IS THE INTERESTING ONE. `RELEASE` is never reachable by intensity alone, however many
 * times it appears in a let-list: it requires a goal that says it is a release. This is what stops "STRICT"
 * from becoming "run the expensive suite for every edit", which is the exact behaviour this milestone exists
 * to stop.
 */
function requiredTierIsAllowed(intensityId, tier, context = {}) {
  const found = intensityById(intensityId) ?? intensityById(DEFAULT_INTENSITY);
  const want = String(tier ?? '').toUpperCase();
  if (!TIER_ORDER.includes(want)) return { allowed: false, reason: `unknown validation tier: ${tier}` };
  if (want === VALIDATION_TIER.NONE) return { allowed: true, reason: 'no validation requested' };
  if (want === VALIDATION_TIER.RELEASE) {
    return context.releaseGoal === true
      ? { allowed: true, reason: 'RELEASE requested by an explicit release goal' }
      : { allowed: false, reason: 'RELEASE requires an explicit release goal; intensity never selects it' };
  }
  return found.allowed_validation_tiers.includes(want)
    ? { allowed: true, reason: `${found.id} allows ${want}` }
    : { allowed: false, reason: `${found.id} allows at most ${found.validation_tier}, not ${want}` };
}

/**
 * Should this task be sent to the ChatGPT worker at all?
 *
 * THE DEFECT THIS PREVENTS: a task existing and a task needing a browser turn are different facts, and the
 * system used to treat the first as the second. Every task meant a real ChatGPT turn, so a one-line
 * documentation edit cost the same as a debugging session.
 *
 * The decision is a DEFAULT, not a gate. `requiresWorker: false` at FAST does not forbid a dispatch - the
 * supervisor may still ask for one, and must give a reason. What it forbids is the dispatch happening because
 * nobody asked whether it should.
 */
function workerNecessityFor(intensityId, task = {}, context = {}) {
  const found = intensityById(intensityId) ?? intensityById(DEFAULT_INTENSITY);
  const type = String(task?.type ?? '').toLowerCase();
  const text = `${task?.title ?? ''} ${task?.description ?? ''}`;

  /**
   * WORK THAT IS GENUINELY MECHANICAL, REGARDLESS OF ITS DECLARED TYPE.
   *
   * The first version of this check was `type === 'docs' || /rename|typo|.../.test(text)`, which read correctly
   * and was wrong: the regex never ran for a coding task, because `type === 'coding'` made the first condition
   * false and the whole `||` was evaluated inside the docs branch. So "Rename the variable", declared as
   * coding, was sent to the browser at FAST - the exact expense this function exists to prevent.
   *
   * A rename is a rename whatever `type` says it is, so the text test stands on its own and the type test is
   * an OR alongside it rather than a gate in front of it.
   */
  const mechanical = type === 'docs'
    || type === 'documentation'
    || /rename|typo|format|changelog|comment|version bump|whitespace/i.test(text);

  // Things that are mechanically answerable are ordinarily finished locally. A mechanical task whose TEXT also
  // asks for judgement ("rename it, and decide whether the abstraction is still right") is not mechanical.
  const judgement = /debug|diagnos|root cause|analys|architect|design|migrat|inspect|investigat|decide|assess|evaluate/i.test(text);

  /**
   * Work that IS a model call: coding, debugging, or an explicit request for judgement.
   *
   * `judgement` is folded in here as well as used as the mechanical guard, because the two are the same signal
   * seen from different sides. A task saying "decide whether the API is still right" is not mechanical, AND it
   * is reasoning work - and leaving it out of this test made such a task fall through to the
   * "FAST sends only complex work" branch and be refused a worker it plainly needed.
   */
  const reasoningish = type === 'coding'
    || /debug|diagnos|root cause|reason|analys|architect|design|migrat|review|inspect|investigat|decide|assess|evaluate/i.test(text)
    || context.needsReasoning === true;

  if (context.forcedByUser === true) {
    return { needs_worker: true, reason: 'the user asked for a worker turn', basis: 'user_request' };
  }
  /**
   * A MECHANICAL EDIT IS REFUSED AT EVERY INTENSITY, AND STRICT IS NOT AN EXCEPTION.
   *
   * STRICT is allowed to use the worker MORE AGGRESSIVELY than the others - `strict_default` below says exactly
   * that - but "aggressively" is not "indiscriminately". A rename that a deterministic local edit can perform
   * does not become a reasoning problem because the user asked for stricter validation, and that validation is
   * `allowed_validation_tiers`, not an extra browser turn. Letting STRICT dispatch here would reintroduce the
   * behaviour this milestone exists to remove: work that is mechanical costing a paid call.
   *
   * An earlier version of this function checked `mechanical && !reasoningish`, and because a coding task is
   * always `reasoningish` the mechanical branch never applied to one - so a coding-task rename was dispatched
   * at FAST. The test caught it. `judgement` is the right guard, not `reasoningish`: the question is whether
   * the TASK needs judgement, not whether its TYPE is one that generally does.
   */
  if (mechanical && !judgement) {
    return {
      needs_worker: false,
      reason: 'a mechanical edit that a local tool or the supervisor can complete without a browser turn',
      basis: 'mechanical',
    };
  }

  if (found.id === INTENSITY.FAST) {
    return reasoningish
      ? { needs_worker: true, reason: 'complex coding, debugging or reasoning', basis: 'reasoning_required' }
      : { needs_worker: false, reason: 'FAST sends only complex coding, debugging or reasoning work to the worker', basis: 'fast_default' };
  }
  if (found.id === INTENSITY.STRICT) {
    return {
      needs_worker: true,
      reason: 'STRICT prefers a worker turn for anything it cannot settle locally, and this is not a mechanical edit',
      basis: 'strict_default',
    };
  }
  return reasoningish
    ? { needs_worker: true, reason: 'a task of this complexity benefits from a worker turn', basis: 'balanced_default' }
    : { needs_worker: false, reason: 'BALANCED keeps ordinary work with the supervisor', basis: 'balanced_default' };
}

/**
 * May a subagent be created?
 *
 * THE RULE IS "IF A DETERMINISTIC TOOL CAN ANSWER IT, A SUBAGENT MUST NOT BE CREATED". A subagent costs a
 * model call and gives an opinion; `sha256`, a file count, a syntax check, a key-set diff, a manifest compare
 * and a test result all give FACTS for the price of a local process. Handing a fact to a model to reason about
 * is not thoroughness, it is spending quota to obtain a worse answer.
 *
 * Every allowed creation must record a reason AND what unique output it will produce, because "review this"
 * and "check that" are how three subagents end up doing the same work.
 */
function subagentGate(intensityId, request = {}, context = {}) {
  const found = intensityById(intensityId) ?? intensityById(DEFAULT_INTENSITY);
  const used = Number.isFinite(context.subagentsUsed) ? context.subagentsUsed : 0;
  const reason = String(request.reason ?? '').trim();
  const unique = String(request.expected_unique_output ?? '').trim();

  if (request.answerableDeterministically === true) {
    return {
      allowed: false,
      code: 'DETERMINISTIC_TOOL_AVAILABLE',
      detail: `a local check can answer this${request.deterministicTool ? ` (${request.deterministicTool})` : ''}; do not spend a model call on it`,
    };
  }
  if (used >= found.budgets.max_subagents) {
    return {
      allowed: false,
      code: 'SUBAGENT_BUDGET_EXHAUSTED',
      detail: `${found.id} allows ${found.budgets.max_subagents} subagent(s); ${used} already used`,
    };
  }
  if (!reason) return { allowed: false, code: 'REASON_REQUIRED', detail: 'a subagent must state why it is needed' };
  if (!unique) {
    return {
      allowed: false,
      code: 'UNIQUE_OUTPUT_REQUIRED',
      detail: 'a subagent must state the unique output it will produce, so two of them cannot do the same work',
    };
  }
  const duplicate = (context.existingOutputs ?? []).find((o) => String(o).trim().toLowerCase() === unique.toLowerCase());
  if (duplicate) {
    return { allowed: false, code: 'DUPLICATE_OUTPUT', detail: `another subagent already promises ${JSON.stringify(duplicate)}` };
  }
  return { allowed: true, code: 'OK', detail: `${found.id} allows ${found.budgets.max_subagents - used} more subagent(s)` };
}

/**
 * The progress fingerprint, and the no-progress guard built on it.
 *
 * WHAT COUNTS AS PROGRESS: a new evidence record, a new diff, a new finding, or a new decision. NOT a new
 * paragraph. Two agents exchanging restatements of the same conclusion is the single most expensive way to
 * make no progress, and it is invisible to a loop that counts turns - so the loop is given something that
 * changes only when the work does.
 *
 * The fingerprint is a deterministic serialisation, so "nothing changed" is a string comparison rather than a
 * judgement, and the guard is testable without a model in the loop.
 */
function progressFingerprint(state = {}) {
  const norm = (v) => (Array.isArray(v) ? [...v].map(String).sort() : []);
  return JSON.stringify({
    evidence: norm(state.evidenceIds),
    changed: norm(state.changedFiles),
    findings: norm(state.findings),
    decisions: norm(state.decisions),
  });
}

/**
 * Advance the streak by one turn.
 *
 * Returns the new streak and whether the goal has now stopped for lack of progress. The caller supplies the
 * previous fingerprint; nothing about this needs a model, a browser or a clock.
 *
 * THE FIRST TURN CAN NEVER BE A NO-PROGRESS TURN: with no previous fingerprint there is nothing to compare
 * against, and treating "nothing to compare" as "no progress" would stop every goal immediately.
 */
function noProgressStep(previous, state = {}, limits = GLOBAL_CEILING) {
  const current = progressFingerprint(state);
  const firstTurn = previous == null;
  const unchanged = !firstTurn && current === previous;
  const streak = unchanged ? (state.noProgressStreak ?? 0) + 1 : 0;
  const limit = Number.isFinite(limits.no_progress_limit) ? limits.no_progress_limit : GLOBAL_CEILING.no_progress_limit;
  return {
    fingerprint: current,
    progressed: !unchanged,
    noProgressStreak: streak,
    stop: !firstTurn && streak >= limit,
    limit,
  };
}

/**
 * Record an expensive call, and refuse a repeat of one already completed.
 *
 * WHAT THIS PROTECTS AGAINST: the same worker turn being dispatched twice because a UI refreshed, a retry
 * fired, or a poll re-entered. That is the cheapest bug to write and the most expensive to run - it looks like
 * a duplicate record, and it bills like a fresh investigation.
 *
 * A repeat is refused unless something that could change the answer has changed: a new instruction, a changed
 * source, or a review finding that asks for more work. "Try again" is not one of those reasons.
 */
function callKey(spec = {}) {
  const norm = (v) => String(v ?? '').trim();
  return [norm(spec.runId), norm(spec.taskId), norm(spec.taskRevision), norm(spec.sourceHash), norm(spec.instructionHash)]
    .join('|');
}

function createCallLedger() {
  const completed = new Map();
  return {
    /**
     * @returns {{allowed: boolean, code: string, detail: string, key: string}}
     */
    check(spec = {}, change = {}) {
      const key = callKey(spec);
      const prior = completed.get(key);
      if (!prior) return { allowed: true, code: 'OK', detail: 'first dispatch for this call', key };
      const reasons = [];
      if (change.newInstruction === true) reasons.push('a new instruction');
      if (change.sourceChanged === true) reasons.push('changed source');
      if (change.reviewFinding === true) reasons.push('a review finding');
      if (reasons.length) {
        return { allowed: true, code: 'RETRY_JUSTIFIED', detail: `re-dispatching because of ${reasons.join(', ')}`, key };
      }
      return {
        allowed: false,
        code: 'DUPLICATE_SUPPRESSED',
        detail: `this exact call already completed (${prior.count} time(s)); re-dispatch needs a new instruction, changed source, or a review finding`,
        key,
      };
    },
    /** Record a COMPLETED call. Only completion counts - a failed attempt is not a paid-for answer. */
    complete(spec = {}) {
      const key = callKey(spec);
      const prior = completed.get(key);
      completed.set(key, { count: (prior?.count ?? 0) + 1, at: new Date().toISOString() });
      return completed.get(key);
    },
    has(spec = {}) { return completed.has(callKey(spec)); },
    size() { return completed.size; },
    clear() { completed.clear(); },
  };
}

module.exports = {
  INTENSITY, INTENSITIES, DEFAULT_INTENSITY, GLOBAL_CEILING, VALIDATION_TIER, TIER_ORDER,
  intensityById, normalizeIntensity, clampBudgets, describeCost, requiredTierIsAllowed,
  workerNecessityFor, subagentGate, progressFingerprint, noProgressStep,
  callKey, createCallLedger,
};
