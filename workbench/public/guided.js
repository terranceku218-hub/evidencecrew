'use strict';
/*
 * guided.js - the beginner layer: a starting point, three plain-language choices, and what they will do.
 *
 * THE RULE THIS FILE FOLLOWS
 *   The UI CONSUMES the policy. It does not contain one.
 *
 *   An earlier version of this file embedded the nine presets, the autonomy limits, the mode map and a
 *   `guidedPolicyShim()` that replicated the resolver branch for branch, on the argument that
 *   `protocol/guided-policy.js` is a CommonJS module outside `public/` and therefore unreachable from the
 *   browser. That argument explains why a copy was CONVENIENT; it does not make a copy SAFE, and the risk it
 *   accepted is the one this whole feature exists to remove: a second mapping in the browser can drift from
 *   the mapping the Workbench enforces, and the drift shows up as a screen that promises a restriction the
 *   run does not have.
 *
 *   The module is not reachable from the browser. So the SERVER is asked instead:
 *
 *     GET /api/goal/presets   the nine presets, the four examples, and the policy value sets
 *     GET /api/goal/preview   the resolved policy for the current choices: write_scope, approval_required,
 *                             codex mode, autonomy mode, loop limits, and the preview lines
 *
 *   Both come from `protocol/guided-policy.js` - the same module `/api/goal/submit` resolves with. So the
 *   preview cannot promise something the run does not do, and adding a preset or a policy branch needs no
 *   change here at all. `previewFor()` renders whatever line keys the server returns; there is no list to
 *   forget to update.
 *
 * WHAT THIS FILE IS ALLOWED TO KNOW
 *   Presentation: headings, option labels, which catalogue key belongs to which choice, and the mapping from
 *   a policy VALUE to the label that describes it. Those are prose, and prose lives in the catalogue.
 *   Everything that decides what the run may DO comes from the server response.
 *
 * WHAT THIS FILE DOES NOT DO
 *   No second submit path. Start goes through the app's own `submitGoal`, which hands the request body here
 *   to be decorated with `guided` - so the busy gate, the empty-box guard and the error handling are still
 *   the app's, and the server still resolves the choices itself and does not trust this file's copy.
 *   No provider branching, no protocol field, no second orchestration system.
 *
 * LOCALISATION
 *   Every visible string comes from the catalogue through `tr()`. There is no `if (lang === ...)` here and no
 *   string table of its own, and a language switch re-renders this whole layer through `window.I18N.onChange`.
 *   Provider names, transport ids, seat/task/run ids, hashes, paths and protocol values are identifiers and
 *   are never translated - including the machine statuses rendered by the plain-language stop-state helper,
 *   which puts the plain wording BESIDE the canonical value rather than replacing it.
 *
 * Plain JS, no framework, no build step, matching the rest of the workbench.
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /** The localisation helper is `tr`, not `t`, for the same reason protocol-ui.js uses it: `t` is a task
   *  elsewhere in the app and a helper named `t` is shadowed inside exactly the functions that render tasks. */
  const tr = (key, vars) => window.I18N.t(key, vars);

  // ---------------------------------------------------------------------------
  // Storage keys
  // ---------------------------------------------------------------------------

  /**
   * Onboarding completion is stored as a VERSION, not as a bare flag.
   *
   * "The key exists, so the user is done" cannot be told apart from "the key exists because a previous
   * version of the tour wrote it", and it cannot be re-shown when the tour changes. A version makes the
   * question answerable: `1` means this tour was completed, anything else means it was not.
   */
  const KEY_ONBOARDING_VERSION = 'evidencecrew.onboarding.version';
  const KEY_VIEW = 'evidencecrew.view';
  const ONBOARDING_VERSION = 1;
  /**
   * The agreed completion flag, written BESIDE the version.
   *
   * The version key answers "has this build's tour been seen"; this one is the plain `done` marker other
   * code and other checks look for. Writing both costs one line and keeps the two questions from being
   * conflated, so a reader who greps for `evidencecrew.onboarding` finds it rather than concluding the
   * tour is not persisted at all - which is exactly what happened when only the versioned key was written.
   */
  const KEY_ONBOARDING = 'evidencecrew.onboarding';

  const state = {
    /** Catalogue from the server. Empty until the first read; nothing is hardcoded as a fallback. */
    presets: [],
    examples: [],
    /** Preset/user choices. The values are the server's own policy values, echoed back to it. */
    presetId: null,
    filePolicy: null,
    autonomy: null,
    reviewPolicy: null,
    /**
     * Execution intensity. Kept in state as the canonical value (`FAST`/`BALANCED`/`STRICT`), never as a label,
     * so the value that travels to the server is the same one the resolver compares against.
     */
    intensity: null,
    /** The last preview resolved BY THE SERVER. Every line of the panel comes from here. */
    resolved: null,
    previewError: null,
    /** The Evidence Card the protocol layer last rendered, handed over through `onEvidenceCard`. */
    card: null,
    /**
     * The value sets from `/api/goal/presets`.
     *
     * Kept separately from `resolved` because the two arrive at different times and the controls need their
     * values as soon as the CATALOGUE lands - see the note in `policySets`. Reading them from the preview meant
     * the intensity control was built from a response that had not arrived yet, and a control with no values is
     * dropped, so it never appeared.
     */
    sets: null,
    /** The last text this layer itself put in the goal box, so a user's own edit is never overwritten silently. */
    templateText: '',
    mounted: false,
    advanced: false,
  };

  let styleInjected = false;

  // ---------------------------------------------------------------------------
  // Presentation
  // ---------------------------------------------------------------------------

  /**
   * Styles for this layer, injected from here rather than appended to styles.css.
   *
   * Not an accident and not a preference: this layer has to be one self-contained file, so its rules ship
   * with it. They follow the same conventions as the rest of the sheet - the shared `:root` tokens, the
   * `.card` surface, the `.status` chip shape, the same 1280px folding point - and every value is existing
   * vocabulary (`--bg3`, `--line`, `--accent`, `--fg-dim`), so there is no second visual language.
   */
  const CSS = `
.guided-advanced-toggle { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-dim); font-size: 12px; }
.guided-advanced-toggle input { padding: 0; }
.guided-block { margin: 10px 0 12px; }
.guided-block > h3 { margin: 0 0 6px; font-size: 13px; }
.guided-head { display: flex; align-items: center; gap: 6px; }
.guided-help {
  width: 17px; height: 17px; padding: 0; line-height: 1;
  border-radius: 50%; font-size: 11px; color: var(--fg-dim);
  border: 1px solid var(--line); background: transparent; flex: none;
}
.guided-help:hover { color: var(--fg); border-color: var(--accent); }
.guided-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(152px, 1fr)); gap: 6px; }
.guided-card {
  display: flex; flex-direction: column; gap: 3px; text-align: left; padding: 7px 9px;
  background: var(--bg3); border: 1px solid var(--line); border-radius: 6px; cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease;
}
.guided-card:hover { border-color: var(--accent); }
.guided-card.sel { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: #1b2534; }
.guided-card-top { display: flex; align-items: center; gap: 6px; }
.guided-card-icon { color: var(--accent); font-size: 13px; width: 14px; text-align: center; flex: none; }
.guided-card-title { font-size: 12.5px; font-weight: 600; }
.guided-card-desc { font-size: 11.5px; color: var(--fg-dim); }
.guided-card-eg {
  margin-top: 3px; padding-top: 3px; border-top: 1px dashed var(--line);
  font-size: 11px; color: var(--fg-dim); font-style: italic;
}
.guided-example {
  display: block; width: 100%; text-align: left; padding: 7px 9px; cursor: pointer;
  background: var(--bg3); border: 1px solid var(--line); border-radius: 6px; font-size: 12px;
  transition: border-color 120ms ease;
}
.guided-example:hover { border-color: var(--accent); }
.guided-choice {
  display: flex; gap: 8px; align-items: flex-start; padding: 7px 9px; margin-bottom: 5px;
  background: var(--bg2); border: 1px solid var(--line); border-radius: 6px; cursor: pointer;
  transition: border-color 120ms ease;
}
.guided-choice:hover { border-color: var(--accent); }
.guided-choice.sel { border-color: var(--accent); background: var(--bg3); }
.guided-choice input { margin: 2px 0 0; padding: 0; flex: none; }
.guided-choice-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.guided-choice-label { font-size: 12.5px; font-weight: 600; }
.guided-choice-desc { font-size: 11.5px; color: var(--fg-dim); }
.guided-preview { margin: 0; padding: 0; list-style: none; font-size: 12.5px; }
.guided-preview li { display: flex; gap: 6px; padding: 1px 0; }
.guided-preview .mark { flex: none; width: 12px; text-align: center; }
.guided-preview li.yes .mark { color: var(--good); }
.guided-preview li.no .mark { color: var(--fg-dim); }
.guided-preview li.no { color: var(--fg-dim); }
.guided-limits { font-size: 11.5px; color: var(--fg-dim); }
.guided-limits dl { margin: 4px 0 0; }
.guided-empty-title { font-size: 15px; font-weight: 600; margin: 4px 0 4px; }
.guided-empty-hint { margin: 0 0 8px; }
.guided-stop {
  display: inline-flex; align-items: baseline; gap: 6px; flex-wrap: wrap;
  padding: 4px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg3);
  font-size: 12.5px; margin: 4px 0;
}
.guided-stop .plain { font-weight: 600; }
.guided-stop .canon { color: var(--fg-dim); font-size: 11px; }
.guided-stop.is-bad { border-color: #6b3030; }
.guided-stop.is-warn { border-color: #6b5a30; }
.guided-overlay {
  position: fixed; inset: 0; z-index: 60;
  display: flex; align-items: center; justify-content: center;
  background: rgba(8, 10, 14, 0.72); padding: 16px;
}
.guided-modal {
  width: min(560px, 94vw); background: var(--bg2); border: 1px solid var(--line); border-radius: 10px;
  padding: 16px 18px; box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
}
.guided-modal h2 { margin: 0 0 10px; font-size: 15px; }
.guided-modal h3 { margin: 0 0 6px; font-size: 13.5px; }
.guided-modal p { margin: 0 0 12px; font-size: 13px; color: var(--fg-dim); line-height: 1.6; }
.guided-steps { font-size: 11.5px; color: var(--fg-dim); }
.guided-popover {
  position: fixed; z-index: 70; width: min(330px, 92vw);
  background: var(--bg2); border: 1px solid var(--line); border-radius: 8px;
  padding: 10px 12px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
}
.guided-popover h3 { margin: 0 0 5px; font-size: 12.5px; }
.guided-popover p { margin: 0; font-size: 12px; color: var(--fg-dim); line-height: 1.55; }
/* Basic is the default, so the technical blocks a beginner does not need start hidden and are revealed by
   the attribute being honoured, never by a second application being built. */
body:not(.advanced) [data-advanced-only] { display: none !important; }
@media (max-width: 1279px) {
  .guided-grid { grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); }
}
`;

  function injectStyle() {
    if (styleInjected || document.getElementById('guidedStyles')) return;
    const s = document.createElement('style');
    s.id = 'guidedStyles';
    s.textContent = CSS;
    document.head.appendChild(s);
    styleInjected = true;
  }

  // ---------------------------------------------------------------------------
  // Reads and writes on the existing page
  // ---------------------------------------------------------------------------

  function goalBox() { return $('goalText'); }

  /** The goal the user will actually submit: the box as it is now. */
  function currentGoalText() {
    const el = goalBox();
    return el ? el.value : '';
  }

  /** True when a goal is already submitted or running, so the empty screen must stay out of the way. */
  function goalRunning() {
    const box = $('goalStatus');
    if (!box || box.classList.contains('hidden')) return false;
    return String(box.textContent ?? '').trim().length > 0;
  }

  function presetById(id) {
    return state.presets.find((p) => p.id === id) ?? null;
  }

  // ---------------------------------------------------------------------------
  // The server reads
  // ---------------------------------------------------------------------------

  async function getJson(url) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.ok === false) {
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
    return body;
  }

  /** The project/workspace the goal would run in, so the preview resolves against the REAL write scope. */
  function scopeQuery() {
    const app = window.AWBAppState;
    if (!app) {
      // The preview is then resolved with no project, which yields the empty-scope branch. That is a
      // DIFFERENT question from "this project permits no writes", and the resolver says so in `notes`.
      return '';
    }
    if (!app.projectId()) return '';
    const ws = app.workspaceId() ? `&workspaceId=${encodeURIComponent(app.workspaceId())}` : '';
    return `projectId=${encodeURIComponent(app.projectId())}${ws}`;
  }

  function loadCatalogue() {
    return getJson('/api/goal/presets').then((r) => {
      state.presets = r.presets ?? [];
      state.examples = r.examples ?? [];
      /**
       * THE VALUE SETS COME FROM THE CATALOGUE, AND THE CONTROLS DEPEND ON THEM.
       *
       * `/api/goal/presets` already serves `file_policies`, `autonomy_levels`, `review_policies`, the
       * `intensities` catalogue and the validation tiers; `/api/goal/preview` serves the same sets back. The
       * controls were being built from `state.resolved`, which is the PREVIEW - so at the moment the catalogue
       * arrived the intensities were not there yet, `renderPicker` dropped a control with no values, and
       * nothing re-rendered afterwards. The visible symptom was a missing intensity control while the server
       * reported three levels on every resolve.
       *
       * Seeding the sets here means the controls have their values as soon as the catalogue lands, and the
       * later preview response simply confirms them.
       */
      state.sets = {
        file_policies: r.file_policies ?? null,
        autonomy_levels: r.autonomy_levels ?? null,
        review_policies: r.review_policies ?? null,
        intensities: r.intensities ?? null,
        validation_tiers: r.validation_tiers ?? null,
        default_intensity: r.default_intensity ?? null,
      };
      // The first preset is the server's own default for a first-time user; with none chosen, the
      // controls start on that preset's policy rather than on a value invented here.
      if (!state.presetId && state.presets.length) {
        const first = state.presets[0];
        state.presetId = first.id;
        state.filePolicy = first.file_policy;
        state.autonomy = first.autonomy;
        state.reviewPolicy = first.review_policy;
        // The preset's own recommendation, so the DEFAULT intensity is the one the catalogue chose for this
        // starting point rather than the global fallback.
        state.intensity = first.recommended_intensity ?? state.intensity;
      }
    });
  }

  /**
   * Re-resolve through the server. This is the ONLY place a policy is computed, and it is not computed here.
   *
   * The query carries the choices and the project/workspace; the response carries `write_scope`,
   * `approval_required`, the Codex mode, the autonomy mode, the loop limits and the preview line keys. The
   * panel renders that response and nothing else, so what the user reads is what the server resolved.
   */
  let previewSeq = 0;
  async function loadPreview() {
    const seq = ++previewSeq;
    const q = new URLSearchParams();
    if (state.presetId) q.set('presetId', state.presetId);
    if (state.filePolicy) q.set('filePolicy', state.filePolicy);
    if (state.autonomy) q.set('autonomy', state.autonomy);
    if (state.reviewPolicy) q.set('reviewPolicy', state.reviewPolicy);
    // The canonical intensity value travels to the resolver unchanged. It is never sent as a display label.
    if (state.intensity) q.set('executionIntensity', state.intensity);
    const extra = scopeQuery();
    const url = `/api/goal/preview?${q.toString()}${extra ? `&${extra}` : ''}`;
    try {
      const r = await getJson(url);
      // A slower earlier response must not overwrite a newer one and show the previous choice's policy.
      if (seq !== previewSeq) return;
      state.resolved = r;
      state.previewError = null;
    } catch (e) {
      if (seq !== previewSeq) return;
      state.resolved = null;
      // A failed resolve is REPORTED, never papered over with a plausible-looking default: showing a
      // read-only preview because the server could not be asked would be the exact lie this layer avoids.
      state.previewError = String(e && e.message ? e.message : e);
    }
    renderPreview();
    /**
     * Let `renderPicker` decide for itself whether it has anything to draw.
     *
     * An earlier attempt put a fingerprint guard HERE and it made things worse: the guard suppressed the
     * catalogue's own render because the fingerprint did not include the preset count, leaving a page with no
     * template cards AND no controls - a worse failure than the missing intensity block it was meant to fix.
     *
     * `renderPicker` already has an early return for "no catalogue yet", which is the only guard this actually
     * needs, and it re-renders on its own after the catalogue lands. The lesson is worth keeping: a guard
     * inserted to suppress redundant work is a guard that can suppress necessary work, and the two are
     * indistinguishable from the outside.
     */
    renderPreview();
  }

  // ---------------------------------------------------------------------------
  // Contextual help
  // ---------------------------------------------------------------------------

  function closeHelp() {
    document.querySelectorAll('.guided-popover').forEach((n) => n.remove());
  }

  function openHelp(conceptId) {
    const id = String(conceptId ?? '');
    const titleKey = `help.${id}.title`;
    const title = tr(titleKey);
    /**
     * An unknown concept is a LOUD no-op rather than an invented panel: a missing key renders as
     * `[MISSING: help.x.title]`, which is exactly the signal a developer needs, and showing it beats
     * showing an empty popover that looks like the help simply has nothing to say.
     */
    if (title.startsWith('[MISSING:')) { console.warn('[guided] unknown help concept', id); return; }

    closeHelp();
    const anchor = document.querySelector(`[data-help="${id}"]`);
    const pop = document.createElement('div');
    pop.className = 'guided-popover';
    pop.setAttribute('role', 'dialog');
    pop.innerHTML = `<h3>${esc(title)}</h3><p>${esc(tr(`help.${id}.desc`))}</p>`;
    document.body.appendChild(pop);

    // Placed beside its button, then clamped into the viewport: a popover that opens off-screen is the
    // same as no help at all.
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      const w = pop.offsetWidth;
      const h = pop.offsetHeight;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      const top = r.bottom + 6 + h <= window.innerHeight ? r.bottom + 6 : Math.max(8, r.top - h - 6);
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
    } else {
      pop.style.left = '16px';
      pop.style.top = '64px';
    }
  }

  /**
   * Attach a `?` button next to one heading, once.
   *
   * Idempotent by the `data-help` marker, because `refresh()` runs on every language change and a second
   * button beside the same heading would be a visible bug. The button carries `data-i18n-aria-label`, so the
   * engine translates it on a language switch like everything else.
   */
  function attachHelp(hostId, conceptId) {
    const host = $(hostId);
    if (!host || host.querySelector(`[data-help="${conceptId}"]`)) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'guided-help';
    b.setAttribute('data-help', conceptId);
    b.setAttribute('aria-label', tr(`help.${conceptId}.title`));
    b.setAttribute('data-i18n-aria-label', `help.${conceptId}.title`);
    b.textContent = '?';
    b.onclick = (e) => { e.stopPropagation(); openHelp(conceptId); };
    host.appendChild(b);
  }

  function attachAllHelp() {
    attachHelp('panelProjects', 'project');
    attachHelp('panelWorkspaces', 'workspace');
    attachHelp('panelGoal', 'goal');
    attachHelp('panelTasks', 'task');
    attachHelp('panelSeats', 'seat');
    attachHelp('panelEvidence', 'evidence');
    attachHelp('codexHelp', 'codex');
  }

  // ---------------------------------------------------------------------------
  // The template picker and the three controls
  // ---------------------------------------------------------------------------

  /**
   * The three controls.
   *
   * This is PRESENTATION ONLY: which heading each control has, and which catalogue key labels each policy
   * VALUE. The values come from the server's own value sets, so a value the server adds appears here without
   * a change to this file; only its LABEL would need a catalogue entry, and a missing one renders as
   * `[MISSING: ...]` rather than as an invented policy.
   */
  function controlDefs(sets) {
    const values = (set, fallback) => Object.values(set ?? fallback);
    const defs = [
      {
        field: 'filePolicy',
        heading: 'file.heading',
        hint: 'file.hint',
        values: values(sets.file_policies, { READ_ONLY: 'read_only', WRITE: 'write', ASK: 'ask' }),
        group: 'file',
      },
      {
        field: 'autonomy',
        heading: 'autonomy.heading',
        values: values(sets.autonomy_levels, { GUIDED: 'guided', RECOMMENDED: 'recommended', AUTONOMOUS: 'autonomous' }),
        group: 'autonomy',
      },
      /**
       * Execution intensity sits DIRECTLY UNDER autonomy, and the order is the explanation.
       *
       * Autonomy and intensity are sibling choices about different things - how far the run goes on its own,
       * and what it spends getting there - so they are adjacent and worded as questions of the same kind.
       * Neither one can loosen the other, and the hint below the budget block says so.
       */
      intensityControl(sets),
      {
        /**
         * Review, in beginner wording.
         *
         * `supervisor` renders as a supervisor review and never as the protocol token: the choice is between
         * a supervisor review and an ADDITIONAL independent one, and `independent_provider` is the machine's
         * word for the second of those, not a thing a beginner is being asked to choose. `min_reviewers` and
         * `review_requirements` are not rendered at all - they are requirements the server derives, not
         * settings, and showing a number the user cannot change invites them to think they chose it.
         */
        field: 'reviewPolicy',
        heading: 'review.heading',
        values: values(sets.review_policies, { SUPERVISOR: 'supervisor', CODEX_AUTO: 'codex_auto' }),
        group: 'review',
      },
    ];
    /**
     * A control with no VALUES is dropped, and that is a timing rule rather than tidiness.
     *
     * `controlDefs` is called TWICE: once from `refresh()` at mount, before any server response has arrived,
     * and again after the catalogue loads. When `intensityControl` was filtered inside the compacted `defs`
     * assignment, the filter ran against the FIRST call's data - which had no intensities - and the block was
     * removed permanently, so the intensity control never appeared at all despite the server sending three
     * levels on every resolve. Filtering here, after the array is built, does not help either.
     *
     * So the filter lives at the CALL SITE, where the caller knows whether it has a catalogue yet. The one
     * thing this must never do is render a heading with no options under it, which is what a null entry would
     * produce.
     */
    return defs.filter((d) => d && Array.isArray(d.values) && d.values.length > 0);
  }

  /**
   * The value sets the controls are built from.
   *
   * The CATALOGUE is the source, because it arrives first; the preview's own copy is used only as a fallback
   * for a page that somehow rendered before the catalogue landed. Building the controls from the preview meant
   * they were empty on the render that mattered.
   */
  function policySets() {
    const r = state.resolved;
    const c = state.sets ?? {};
    return {
      file_policies: c.file_policies ?? r?.file_policies ?? { READ_ONLY: 'read_only', WRITE: 'write', ASK: 'ask' },
      autonomy_levels: c.autonomy_levels ?? r?.autonomy_levels ?? { GUIDED: 'guided', RECOMMENDED: 'recommended', AUTONOMOUS: 'autonomous' },
      review_policies: c.review_policies ?? r?.review_policies ?? { SUPERVISOR: 'supervisor', CODEX_AUTO: 'codex_auto' },
      intensities: c.intensities ?? r?.intensities ?? null,
    };
  }

  /**
   * The three intensities, described from the SERVER's catalogue rather than from a table here.
   *
   * Each level arrives with its own `icon`, `title_key`, `description_key`, `budgets`, `validation_tier` and
   * `context`, so this function decides only HOW they are presented - which icon slot, which heading - and
   * never what a level means. A fourth intensity added on the server appears here with no change to this file.
   */
  function intensityControl(sets) {
    const list = Array.isArray(sets.intensities) ? sets.intensities : [];
    if (!list.length) return null;
    const find = (id) => list.find((i) => i.id === id);
    return {
      field: 'intensity',
      heading: 'intensity.heading',
      values: list.map((i) => i.id),
      group: 'intensity',
      labelKey: (id) => find(id)?.title_key ?? `intensity.${String(id).toLowerCase()}`,
      descKey: (id) => find(id)?.description_key ?? `intensity.${String(id).toLowerCase()}.desc`,
      iconOf: (id) => find(id)?.icon ?? '',
    };
  }

  /**
   * The label key for one policy VALUE.
   *
   * The values are snake_case (`read_only`, `codex_auto`) and the catalogue keys are camelCase
   * (`file.readOnly`, `review.codexAuto`), so the mapping is spelled out. Deriving it mechanically was the
   * first attempt and it produced `file.read_only`, a key that does not exist - which is exactly the class of
   * silent defect this whole review is about, caught by rendering `[MISSING: file.read_only]` on screen.
   */
  const VALUE_LABEL_KEY = {
    'file.read_only': 'file.readOnly',
    'file.write': 'file.write',
    'file.ask': 'file.ask',
    'autonomy.guided': 'autonomy.guided',
    'autonomy.recommended': 'autonomy.recommended',
    'autonomy.autonomous': 'autonomy.autonomous',
    'review.supervisor': 'review.supervisor',
    'review.codex_auto': 'review.codexAuto',
  };

  function valueKey(group, value) {
    return VALUE_LABEL_KEY[`${group}.${value}`] ?? `${group}.${value}`;
  }

  function renderControl(c) {
    const labelOf = (o) => (typeof c.labelKey === 'function' ? tr(c.labelKey(o)) : tr(valueKey(c.group, o)));
    const descOf = (o) => (typeof c.descKey === 'function' ? tr(c.descKey(o)) : tr(`${valueKey(c.group, o)}.desc`));
    const iconOf = (o) => (typeof c.iconOf === 'function' ? c.iconOf(o) : '');
    const rows = c.values.map((o) => {
      const sel = state[c.field] === o;
      const mark = iconOf(o);
      return `<label class="guided-choice${sel ? ' sel' : ''}" data-field="${esc(c.field)}" data-value="${esc(o)}"
          title="${esc(descOf(o))}">
        <input type="radio" name="guided-${esc(c.field)}" value="${esc(o)}" ${sel ? 'checked' : ''}>
        <span class="guided-choice-text">
          <span class="guided-choice-label">${mark ? `<span class="guided-card-icon" aria-hidden="true">${esc(mark)}</span>` : ''}${esc(labelOf(o))}</span>
          <span class="guided-choice-desc">${esc(descOf(o))}</span>
        </span>
      </label>`;
    }).join('');
    return `<div class="guided-block" data-control="${esc(c.field)}">
      <h3>${esc(tr(c.heading))}</h3>
      ${c.hint ? `<p class="hint small">${esc(tr(c.hint))}</p>` : ''}
      ${rows}
    </div>`;
  }

  function renderPicker() {
    const root = $('guidedRoot');
    if (!root) return;

    // Before the catalogue arrives there is nothing truthful to show, so the area says it is loading
    // rather than rendering a grid of cards this file made up.
    if (!state.presets.length) {
      root.innerHTML = `<div class="guided-block"><h3>${esc(tr('goal.prompt'))}</h3>
        <p class="hint small">${esc(tr('guided.loading'))}</p></div>`;
      return;
    }

    const cards = state.presets.map((p) => {
      const sel = state.presetId === p.id;
      const title = tr(p.title_key);
      const desc = tr(p.description_key);
      // The per-preset goal example, so a beginner can see what this template would actually ask for
      // before choosing it. Absent for `custom`, which by definition has no starter.
      const eg = p.goal_template
        ? `<span class="guided-card-eg">${esc(tr('preset.exampleLabel'))} ${esc(tr(p.goal_template))}</span>`
        : '';
      return `<button type="button" class="guided-card${sel ? ' sel' : ''}" data-preset="${esc(p.id)}"
          aria-pressed="${sel ? 'true' : 'false'}" title="${esc(desc)}">
        <span class="guided-card-top">
          <span class="guided-card-icon" aria-hidden="true">${esc(p.icon)}</span>
          <span class="guided-card-title">${esc(title)}</span>
        </span>
        <span class="guided-card-desc">${esc(desc)}</span>
        ${eg}
      </button>`;
    }).join('');

    /**
     * The heading is the app's own goal prompt, so the picker reads as a way of answering the question the
     * box below is asking rather than as a separate menu. It carries no new string of its own.
     */
    root.innerHTML = `<div class="guided-block">
        <h3>${esc(tr('goal.prompt'))}</h3>
        <div class="guided-grid">${cards}</div>
      </div>
      ${controlDefs(policySets()).map(renderControl).join('')}
      <div class="guided-block" data-preview></div>`;

    root.querySelectorAll('[data-preset]').forEach((b) => {
      b.onclick = () => selectPreset(b.getAttribute('data-preset'), { fillTemplate: true });
    });
    root.querySelectorAll('.guided-choice').forEach((row) => {
      row.onclick = () => {
        const field = row.getAttribute('data-field');
        const value = row.getAttribute('data-value');
        if (field && Object.prototype.hasOwnProperty.call(state, field)) state[field] = value;
        renderPicker();
        loadPreview();
      };
    });
    renderPreview();
  }

  /**
   * The "what will happen" list.
   *
   * Every line is DERIVED from the resolved policy the SERVER returned - both the line keys and which of
   * them are affirmed. Nothing here infers a capability from the template's title, and there is no list of
   * rules in this file to forget to update when a rule is added to guided-policy.js.
   */
  function renderPreview() {
    const box = document.querySelector('[data-preview]');
    if (!box) return;

    if (state.previewError) {
      box.innerHTML = `<h3>${esc(tr('preview.heading'))}</h3>
        <p class="hint small badText">${esc(tr('preview.failed', { error: state.previewError }))}</p>`;
      return;
    }
    const r = state.resolved;
    if (!r) {
      box.innerHTML = `<h3>${esc(tr('preview.heading'))}</h3><p class="hint small">${esc(tr('guided.loading'))}</p>`;
      return;
    }

    /**
     * Every line is derived from the server's resolve, and a line may carry `vars`.
     *
     * THE BAND IS A VALUE, NOT A SENTENCE, SO IT IS LOOKED UP BEFORE IT IS INTERPOLATED.
     *
     * The server sends `vars.band` - the band NAME it decided, e.g. `few` - and `vars.band_key`, the catalogue
     * key for it, e.g. `band.few`. Passing the name straight into `{band}` put the raw English token into a
     * Chinese sentence: the first version of this rendered `AI 调用：few`, because nothing told the panel that
     * the value needed looking up. The NAME stays untranslated in the policy and in the logs; only the display
     * goes through the catalogue, and an unknown band falls back to its raw name rather than rendering
     * `[MISSING: band.x]` at a user.
     */
    const bandText = (vars) => {
      if (!vars?.band) return vars;
      const shown = tr(vars.band_key ?? `band.${vars.band}`);
      return { ...vars, band: shown.startsWith('[MISSING:') ? String(vars.band) : shown };
    };
    const lines = (r.preview ?? []).map((i) => {
      const yes = i.state === 'yes';
      const vars = i.vars ? bandText(i.vars) : null;
      const text = vars ? tr(i.key, vars) : tr(i.key);
      return `<li class="${yes ? 'yes' : 'no'}">
        <span class="mark" aria-hidden="true">${yes ? '\u2713' : '\u2013'}</span>
        <span>${esc(text)}</span></li>`;
    }).join('');

    // The technical numbers are real and belong in Advanced, where the user asked for them.
    const lim = r.limits ?? {};
    const limits = `<details class="guided-limits" data-advanced-only>
      <summary>${esc(tr('intensity.budgets'))}</summary>
      <dl class="kv">
        <dt>${esc(tr('intensity.workerDispatches'))}</dt><dd>${esc(String(lim.max_worker_dispatches_per_task ?? 'n/a'))}</dd>
        <dt>${esc(tr('intensity.retries'))}</dt><dd>${esc(String(lim.max_task_retries ?? 'n/a'))}</dd>
        <dt>${esc(tr('intensity.reviews'))}</dt><dd>${esc(String(lim.max_supervisor_reviews ?? 'n/a'))}</dd>
        <dt>${esc(tr('intensity.subagents'))}</dt><dd>${esc(String(lim.max_subagents ?? 'n/a'))}</dd>
        <dt>${esc(tr('intensity.validationTier'))}</dt><dd>${esc(String(r.validation_tier ?? 'n/a'))}</dd>
        <dt>${esc(tr('intensity.contextMode'))}</dt><dd>${esc(String(r.context_mode ?? 'n/a'))}</dd>
      </dl>
      <p class="hint small">${esc(tr('intensity.ceilingNote'))}</p>
      <dl class="kv">
        <dt>max_goal_iterations</dt><dd>${esc(String(lim.max_goal_iterations ?? 'n/a'))}</dd>
        <dt>no_progress_limit</dt><dd>${esc(String(lim.no_progress_limit ?? 'n/a'))}</dd>
      </dl></details>`;

    /**
     * The resolved permissions, verbatim.
     *
     * This is what the run is submitted with, so showing it is the difference between asking the user to trust
     * the wording and letting them read the value. It carries `data-advanced-only` on the WRAPPER, not only on
     * an inner node: measured on a fresh profile, a version with the attribute on the outer element alone
     * still had the whole block in the page's `innerText`, because a `[data-advanced-only]` rule hides the
     * element it is ON and not the element it is INSIDE. A beginner is not shown raw `write_scope` arrays.
     */
    const ws = r.permissions?.write_scope ?? [];
    const ar = r.permissions?.approval_required ?? [];
    const perms = `<div data-advanced-only><dl class="kv">
      <dt>file_policy</dt><dd>${esc(String(r.file_policy ?? 'n/a'))}</dd>
      <dt>write_scope</dt><dd>${esc(ws.length ? ws.join(', ') : '(none)')}</dd>
      <dt>approval_required</dt><dd>${esc(ar.length ? ar.join(', ') : '(none)')}</dd>
      <dt>codex_review_mode</dt><dd>${esc(String(r.codex_review_mode ?? 'n/a'))}</dd>
      <dt>autonomy_mode</dt><dd>${esc(String(r.autonomy_mode ?? 'n/a'))}</dd>
    </dl></div>`;

    box.innerHTML = `<h3>${esc(tr('preview.heading'))}</h3>
      <ul class="guided-preview">${lines}</ul>
      ${limits}
      ${perms}`;
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  /**
   * Select a preset: set the three controls to its values and offer its goal template.
   *
   * NEVER SILENTLY OVERWRITE THE USER'S OWN TEXT. The box is only replaced when it is empty or still holds
   * the exact text this layer last put there. Anything else is the user's writing, so it is replaced only
   * after `confirm()` says so, and a refusal leaves their text alone.
   */
  function selectPreset(presetId, opts = {}) {
    const preset = presetById(presetId);
    if (!preset) return;
    state.presetId = preset.id;
    state.filePolicy = preset.file_policy;
    state.autonomy = preset.autonomy;
    state.reviewPolicy = preset.review_policy;
    /**
     * The preset's RECOMMENDED intensity, applied on selection.
     *
     * `preset.recommended_intensity` is what makes "check something" arrive as Quick and "fix something
     * broken" arrive as Balanced, instead of both arriving on whatever the previous screen left behind. The
     * user can override it afterwards - the recommendation is a starting point, not a lock.
     */
    state.intensity = preset.recommended_intensity ?? state.intensity;

    const box = goalBox();
    if (box && opts.fillTemplate && preset.goal_template) {
      const text = tr(preset.goal_template);
      const current = box.value;
      const untouched = !current.trim() || current === state.templateText;
      if (untouched || window.confirm(tr('guided.replaceConfirm'))) {
        box.value = text;
        state.templateText = text;
        box.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    renderPicker();
    loadPreview();
    renderEmpty();
  }

  // ---------------------------------------------------------------------------
  // Empty state
  // ---------------------------------------------------------------------------

  /**
   * The first screen: what to do, and four real goals to start from.
   *
   * Shown while the goal box is empty and no goal is running. Clicking an example FILLS the box and selects
   * its preset - it never submits, because a click on an example is not consent to start a run.
   *
   * IT COVERS THE NO-PROJECT CASE, WHICH IS NOT AN EDGE CASE - IT IS THE FIRST SCREEN ANYONE SEES.
   *
   * The previous version deferred to the app's own `#emptyMid` placeholder and only appeared once a project
   * AND a workspace were chosen. Measured on a fresh profile: `emptyStateVisible: false`,
   * `taskListVisible: false`, and the guided cards nowhere - so a first-time user met an empty column and the
   * instruction "Select a project and a workspace to begin", with the nine starting points invisible until
   * they had already guessed what to click. That is the opposite of a one-minute start.
   *
   * So it is shown whenever no goal is running, and the app's placeholder is hidden while it is up: it says
   * the same thing in a sentence ("pick a project on the left") and then immediately offers the templates,
   * instead of being the whole screen.
   */
  function renderEmpty() {
    const col = $('colMid');
    if (!col) return;
    let box = $('guidedEmpty');
    if (!box) {
      box = document.createElement('div');
      box.id = 'guidedEmpty';
      box.className = 'card';
      /**
       * Inserted into the COLUMN, as a sibling of `#midBody` - NOT inside it.
       *
       * This is the difference between the first screen working and not working, and it was measured rather
       * than reasoned about: `#midBody` carries a `hidden` class until a project AND a workspace are chosen,
       * so a block placed inside it has its text in the DOM and renders nothing at all. The probe showed
       * exactly that - `emptyStateText` populated while `emptyStateVisible` was false. A first-time user saw
       * an empty column with the templates invisible until they had already guessed what to click.
       *
       * `#emptyMid` is the app's own placeholder for the same moment, so this goes directly after it.
       */
      const anchor = $('emptyMid');
      if (anchor && anchor.parentNode === col) col.insertBefore(box, anchor.nextSibling);
      else col.insertBefore(box, col.firstChild);
    }

    const active = !currentGoalText().trim() && !goalRunning();
    box.classList.toggle('hidden', !active);

    /**
     * The task surfaces are hidden only once a project is chosen.
     *
     * Before that there is no task list to hide, and `#emptyMid` - the app's "pick a project" sentence - is
     * exactly the right thing to show next to the guided cards, so it is left alone.
     */
    const hasCtx = !!(window.AWBAppState?.projectId?.() && window.AWBAppState?.workspaceId?.());
    for (const id of ['taskFilter', 'taskList']) {
      const n = $(id);
      if (n) n.classList.toggle('hidden', active && hasCtx);
    }
    if (!active) { box.innerHTML = ''; return; }

    // Examples fill the goal box, so they are offered only once there is a project for the goal to run in.
    // Offering them earlier would fill a box the Start button then refuses to submit.
    const cards = hasCtx ? state.examples.map((e) => {
      const label = tr(e.goal);
      return `<button type="button" class="guided-example" data-example="${esc(e.id)}"
        title="${esc(label)}">${esc(label)}</button>`;
    }).join('') : '';

    box.innerHTML = `<div class="guided-empty-title">${esc(tr('guided.emptyTitle'))}</div>
      <p class="hint guided-empty-hint">${esc(hasCtx ? tr('guided.emptyHint') : tr('guided.needProject'))}</p>
      ${cards ? `<div class="guided-grid">${cards}</div>` : ''}`;

    box.querySelectorAll('[data-example]').forEach((b) => {
      b.onclick = () => {
        const e = state.examples.find((x) => x.id === b.getAttribute('data-example'));
        if (!e) return;
        const text = tr(e.goal);
        const g = goalBox();
        if (g) {
          g.value = text;
          state.templateText = text;
          g.dispatchEvent(new Event('input', { bubbles: true }));
        }
        selectPreset(e.preset, { fillTemplate: false });
        g?.focus();
        // Deliberately NOT submitting: the user presses Start, and a click on an example is not consent to
        // start a run.
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Plain-language stop states
  // ---------------------------------------------------------------------------

  /**
   * The machine status, said in words, with the canonical value kept.
   *
   * The status is NOT translated or replaced: `BLOCKED` stays `BLOCKED` on screen, because it is what the
   * protocol, the logs and the Evidence record say, and a user comparing the screen with an error report
   * must see the same token. The plain wording is added BESIDE it. A status with no plain wording is
   * rendered as the canonical value alone rather than guessed at.
   */
  const STOP_PLAIN = {
    BLOCKED: 'plain.BLOCKED',
    NO_PROGRESS: 'plain.NO_PROGRESS',
    BUDGET_EXHAUSTED: 'plain.BUDGET_EXHAUSTED',
    USER_APPROVAL_REQUIRED: 'plain.USER_APPROVAL_REQUIRED',
  };
  const STOP_SEVERITY = {
    BLOCKED: 'is-bad',
    NO_PROGRESS: 'is-warn',
    BUDGET_EXHAUSTED: 'is-warn',
    USER_APPROVAL_REQUIRED: 'is-warn',
  };

  /** HTML for one stop state, or '' when this status has no plain-language form. */
  function stopStateHtml(canonical) {
    const key = STOP_PLAIN[String(canonical ?? '').toUpperCase()];
    if (!key) return '';
    return `<div class="guided-stop ${STOP_SEVERITY[String(canonical).toUpperCase()] ?? ''}">
      <span class="plain">${esc(tr(key))}</span>
      <span class="canon">${esc(String(canonical))}</span>
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // Beginner Evidence summary
  // ---------------------------------------------------------------------------

  /**
   * "Is this result trustworthy?" - answered from the Evidence Card's own FIELDS, never from its prose.
   *
   * The inputs are `status`, the `elements` marks, the `warnings` levels and `missing_evidence`. The code
   * below reads those and chooses one of three fixed answers. It does not read the summary text and it does
   * not look for reassuring words, because a summary is written by the thing being judged.
   *
   * TWO DISTINCTIONS THAT MATTER, both learned from the green-tick defects this card already has a regression
   * suite for:
   *
   *   `n/a` is NOT a problem. `DISABLED_BY_POLICY` arrives here as an `n/a` mark on the review element, and
   *   counting it as missing evidence would tell a user to switch the reviewer on merely to clear the
   *   warning - the opposite of an optional reviewer.
   *
   *   `absent` IS a problem. It means NOT RECORDED, which the card renders as a dash and never as a tick. So
   *   it can stop a VERIFIED verdict from being reported as clean, but it is counted separately from a `bad`
   *   mark, because "recorded, and it is a problem" and "not recorded at all" are different facts.
   *
   * The canonical `status` is NOT changed or hidden - the summary is added above it.
   */
  function evidenceSummaryHtml(card) {
    if (!card) return '';
    const status = String(card.status ?? '').toUpperCase();
    const elements = Array.isArray(card.elements) ? card.elements : [];
    const marks = elements.map((e) => String(e?.mark ?? '').toLowerCase()).filter(Boolean);
    const missing = Array.isArray(card.missing_evidence) ? card.missing_evidence : [];
    const warnings = Array.isArray(card.warnings) ? card.warnings : [];

    const bad = marks.filter((m) => m === 'bad').length;
    const absent = marks.filter((m) => m === 'absent').length;
    const errorWarnings = warnings.filter((w) => w?.level === 'error').length;

    // Clean means: verified, nothing recorded as a problem, nothing unrecorded, nothing missing, and no error
    // warning. `n/a` is deliberately excluded from that list.
    const clean = status === 'VERIFIED'
      && bad === 0 && absent === 0 && errorWarnings === 0 && missing.length === 0;

    let key;
    if (clean) key = 'ev.summary.verified';
    else if (status === 'VERIFIED' || status === 'PARTIAL') key = 'ev.summary.partial';
    else key = 'ev.summary.unverified';

    const detail = [];
    if (bad) detail.push(tr('ev.summary.bad', { count: String(bad) }));
    if (absent) detail.push(tr('ev.summary.absent', { count: String(absent) }));
    if (errorWarnings) detail.push(tr('ev.summary.warnings', { count: String(errorWarnings) }));
    if (missing.length) detail.push(tr('ev.summary.missing', { count: String(missing.length) }));

    return `<div class="guided-evsummary" data-guided-ev>
      <h3>${esc(tr('ev.summary.heading'))}</h3>
      <p class="guided-stop ${clean ? '' : 'is-warn'}">
        <span class="plain">${esc(tr(key))}</span>
      </p>
      ${detail.length ? `<p class="hint small">${esc(detail.join(' '))}</p>` : ''}
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // Onboarding
  // ---------------------------------------------------------------------------

  function onboardedVersion() {
    try {
      const raw = window.localStorage?.getItem(KEY_ONBOARDING_VERSION);
      const n = Number.parseInt(String(raw ?? ''), 10);
      return Number.isFinite(n) ? n : 0;
    } catch { return 0; }
  }

  /** A completed tour is recorded as this version, explicitly. Not as "the key exists". */
  function markOnboarded() {
    try {
      window.localStorage?.setItem(KEY_ONBOARDING_VERSION, String(ONBOARDING_VERSION));
      window.localStorage?.setItem(KEY_ONBOARDING, 'done');
    } catch { /* private mode */ }
  }

  function isOnboarded() {
    // Either marker counts: a user who has seen the tour must not be shown it again because one of the two
    // writers ran and the other did not.
    try {
      if (window.localStorage?.getItem(KEY_ONBOARDING) === 'done') return true;
    } catch { /* fall through to the version check */ }
    return onboardedVersion() >= ONBOARDING_VERSION;
  }

  function closeOnboarding() {
    $('guidedOnboarding')?.remove();
  }

  function openOnboarding() {
    closeOnboarding();
    let step = 0;

    const overlay = document.createElement('div');
    overlay.id = 'guidedOnboarding';
    overlay.className = 'guided-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    document.body.appendChild(overlay);

    function paint() {
      const n = step + 1;
      overlay.innerHTML = `<div class="guided-modal">
        <h2>${esc(tr('onboarding.title'))}</h2>
        <div class="guided-steps">${esc(tr('onboarding.progress', { step: String(n), total: '5' }))}</div>
        <h3>${esc(tr(`onboarding.step${n}.title`))}</h3>
        <p>${esc(tr(`onboarding.step${n}.desc`))}</p>
        <div class="row tight">
          ${step > 0 ? `<button type="button" class="small" data-ob="back">\u2190</button>` : ''}
          <button type="button" class="primary" data-ob="next">${esc(tr('onboarding.start'))}</button>
          <button type="button" class="small ghost" data-ob="skip">${esc(tr('onboarding.skip'))}</button>
        </div>
      </div>`;
      const next = overlay.querySelector('[data-ob="next"]');
      if (next) {
        next.onclick = () => {
          if (step >= 4) {
            markOnboarded();
            closeOnboarding();
            // The tour ends by putting the user where the tour was describing, with the first template
            // chosen, so "start your first task" is one click away rather than a thing to go looking for.
            goalBox()?.focus();
            return;
          }
          step += 1;
          paint();
        };
      }
      const back = overlay.querySelector('[data-ob="back"]');
      if (back) back.onclick = () => { step -= 1; paint(); };
      const skip = overlay.querySelector('[data-ob="skip"]');
      if (skip) {
        skip.onclick = () => {
          /**
           * Skipping is a DECISION and is remembered as one. Showing this again on the next visit would be
           * re-asking a question the user has already answered, which is the behaviour people complain about.
           */
          markOnboarded();
          closeOnboarding();
        };
      }
    }
    paint();
  }

  // ---------------------------------------------------------------------------
  // Beginner / Advanced
  // ---------------------------------------------------------------------------

  function readAdvanced() {
    try { return window.localStorage?.getItem(KEY_VIEW) === 'advanced'; } catch { return false; }
  }

  function isAdvanced() { return state.advanced; }

  /**
   * A PRESENTATION MODE, not a second application.
   *
   * Advanced changes nothing about what runs: it reveals the blocks already marked `data-advanced-only` (the
   * Evidence technical drawer, the raw Diff panel, the ids, the resolved permission values and the loop
   * limits) through the `advanced` class on `body`, and nothing else. The markers live where the markup is,
   * so the set of advanced surfaces is declared there rather than in a list here that would drift.
   */
  function setAdvanced(on) {
    state.advanced = on === true;
    document.body.classList.toggle('advanced', state.advanced);
    try { window.localStorage?.setItem(KEY_VIEW, state.advanced ? 'advanced' : 'basic'); } catch { /* private mode */ }
    const hint = $('guidedViewHint');
    if (hint) hint.textContent = state.advanced ? tr('view.basic') : tr('view.advanced');
    const box = $('guidedViewAdvanced');
    if (box) box.checked = state.advanced;
  }

  function installAdvancedToggle() {
    if ($('guidedAdvancedToggle')) return;
    const bar = $('bar');
    if (!bar) return;
    const host = document.createElement('label');
    host.id = 'guidedAdvancedToggle';
    host.className = 'guided-advanced-toggle inline';
    host.title = tr('view.advanced');
    host.setAttribute('data-i18n-title', 'view.advanced');
    host.innerHTML = `<input type="checkbox" id="guidedViewAdvanced">
      <span id="guidedViewHint">${esc(tr('view.advanced'))}</span>`;

    /**
     * The tour has to be re-openable, or a user who skipped it has no way back to the explanation of what
     * the four panels are. It is a button beside the mode switch rather than a new menu: the bar is where a
     * user looks for this, and Help is one of the two things it holds.
     */
    const help = document.createElement('button');
    help.type = 'button';
    help.id = 'guidedHelpOpen';
    help.className = 'small ghost';
    help.setAttribute('data-i18n', 'onboarding.reopen');
    help.textContent = tr('onboarding.reopen');
    help.onclick = () => openOnboarding();

    const right = bar.querySelector('.bar-right') ?? bar;
    right.appendChild(help);
    right.appendChild(host);
    const box = $('guidedViewAdvanced');
    if (box) {
      box.checked = state.advanced;
      box.onchange = () => setAdvanced(box.checked);
    }
  }

  // ---------------------------------------------------------------------------
  // Cost report
  // ---------------------------------------------------------------------------

  /**
   * "What this run used" - counts that were MEASURED, and an explicit refusal to guess at the rest.
   *
   * WHY THIS IS A SEPARATE PANEL FROM THE EVIDENCE CARD. The card answers "can I trust this result". This
   * answers "what did it cost", which is a different question with a different failure mode: a cost report
   * that invents a number is not merely wrong, it is the kind of wrong that gets quoted as a measurement in
   * the next planning meeting. So every row here is a COUNT the workbench actually performed, and the token
   * row says `not measured` because nothing in this stack reports token usage - the ChatGPT worker is driven
   * through a browser and no provider returns usage to us.
   *
   * The counts come from the goal record the server keeps, not from anything computed here.
   */
  function costReportHtml(report) {
    if (!report) return '';
    const rows = [
      ['cost.supervisorTurns', report.supervisor_turns],
      ['cost.workerTurns', report.worker_turns],
      ['cost.reviewerTurns', report.reviewer_turns],
      ['cost.subagents', report.subagents_used],
      ['cost.retries', report.retries],
      ['cost.validationTier', report.validation_tier],
      ['cost.elapsed', Number.isFinite(report.elapsed_ms) ? `${Math.round(report.elapsed_ms / 1000)}s` : null],
    ].filter(([, v]) => v !== null && v !== undefined && v !== '');

    return `<div class="guided-cost">
      <h3>${esc(tr('cost.heading'))}</h3>
      <dl class="kv">
        <dt>${esc(tr('intensity.heading'))}</dt>
        <dd>${esc(report.execution_intensity_label_key ? tr(report.execution_intensity_label_key) : '')}
          <span class="mono small">${esc(String(report.execution_intensity ?? 'n/a'))}</span></dd>
        ${rows.map(([k, v]) => `<dt>${esc(tr(k))}</dt><dd>${esc(String(v))}</dd>`).join('')}
        <dt>${esc(tr('cost.tokens'))}</dt><dd class="muted">${esc(tr('cost.tokensNote'))}</dd>
      </dl>
      <p class="hint small">${esc(tr('preview.noTokenEstimate'))}</p>
    </div>`;
  }

  /**
   * Put the cost report on the goal panel, once a goal exists.
   *
   * It ASKS the server for this goal's own numbers rather than computing anything here: the intensity the goal
   * was submitted under is read back from its record, so a later change to the presets cannot rewrite what a
   * past run cost. On a goal with no guided policy the report is absent, because there is no intensity to
   * report and inventing "BALANCED" for an unguided run would be a fabricated fact.
   */
  let costSeq = 0;
  async function decorateCostReport() {
    const box = $('goalStatus');
    if (!box) return;
    const existing = $('guidedCostReport');
    if (existing) existing.remove();
    const g = window.AWBAppState?.lastGoal?.() ?? null;
    if (!g?.goal_id) return;
    const seq = ++costSeq;
    try {
      const r = await getJson(`/api/goal/cost?goalId=${encodeURIComponent(g.goal_id)}`);
      if (seq !== costSeq) return;
      if (!r?.cost?.execution_intensity) return;
      const html = costReportHtml(r.cost);
      if (!html) return;
      const wrap = document.createElement('div');
      wrap.innerHTML = html;
      const node = wrap.firstElementChild;
      if (!node) return;
      node.id = 'guidedCostReport';
      node.setAttribute('data-advanced-only', '');
      box.appendChild(node);
    } catch { /* a cost report is an extra; its absence must not break the goal panel */ }
  }

  // ---------------------------------------------------------------------------
  // Re-rendering material owned by the app
  // ---------------------------------------------------------------------------

  /**
   * Add the plain-language stop state and the Evidence summary to the app's own panels.
   *
   * These are DECORATIONS on existing surfaces, inserted into a container the app also writes. They are
   * re-applied after every render rather than owning the panel, so the app stays the single author of its
   * own markup, and they are idempotent by id so a repeated call cannot stack them.
   */
  function decorateGoalStatus() {
    const box = $('goalStatus');
    if (!box) return;
    const existing = $('guidedStopState');
    if (existing) existing.remove();
    // The app's own last goal, read through the one accessor it publishes. No second copy of the goal list
    // is kept here, so this can never describe a different goal than the panel it is decorating.
    const g = window.AWBAppState?.lastGoal?.() ?? null;
    const html = stopStateHtml(g?.status);
    if (!html) return;
    const div = document.createElement('div');
    div.id = 'guidedStopState';
    div.innerHTML = html;
    box.appendChild(div.firstElementChild);
  }

  function decorateEvidence() {
    const host = $('evidenceCard');
    if (!host) return;
    /**
     * IDEMPOTENCE, AND WHY THE OBVIOUS VERSION WAS NOT.
     *
     * This used to build the summary in a temporary `<div>`, set that div's id, then insert `firstElementChild`
     * - which is the INNER element, `div.guided-evsummary`, NOT the temp div that carried the id. So
     * `$('guidedEvSummary')` never matched anything, the guard never fired, and every refresh inserted another
     * copy. `renderCard` runs on every protocol refresh and on every language switch, so the Evidence panel
     * accumulated a stack of summaries - each one correct, which is why it looked fine until the ids were
     * actually checked.
     *
     * Now the id is set on the node that is really inserted, and the duplicate sweep matches BOTH the id and
     * the class so a copy left by an older build is cleared too.
     */
    host.querySelectorAll('#guidedEvSummary, .guided-evsummary').forEach((n) => n.remove());
    const html = evidenceSummaryHtml(state.card);
    if (!html) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const node = wrap.firstElementChild;
    if (!node) return;
    node.id = 'guidedEvSummary';
    host.insertBefore(node, host.firstChild);
  }

  // ---------------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------------

  /** Re-render everything this layer owns. Called on mount, on a language change, and on any selection. */
  function refresh() {
    renderPicker();
    renderEmpty();
    installAdvancedToggle();
    setAdvanced(state.advanced);
    attachAllHelp();
    decorateGoalStatus();
    decorateEvidence();
    decorateCostReport();
  }

  /**
   * Called whenever the app's context may have changed.
   *
   * The write scope the preview resolves against comes from the selected workspace, so a project or workspace
   * change invalidates it. Re-resolving here is what keeps the preview honest: a stale preview would describe
   * the permissions of a workspace the goal is no longer going to run in.
   */
  let lastScopeKey = null;
  function onContextMaybeChanged() {
    const key = `${window.AWBAppState?.projectId?.() ?? ''}|${window.AWBAppState?.workspaceId?.() ?? ''}`;
    renderEmpty();
    if (key === lastScopeKey) return;
    lastScopeKey = key;
    loadPreview();
  }

  /**
   * Start the guided layer.
   *
   * There is no submit function handed in any more, and that is deliberate. The app's `submitGoal` reads
   * `GuidedUI.submitChoices()` itself, so the choices travel through the ONE submit path that already exists
   * instead of through a wrapper around it - a wrapper could be bypassed by Ctrl+Enter, or by any future
   * caller, and then a guided user would silently get an unguided run.
   *
   * `opts` is accepted but unused, so a caller written against the previous signature still works.
   */
  function mount(opts = {}) {
    void opts;
    injectStyle();

    state.advanced = readAdvanced();
    // The goal box as the user left it, not as a template: an untouched box must not trigger the replace
    // confirmation on the first card click.
    state.templateText = currentGoalText();

    // The catalogue is read once; every preview after that is a server resolve of the current choices.
    loadCatalogue()
      .then(() => { renderPicker(); renderEmpty(); return loadPreview(); })
      .catch((e) => {
        state.previewError = String(e && e.message ? e.message : e);
        renderPicker();
      });

    refresh();

    const box = goalBox();
    if (box) {
      box.addEventListener('input', () => renderEmpty());
      // Ctrl+Enter already submits through app.js, so this only keeps the empty screen in step with the box.
    }

    const status = $('goalStatus');
    if (status && typeof MutationObserver === 'function') {
      // The app shows and hides this element as a goal progresses, and that is the only signal that a goal is
      // running. Observing it is cheaper and more honest than polling, and a guard above keeps the empty
      // screen off while a goal is live.
      new MutationObserver(() => {
        try { renderEmpty(); decorateGoalStatus(); decorateCostReport(); onContextMaybeChanged(); } catch (e) { console.warn('[guided] refresh failed', e); }
      }).observe(status, { attributes: true, childList: true, subtree: true });
    }

    /**
     * The selected context can change without any DOM signal this layer can watch: the workspace list is
     * re-rendered with new elements, and `#midBody`'s class stops changing once a context exists at all.
     * Measured: with the previous version, choosing a project and then a workspace left the preview showing the
     * scope of NO workspace while the server resolved the real one - so "ask before write" displayed an empty
     * approval list and the user was shown a permission the run would not have.
     *
     * So there are two triggers, and both are cheap: the app's own event when it re-renders the context, and a
     * slow poll as a backstop for any path that does not raise it. The poll compares a key and does nothing
     * when it is unchanged, so it costs one string comparison per second.
     */
    document.addEventListener('awb:context', () => {
      try { onContextMaybeChanged(); } catch (e) { console.warn('[guided] context refresh failed', e); }
    });
    setInterval(() => {
      try { onContextMaybeChanged(); } catch { /* transient during a render */ }
    }, 1000);

    // Clicking anywhere outside the popover closes it; Esc closes it too, which is what a `?` panel owes a
    // keyboard user.
    document.addEventListener('click', (e) => {
      if (!e.target?.closest?.('.guided-popover, .guided-help')) closeHelp();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHelp(); });

    state.mounted = true;
    // Shown on a first visit, and on the first visit after the tour itself changes. Not on every visit, and
    // not only when a localStorage key happens to be absent.
    if (!isOnboarded()) openOnboarding();
    return window.GuidedUI;
  }

  /** The choices, as `/api/goal/submit` expects them. Read by the app's submit path, never sent by this file. */
  function submitChoices() {
    if (!state.presetId && !state.filePolicy) return null;
    const g = {};
    if (state.presetId) g.presetId = state.presetId;
    if (state.filePolicy) g.filePolicy = state.filePolicy;
    if (state.autonomy) g.autonomy = state.autonomy;
    if (state.reviewPolicy) g.reviewPolicy = state.reviewPolicy;
    // Sent as the canonical value. The server resolves it and does not read this file's copy of the policy.
    if (state.intensity) g.executionIntensity = state.intensity;
    return g;
  }

  window.GuidedUI = {
    mount, refresh, openOnboarding, openHelp, isAdvanced, setAdvanced,
    submitChoices, stopStateHtml, evidenceSummaryHtml,
    /**
     * Test seams. These exist so a browser check can ask WHY a control is missing instead of inferring it from
     * a selector count - which is how the intensity control stayed invisible through several probe cycles while
     * every visible symptom said only "0 rows".
     */
    controlDefs: () => controlDefs(policySets()).map((d) => ({ field: d.field, values: d.values })),
    policySets,
    /** Called by the app once the box has been cleared, so the next template click may fill it freely. */
    clearTemplateText: () => { state.templateText = ''; },
    /** Called by the protocol layer with the Evidence Card it just rendered, so the summary reads real fields. */
    onEvidenceCard: (card) => { state.card = card ?? null; decorateEvidence(); },
    /** Test seam: the last policy the SERVER resolved, for asserting the UI and the run agree. */
    resolvedPolicy: () => state.resolved,
    /**
     * Test seams for the control catalogue.
     *
     * These exist because a browser check could otherwise only report "0 rows" and leave the cause unknown -
     * which is exactly what happened for several probe cycles while the real answer was "the control was built
     * from the preview, which had not arrived yet". Asking the module directly turns a symptom into a fact.
     */
    policySets: () => policySets(),
    controlDefs: () => controlDefs(policySets()).map((d) => ({ field: d.field, values: d.values })),
  };

  // The engine fires this on every language switch, so no label here can be left in the previous language.
  // The hook is claimed as soon as this file runs, before the first render, so a switch during startup is
  // not missed.
  window.I18N?.onChange(() => { if (state.mounted) refresh(); });
})();
