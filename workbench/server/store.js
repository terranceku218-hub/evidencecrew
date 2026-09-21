'use strict';
/**
 * store.js - workbench-side state that the harness has no concept of.
 *
 * WHAT BELONGS HERE, AND WHAT DOES NOT
 *   The harness owns projects, workspaces, tasks, workers and Git. This file owns ONLY what
 *   the workbench itself introduces:
 *
 *     autonomyMode  - ADVISOR or SAFE_AUTO, the approval gate level
 *     paused        - whether new automatic actions may start
 *     goals         - the natural-language goals the user submitted
 *     decisions     - approve / reject records attached to goals and tasks
 *
 *   It is emphatically NOT a second business database. Nothing here duplicates a task, a
 *   workspace or a project: it stores identifiers plus the user's own intent, and every
 *   lookup of real state goes back to the harness. If this file were deleted, no project
 *   truth would be lost - only the user's pending-goal bookkeeping.
 *
 * ATOMIC WRITES
 *   Temp file plus rename, so an interrupted write cannot leave a half-file that the next
 *   read misinterprets.
 *
 * ASCII-ONLY source.
 */

const fs = require('node:fs');
const path = require('node:path');

// PUBLIC RELEASE CHANGE: one shared loader resolves every configured path against the repository root,
// so this file no longer assumes absolute paths recorded on the maintainer machine.
const { CONFIG } = require('../config.js');
const STATE_FILE = CONFIG.paths.stateFile;

function emptyState() {
  return {
    version: 1,
    workbench: CONFIG.workbench.version,
    updated_at: null,
    autonomy: {},   // project_id -> 'ADVISOR' | 'SAFE_AUTO'
    paused: {},     // project_id -> boolean
    goals: [],      // newest first
    decisions: [],  // newest first
    sendStates: [], // newest first - the send lifecycle, see send-state.js
    seq: 0,
  };
}

function load() {
  if (!fs.existsSync(STATE_FILE)) return emptyState();
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, ''));
    const base = emptyState();
    return { ...base, ...raw, autonomy: raw.autonomy ?? {}, paused: raw.paused ?? {},
             goals: raw.goals ?? [], decisions: raw.decisions ?? [],
             sendStates: raw.sendStates ?? [] };
  } catch (e) {
    // A corrupt workbench state must not take the UI down: the loss is only goal
    // bookkeeping, and regenerating it is harmless. The harness remains the source of truth
    // for everything that actually matters.
    process.stderr.write(`workbench store unreadable (${STATE_FILE}): ${e.message}; starting fresh\n`);
    return emptyState();
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  state.updated_at = new Date().toISOString();
  const tmp = `${STATE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, STATE_FILE);
  return state;
}

function nextGoalId(state) {
  state.seq = (state.seq ?? 0) + 1;
  return `GOAL-${String(state.seq).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// autonomy + pause
// ---------------------------------------------------------------------------

/** Effective autonomy mode for a project. Defaults to ADVISOR, never to autonomy. */
function autonomyOf(projectId) {
  const s = load();
  return s.autonomy[projectId] ?? CONFIG.safety.defaultAutonomyMode;
}

function setAutonomy(projectId, mode) {
  if (!['ADVISOR', 'SAFE_AUTO'].includes(mode)) {
    return { ok: false, error: `unknown autonomy mode: ${mode}; expected ADVISOR or SAFE_AUTO` };
  }
  const s = load();
  s.autonomy[projectId] = mode;
  save(s);
  return { ok: true, project_id: projectId, autonomy_mode: mode };
}

function isPaused(projectId) {
  const s = load();
  return s.paused[projectId] === true;
}

function setPaused(projectId, paused) {
  const s = load();
  s.paused[projectId] = paused === true;
  save(s);
  return { ok: true, project_id: projectId, paused: s.paused[projectId] };
}

// ---------------------------------------------------------------------------
// goals
// ---------------------------------------------------------------------------

function addGoal(goal) {
  const s = load();
  const id = nextGoalId(s);
  const record = {
    goal_id: id,
    project_id: goal.project_id,
    workspace_id: goal.workspace_id ?? null,
    text: goal.text,
    status: goal.status ?? 'SUBMITTED',
    routing: goal.routing ?? null,
    plan: goal.plan ?? [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    error: null,
  };
  s.goals.unshift(record);
  save(s);
  return record;
}

function updateGoal(goalId, patch) {
  const s = load();
  const g = s.goals.find((x) => x.goal_id === goalId);
  if (!g) return { ok: false, error: `no such goal: ${goalId}` };
  Object.assign(g, patch, { updated_at: new Date().toISOString() });
  save(s);
  return { ok: true, goal: g };
}

function getGoal(goalId) {
  return load().goals.find((g) => g.goal_id === goalId) ?? null;
}

function listGoals(projectId, limit = 50) {
  const s = load();
  const all = projectId ? s.goals.filter((g) => g.project_id === projectId) : s.goals;
  return all.slice(0, limit);
}

// ---------------------------------------------------------------------------
// decisions (approve / reject)
// ---------------------------------------------------------------------------

function addDecision(decision) {
  const s = load();
  const record = {
    at: new Date().toISOString(),
    project_id: decision.project_id,
    goal_id: decision.goal_id ?? null,
    task_id: decision.task_id ?? null,
    action: decision.action, // APPROVE | REJECT | RETRY | ASK
    reason: decision.reason ?? null,
    actor: 'user',
  };
  s.decisions.unshift(record);
  // Keep the log bounded; it is an audit trail for the UI, not an archive.
  if (s.decisions.length > 1000) s.decisions.length = 1000;
  save(s);
  return record;
}

function listDecisions(projectId, limit = 100) {
  const s = load();
  const all = projectId ? s.decisions.filter((d) => d.project_id === projectId) : s.decisions;
  return all.slice(0, limit);
}

// ---------------------------------------------------------------------------
// send lifecycle (see send-state.js)
// ---------------------------------------------------------------------------

/** Insert or replace one send-state record. Newest first, bounded. */
function upsertSendState(record) {
  const s = load();
  const i = s.sendStates.findIndex((x) => x.send_state_id === record.send_state_id);
  if (i >= 0) s.sendStates[i] = record;
  else s.sendStates.unshift(record);
  if (s.sendStates.length > 200) s.sendStates.length = 200;
  save(s);
  return record;
}

function getSendState(sendStateId) {
  return load().sendStates.find((x) => x.send_state_id === sendStateId) ?? null;
}

function listSendStates(projectId, limit = 20) {
  const s = load();
  const all = projectId ? s.sendStates.filter((x) => x.project_id === projectId) : s.sendStates;
  return all.slice(0, limit);
}

/**
 * The independent-reviewer switch, stored per project.
 *
 * The RAW selection is stored, not the normalised mode: the operator chose ON, so the UI must show ON
 * when it reloads. Normalisation happens in ONE place - `protocol/policy.js` - and both this server and
 * the autonomous loop call it, so a value cannot mean AUTO to the UI and OFF to the loop. The normalised
 * value is returned alongside for display, which is how `ON (effective AUTO)` can be shown honestly
 * instead of silently rewriting the operator's choice.
 */
function setCodexReviewMode(projectId, mode) {
  const policy = require('../protocol/policy.js');
  const raw = String(mode ?? '').trim().toUpperCase();
  if (!['OFF', 'ON', 'AUTO', 'REQUIRED'].includes(raw)) {
    return { ok: false, error: `unknown reviewer mode: ${mode}; expected OFF, ON, AUTO or REQUIRED` };
  }
  const s = load();
  s.review = s.review ?? {};
  s.review[projectId] = raw;
  save(s);
  return { ok: true, project_id: projectId, requested: raw, mode: policy.normalizeCodexMode(raw) };
}

function codexReviewModeOf(projectId) {
  const s = load();
  return s.review?.[projectId] ?? CONFIG.review?.codexReviewMode ?? 'OFF';
}

/** Everything the UI needs about workbench-owned state for one project. */
function view(projectId) {
  const s = load();
  const policy = require('../protocol/policy.js');
  const selectedReview = codexReviewModeOf(projectId);
  return {
    autonomy_mode: s.autonomy[projectId] ?? CONFIG.safety.defaultAutonomyMode,
    codex_review_mode: selectedReview,
    codex_review_mode_effective: policy.normalizeCodexMode(selectedReview),
    paused: s.paused[projectId] === true,
    goals: s.goals.filter((g) => g.project_id === projectId).slice(0, 20),
    decisions: s.decisions.filter((d) => d.project_id === projectId).slice(0, 50),
    send_states: s.sendStates.filter((x) => x.project_id === projectId).slice(0, 10),
    state_file: STATE_FILE,
    default_autonomy_mode: CONFIG.safety.defaultAutonomyMode,
  };
}

module.exports = {
  STATE_FILE,
  load, save,
  autonomyOf, setAutonomy, isPaused, setPaused,
  setCodexReviewMode, codexReviewModeOf,
  addGoal, updateGoal, getGoal, listGoals,
  addDecision, listDecisions,
  upsertSendState, getSendState, listSendStates,
  view,
};
