'use strict';
/*
 * app.js - EvidenceCrew front end. No framework, no build step, no dependencies.
 *
 * WHY PLAIN JS
 *   The server is zero-dependency so the tool runs on a machine that cannot reach npm. A
 *   bundled front end would undo that. This file is loaded directly by the browser and is
 *   small enough to read end to end, which matters more here than any framework convenience.
 *
 * THE ONE INVARIANT THAT SHAPES EVERYTHING
 *   Only ONE long operation may be running at a time. A real ChatGPT turn drives a real
 *   browser through a shared profile, so two concurrent sends would interleave in the same
 *   tab. `state.busy` is therefore a hard gate: every action checks it, and every button is
 *   disabled while it is set. This is not cosmetic - it is the same single-concurrency rule
 *   the harness enforces underneath.
 *
 * ERROR POLICY
 *   The UI never guesses and never hides a refusal. When the server says WORKSPACE_REQUIRED,
 *   the message is shown verbatim with the candidates, because that refusal is a feature:
 *   guessing a workspace means sending the wrong context to the worker.
 *
 * LOCALISATION
 *   Every user-visible string comes from the catalogue through `t()` or `ts()`. There is no
 *   `if (lang === ...)` in this file and no component that keeps its own strings: that is how half a
 *   screen ends up in one language and half in another. `ts()` translates a canonical machine value for
 *   DISPLAY ONLY and hands back the original beside it, so a translated label never replaces the value
 *   the protocol actually wrote.
 */

// ---------------------------------------------------------------------------
// i18n shortcuts
// ---------------------------------------------------------------------------

/** Translate a catalogue key. */
const tr = (key, vars) => window.I18N.t(key, vars);

/**
 * Translate a canonical machine value for display.
 *
 * Returns `{ text, canonical }`: the panel shows `text` and keeps `canonical` in a title attribute, so a
 * reader can always see the value the protocol produced. `GOAL_COMPLETE` is never rewritten anywhere -
 * not in the JSON, not in the API, not in the record, not in the tests.
 */
const ts = (value) => window.I18N.ts(value);

/** Render a status label with the canonical value kept as a tooltip, plus the shared icon. */
function statusChip(value, extraClass = '') {
  const s = ts(value);
  if (!s.text) return '';
  const icon = statusIcon(s.canonical);
  return `<span class="status ${statusClass(s.canonical)} ${extraClass}" title="${esc(tr('evidence.canonicalHint'))}: ${esc(s.canonical)}">`
    + `<span class="status-icon" aria-hidden="true">${icon}</span>${esc(s.text)}</span>`;
}

/**
 * A status is never expressed by colour alone: each one also carries an icon and a word, so it survives
 * colour blindness, a greyscale screenshot and a printed page.
 */
function statusIcon(value) {
  const v = String(value ?? '').toUpperCase();
  if (/COMPLETE|DONE|PASS|VERIFIED|SATISFIED|CORRELATED|ACTIVE|RESOLVED|READY|CONNECTED|RESUMED/.test(v)) return '\u2713';
  if (/BLOCKED|FAILED|UNVERIFIED|ERROR|NOT_SATISFIED|UNCERTAIN|DISABLED|REJECTED|UNAVAILABLE/.test(v)) return '!';
  if (/REVIEW|AWAITING|PENDING|PLANNING|RUNNING|IN_PROGRESS|SUBMITTING/.test(v)) return '\u25d0';
  if (/TODO|IDLE|NEW|NOT_REQUESTED|NOT_CONNECTED|ARCHIVED/.test(v)) return '\u25cb';
  return '\u25cb';
}

function statusClass(value) {
  const v = String(value ?? '').toUpperCase();
  if (/COMPLETE|DONE|PASS|VERIFIED|SATISFIED|CORRELATED|ACTIVE|RESOLVED|READY|CONNECTED|RESUMED/.test(v)) return 'is-good';
  if (/BLOCKED|FAILED|UNVERIFIED|ERROR|NOT_SATISFIED|UNCERTAIN|REJECTED|UNAVAILABLE/.test(v)) return 'is-bad';
  if (/REVIEW|AWAITING|PENDING|PLANNING|RUNNING|IN_PROGRESS|SUBMITTING/.test(v)) return 'is-busy';
  return 'is-idle';
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const state = {
  projects: [],
  projectId: null,
  project: null,
  workspaces: [],
  workspaceId: null,
  tasks: [],
  workers: [],
  events: [],
  job: null,
  goals: [],
  decisions: [],
  lastGoal: null,
  showClosed: false,
  busy: false,
  lastError: null,
  pollTimer: null,
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// api
// ---------------------------------------------------------------------------

async function api(pathname, opts = {}) {
  const init = { method: opts.method ?? 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.method = 'POST';
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(pathname, init);
  } catch (e) {
    throw new Error(`cannot reach the workbench server: ${e.message}`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data.error || `${res.status} ${res.statusText}`);
    err.payload = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------
// small view helpers
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function shortPath(p) {
  return String(p ?? '').replace(/^[A-Za-z]:\\Users\\[^\\]+\\/, '~\\');
}

function ago(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return tr('time.secondsAgo', { count: s });
  const m = Math.round(s / 60);
  if (m < 60) return tr('time.minutesAgo', { count: m });
  const h = Math.round(m / 60);
  if (h < 24) return tr('time.hoursAgo', { count: h });
  return tr('time.daysAgo', { count: Math.round(h / 24) });
}

function clock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso).slice(11, 19) : d.toTimeString().slice(0, 8);
}

let toastTimer = null;
function toast(msg, kind = '') {
  const t = $('toast');
  t.className = `toast ${kind}`;
  t.innerHTML = msg;
  t.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), kind === 'bad' ? 12000 : 6000);
}

/**
 * Toggle the blocking overlay and re-derive every task's buttons from the new busy state.
 *
 * The refresh is wrapped: it is purely cosmetic, and a failure inside it must never be able to
 * leave the overlay stuck on screen with the tool unusable. That is exactly what an unguarded
 * call did once - the exception propagated out of longOp's finally block, so setBusy(false)
 * never completed and the UI froze behind the overlay.
 */
function setBusy(on, title, text) {
  state.busy = on;
  const b = $('busy');
  if (on) {
    $('busyTitle').textContent = title || `${tr('seat.state.working')}…`;
    $('busyText').textContent = text || '';
    b.classList.remove('hidden');
  } else {
    b.classList.add('hidden');
  }
  try {
    refreshTaskActions();
  } catch (e) {
    console.warn(tr('error.refreshTasks'), e);
  }
}

/**
 * Run one long operation with the single-concurrency gate held.
 *
 * Every caller goes through here so the gate cannot be forgotten in one place and honoured
 * in another.
 */
async function longOp(title, text, fn) {
  if (state.busy) { toast(tr('error.busy'), 'bad'); return null; }
  setBusy(true, title, text);

  // Watchdog. A browser turn is bounded server-side, so a wait longer than this means the
  // request itself is lost rather than slow. Without it a dropped connection would hold the
  // overlay forever and the only escape would be reloading the page, which is precisely the
  // kind of dead end this tool exists to remove.
  const watchdog = setTimeout(() => {
    if (state.busy) {
      setBusy(false);
      toast(`<strong>${tr('error.timeout')}</strong><br>${tr('error.timeoutDetail')}`, 'bad');
    }
  }, 360000);

  try {
    return await fn();
  } catch (e) {
    const detail = e.payload && e.payload.status === 'WORKSPACE_REQUIRED'
      ? e.message
      : (e.payload && e.payload.error) || e.message;
    toast(`<strong>${tr('error.failed')}</strong><br>${esc(detail)}`, 'bad');
    return null;
  } finally {
    clearTimeout(watchdog);
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

async function loadHealth(probe) {
  const params = [];
  if (probe) params.push('probeWorker=1');
  if (state.projectId) params.push(`projectId=${encodeURIComponent(state.projectId)}`);
  const q = params.length ? `?${params.join('&')}` : '';
  try {
    const h = await api(`/api/health${q}`);
    const hv = h.harness ?? {};
    $('chipHarness').textContent = `harness: ${hv.status}${hv.version ? ` v${hv.version}` : ''}`;
    $('chipHarness').className = `chip ${hv.status === 'READY' ? 'ok' : 'bad'}`;

    $('chipFrozen').textContent = hv.frozen === true
      ? 'frozen: verified'
      : hv.frozen === false ? 'frozen: DRIFT' : tr('header.frozen');
    $('chipFrozen').className = `chip ${hv.frozen === true ? 'ok' : hv.frozen === false ? 'bad' : ''}`;

    const w = h.worker ?? {};
    $('chipWorker').textContent = `worker: ${w.status}${w.state ? ` (${w.state})` : ''}`;
    $('chipWorker').className = `chip ${w.status === 'READY' || w.status === 'OK' ? 'ok' : w.status === 'NOT_PROBED' ? '' : 'warn'}`;
    if (w.detail) $('chipWorker').title = w.detail + (w.human_action ? `\n${w.human_action}` : '');

    const g = h.git ?? {};
    $('chipGit').textContent = `git: ${g.status}${g.head ? ` ${g.head}` : ''}`;
    $('chipGit').className = `chip ${g.status === 'CLEAN' ? 'ok' : g.status === 'DIRTY' ? 'warn' : ''}`;

    const dot = $('healthDot');
    const bad = hv.status !== 'READY' || hv.frozen === false;
    dot.className = `dot ${bad ? 'bad' : 'ok'}`;
  } catch (e) {
    $('chipHarness').textContent = 'harness: unreachable';
    $('chipHarness').className = 'chip bad';
    $('healthDot').className = 'dot bad';
  }
}

async function loadProjects() {
  const r = await api('/api/projects');
  state.projects = r.projects ?? [];
  if (r.workbench) $('version').textContent = `v${r.workbench.version}`;

  const ul = $('projectList');
  ul.innerHTML = '';
  if (!state.projects.length) {
    ul.appendChild(el(`<li class="muted">${tr('project.none')}</li>`));
    return;
  }
  for (const p of state.projects) {
    const li = el(`
      <li data-id="${esc(p.project_id)}" class="${p.project_id === state.projectId ? 'sel' : ''}">
        <div class="li-title"><span>${esc(p.name)}</span>
          <span class="li-sub">${p.active_workers}/${p.worker_count}w</span></div>
        <div class="li-sub">${esc(p.project_id)} · ${p.workspace_count} ws · ${p.task_count} tasks</div>
        ${p.root_exists ? '' : '<div class="li-sub badText">root path missing</div>'}
      </li>`);
    li.onclick = () => selectProject(p.project_id);
    ul.appendChild(li);
  }
}

async function selectProject(projectId) {
  state.projectId = projectId;
  state.workspaceId = null;
  state.lastGoal = null;
  await loadProjects();
  await loadProject();
  await loadHealth(false);
  await loadEvents();
  render();
}

async function loadProject() {
  if (!state.projectId) return;
  try {
    state.project = await api(`/api/project?projectId=${encodeURIComponent(state.projectId)}`);
    state.workspaces = state.project.workspaces ?? [];
    state.workers = state.project.workers ?? [];

    // RESTORE the last explicit choice, or fall back to the project default, but never invent
    // a workspace: if none is marked default and there is exactly one, that one is picked.
    const cfg = state.project.config ?? {};
    const fallback = cfg.default_workspace
      ?? (state.workspaces.length === 1 ? state.workspaces[0].workspace_id : null);
    if (!state.workspaceId && fallback && state.workspaces.some((w) => w.workspace_id === fallback)) {
      state.workspaceId = fallback;
    }

    const wb = state.project.workbench ?? {};
    $('autonomy').value = wb.autonomy_mode ?? 'ADVISOR';
    // Show the mode the operator chose, not the one it normalises to: OFF stays OFF, ON stays ON, and
    // the effective AUTO it maps to is stated in the confirmation toast rather than silently replacing
    // the operator's own selection.
    $('codexReview').value = wb.codex_review_mode ?? tr('codex.off');
    state.goals = wb.goals ?? [];
    state.decisions = wb.decisions ?? [];
    applyPaused(wb.paused === true);

    await Promise.all([loadTasks(), loadJob()]);
  } catch (e) {
    toast(`<strong>${tr('project.loadFailed')}</strong><br>${esc(e.message)}`, 'bad');
  }
}

async function loadTasks() {
  if (!state.projectId) return;
  const include = state.showClosed ? '' : `&include${tr('common.close')}d=0`;
  const ws = state.workspaceId ? `&workspaceId=${encodeURIComponent(state.workspaceId)}` : '';
  const r = await api(`/api/tasks?projectId=${encodeURIComponent(state.projectId)}${ws}${include}`);
  state.tasks = r.tasks ?? [];
}

async function loadJob() {
  if (!state.projectId) return;
  const r = await api(`/api/state?projectId=${encodeURIComponent(state.projectId)}`);
  state.job = r.job ?? null;
  state.goals = r.goals ?? [];
  state.decisions = r.decisions ?? [];
  return r;
}

async function loadEvents() {
  if (!state.projectId) return;
  try {
    const r = await api(`/api/events?projectId=${encodeURIComponent(state.projectId)}&limit=120`);
    state.events = r.events ?? [];
  } catch { state.events = []; }
}

function applyPaused(paused) {
  $('btnPause').classList.toggle('hidden', paused);
  $('btnResume').classList.toggle('hidden', !paused);
  $('pausedBanner').classList.toggle('hidden', !paused);
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function render() {
  renderWorkspaces();
  renderContext();
  renderJob();
  renderWorker();
  renderTasks();
  renderEvents();
}

function renderWorkspaces() {
  const ul = $('workspaceList');
  ul.innerHTML = '';
  if (!state.projectId) { $('wsHint').textContent = tr('goal.selectProject'); return; }
  if (!state.workspaces.length) {
    ul.appendChild(el(`<li class="muted">${tr('workspace.none')}</li>`));
    $('wsHint').textContent = '';
    return;
  }
  $('wsHint').textContent = tr('workspace.hint');
  for (const w of state.workspaces) {
    const li = el(`
      <li data-id="${esc(w.workspace_id)}" class="${w.workspace_id === state.workspaceId ? 'sel' : ''}">
        <div class="li-title"><span>${esc(w.name)}</span>
          <span class="li-sub">${w.open_tasks} open</span></div>
        <div class="li-sub">${esc(w.workspace_id)} · ${esc(w.type)}${w.worker ? ` · rounds ${w.worker.effective_rounds}/${w.worker.rotation.threshold}` : ` · ${tr('workspace.noWorker')}`}</div>
        ${w.status === 'ACTIVE' ? '' : `<div class="li-sub warnText">status ${esc(w.status)}</div>`}
      </li>`);
    li.onclick = async () => {
      state.workspaceId = w.workspace_id;
      await loadTasks();
      render();
    };
    ul.appendChild(li);
  }
}

function renderContext() {
  const hasCtx = !!(state.projectId && state.workspaceId);
  $('emptyMid').classList.toggle('hidden', hasCtx);
  $('midBody').classList.toggle('hidden', !hasCtx);
  /**
   * Tell the rest of the page that the SELECTED CONTEXT may have changed.
   *
   * The guided layer resolves its preview against the selected workspace's write scope, so a workspace change
   * invalidates what it is showing. It cannot observe that: the class toggles above stop changing once a
   * context exists, and the workspace list is re-rendered with fresh elements, so there is no stable node to
   * watch. An event is the smallest thing that makes the change visible without either module reaching into
   * the other, and it is a plain DOM event, so nothing new is introduced to the architecture.
   */
  try { document.dispatchEvent(new CustomEvent('awb:context')); } catch { /* very old browser: the poll in guided.js covers it */ }
  if (!hasCtx) return;

  const p = state.project ?? {};
  const ws = state.workspaces.find((w) => w.workspace_id === state.workspaceId);
  const g = p.git ?? {};
  $('ctxLine').textContent =
    `${p.name} (${p.project_id}) › ${ws ? ws.name : state.workspaceId} [${state.workspaceId}]` +
    `  |  ${g.present ? `${g.branch} @ ${g.head}${g.clean ? ' clean' : ` DIRTY(${g.changed_count})`}` : tr('workspace.noGit')}` +
    `  |  paths: ${ws && ws.paths && ws.paths.length ? ws.paths.join(', ') : '(root)'}`;
}

function renderJob() {
  const box = $('jobCard');
  const job = state.job;
  const goals = state.goals ?? [];

  let html = '';
  if (job && job.running && job.job) {
    html += `<h3>Goal running</h3><dl class="kv">
      <dt>goal</dt><dd>${esc(job.job.goal_id)}</dd>
      <dt>checkpoint</dt><dd>${esc(job.job.step)}</dd>
      <dt>started</dt><dd>${esc(ago(job.job.started_at))}</dd>
    </dl><p class="hint">Pause takes effect at the next checkpoint. The current call finishes first.</p>`;
  } else {
    html += `<h3>${tr('run.idle')}</h3><p class="hint">${tr('run.noGoal')}</p>`;
  }

  const last = goals[0];
  if (last) {
    const cls = last.status === 'BLOCKED' ? 'badText'
      : last.status === 'AWAITING_APPROVAL' ? 'warnText'
      : last.status === 'COMPLETED' ? 'goodText' : '';
    html += `<h3 style="margin-top:12px">Last goal</h3><dl class="kv">
      <dt>id</dt><dd>${esc(last.goal_id)}</dd>
      <dt>status</dt><dd class="${cls}">${esc(last.status)}</dd>
      <dt>workspace</dt><dd>${esc(last.workspace_id)}</dd>
      <dt>updated</dt><dd>${esc(ago(last.updated_at))}</dd>
    </dl>`;
    if (last.error) html += `<p class="badText small">${esc(last.error)}</p>`;
  }
  box.innerHTML = html;
}

function renderWorker() {
  const box = $('workerCard');
  const ws = state.workspaces.find((w) => w.workspace_id === state.workspaceId);
  const w = ws ? ws.worker : null;

  if (!w) {
    box.innerHTML = `<h3>None</h3>
      <p class="hint">No worker in this workspace. A worker owns the ChatGPT conversation for this context boundary.</p>
      <div class="row"><button id="btnNewWorker" class="small">Create worker</button></div>`;
    const b = $('btnCreateWorker');
    if (b) b.onclick = () => createWorker();
    return;
  }

  const rot = w.rotation ?? {};
  const stateCls = w.conversation_state === 'RESOLVED' ? 'goodText'
    : w.conversation_state === 'BLOCKED' ? 'badText' : 'warnText';

  box.innerHTML = `<h3>${esc(w.worker_id)}</h3><dl class="kv">
    <dt>role</dt><dd>${esc(w.role)}</dd>
    <dt>status</dt><dd>${esc(w.status)}</dd>
    <dt>conversation</dt><dd class="${stateCls}">${esc(w.conversation_state)}</dd>
    <dt>rounds</dt><dd>${w.effective_rounds} / ${esc(rot.threshold ?? '?')}${w.observed_user_turns != null ? ` (observed ${w.observed_user_turns})` : ''}</dd>
    <dt>last used</dt><dd>${esc(ago(w.last_used))}</dd>
  </dl>
  ${rot.shouldRotate ? `<p class="warnText small">Rotation recommended: ${esc((rot.reasons || []).join('; '))}</p>` : ''}
  ${w.conversation_resolved
      ? `<p class="small"><a href="${esc(w.conversation_url)}" target="_blank" rel="noopener" style="color:var(--accent)">open the conversation in ChatGPT</a></p>`
      : `<p class="warnText small">${tr('worker.unresolvedUrl')}</p>`}
  <div class="row">
    ${w.conversation_resolved ? '' : `<button id="btnOpenConv" class="small primary">${tr('worker.openConversation')}</button>`}
    <button id="btnRotate" class="small warn">Rotate</button>
    <button id="btnNewWorker2" class="small">New worker</button>
  </div>`;

  const oc = $('btnOpenConv');
  if (oc) oc.onclick = () => openConversation(w.worker_id);
  $('btnRotate').onclick = () => rotateWorker(w.worker_id);
  $('btnCreateWorker2').onclick = () => createWorker();
}

/**
 * One task, explained in the four things a first-time user actually needs.
 *
 * WHO and WHY and DONE-WHEN, in plain words, with no task id and no status token in the primary text: the
 * task id, the type, the priority and the workspace stay in the meta row above, which is advanced-only, and
 * the canonical status is still rendered by the chip beside the title.
 *
 * The completion criteria are the task's OWN `success_criteria` array, rendered as they are. They are not
 * summarised or invented here: a task cannot become READY or DONE without them, so if the list is empty that
 * is a fact about the task and the block says so rather than guessing at an acceptance condition.
 *
 * WHY THIS LIVES IN app.js AND NOT guided.js: the task list is the app's own surface, and a second module
 * patching it after every render would fight the renderer. It consumes nothing but the task object, so there
 * is no policy here and nothing to drift.
 */
function taskExplanation(t) {
  const ws = state.workspaces.find((w) => w.workspace_id === t.workspace_id);
  const worker = ws && ws.worker && ws.worker.conversation_resolved ? ws.worker.worker_id : null;
  const who = worker
    ? tr('taskx.who.worker', { worker: esc(worker) })
    : tr('taskx.who.none');

  // `why` comes from the task's own description when the planner wrote one, and never from the title.
  const why = String(t.description ?? '').split('\n').map((s) => s.trim()).filter(Boolean)[0] ?? '';
  const criteria = Array.isArray(t.success_criteria) ? t.success_criteria : [];

  return `<div class="taskx">
    <dl class="kv">
      <dt>${esc(tr('taskx.what'))}</dt><dd>${esc(t.title)}</dd>
      ${why ? `<dt>${esc(tr('taskx.why'))}</dt><dd>${esc(why)}</dd>` : ''}
      <dt>${esc(tr('taskx.who'))}</dt><dd>${who}</dd>
      <dt>${esc(tr('taskx.status'))}</dt><dd>${statusChip(t.status, 'small')}
        ${window.GuidedUI?.stopStateHtml ? window.GuidedUI.stopStateHtml(t.status) : ''}</dd>
      <dt>${esc(tr('taskx.doneWhen'))}</dt>
      <dd>${criteria.length
        ? `<ul class="taskx-crit">${criteria.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`
        : `<span class="warnText">${esc(tr('taskx.noCriteria'))}</span>`}</dd>
    </dl>
  </div>`;
}

function renderTasks() {
  const ul = $('taskList');
  ul.innerHTML = '';
  const open = state.tasks.filter((t) => t.status !== 'DONE' && t.status !== 'CANCELLED').length;
  $('taskCount').textContent = state.tasks.length
    ? tr('task.count', { shown: state.tasks.length, open }) + (state.workspaceId ? ` \u00b7 ${state.workspaceId}` : '')
    : '';

  if (!state.tasks.length) {
    ul.appendChild(el(`<li class="muted" style="border:none;background:none">${tr('task.none')}</li>`));
    return;
  }

  const order = { IN_PROGRESS: 0, REVIEW: 1, BLOCKED: 2, READY: 3, DONE: 4, CANCELLED: 5 };
  const sorted = [...state.tasks].sort((a, b) =>
    (order[a.status] ?? 9) - (order[b.status] ?? 9) || String(b.updated_at).localeCompare(String(a.updated_at)));

  for (const t of sorted) {
    const li = el(`
      <li class="s-${esc(t.status)}" data-id="${esc(t.task_id)}">
        <div class="t-top">
          <span class="t-title">${esc(t.title)}</span>
          ${statusChip(t.status, 'small')}
        </div>
        <div class="t-meta" data-advanced-only>
          <span class="t-id">${esc(t.task_id)}</span>
          <span>${esc(t.type)}</span>
          <span>${esc(t.priority)}</span>
          <span>${esc(t.workspace_id)}</span>
          ${t.retry_count ? `<span class="warnText">${esc(tr('task.retries', { count: t.retry_count }))}</span>` : ''}
          <span>${esc(ago(t.updated_at))}</span>
        </div>
        ${taskExplanation(t)}
        <div class="t-actions"></div>
      </li>`);
    li.querySelector('.t-top').onclick = () => showTask(t.task_id);
    li.querySelector('.t-meta').onclick = () => showTask(t.task_id);
    renderTaskActions(li, t);
    ul.appendChild(li);
  }
}

/** The action buttons a task offers, derived from its status. */
function taskActions(t) {
  const disabled = state.busy;
  const ws = state.workspaces.find((w) => w.workspace_id === t.workspace_id);
  const hasWorker = !!(ws && ws.worker && ws.worker.conversation_resolved);

  switch (t.status) {
    case 'READY':
      return [
        { label: tr('goal.submit'), kind: 'primary', disabled,
          title: hasWorker ? tr('task.markInProgress') : tr('task.noWorker'),
          run: () => transition(t, 'start', 'started') },
        { label: tr('task.sendToWorker'), kind: '', disabled: disabled || !hasWorker,
          title: hasWorker ? tr('task.sendToWorker.title') : tr('task.noWorkerConversation'),
          run: () => sendTaskToWorker(t) },
        { label: tr('common.cancel'), kind: '', disabled, run: () => transition(t, 'cancel', 'cancelled') },
      ];
    case 'IN_PROGRESS':
      return [
        { label: tr('task.sendToWorker'), kind: 'primary', disabled: disabled || !hasWorker,
          title: tr('task.sendToWorker.title'),
          run: () => sendTaskToWorker(t) },
        { label: tr('task.toReview'), kind: '', disabled, run: () => transition(t, 'review', tr('task.movedToReview')) },
        { label: 'Block', kind: 'warn', disabled, run: () => transition(t, 'block', 'blocked') },
      ];
    case 'REVIEW':
      return [
        { label: 'Approve', kind: 'good', disabled,
          title: tr('task.done'),
          run: () => decision(t, 'APPROVE', 'approved') },
        { label: 'Reject', kind: 'bad', disabled,
          title: tr('task.block'),
          run: () => decision(t, 'REJECT', 'rejected') },
        { label: 'Retry', kind: 'warn', disabled,
          title: tr('task.backToProgress'),
          run: () => decision(t, 'RETRY', 'retry') },
      ];
    case 'BLOCKED':
      return [
        { label: 'Retry', kind: 'warn', disabled, run: () => decision(t, 'RETRY', 'retry') },
        { label: tr('common.cancel'), kind: '', disabled, run: () => transition(t, 'cancel', 'cancelled') },
      ];
    case 'DONE':
    case 'CANCELLED':
      return [
        { label: tr('task.details'), kind: '', disabled: false, run: () => showTask(t.task_id) },
        { label: 'Reopen', kind: 'warn', disabled, run: () => transition(t, 'ready', 'reopened') },
      ];
    default:
      return [{ label: tr('task.details'), kind: '', disabled: false, run: () => showTask(t.task_id) }];
  }
}

/**
 * Re-derive the action buttons of every task already rendered.
 *
 * Separate from renderTaskActions because the two take different things: this walks the live
 * DOM after a state change, renderTaskActions fills one already-built list item.
 */
function refreshTaskActions() {
  for (const li of document.querySelectorAll('#taskList li[data-id]')) {
    const t = state.tasks.find((x) => x.task_id === li.getAttribute('data-id'));
    if (t) renderTaskActions(li, t);
  }
}

function renderTaskActions(li, t) {
  // Guard: without the task there is nothing to derive buttons from, and throwing here would
  // take down whatever state change is in progress.
  if (!li || !t) return;
  const box = li.querySelector('.t-actions');
  if (!box) return;
  box.innerHTML = '';
  for (const a of taskActions(t)) {
    const b = el(`<button class="small ${a.kind}" ${a.disabled ? 'disabled' : ''} title="${esc(a.title ?? '')}">${esc(a.label)}</button>`);
    b.onclick = (ev) => { ev.stopPropagation(); a.run(); };
    box.appendChild(b);
  }
}

async function showTask(taskId) {
  const box = $('taskDetail');
  try {
    const t = await api(`/api/task?taskId=${encodeURIComponent(taskId)}&projectId=${encodeURIComponent(state.projectId)}`);
    box.classList.remove('hidden');
    box.innerHTML = `<h3>${esc(t.task_id)} - ${esc(t.title)}</h3>
      <dl class="kv">
        <dt>status</dt><dd>${esc(t.status)}</dd>
        <dt>type / prio</dt><dd>${esc(t.type)} / ${esc(t.priority)}</dd>
        <dt>workspace</dt><dd>${esc(t.workspace_id)}</dd>
        <dt>assigned</dt><dd>${esc(t.assigned_worker ?? tr('common.none'))}</dd>
        <dt>retries</dt><dd>${t.retry_count}</dd>
        <dt>created</dt><dd>${esc(t.created_at)}</dd>
      </dl>
      <h3 style="margin-top:10px">Success criteria</h3>
      ${t.success_criteria && t.success_criteria.length
        ? `<ul class="hint">${t.success_criteria.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`
        : `<p class="hint">${tr('task.criteria.none')}</p>`}
      <h3 style="margin-top:10px">History</h3>
      ${(t.history ?? []).length
        ? `<ul class="hint">${t.history.map((h) => `<li>${esc(clock(h.at))} <strong>${esc(h.event)}</strong> ${esc(h.detail ?? '')}</li>`).join('')}</ul>`
        : `<p class="hint">${tr('task.history.none')}</p>`}
      <div class="row">
        <button id="btnPacket" class="small">Show packet</button>
        <button id="btnCloseDetail" class="small">Close</button>
      </div>
      <pre class="diff hidden" id="packetBox"></pre>`;
    $('btnCloseDetail').onclick = () => box.classList.add('hidden');
    $('btnPacket').onclick = () => showPacket(taskId);
  } catch (e) {
    toast(`<strong>${tr('task.loadFailed')}</strong><br>${esc(e.message)}`, 'bad');
  }
}

async function showPacket(taskId) {
  const pre = $('packetBox');
  pre.classList.remove('hidden');
  pre.textContent = tr('task.buildingPacket');
  try {
    const r = await api(`/api/packet?projectId=${encodeURIComponent(state.projectId)}&taskId=${encodeURIComponent(taskId)}`);
    pre.textContent = `${r.packet}\n\n--- ${r.bytes} bytes ---`;
  } catch (e) {
    pre.textContent = `cannot build packet: ${e.message}`;
  }
}

function renderEvents() {
  const ol = $('eventList');
  ol.innerHTML = '';
  if (!state.events.length) {
    ol.appendChild(el(`<li class="muted" style="grid-template-columns:1fr">${tr('timeline.none')}</li>`));
    return;
  }
  for (const e of state.events) {
    ol.appendChild(el(`<li class="lvl-${esc(e.level)}">
      <span class="src">${esc(clock(e.at))}</span>
      <span class="src">${esc(e.source)}</span>
      <span><strong>${esc(e.label)}</strong>${e.detail ? ` — ${esc(e.detail)}` : ''}</span>
    </li>`));
  }
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function refreshAll() {
  // Projects first: the health call needs a project to report git state, so asking for health
  // before a project is selected would always leave the git chip reading N/A.
  await loadProjects();
  await loadHealth(false);
  await loadProject();
  await loadEvents();
  render();
}

async function submitGoal() {
  const text = $('goalText').value.trim();
  if (!text) { toast(tr('goal.typeFirst'), 'bad'); return; }
  if (!state.projectId) { toast('Select a project first.', 'bad'); return; }

  /**
   * The beginner's three choices ride on THIS body, produced by the app's own submit path.
   *
   * There is no second submit endpoint and no second submit function: the guided layer contributes the
   * `guided` block and nothing else, and the server resolves that block with the same module it uses for
   * everything else. When the guided layer is absent or the user is in Advanced without a template, the
   * block is simply not sent and the run is the plain goal it always was.
   *
   * `guided` is read here, at submit time, rather than captured at mount: the user may change a control
   * after the layer has mounted, and submitting a stale choice would apply a policy they had moved off.
   */
  const guided = window.GuidedUI?.submitChoices?.() ?? null;

  const r = await longOp(tr('goal.planning'),
    tr('goal.planningDetail'),
    () => api('/api/goal/submit', {
      body: {
        projectId: state.projectId,
        workspaceId: state.workspaceId || null,
        text,
        ...(guided ? { guided } : {}),
      },
    }));

  if (!r) return;
  $('goalText').value = '';
  // The guided layer remembers this text as "mine", so the next template click may replace it without
  // asking. Cleared here because the box is now empty and nothing in it belongs to that layer.
  if (window.GuidedUI?.clearTemplateText) window.GuidedUI.clearTemplateText();
  toast(tr('goal.accepted', { goalId: esc(r.goal_id ?? ''), workspace: `<strong>${esc(r.workspace_id)}</strong>` }), 'good');
  renderGoalStatus({
    goal_id: r.goal_id, status: 'SUBMITTED', workspace_id: r.workspace_id, routing: r.routing,
  });

  // The job runs server-side; the first plan is usually seconds away, so a short poll is
  // honest rather than misleading. It stops as soon as the goal leaves PLANNING.
  pollJob(r.goal_id, 0);
}

function pollJob(goalId, attempt) {
  if (attempt > 90) return;
  setTimeout(async () => {
    try {
      await loadJob();
      await loadTasks();
      await loadEvents();
      render();
      const g = (state.goals ?? []).find((x) => x.goal_id === goalId);
      if (!g) return;
      renderGoalStatus(g);
      if (g.status === 'SUBMITTED' || g.status === 'PLANNING' || g.status === 'IN_PROGRESS' || g.status === 'PAUSED') {
        pollJob(goalId, attempt + 1);
      } else {
        if (g.status === 'AWAITING_APPROVAL') {
          toast(tr('goal.planReady', { count: `<strong>${(g.plan ?? []).length}</strong>` }), 'good');
        } else if (g.status === 'BLOCKED') {
          toast(`<strong>${tr('goal.blocked')}</strong><br>${esc(g.error ?? tr('goal.noReason'))}`, 'bad');
        }
      }
    } catch { /* transient; the next tick retries */ }
  }, attempt === 0 ? 1200 : 2500);
}

function renderGoalStatus(g) {
  const box = $('goalStatus');
  box.classList.remove('hidden');
  const cls = g.status === 'BLOCKED' ? 'badText'
    : g.status === 'AWAITING_APPROVAL' ? 'warnText'
    : g.status === 'COMPLETED' ? 'goodText' : '';
  box.innerHTML = `<h3>Goal ${esc(g.goal_id)} <span class="${cls}">${esc(g.status)}</span></h3>
    <dl class="kv">
      <dt>workspace</dt><dd>${esc(g.workspace_id)}</dd>
      ${g.routing ? `<dt>${tr('goal.routedAs')}</dt><dd>${esc(g.routing.task_type)} (${esc(g.routing.confidence)}), delegate=${esc(g.routing.delegate)}</dd>` : ''}
      ${g.routing && g.routing.reason ? `<dt>why</dt><dd>${esc(g.routing.reason)}</dd>` : ''}
      <dt>created</dt><dd>${esc(g.created_at)}</dd>
    </dl>
    ${g.error ? `<p class="badText">${esc(g.error)}</p>` : ''}`;

  const plan = $('planCard');
  if (g.status === 'AWAITING_APPROVAL' || (g.plan && g.plan.length)) {
    plan.classList.remove('hidden');
    const warnings = g.plan_warnings ?? [];
    plan.innerHTML = `<h3>Proposed plan - ${(g.plan ?? []).length} task(s), created as READY</h3>
      <ul class="hint">${(g.plan ?? []).map((p) => `<li><strong>${esc(p.task_id)}</strong> ${esc(p.title)}
        <span class="li-sub">${esc(p.type)} · ${esc(p.priority)} · ${p.modifies_files ? tr('task.modifiesFiles') : tr('task.noFileChanges')}</span></li>`).join('')}</ul>
      ${(g.plan ?? []).length ? `<p class="hint">${tr('goal.nothingRuns')}</p>` : ''}
      ${warnings.length ? `<p class="warnText small">${tr('goal.parserNotes', { notes: esc(warnings.join(' | ')) })}</p>` : ''}
      ${(g.plan_notes ?? []).length ? `<p class="hint small">${tr('goal.plannerNotes', { notes: esc((g.plan_notes ?? []).join(' ')) })}</p>` : ''}`;
  } else {
    plan.classList.add('hidden');
  }
}

async function transition(t, verb, label) {
  const r = await longOp(`Task ${t.task_id}: ${label}…`, '', () =>
    api('/api/task/transition', { body: { projectId: state.projectId, taskId: t.task_id, verb } }));
  if (!r) return;
  await loadProject();
  render();
  toast(`<strong>${esc(t.task_id)}</strong> → ${esc(r.task?.status ?? verb)}`, 'good');
}

async function decision(t, action, label) {
  let reason = null;
  if (action === 'REJECT' || action === 'RETRY') {
    reason = window.prompt(`${tr('decision.reason', { label, taskId: t.task_id })}`, '');
    if (reason === null) return;
  }
  const body = { projectId: state.projectId, taskId: t.task_id, action, reason,
                 verified: action === 'APPROVE' ? true : undefined };
  const r = await longOp(`${label} ${t.task_id}…`, '', () => api('/api/task/decision', { body }));
  if (!r) return;
  await loadProject();
  render();
  toast(`<strong>${esc(t.task_id)}</strong> ${esc(action)} → ${esc(r.task?.status ?? '')}`, action === 'REJECT' ? 'bad' : 'good');
}

/**
 * Send a task's packet to its worker.
 *
 * The server returns as soon as the turn has STARTED; the turn itself takes as long as ChatGPT
 * takes and runs in its own process. So this starts it, then polls. Waiting on one blocking HTTP
 * request for minutes is what used to freeze the whole page.
 */
async function sendTaskToWorker(t) {
  const ws = state.workspaces.find((w) => w.workspace_id === t.workspace_id);
  const w = ws && ws.worker;
  if (!w) { toast(tr('worker.noneInWorkspace'), 'bad'); return; }
  if (!w.conversation_resolved) {
    toast(tr('worker.noConversation'), 'bad');
    return;
  }

  const pkt = await longOp('Building the packet…', '', () =>
    api(`/api/packet?projectId=${encodeURIComponent(state.projectId)}&taskId=${encodeURIComponent(t.task_id)}`));
  if (!pkt) return;

  const ok = window.confirm(
    `${tr('send.confirm', { workerId: w.worker_id })}\n\n` +
    `conversation: ${w.conversation_url}\n` +
    `packet:       ${pkt.bytes} bytes, workspace ${pkt.workspace_id}\n\n` +
    `A real browser window will be driven and ChatGPT will answer. ` +
    `The answer is a proposal: nothing in your project is written until you approve it.`);
  if (!ok) return;

  const started = await longOp(tr('send.starting'), '', () =>
    api('/api/worker/send', {
      body: { projectId: state.projectId, workerId: w.worker_id, text: pkt.packet },
    }));
  if (!started || !started.send_id) return;

  await pollSend(started.send_id, t, w);
}

/**
 * Poll a started turn until it settles.
 *
 * The page stays fully usable while this runs - buttons stay live, Pause can be pressed, and the
 * timeline keeps updating - because nothing here holds a blocking request open.
 */
function pollSend(sendId, t, w) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = async () => {
      let s = null;
      try {
        s = await api(`/api/send/status?sendId=${encodeURIComponent(sendId)}`);
      } catch (e) {
        toast(`<strong>${tr('send.lostContact')}</strong><br>${esc(e.message)}`, 'bad');
        return resolve(null);
      }

      const secs = Math.round((Date.now() - startedAt) / 1000);
      $('busyTitle').textContent = tr('send.waitingSeconds', { seconds: secs });
      $('busyText').textContent = tr('send.workingDetail', { workerId: w.worker_id });

      if (s.status === 'RUNNING') {
        if (Date.now() - startedAt > 15 * 60 * 1000) {
          setBusy(false);
          toast(`<strong>${tr('send.stillRunning')}</strong><br>${tr('send.stillRunningDetail')}`, 'bad');
          return resolve(null);
        }
        return setTimeout(tick, 2000);
      }

      setBusy(false);
      await loadProject();
      render();

      const r = s.result;
      if (s.status === 'COMPLETE' && r && r.outcome === 'ASSISTANT_COMPLETE') {
        toast(`<strong>${tr('toast.replyReceived')}</strong> (${secs}s).<br>` +
              `<span class="small">${tr('send.roundsNow', { rounds: esc(r.rounds_after ?? '?') })}</span>`, 'good');
        showReply(t, w, r, secs);
      } else if (r && r.sent_confirmed) {
        toast(`<strong>${tr('toast.turnCounted')}</strong><br>${esc(r.outcome)}: ${esc(r.detail ?? '')}<br>` +
              `<span class="small">${tr('send.landedNote')}</span>`, 'bad');
      } else {
        toast(`<strong>${tr('toast.nothingLanded')}</strong><br>${esc(r?.outcome ?? s.status)}: ` +
              `${esc(r?.detail ?? s.error ?? tr('send.noDetail'))}<br>` +
              `<span class="small">${tr('send.notLandedNote')}</span>`, 'bad');
      }
      resolve(r);
    };
    setBusy(true, tr('send.waiting'), tr('send.working', { workerId: w.worker_id }));
    tick();
  });
}

/** Render a completed reply with the approve / reject / retry decision on it. */
function showReply(t, w, r, secs) {
  const box = $('taskDetail');
  box.classList.remove('hidden');
  box.innerHTML = `<h3>Reply for ${esc(t.task_id)}</h3>
    <p class="hint">round ${esc(r.baseline_turns ?? '?')} · worker ${esc(r.worker_id ?? w.worker_id)} · ${secs}s</p>
    <pre class="diff" id="replyText">loading…</pre>
    <div class="row">
      <button id="btnApproveR" class="small good">Approve (mark DONE)</button>
      <button id="btnRejectR" class="small bad">Reject</button>
      <button id="btnRetryR" class="small warn">Retry</button>
      <button id="btnCloseR" class="small">Close</button>
    </div>`;
  $('btnApproveR').onclick = () => decision(t, 'APPROVE', 'approved');
  $('btnRejectR').onclick = () => decision(t, 'REJECT', 'rejected');
  $('btnRetryR').onclick = () => decision(t, 'RETRY', 'retry');
  $('btnCloseR').onclick = () => box.classList.add('hidden');

  // Fetch the text separately: the send result carries the outcome, not a copy of the reply.
  api(`/api/worker/reply?workerId=${encodeURIComponent(w.worker_id)}&turnIndex=${encodeURIComponent(r.baseline_turns ?? 0)}`)
    .then((d) => { $('replyText').textContent = d.text ?? tr('send.emptyReply'); })
    .catch((e) => { $('replyText').textContent = `could not read the reply back: ${e.message}`; });
}

async function createWorker() {
  if (!state.workspaceId) { toast(tr('goal.selectWorkspace'), 'bad'); return; }
  const r = await longOp(tr('worker.creating'), '', () =>
    api('/api/worker/create', { body: { projectId: state.projectId, workspaceId: state.workspaceId, role: 'general' } }));
  if (!r) return;
  await loadProject();
  render();
  toast(`${tr('toast.workerCreated')} <strong>${esc(r.worker?.worker_id ?? '')}</strong> ` +
        `Its conversation is not resolved yet: press <em>Open conversation</em>.`, 'good');
}

async function openConversation(workerId) {
  await longOp(tr('worker.opening'),
    tr('worker.openingDetail'),
    async () => {
      const r = await api('/api/worker/send', { body: { projectId: state.projectId, workerId, mode: 'open' } });
      await loadProject();
      render();
      toast(`Conversation: <span class="small">${esc(r.conversation_url ?? r.url ?? JSON.stringify(r).slice(0, 160))}</span>`, 'good');
    });
}

async function rotateWorker(workerId) {
  const reason = window.prompt(tr('worker.rotateConfirm', { workerId }), '');
  if (reason === null) return;
  const r = await longOp(tr('worker.rotating'), '', () =>
    api('/api/worker/rotate', { body: { projectId: state.projectId, workerId, reason } }));
  if (!r) return;
  await loadProject();
  render();
  toast(`${tr('worker.rotated', { workerId: `<strong>${esc(r.worker?.worker_id ?? r.new_worker_id ?? '?')}</strong>` })} ` +
        `Its conversation still needs opening before it can be used.`, 'good');
}

async function doPause() {
  const r = await api('/api/job/pause', { body: { projectId: state.projectId } });
  applyPaused(true);
  renderJob();
  toast(`<strong>${tr('toast.paused')}</strong> ${esc(r.note ?? '')}${r.running_job ? ` A job is running and will stop at step ${esc(r.current_step)}.` : ''}`);
}

async function doResume() {
  await api('/api/job/resume', { body: { projectId: state.projectId } });
  applyPaused(false);
  await loadJob();
  renderJob();
  toast(`<strong>${tr('toast.resumed')}</strong> ${tr('toast.resumedDetail')}`, 'good');
}

async function loadDiff() {
  const box = $('diffCard');
  box.textContent = 'loading…';
  try {
    const d = await api(`/api/diff?projectId=${encodeURIComponent(state.projectId)}`);
    if (!d.present) { box.innerHTML = `<p class="hint">${tr('workspace.notGit')}</p>`; return; }
    if (d.clean) {
      box.innerHTML = `<p class="goodText">Working tree clean.</p>
        <p class="hint small">last commit: ${esc(d.last_commit ?? '')}</p>`;
      return;
    }
    box.innerHTML = `<p><strong>${d.files.length}</strong> changed file(s) at ${esc(d.head)}
        ${d.whitespace_ok ? '' : '<span class="badText"> · whitespace errors</span>'}</p>
      <pre class="diff">${esc(d.stat ?? '')}</pre>
      <pre class="diff">${esc((d.diff ?? '').slice(0, 20000))}</pre>`;
  } catch (e) {
    box.innerHTML = `<p class="badText">${esc(e.message)}</p>`;
  }
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

function wire() {
  $('btnRefresh').onclick = () => refreshAll().then(() => toast(tr('nav.reloaded')));
  $('btnProbe').onclick = async () => {
    $('chipWorker').textContent = 'worker: probing…';
    await loadHealth(true);
  };
  $('btnPause').onclick = () => doPause();
  $('btnResume').onclick = () => doResume();
  $('btnSubmitGoal').onclick = () => submitGoal();
  $('btnDiff').onclick = () => loadDiff();
  $('showClosed').onchange = async (e) => {
    state.showClosed = e.target.checked;
    await loadTasks();
    render();
  };
  /**
   * Use Codex Reviewer. ON submits the literal string ON, which the POLICY layer normalises to AUTO -
   * the mapping lives in protocol/policy.js, not here, so the UI cannot invent a fourth mode and the
   * server and the autonomous loop resolve the value the same way.
   */
  $('codexReview').onchange = async (e) => {
    const requested = e.target.value;
    try {
      const r = await api('/api/review/mode', { body: { projectId: state.projectId, mode: requested } });
      const effective = r.mode ?? requested;
      e.target.value = requested;
      toast(tr('codex.setEffective', { value: `<strong>${esc(requested)}</strong>`, effective: `<strong>${esc(effective)}</strong>` }) + ' ' +
            (effective === 'OFF'
              ? tr('codex.offNote')
              : tr('codex.autoNote')));
    } catch (err) { toast(esc(err.message), 'bad'); }
  };
  $('autonomy').onchange = async (e) => {
    const mode = e.target.value;
    try {
      await api('/api/autonomy', { body: { projectId: state.projectId, mode } });
      toast(tr('autonomy.set', { value: `<strong>${esc(mode)}</strong>` }) + ' ' +
            (mode === 'SAFE_AUTO'
              ? tr('autonomy.safeAutoNote')
              : tr('autonomy.advisorNote')));
    } catch (err) { toast(esc(err.message), 'bad'); }
  };
  // Ctrl+Enter submits the goal, the usual convention for a text box with a button.
  $('goalText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitGoal();
  });

  /**
   * Language picker.
   *
   * Options are built from the engine's language list and labelled in their own language, so a user looking
   * for their own language does not have to read one they do not have. Changing it re-renders in place: no
   * page reload, no server call, and the panels that build their own markup are re-rendered through the
   * listener registered in the startup block below.
   */
  const langSelect = $('language');
  langSelect.innerHTML = window.I18N.LANGUAGES
    .map((l) => `<option value="${esc(l.code)}">${esc(l.name)}</option>`).join('');
  langSelect.value = window.I18N.locale();
  langSelect.onchange = (e) => {
    const chosen = window.I18N.setLocale(e.target.value, { persist: true });
    langSelect.value = chosen;
  };

  // Logs are collapsed by default: a wall of English log text is the wrong first impression for a user who
  // does not read it, and the panel is one click away.
  $('btnToggleLogs').onclick = () => {
    const section = $('timeline');
    const collapsed = section.classList.toggle('collapsed');
    $('btnToggleLogs').textContent = collapsed ? tr('logs.expand') : tr('logs.collapse');
    $('btnToggleLogs').setAttribute('aria-expanded', String(!collapsed));
  };
}

// Slow safety net only: the goal poll and explicit actions do the real work, so this just
// repairs drift (a change made in a terminal, a token refresh) without hammering the disk.
setInterval(() => {
  if (!state.projectId || state.busy) return;
  loadJob().then(() => { renderJob(); }).catch(() => {});
}, 30000);

/**
 * Startup.
 *
 * The language is resolved ONCE, before anything renders: a saved choice first, then the browser's own
 * languages, then the build default. It is applied with `persist: false`, because detecting a language is
 * not the user choosing one, and writing it would make the next visit claim they picked it.
 *
 * The listener then re-renders every panel that builds its own markup, which is what makes a language
 * switch update the whole page instead of only the static labels.
 */
window.I18N.setLocale(window.I18N.detect(), { persist: false, render: false });
window.I18N.onChange(() => {
  renderWorkspaces();
  renderContext();
  renderTasks();
  renderJob();
  renderWorker();
  renderEvents();
  renderGoalStatus(state.lastGoal);
  if (window.ProtocolUI?.refresh) window.ProtocolUI.refresh();
});
window.I18N.applyToDom();

wire();
refreshAll().catch((e) => toast(`<strong>${esc(tr('error.startup'))}</strong><br>${esc(e.message)}`, 'bad'));

/**
 * A READ-ONLY view of this module's state, for the guided layer.
 *
 * The guided layer needs three facts that only the app owns: which project and workspace are selected (so
 * the preview resolves against the real write scope), and what the last goal's status was (so the plain
 * wording can sit beside it). Reaching into `window.state` would either fail, because `state` is a
 * module-scoped binding, or - worse - appear to work after someone made it global and then silently read a
 * different object.
 *
 * It is accessors, not the object. The guided layer cannot write through it, so there is no second owner of
 * this state and no way for a render in one module to corrupt the other's.
 */
window.AWBAppState = {
  projectId: () => state.projectId,
  workspaceId: () => state.workspaceId,
  lastGoal: () => state.lastGoal ?? (state.goals ?? [])[0] ?? null,
};

/**
 * Hand the guided layer the app's OWN submit path.
 *
 * Passed in rather than reached for, so the guided layer cannot start a goal the app would not have started
 * itself: the busy gate, the empty-goal guard, the error toast and the planning poll are all still this
 * function's. `submitGoal` reads the goal box, which the guided layer has already filled, AND reads
 * `GuidedUI.submitChoices()` itself at submit time - so nothing is wrapped and no second submit path exists.
 *
 * WHY IT WAITS FOR DOMContentLoaded, WHICH IS NOT DECORATION. `/guided.js` is a LATER <script> than this one,
 * so it has not run when this file reaches its last line: at that moment `window.GuidedUI` is undefined and
 * `?.` turns the whole call into a silent no-op - the guided layer then never mounts, with no error anywhere
 * to point at it. MEASURED, not theorised: instrumenting this exact line printed
 * `REACHED MOUNT LINE, typeof GuidedUI=undefined`. Every parser-inserted script has run by DOMContentLoaded,
 * so waiting for it is what makes the handoff real, and it still runs before the user can click anything.
 */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.GuidedUI?.mount());
} else {
  window.GuidedUI?.mount();
}
