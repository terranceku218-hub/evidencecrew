'use strict';
/**
 * workers.js - the global Worker Pool.
 *
 * THE CORE INVARIANT
 *   A ChatGPT conversation belongs to exactly ONE project. The browser session and the
 *   logged-in profile are global (the login is not per-project), but the CONVERSATION is
 *   the unit of isolation, because a conversation carries context. Sharing one
 *   conversation across two projects would leak project A's state into project B's
 *   reasoning - the exact cross-contamination the harness must prevent.
 *
 *   `bind()` therefore refuses to point an existing ACTIVE conversation at a different
 *   project. Switching projects means using (or creating) that project's own worker.
 *
 * ASCII-ONLY source: see the encoding note in ../config.json.
 */

const fs = require('node:fs');

const {
  CONFIG, readJsonIfExists, writeJsonAtomic, ensureDir, logEvent, nowIso,
} = require('./paths.js');
const driver = require('./driver.js');

const STATUS = { ACTIVE: 'ACTIVE', ARCHIVED: 'ARCHIVED' };
const ROLES = ['coding', 'writing', 'research', 'review', 'general'];

/**
 * Conversation URL lifecycle (HOTFIX 2.0.1, bug H1).
 *
 * A brand-new ChatGPT conversation has NO id until its first message is sent - the browser
 * sits on the bare base URL. The ledger previously stored that base URL as if it were the
 * conversation, so a later `focusConversation` navigated to a NEW chat instead of the
 * worker's own conversation, which is how a review packet ended up in the wrong thread.
 *
 * The states below make the difference explicit, and the invariant is enforced at USE time:
 * only a URL matching /c/<conversation-id> may be treated as a settled conversation.
 */
const CONVERSATION_STATE = {
  /** No conversation opened yet. */
  NEW: 'NEW',
  /** A browser conversation was opened, but its id is not yet known (still the base URL). */
  UNRESOLVED: 'UNRESOLVED',
  /** A real /c/<id> URL is stored and may be used for focus, resume and handoff. */
  RESOLVED: 'RESOLVED',
  /** Resolution was attempted and failed; the worker must not be used until resolved. */
  BLOCKED: 'BLOCKED',
};

/** True when a URL is a real, id-bearing ChatGPT conversation URL. */
function isConversationUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    if (!/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/i.test(u.hostname)) return false;
    return /\/c\/[0-9a-z-]{8,}/i.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Effective conversation state of a worker.
 *
 * Derived rather than trusted: a worker whose stored URL is not a real conversation URL can
 * never be reported as RESOLVED, whatever `conversation_state` happens to say. This is what
 * makes the H1 invariant hold even for records written by an older version.
 */
function conversationStateOf(worker) {
  if (!worker) return CONVERSATION_STATE.NEW;
  if (isConversationUrl(worker.conversation_url)) return CONVERSATION_STATE.RESOLVED;
  const raw = worker.conversation_state;
  if (raw === CONVERSATION_STATE.BLOCKED) return CONVERSATION_STATE.BLOCKED;
  if (worker.conversation_url) return CONVERSATION_STATE.UNRESOLVED;
  return raw === CONVERSATION_STATE.UNRESOLVED ? CONVERSATION_STATE.UNRESOLVED : CONVERSATION_STATE.NEW;
}

/** May this worker's conversation be focused, resumed, or handed off? */
function isResolved(worker) {
  return conversationStateOf(worker) === CONVERSATION_STATE.RESOLVED;
}

function emptyPool() {
  return { version: 1, seq: 0, workers: [] };
}

function load() {
  const data = readJsonIfExists(CONFIG.paths.workerPool, emptyPool());
  if (!Array.isArray(data.workers)) return emptyPool();
  return data;
}

function save(data) {
  ensureDir(CONFIG.paths.registry);
  return writeJsonAtomic(CONFIG.paths.workerPool, data);
}

function find(data, workerId) {
  return data.workers.find((w) => w.worker_id === workerId) ?? null;
}

function list(projectId) {
  const data = load();
  const all = projectId ? data.workers.filter((w) => w.project_id === projectId) : data.workers;
  return all.sort((a, b) => a.worker_id.localeCompare(b.worker_id));
}

/**
 * Effective workspace of a worker.
 *
 * V1 workers predate the Workspace layer and carry no `workspace_id`. They are reported as
 * the implicit `default` workspace, which is exactly how V1 projects are treated
 * everywhere else - so a V1 worker keeps working with no migration.
 */
function workspaceOf(worker) {
  return worker?.workspace_id ?? 'default';
}

function listView(projectId, opts = {}) {
  const data = load();
  let all = projectId ? data.workers.filter((w) => w.project_id === projectId) : data.workers;
  if (opts.workspaceId) all = all.filter((w) => workspaceOf(w) === opts.workspaceId);
  return {
    total: all.length,
    active: all.filter((w) => w.status === STATUS.ACTIVE).length,
    archived: all.filter((w) => w.status === STATUS.ARCHIVED).length,
    workers: all
      .sort((a, b) => a.worker_id.localeCompare(b.worker_id))
      .map((w) => ({
        worker_id: w.worker_id,
        project_id: w.project_id,
        workspace_id: workspaceOf(w),
        role: w.role,
        status: w.status,
        rounds: w.rounds,
        effective_rounds: effectiveRounds(w),
        observed_user_turns: w.observed_user_turns ?? null,
        conversation_url: w.conversation_url,
        conversation_state: conversationStateOf(w),
        created_at: w.created_at,
        last_used: w.last_used,
      })),
  };
}

/**
 * Resolve the worker that should serve a project - and, in V2, a workspace.
 *
 * THE ISOLATION INVARIANT
 *   A conversation belongs to one project AND one workspace. Story context must never
 *   reach the worker fixing a null reference, because that is precisely the context
 *   pollution the Workspace layer exists to prevent. So when a workspace is requested,
 *   ONLY a worker bound to that workspace is eligible - falling back to a worker from a
 *   different workspace would silently defeat the whole abstraction.
 *
 *   When no workspace is requested, V1 behaviour is preserved: any active worker for the
 *   project qualifies, with implicit-default workers treated as belonging to `default`.
 *
 * @param {string} projectId
 * @param {{workspaceId?:string, role?:string}} [opts]
 */
function getForProject(projectId, opts = {}) {
  const data = load();
  let mine = data.workers.filter((w) => w.project_id === projectId && w.status === STATUS.ACTIVE);
  if (!mine.length) return null;

  if (opts.workspaceId) {
    mine = mine.filter((w) => workspaceOf(w) === opts.workspaceId);
    if (!mine.length) return null;
  }

  // Prefer a worker that already has a conversation; otherwise the oldest.
  const withConv = mine.filter((w) => w.conversation_url);
  const pool = withConv.length ? withConv : mine;
  if (opts.role) {
    const byRole = pool.filter((w) => w.role === opts.role);
    if (byRole.length) return byRole[0];
  }
  return pool.sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
}

/**
 * Create a worker record bound to a project AND a workspace.
 *
 * A conversation is NOT opened here: creating the conversation is a separate, explicit
 * step (`openConversation`) so a failure to reach the browser cannot leave a worker
 * record that claims a conversation it does not have.
 *
 * Omitting `workspaceId` yields `null`, which reads as the implicit `default` workspace.
 * Existing callers therefore keep their V1 meaning without change.
 */
function create(projectId, opts = {}) {
  if (!projectId) return { ok: false, error: 'projectId is required' };
  const role = opts.role ?? 'general';
  if (!ROLES.includes(role)) {
    return { ok: false, error: `unknown role "${role}"; expected one of ${ROLES.join(', ')}` };
  }

  const workspaceId = opts.workspaceId ?? null;
  const data = load();
  data.seq = (data.seq ?? 0) + 1;
  const workerId = opts.workerId
    ?? `GPT-WORKER-${projectId}${workspaceId ? `-${workspaceId}` : ''}-${String(data.seq).padStart(3, '0')}`;

  if (find(data, workerId)) {
    return { ok: false, error: `worker_id already exists: ${workerId}` };
  }

  const worker = {
    worker_id: workerId,
    project_id: projectId,
    workspace_id: workspaceId,
    role,
    // A fresh worker has no conversation. It is NEVER given the bare base URL as if that
    // were a conversation - see the HOTFIX 2.0.1 note on CONVERSATION_STATE.
    conversation_url: null,
    conversation_state: CONVERSATION_STATE.NEW,
    rounds: 0,
    status: STATUS.ACTIVE,
    created_at: nowIso(),
    last_used: null,
    archived: false,
    archived_at: null,
    task: opts.task ?? '',
    history: [{ n: 1, at: nowIso(), event: 'created', detail: opts.task ?? '' }],
  };

  data.workers.push(worker);
  save(data);
  logEvent('worker.create', { workerId, role, workspaceId, task: opts.task ?? '' }, projectId);
  return { ok: true, worker };
}

function record(data, worker, event, detail) {
  worker.history = worker.history ?? [];
  worker.history.push({ n: worker.history.length + 1, at: nowIso(), event, detail: String(detail ?? '') });
}

/**
 * Bind a conversation URL to a worker.
 *
 * Refuses two things:
 *   1. handing an existing ACTIVE conversation to a different project; and
 *   2. handing it to a different WORKSPACE, which is the V2 form of the same leak.
 *
 * HOTFIX 2.0.1 (H1): a URL that is not a real /c/<id> conversation sets the worker's state
 * to UNRESOLVED rather than pretending the conversation is settled. Binding is still
 * permitted so the "opened but not yet resolved" moment is representable, but nothing
 * downstream may treat such a worker as having a usable conversation.
 */
function bind(workerId, conversationUrl, projectId, workspaceId) {
  const data = load();
  const w = find(data, workerId);
  if (!w) return { ok: false, error: `no such worker: ${workerId}` };

  if (projectId && w.project_id !== projectId) {
    return {
      ok: false,
      error: `refusing to bind worker ${workerId} (project ${w.project_id}) to project ${projectId}`,
    };
  }

  if (workspaceId && workspaceOf(w) !== workspaceId) {
    return {
      ok: false,
      error: `refusing to bind worker ${workerId} (workspace ${workspaceOf(w)}) to workspace ${workspaceId}. ` +
             `A conversation belongs to one workspace; create a separate worker for ${workspaceId}.`,
    };
  }

  const resolved = isConversationUrl(conversationUrl);

  if (w.conversation_url && conversationUrl && w.conversation_url !== conversationUrl) {
    record(data, w, 'conversation.replaced', `${w.conversation_url} -> ${conversationUrl}`);
  } else {
    record(data, w, 'conversation.bound', conversationUrl);
  }
  w.conversation_url = conversationUrl;
  w.conversation_state = resolved ? CONVERSATION_STATE.RESOLVED : CONVERSATION_STATE.UNRESOLVED;
  if (resolved) w.conversation_resolved_at = nowIso();
  w.last_used = nowIso();
  save(data);
  logEvent('worker.bind', { workerId, conversationUrl, resolved, workspaceId: workspaceOf(w) }, w.project_id);
  return { ok: true, worker: w, conversation_state: w.conversation_state, resolved };
}

/**
 * Read the browser's ACTUAL url and, if it is a real conversation, settle it on the worker.
 *
 * This is the H1 resolution step: after the first message the conversation id exists, and
 * only this call turns an UNRESOLVED worker into a usable one.
 *
 * @returns {{ok:boolean, state?:string, conversation_url?:string, detail?:string}}
 */
function resolveConversationUrl(workerId) {
  const data = load();
  const w = find(data, workerId);
  if (!w) return { ok: false, error: `no such worker: ${workerId}` };

  const cur = driver.currentUrl({ projectId: w.project_id });
  if (!cur.ok || !cur.value?.ok) {
    return { ok: false, state: conversationStateOf(w),
             detail: cur.value?.error ?? cur.error ?? 'could not read browser url' };
  }

  const url = cur.value.url;
  if (!isConversationUrl(url)) {
    // Never fall back to the base URL, and never guess a conversation.
    w.conversation_state = CONVERSATION_STATE.UNRESOLVED;
    save(data);
    return {
      ok: false,
      state: CONVERSATION_STATE.UNRESOLVED,
      detail: `browser url is not a conversation url yet: ${url}`,
    };
  }

  const already = w.conversation_url;
  w.conversation_url = url;
  w.conversation_state = CONVERSATION_STATE.RESOLVED;
  w.conversation_resolved_at = nowIso();
  w.last_used = nowIso();
  record(data, w, 'conversation.resolved', already && already !== url ? `${already} -> ${url}` : url);
  save(data);
  logEvent('worker.conversation.resolved', { workerId, url }, w.project_id);
  return { ok: true, state: CONVERSATION_STATE.RESOLVED, conversation_url: url };
}

/**
 * Mark a worker's conversation as BLOCKED because resolution failed.
 * The worker must not be used for a second round until it is resolved.
 */
function blockConversation(workerId, reason) {
  const data = load();
  const w = find(data, workerId);
  if (!w) return { ok: false, error: `no such worker: ${workerId}` };
  w.conversation_state = CONVERSATION_STATE.BLOCKED;
  record(data, w, 'conversation.unresolved', reason ?? 'resolution failed');
  save(data);
  logEvent('worker.conversation.blocked', { workerId, reason }, w.project_id);
  return { ok: true, worker: w, state: CONVERSATION_STATE.BLOCKED };
}

/**
 * Open a brand-new ChatGPT conversation for this worker.
 *
 * HOTFIX 2.0.1 (H1): a fresh conversation has no id until its FIRST message is sent, so the
 * browser reports the bare base URL here. That URL is intentionally NOT stored as the
 * worker's conversation - doing so was the bug, because a later focus would open a different
 * chat. The worker is left in UNRESOLVED state and `conversation_url` stays null until
 * `resolveConversationUrl` observes a real /c/<id> URL after the first send.
 */
function openConversation(workerId) {
  const data = load();
  const w = find(data, workerId);
  if (!w) return { ok: false, error: `no such worker: ${workerId}` };

  const health = driver.healthCheck({ projectId: w.project_id });
  if (!health.ok || health.value?.status !== 'READY') {
    return {
      ok: false,
      status: health.value?.status ?? 'ERROR',
      detail: health.value?.detail ?? health.error ?? 'worker not ready',
      humanAction: health.value?.humanAction,
    };
  }

  const created = driver.newConversation({ projectId: w.project_id });
  if (!created.ok || !created.value?.ok) {
    return { ok: false, status: created.value?.status ?? 'ERROR',
             detail: created.value?.detail ?? created.error ?? 'could not create conversation',
             humanAction: created.value?.humanAction };
  }

  const url = created.value.url;

  if (isConversationUrl(url)) {
    const bound = bind(workerId, url, w.project_id);
    if (!bound.ok) return bound;
    return { ok: true, worker: bound.worker, conversation_url: url,
             conversation_state: CONVERSATION_STATE.RESOLVED, note: created.value.note };
  }

  // Base URL only: the conversation exists but is not yet identifiable. Record the state as
  // UNRESOLVED and keep conversation_url null so no downstream operation can mistake it for
  // a settled conversation.
  const d2 = load();
  const w2 = find(d2, workerId);
  w2.conversation_url = null;
  w2.conversation_state = CONVERSATION_STATE.UNRESOLVED;
  w2.last_used = nowIso();
  record(d2, w2, 'conversation.opened.unresolved', url);
  save(d2);
  logEvent('worker.conversation.opened', { workerId, url, resolved: false }, w2.project_id);

  return {
    ok: true,
    worker: w2,
    conversation_url: null,
    conversation_state: CONVERSATION_STATE.UNRESOLVED,
    note: created.value.note,
    next_step: 'Send the first message, then resolveConversationUrl() settles the real /c/<id> url.',
  };
}

/**
 * Point the browser at this worker's conversation.
 *
 * HOTFIX 2.0.1 (H1): refuses to run unless the conversation is RESOLVED. Previously a worker
 * holding the bare base URL was "focused" onto a BRAND NEW chat, which silently moved the
 * worker's next message into a different thread. Verification only - sends nothing.
 */
function focusConversation(workerId) {
  const data = load();
  const w = find(data, workerId);
  if (!w) return { ok: false, error: `no such worker: ${workerId}` };

  if (!isResolved(w)) {
    const state = conversationStateOf(w);
    return {
      ok: false,
      status: 'BLOCKED',
      state,
      error: `worker ${workerId} has no resolved conversation (state ${state}). ` +
             `Refusing to focus: a non-conversation url would open a NEW chat and move this ` +
             `worker's next message into the wrong thread. Resolve it first with resolveConversationUrl.`,
    };
  }

  const opened = driver.openConversation(w.conversation_url, { projectId: w.project_id });
  if (!opened.ok || !opened.value?.ok) {
    return { ok: false, status: opened.value?.status ?? 'ERROR',
             detail: opened.value?.detail ?? opened.error,
             humanAction: opened.value?.humanAction };
  }
  w.last_used = nowIso();
  save(data);
  return { ok: true, worker: w, assistantTurns: opened.value.assistantTurns,
           conversation_url: w.conversation_url };
}

/** Rounds as the rotation policy should see them: recorded, but never below observed. */
function effectiveRounds(worker) {
  const observed = Number.isFinite(worker?.observed_user_turns) ? worker.observed_user_turns : null;
  if (observed === null) return worker?.rounds ?? 0;
  return Math.max(worker?.rounds ?? 0, observed);
}

/**
 * Reconcile the recorded round count against what the conversation ACTUALLY contains.
 *
 * HOTFIX 2.0.1 (H2): a round is "a user turn that really appeared in the ChatGPT
 * conversation", not "the harness believed an entire round succeeded". When a send lands but
 * the completion check fails, the old code left the counter untouched even though the
 * conversation had grown - so the rotation threshold under-counted exactly the context
 * growth it exists to bound.
 *
 * @param {string} workerId
 * @param {number} observedUserTurns turn count read from the live page by the caller
 */
function reconcileRounds(workerId, observedUserTurns) {
  const data = load();
  const w = find(data, workerId);
  if (!w) return { ok: false, error: `no such worker: ${workerId}` };

  const n = Number(observedUserTurns);
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, error: `observed user turns must be a non-negative number, got ${observedUserTurns}` };
  }

  const previous = w.rounds ?? 0;
  w.observed_user_turns = Math.floor(n);
  const corrected = Math.max(previous, w.observed_user_turns);

  if (corrected !== previous) {
    w.rounds = corrected;
    w.rounds_reconciled_at = nowIso();
    record(data, w, 'rounds.reconciled',
      `recorded ${previous} -> observed ${w.observed_user_turns} (adopted ${corrected})`);
    save(data);
    logEvent('worker.rounds.reconciled',
      { workerId, previous, observed: w.observed_user_turns, adopted: corrected }, w.project_id);
    return { ok: true, worker: w, previous, observed: w.observed_user_turns, adopted: corrected,
             changed: true, rotation: rotationCheck(w) };
  }

  record(data, w, 'rounds.checked', `recorded ${previous} matches observed ${w.observed_user_turns}`);
  save(data);
  return { ok: true, worker: w, previous, observed: w.observed_user_turns, adopted: corrected,
           changed: false, rotation: rotationCheck(w) };
}

/** Count one completed round. Round counting is per worker, hence per project. */
function bumpRound(workerId, opts = {}) {
  const data = load();
  const w = find(data, workerId);
  if (!w) return { ok: false, error: `no such worker: ${workerId}` };
  w.rounds += 1;
  w.last_used = nowIso();
  record(data, w, 'round', `round ${w.rounds}${opts.detail ? ` - ${opts.detail}` : ''}`);
  save(data);
  return { ok: true, worker: w, rotation: rotationCheck(w) };
}

function markSuccess(workerId) {
  const data = load();
  const w = find(data, workerId);
  if (!w) return { ok: false, error: `no such worker: ${workerId}` };
  record(data, w, 'success', 'review PASS');
  save(data);
  return { ok: true, worker: w };
}

function archive(workerId, reason) {
  const data = load();
  const w = find(data, workerId);
  if (!w) return { ok: false, error: `no such worker: ${workerId}` };
  w.status = STATUS.ARCHIVED;
  w.archived = true;
  w.archived_at = nowIso();
  w.rotation_reason = reason ?? 'manual';
  record(data, w, 'archived', w.rotation_reason);
  save(data);
  logEvent('worker.archive', { workerId, reason: w.rotation_reason }, w.project_id);
  return { ok: true, worker: w };
}

/**
 * Rotation policy: a threshold is a SIGNAL, not an order. The caller decides, because
 * slow or truncated replies and context warnings are equally valid triggers that the
 * round count cannot see.
 */
function rotationCheck(worker) {
  const reasons = [];
  const threshold = CONFIG.limits.maxWorkerRounds;
  // HOTFIX 2.0.1 (H2): use EFFECTIVE rounds - recorded, but never below the observed
  // user-turn count - so a stale low counter cannot postpone rotation past the context
  // growth the threshold exists to bound.
  const rounds = effectiveRounds(worker);
  if (rounds >= threshold) {
    reasons.push(`rounds ${rounds} >= max_worker_rounds ${threshold}`);
  }
  return { shouldRotate: reasons.length > 0, reasons, rounds, threshold };
}

/**
 * Rotate a project to a fresh conversation: archive the old worker, create a new one.
 * The caller must then send a handoff packet; this function deliberately does not, so
 * that the handoff content stays the supervisor's responsibility.
 */
function rotate(oldWorkerId, reason, opts = {}) {
  const data = load();
  const old = find(data, oldWorkerId);
  if (!old) return { ok: false, error: `no such worker: ${oldWorkerId}` };
  const projectId = old.project_id;
  // Rotation stays within the workspace: a replacement for the story worker is another
  // story worker, never a coding one.
  const workspaceId = workspaceOf(old);

  const archived = archive(oldWorkerId, reason ?? 'rotation');
  if (!archived.ok) return archived;

  const fresh = create(projectId, {
    role: opts.role ?? old.role,
    task: opts.task ?? '',
    workspaceId: old.workspace_id ?? null,
  });
  if (!fresh.ok) return fresh;

  const d2 = load();
  const w = find(d2, fresh.worker.worker_id);
  w.handoff_from = oldWorkerId;
  record(d2, w, 'handoff', `from ${oldWorkerId}`);
  save(d2);
  logEvent('worker.rotate', { from: oldWorkerId, to: w.worker_id, workspaceId }, projectId);
  return { ok: true, archived: archived.worker, created: w, project_id: projectId, workspace_id: workspaceId };
}

/**
 * Guard: may this worker serve this project (and workspace)?
 * Exists so callers can assert the isolation invariant rather than trusting their inputs.
 *
 * @param {string} workerId
 * @param {string} projectId
 * @param {string} [workspaceId] when given, the workspace must match too
 */
function assertOwnership(workerId, projectId, workspaceId) {
  const w = find(load(), workerId);
  if (!w) return { ok: false, error: `no such worker: ${workerId}` };
  if (w.project_id !== projectId) {
    return { ok: false, error: `worker ${workerId} belongs to project ${w.project_id}, not ${projectId}` };
  }
  if (workspaceId && workspaceOf(w) !== workspaceId) {
    return { ok: false, error: `worker ${workerId} belongs to workspace ${workspaceOf(w)}, not ${workspaceId}` };
  }
  return { ok: true, worker: w };
}

function renderMarkdown(projectId) {
  const view = listView(projectId);
  const lines = [];
  lines.push('# Agent Harness - Worker Pool');
  lines.push('');
  lines.push('> RUNNING STATE, not project knowledge. Generated from registry/workers.json.');
  lines.push('> A worker conversation belongs to exactly one project.');
  lines.push('');
  lines.push(`- scope: ${projectId ?? '(all projects)'}`);
  lines.push(`- active: ${view.active}   archived: ${view.archived}   total: ${view.total}`);
  lines.push(`- rotation threshold: ${CONFIG.limits.maxWorkerRounds} rounds`);
  lines.push(`- updated: ${nowIso()}`);
  lines.push('');
  lines.push('| Worker | Project | Role | Status | Rounds | URL |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const w of view.workers) {
    const url = w.conversation_url ? `[link](${w.conversation_url})` : '(none)';
    lines.push(`| ${w.worker_id} | ${w.project_id} | ${w.role} | ${w.status} | ${w.rounds} | ${url} |`);
  }
  if (!view.workers.length) lines.push('| _(none)_ | | | | | |');
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  STATUS, ROLES, CONVERSATION_STATE,
  isConversationUrl, conversationStateOf, isResolved, effectiveRounds,
  load, save, list, listView, getForProject, create, bind, openConversation, workspaceOf,
  resolveConversationUrl, blockConversation, reconcileRounds,
  focusConversation, bumpRound, markSuccess, archive, rotationCheck, rotate,
  assertOwnership, renderMarkdown,
};
