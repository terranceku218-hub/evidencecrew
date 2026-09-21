'use strict';
/*
 * protocol-ui.js - the V0.2 views: Seats, Runs, Evidence Cards, and the human seat inbox.
 *
 * WHAT THIS FILE IS FOR
 *   The Evidence Card is the product of a run, so it is the one surface that must not be cheerful.
 *   Every mark it renders comes from the server's projection, and the four marks are kept visually
 *   distinct on purpose: a dash means NOT RECORDED, and it must never look like a pass.
 *
 * WHAT IT IS NOT
 *   It is not a chat window. There is no conversation pane here, by design - the goal of this version
 *   is that a task's result is evidence, not a transcript.
 *
 * Plain JS, no framework, no build step, matching the rest of the workbench.
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * Localisation, from the one catalogue.
   *
   * The helper is `tr`, not `t`, and that is deliberate: `t` is already the task object in the app's task
   * panels, so a helper named `t` is shadowed inside exactly the functions that render tasks.
   */
  const tr = (key, vars) => window.I18N.t(key, vars);
  /** Translate a canonical machine value for display; the canonical value stays available beside it. */
  const ts = (value) => window.I18N.ts(value);
  /** A status with icon, colour and word together, so it never depends on colour alone. */
  function statusChip(value, extraClass = '') {
    const s = ts(value);
    if (!s.text) return '';
    const v = String(s.canonical).toUpperCase();
    const good = /COMPLETE|DONE|PASS|VERIFIED|SATISFIED|CORRELATED|ACTIVE|RESOLVED|READY|CONNECTED/.test(v);
    const bad = /BLOCKED|FAILED|UNVERIFIED|ERROR|NOT_SATISFIED|UNCERTAIN|REJECTED|UNAVAILABLE/.test(v);
    const icon = good ? '\u2713' : bad ? '!' : '\u25cb';
    const cls = good ? 'is-good' : bad ? 'is-bad' : 'is-idle';
    return `<span class="status ${cls} ${extraClass}" title="${esc(tr('evidence.canonicalHint'))}: ${esc(s.canonical)}">`
      + `<span class="status-icon" aria-hidden="true">${icon}</span>${esc(s.text)}</span>`;
  }

  const state = {
    seats: [],
    unavailable: [],
    runs: [],
    records: [],
    card: null,
    inbox: [],
    busy: false,
  };

  async function api(pathname, body) {
    const init = { method: body ? 'POST' : 'GET' };
    if (body) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body); }
    const res = await fetch(pathname, init);
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) { const e = new Error(data.error || `${res.status}`); e.payload = data; throw e; }
    return data;
  }

  function toast(msg, kind) {
    if (typeof window.__awbToast === 'function') return window.__awbToast(msg, kind);
    console.log(msg);
  }

  // -------------------------------------------------------------------
  // Seats
  // -------------------------------------------------------------------

  function renderSeats() {
    const box = $('seatsCard');
    if (!box) return;
    if (!state.seats.length) { box.innerHTML = `<p class="hint">${tr('seat.none')}</p>`; return; }

    /**
     * A seat card is written for someone who does not know what a seat is.
     *
     * The role is a WORD ("Supervisor", "Executor", "Independent reviewer"), with what it does underneath,
     * and the provider and transport stay in monospace as identifiers rather than being translated. The
     * delivery state goes through `statusChip`, so it carries an icon and a word as well as a colour.
     *
     * A DISABLED REVIEWER IS NOT AN ERROR. Codex is off by default, and the card says "Not enabled" with the
     * way to turn it on, instead of a red state that reads like something is broken. That distinction is the
     * same one the Evidence Card makes with DISABLED_BY_POLICY, and it matters more here because this is the
     * panel a first-time user looks at first.
     */
    const rows = state.seats.map((s) => {
      const h = s.health ?? {};
      /**
       * The reviewer is "not enabled" when the MODE is OFF, not when a transport is unhealthy.
       *
       * MEASURED: the seat payload carries no `connected` field, so the first version of this check compared
       * against `undefined` and would have shown Codex as disabled even after it was switched on. The mode is
       * the honest signal, and it is already in the page: the header switch holds the same value the policy
       * layer normalises. A human seat is labelled as a human seat rather than as whatever role it fills.
       */
      const codexMode = ($('codexReview')?.value ?? 'OFF');
      const isHuman = s.provider === 'human';
      const roleKey = isHuman ? 'seat.role.human' : `seat.role.${s.role}`;
      const roleLabel = tr(roleKey);
      const role = roleLabel.startsWith('[MISSING:') ? s.role : roleLabel;
      const duty = tr(`${roleKey}.duty`);
      const healthText = statusChip(h.status ?? 'UNKNOWN', 'small');
      const isReviewer = s.role === 'reviewer';
      const disabled = isReviewer && codexMode === 'OFF';
      const rounds = s.rounds
        ? tr('seat.roundsBudget', { recorded: s.rounds.recorded ?? 0, limit: s.rounds.rotation_threshold ?? '\u221e' })
        : '';
      const scope = s.permissions?.write_scope?.length
        ? tr('seat.permissions.writes', { paths: s.permissions.write_scope.join(', ') })
        : tr('seat.permissions.readOnly');
      return `<div class="seat ${disabled ? 'seat-disabled' : ''}">
        <div class="seat-top">
          <span class="seat-role">
            <strong>${esc(role)}</strong>
            ${duty.startsWith('[MISSING:') ? '' : `<span class="seat-duty">${esc(duty)}</span>`}
          </span>
          ${disabled ? `<span class="status is-idle"><span class="status-icon" aria-hidden="true">\u25cb</span>${esc(tr('seat.disabled'))}</span>`
            : statusChip(s.delivery_state, 'small')}
        </div>
        <div class="seat-meta">
          <span class="mono">${esc(s.provider)}</span>
          <span class="muted">${esc(tr('evidence.detail.transport'))}</span>
          <span class="mono">${esc(s.transport)}</span>
        </div>
        <div class="seat-meta">
          ${healthText}
          ${rounds ? `<span class="muted">${esc(rounds)}</span>` : ''}
          <span class="muted">${esc(scope)}</span>
        </div>
        ${disabled ? `<div class="seat-meta hint small">${esc(tr('seat.disabled.policy'))}
            <button class="small ghost" data-enable-codex>${esc(tr('seat.enable'))}</button></div>` : ''}
        ${s.capabilities?.needs_human ? `<div class="seat-meta hint small">${esc(tr('seat.humanInbox'))}</div>` : ''}
      </div>`;
    }).join('');

    const unavailable = state.unavailable.length
      ? `<div class="seat unavailable">
           <div class="seat-top"><strong>${esc(tr('seat.declaredNotConnected'))}</strong></div>
           ${state.unavailable.map((u) => `<div class="seat-meta"><span class="mono">${esc(u.provider)} / ${esc(u.transport)}</span></div>
             <div class="hint small">${esc(u.reason)}</div>`).join('')}
         </div>`
      : '';

    box.innerHTML = rows + unavailable;

    // The reviewer's "turn on" button drives the same endpoint as the header switch, so there is one
    // implementation of switching the reviewer on and no second path to drift.
    const enable = box.querySelector('[data-enable-codex]');
    if (enable) {
      enable.onclick = async () => {
        const sel = document.getElementById('codexReview');
        if (sel) { sel.value = 'ON'; sel.dispatchEvent(new Event('change')); }
      };
    }
  }

  // -------------------------------------------------------------------
  // Evidence Card - the core surface
  // -------------------------------------------------------------------

  const STATUS_LABEL = {
    verified: 'VERIFIED',
    partial: 'PARTIAL',
    unverified: 'UNVERIFIED',
    blocked: 'BLOCKED',
  };

  /** The four marks, and what each one actually means. */
  const MARK_KEYS = {
    ok: 'mark.ok',
    bad: 'mark.bad',
    absent: 'mark.absent',
    'n/a': 'mark.na',
  };

  /**
   * Localise one card element.
   *
   * THE LABEL comes from the element's own `key`, so it follows the data rather than the row order: add a
   * row on the server and it appears with its English label until a translation is added, rather than
   * shifting every label below it by one.
   *
   * THE VERDICT is DERIVED from the mark the server produced. A translation may phrase it, but it can never
   * claim more than the record does: a dash stays "not recorded", the not-applicable dot stays "not
   * applicable", and a disabled reviewer stays "disabled by policy" rather than becoming an error.
   *
   * THE RAW VALUE is kept, in the row tooltip and in the technical drawer, because the server's wording is
   * the evidence and a translation is a convenience.
   */
  function localizeElement(e) {
    const label = tr(`evidence.element.${e.key}`);
    const labelText = label.startsWith('[MISSING:') ? e.label : label;
    const specific = tr(`evidence.element.${e.key}.${e.mark}`);
    const generic = tr(MARK_KEYS[e.mark] ?? 'mark.absent');
    const verdict = specific.startsWith('[MISSING:') ? generic : specific;
    // Identifiers are not prose: an executor row shows the seat and provider, not a word like "Recorded".
    const isIdentity = e.key === 'worker_identity' || e.key === 'source_hash';
    return {
      label: labelText,
      verdict: isIdentity && e.mark === 'ok' ? String(e.value ?? verdict) : verdict,
      raw: String(e.value ?? ''),
      mark: e.mark,
      symbol: e.symbol,
    };
  }

  function renderCard() {
    const box = $('evidenceCard');
    if (!box) return;
    const c = state.card;
    if (!c) { box.innerHTML = `<p class="hint">${tr('evidence.none')}</p>`; return; }

    const els = c.elements.map((e) => {
      const loc = localizeElement(e);
      // The element's own label and the server's raw value are both in the tooltip: a reader can always get
      // back to the machine's wording without leaving the card.
      const tip = `${e.label}: ${loc.raw}`;
      return `
      <div class="ev-row ev-${esc(e.mark)}">
        <span class="ev-mark" title="${esc(tr(MARK_KEYS[e.mark] ?? 'mark.absent'))}">${esc(e.symbol)}</span>
        <span class="ev-label" title="${esc(tip)}">${esc(loc.label)}</span>
        <span class="ev-value" title="${esc(tr('evidence.rawValue'))}: ${esc(loc.raw)}">${esc(loc.verdict)}</span>
      </div>`;
    }).join('');

    const warns = c.warnings.map((w) => `<div class="ev-warn ev-warn-${esc(w.level)}">${esc(w.text)}</div>`).join('');
    const legend = Object.entries(MARK_KEYS)
      .map(([mark, key]) => `<span><b>${esc({ ok: '\u2713', bad: '\u2717', absent: '\u2013', 'n/a': '\u00b7' }[mark])}</b> ${esc(tr(key))}</span>`)
      .join('');

    /**
     * Technical details, collapsed.
     *
     * A normal user should not have to read run ids and hashes to answer "did it work". A developer auditing
     * a result does need them, and previously they were the first thing on the card. Folding them away is
     * the entire change: nothing was removed, and the raw server value of every row is in here too, so the
     * translated labels above can always be checked against the machine's own wording.
     */
    const drawerRows = [
      [tr('evidence.detail.runId'), c.run_id],
      [tr('evidence.detail.taskId'), c.task_id],
      [tr('evidence.detail.seat'), c.seat_providers ? Object.values(c.seat_providers).join(' / ') : null],
      [tr('evidence.detail.provider'), c.seat_providers ? Object.entries(c.seat_providers).map(([k, v]) => `${k}=${v}`).join(', ') : null],
      [tr('evidence.detail.ack'), c.record_id],
    ].filter(([, v]) => v);
    const rawRows = c.elements
      .map((e) => `<tr><td class="mono small">${esc(e.key)}</td><td class="mono small">${esc(e.mark)}</td><td class="mono small">${esc(String(e.value ?? ''))}</td></tr>`)
      .join('');

    box.innerHTML = `
      <div class="ev-head ev-head-${esc(c.status_class)}">
        <span class="ev-status">${esc(STATUS_LABEL[c.status_class] ?? c.status)}</span>
        ${c.legacy ? `<span class="ev-legacy">${tr('evidence.legacy.short')}</span>` : ''}
        <span class="ev-task mono">${esc(c.task_id ?? '')}</span>
      </div>
      <p class="ev-headline">${esc(c.headline ?? '')}</p>
      ${warns}
      <div class="ev-grid">${els}</div>
      <div class="ev-legend">${legend}</div>
      ${c.missing_evidence?.length ? `<p class="hint small">${tr('evidence.missing')}: <span class="mono">${esc(c.missing_evidence.join(', '))}</span></p>` : ''}
      <details class="ev-tech">
        <summary>${tr('evidence.technical')}</summary>
        <p class="hint small">${tr('evidence.technical.hint')}</p>
        <table class="ev-tech-table">
          ${drawerRows.map(([k, v]) => `<tr><th>${esc(k)}</th><td class="mono small">${esc(String(v))}</td></tr>`).join('')}
          ${rawRows}
        </table>
        <p class="hint small">${tr('evidence.drawer.note')}</p>
      </details>`;

    /**
     * Hand the card to the guided layer, which renders "is this result trustworthy?" at the top of the card.
     *
     * THE CALL MUST COME AFTER `box.innerHTML = ...`, AND THAT ORDER IS THE WHOLE POINT.
     *
     * The first version of this hook sat above the assignment, next to the other derived values - which read
     * naturally and was silently useless: the guided layer inserted the summary into `#evidenceCard`, and the
     * very next statement replaced the element's entire contents, deleting it. The feature was dead in both
     * modes and nothing reported an error, because every part of it worked except the ordering.
     *
     * MEASURED, not reasoned: with the call above the assignment, `#guidedEvSummary` was absent from the DOM
     * after renderCard ran in either view. That is why the acceptance suite now asserts the summary is really
     * RENDERED rather than only that the function that produces it returns the right strings - a pure-function
     * test passes happily over a feature that never reaches the screen.
     */
    window.GuidedUI?.onEvidenceCard?.(c);
  }

  // -------------------------------------------------------------------
  // Records list, run controls, human inbox
  // -------------------------------------------------------------------

  function renderRecords() {
    const box = $('evidenceList');
    if (!box) return;
    if (!state.records.length) { box.innerHTML = `<p class="hint">${tr('evidence.noRecords')}</p>`; return; }
    box.innerHTML = state.records.map((r) => `
      <div class="ev-item" data-id="${esc(r.record_id)}">
        <span class="ev-pill ev-pill-${esc(String(r.final_status).toLowerCase())}">${esc(r.final_status)}</span>
        <span class="mono small">${esc(r.task_id ?? '')}</span>
        ${r.origin === 'LEGACY_RUN' ? `<span class="ev-legacy small">${tr('evidence.legacy.short')}</span>` : ''}
      </div>`).join('');
    box.querySelectorAll('.ev-item').forEach((el) => {
      el.onclick = () => loadCard(el.getAttribute('data-id'));
    });
  }

  function renderRun() {
    const box = $('runCard');
    if (!box) return;
    const r = state.runs[0];
    if (!r) {
      box.innerHTML = `<p class="hint">${tr('run.none')}</p>`;
      return;
    }
    const step = (label, value, ok) => `<div class="ev-row ev-${ok === true ? 'ok' : ok === false ? 'bad' : 'absent'}">
      <span class="ev-mark">${ok === true ? '\u2713' : ok === false ? '\u2717' : '\u00b7'}</span>
      <span class="ev-label">${esc(label)}</span><span class="ev-value">${esc(value ?? '')}</span></div>`;

    box.innerHTML = `
      <div class="mono small">${esc(r.run_id)}</div>
      <div class="mono small muted">${esc(r.task_id)}</div>
      <div class="ev-grid">
        ${step('delivery', r.delivery_state, r.delivery_state === 'COMPLETE' ? true : null)}
        ${step('correlation', r.correlation_disposition ?? tr('run.notAttempted'), r.correlation_disposition === 'CORRELATED' ? true : (r.correlation_disposition ? false : null))}
        ${step(tr('run.sourceUnchanged'), r.toctou_ok === null ? tr('run.notChecked') : String(r.toctou_ok), r.toctou_ok)}
        ${step(tr('run.independentReview'), r.independence?.detail ?? tr('run.noReview'), r.independence?.satisfied ?? null)}
        ${step('approval', r.approval ?? tr('run.notRecorded'), r.approval === 'APPROVED' ? true : (r.approval ? false : null))}
      </div>
      <div class="hint small">status: ${esc(r.status)}</div>`;
  }

  function renderInbox() {
    const box = $('humanInbox');
    if (!box) return;
    const items = state.inbox;
    if (!items.length) { box.innerHTML = `<p class="hint">${tr('human.none')}</p>`; return; }
    box.innerHTML = items.map((p) => `
      <div class="inbox-item">
        <div class="mono small">${esc(p.run_id)}</div>
        <div class="muted small">task ${esc(p.task_id)}</div>
        <details><summary class="small">show the packet</summary><pre class="diff">${esc(p.packet)}</pre></details>
        <textarea class="inbox-answer" rows="4" placeholder="Paste your answer here. It MUST start with the RUN_ID_ACK and SOURCE_HASH_ACK lines from the packet, or it will be quarantined as uncorrelated."></textarea>
        <div class="row tight">
          <button class="small primary" data-answer="${esc(p.run_id)}">Submit answer</button>
        </div>
      </div>`).join('');
    box.querySelectorAll('button[data-answer]').forEach((b) => {
      b.onclick = () => submitAnswer(b.getAttribute('data-answer'), b);
    });
  }

  async function submitAnswer(runId, btn) {
    const item = btn.closest('.inbox-item');
    const ta = item.querySelector('.inbox-answer');
    const text = ta.value;
    if (!text.trim()) { toast(tr('human.pasteFirst'), 'bad'); return; }
    try {
      // The human seat's answer goes through the SAME protocol path as a machine's: dispatch,
      // correlate, verify. Nothing here may fill in the ack on the operator's behalf.
      const r = await api('/api/human/answer', { runId, replyText: text });
      toast(r.correlated
        ? tr('human.submitted')
        : `<strong>Answer quarantined</strong><br>${esc(r.detail ?? tr('human.noAck'))}`, r.correlated ? 'good' : 'bad');
      await refresh();
    } catch (e) { toast(esc(e.message), 'bad'); }
  }

  // -------------------------------------------------------------------
  // refresh + wiring
  // -------------------------------------------------------------------

  async function loadCard(recordId) {
    try {
      const r = await api(`/api/evidence/card?recordId=${encodeURIComponent(recordId)}`);
      state.card = r.card;
      renderCard();
    } catch (e) { toast(tr('error.loadCard', { message: esc(e.message) }), 'bad'); }
  }

  async function refresh() {
    try {
      const [seats, evidence, runs, inbox] = await Promise.all([
        api('/api/seats'),
        api('/api/evidence?limit=25'),
        api('/api/runs'),
        api('/api/human/inbox'),
      ]);
      state.seats = seats.seats ?? [];
      state.unavailable = seats.unavailable ?? [];
      state.records = evidence.records ?? [];
      state.runs = runs.runs ?? [];
      state.inbox = inbox.pending ?? [];
      renderSeats(); renderRecords(); renderRun(); renderInbox();
      // Keep the shown card fresh: a record that changed server-side must not be displayed stale.
      if (state.card?.record_id) await loadCard(state.card.record_id);
      else if (state.records.length) await loadCard(state.records[0].record_id);
    } catch (e) {
      console.error(tr('error.protocolRefresh'), e);
    }
  }

  // expose for the main app
  window.AWBProtocol = { refresh, loadCard, state, renderCard };

  document.addEventListener('DOMContentLoaded', refresh);
  // Slow background refresh only: the protocol layer is not a live console and must not poll hard.
  setInterval(refresh, 20000);
})();
