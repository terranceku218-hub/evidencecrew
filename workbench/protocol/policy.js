'use strict';
/**
 * policy.js - team policy: which seats, which review level, when to stop.
 *
 * WHY THIS IS A POLICY MODULE AND NOT SCATTERED FLAGS
 *   Three decisions now shape every run - is an independent reviewer wanted, which seat fills each
 *   role, and when does a loop stop. Spread across the orchestrator they would drift, and worse, a
 *   caller could quietly decide "this looked fine, skip the reviewer". Centralised, they are data that
 *   can be tested and shown in the UI.
 *
 * CODEX IS OPTIONAL BY DESIGN
 *   The reviewer is a switch, not a requirement. The default is OFF, and OFF must never block a goal:
 *   the supervisor reviews its own work and the Evidence Record says so plainly
 *   (`DISABLED_BY_POLICY`, `review_level = SUPERVISOR_REVIEW`). A disabled reviewer and a missing one
 *   are different facts, and the record keeps them apart.
 */

const REVIEW_LEVEL = {
  SUPERVISOR_REVIEW: 'SUPERVISOR_REVIEW',
  INDEPENDENT_PROVIDER_REVIEW: 'INDEPENDENT_PROVIDER_REVIEW',
};

const CODEX_MODE = { OFF: 'OFF', AUTO: 'AUTO', REQUIRED: 'REQUIRED' };

const INDEPENDENT_REVIEW = {
  DISABLED_BY_POLICY: 'DISABLED_BY_POLICY',
  REQUESTED: 'REQUESTED',
  SATISFIED: 'SATISFIED',
  NOT_SATISFIED: 'NOT_SATISFIED',
  UNAVAILABLE: 'UNAVAILABLE',
  NOT_REQUESTED: 'NOT_REQUESTED',
};

const STOP = {
  GOAL_COMPLETE: 'GOAL_COMPLETE',
  USER_APPROVAL_REQUIRED: 'USER_APPROVAL_REQUIRED',
  BLOCKED: 'BLOCKED',
  NO_PROGRESS: 'NO_PROGRESS',
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
};

/** Defaults, overridable per goal. Bounded on purpose: an unbounded loop is not autonomy, it is a bill. */
const DEFAULT_LIMITS = {
  max_worker_rounds: 8,
  max_task_retries: 3,
  max_goal_iterations: 12,
  no_progress_limit: 2,
};

/**
 * Normalise a codex_review_mode value.
 *
 * THE `ON` CASE IS NOT COSMETIC. The UI control is a toggle labelled "Use Codex Reviewer [OFF/ON]", so
 * the value it submits is `ON` - and `ON` is not a mode, it is a request to USE the reviewer. Before this
 * mapping existed, `normalizeCodexMode('ON')` fell through to the safe-by-default branch and returned
 * OFF: the operator switched the reviewer ON and the system silently switched it off, then recorded
 * `DISABLED_BY_POLICY` as if that had been the intent. A silent inversion of an explicit human choice is
 * the worst failure mode a policy switch can have, so the boolean spellings map to AUTO explicitly.
 *
 * AUTO (not REQUIRED) is the right target: ON means "use the reviewer where it earns its cost", which is
 * exactly what AUTO decides. An unrecognised value still falls back to OFF, because a typo must not spend
 * quota - and that fallback is visible in the Evidence Record as `codex_review_mode=OFF`.
 */
const CODEX_MODE_ALIASES = {
  ON: 'AUTO', TRUE: 'AUTO', YES: 'AUTO', Y: 'AUTO', '1': 'AUTO', ENABLED: 'AUTO', ENABLE: 'AUTO',
  OFF: 'OFF', FALSE: 'OFF', NO: 'OFF', N: 'OFF', '0': 'OFF', DISABLED: 'OFF', DISABLE: 'OFF',
  AUTO: 'AUTO', AUTOMATIC: 'AUTO',
  REQUIRED: 'REQUIRED', REQUIRE: 'REQUIRED', ALWAYS: 'REQUIRED', MANDATORY: 'REQUIRED',
};

function normalizeCodexMode(v) {
  if (typeof v === 'boolean') return v ? CODEX_MODE.AUTO : CODEX_MODE.OFF;
  const s = String(v ?? '').trim().toUpperCase();
  return CODEX_MODE[CODEX_MODE_ALIASES[s] ?? s] ?? CODEX_MODE.OFF;
}

/**
 * Decide whether an independent review is wanted for this task.
 *
 * AUTO is deliberately conservative: it asks for a second provider only where a second opinion
 * actually changes the outcome - complex coding, architecture, high-risk writes, or a disputed
 * result. Asking always would burn quota on trivial reads; asking never would make AUTO meaningless.
 */
function wantsIndependentReview(mode, task, context = {}) {
  const m = normalizeCodexMode(mode);
  if (m === CODEX_MODE.OFF) {
    return { wanted: false, mode: m, reason: 'codex_review_mode is OFF', status: INDEPENDENT_REVIEW.DISABLED_BY_POLICY };
  }
  if (m === CODEX_MODE.REQUIRED) {
    return { wanted: true, mode: m, reason: 'codex_review_mode is REQUIRED', status: INDEPENDENT_REVIEW.REQUESTED };
  }

  const signals = [];
  const type = String(task?.type ?? '').toLowerCase();
  const writes = Array.isArray(context.writeScope) ? context.writeScope.length : 0;
  if (type === 'coding') signals.push('coding task');
  if (/architect|design|migration|refactor/i.test(`${task?.title ?? ''} ${task?.description ?? ''}`)) signals.push('architecture-level change');
  if (writes > 0 && context.highRisk === true) signals.push('high-risk write');
  if (context.disputed === true) signals.push('disputed supervisor verdict');
  if (context.retries >= 2) signals.push('repeated retries');

  return signals.length
    ? { wanted: true, mode: m, reason: `AUTO: ${signals.join(', ')}`, status: INDEPENDENT_REVIEW.REQUESTED, signals }
    : { wanted: false, mode: m, reason: 'AUTO: no independent-review signal for this task', status: INDEPENDENT_REVIEW.NOT_REQUESTED };
}

/**
 * The review level actually achieved, given what the reviewer did.
 *
 * Independent review is only claimed when it really happened. Disabled, unavailable and requested-but-
 * not-satisfied all fall back to SUPERVISOR_REVIEW, which is an honest description rather than a
 * downgrade to hide.
 */
function reviewLevelFor(independentStatus) {
  return independentStatus === INDEPENDENT_REVIEW.SATISFIED
    ? REVIEW_LEVEL.INDEPENDENT_PROVIDER_REVIEW
    : REVIEW_LEVEL.SUPERVISOR_REVIEW;
}

/** A loop's stop condition, evaluated after each task. */
function evaluateStop(state, limits = DEFAULT_LIMITS) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  if (state.goalComplete === true) return { stop: true, condition: STOP.GOAL_COMPLETE, detail: 'goal criteria satisfied' };
  if (state.blocked === true) return { stop: true, condition: STOP.BLOCKED, detail: state.blockedReason ?? 'blocked' };
  if (state.needsApproval === true) return { stop: true, condition: STOP.USER_APPROVAL_REQUIRED, detail: state.approvalReason ?? 'a human decision is required' };
  if ((state.noProgressStreak ?? 0) >= L.no_progress_limit) {
    return { stop: true, condition: STOP.NO_PROGRESS, detail: `${state.noProgressStreak} consecutive iterations produced no new completed task` };
  }
  if ((state.iterations ?? 0) >= L.max_goal_iterations) {
    return { stop: true, condition: STOP.BUDGET_EXHAUSTED, detail: `goal iteration limit ${L.max_goal_iterations} reached` };
  }
  return { stop: false, condition: null, detail: null };
}

/**
 * Should the worker's conversation be rotated?
 *
 * A browser conversation is a resource with a context budget, not a permanent home. When the budget is
 * reached the conversation rotates and the new one receives a compact handoff - because long-term state
 * lives in the Workbench and the Evidence Records, never in a chat transcript.
 */
function shouldRotate(workerRounds, limits = DEFAULT_LIMITS) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  return {
    rotate: workerRounds >= L.max_worker_rounds,
    reason: workerRounds >= L.max_worker_rounds
      ? `worker rounds ${workerRounds} reached max_worker_rounds ${L.max_worker_rounds}; rotate the conversation and hand off compactly`
      : null,
    rounds: workerRounds,
    threshold: L.max_worker_rounds,
  };
}

module.exports = {
  REVIEW_LEVEL, CODEX_MODE, INDEPENDENT_REVIEW, STOP, DEFAULT_LIMITS,
  normalizeCodexMode, wantsIndependentReview, reviewLevelFor, evaluateStop, shouldRotate,
};
