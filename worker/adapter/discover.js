'use strict';
/**
 * discover.js - PHASE 3 real-page calibration probe.
 *
 * PURPOSE
 *   Populate the selector registry from the REAL page. Nothing here is inferred from
 *   documentation or memory; the script reports what is actually in the DOM, so every
 *   `verified` status in selectors.json is evidence-backed.
 *
 * WHAT IT COLLECTS
 *   1. candidate resolution per selector group (which candidate matched, how many visible)
 *   2. an inventory of semantic anchors: data-testid, aria-label, data-message-*
 *   3. composer facts (tag, contenteditable, ids, classes)
 *   4. role=button / role=link labels, so UI affordances can be identified by name
 *   5. the assistant body's shape inside the last assistant turn
 *   6. blocking-state text matches
 *
 * SAFETY
 *   Read-only: it never types, clicks, or navigates. It cannot trigger a send, a
 *   regeneration, or any account action.
 *
 * NOTE ON MESSAGE SELECTORS
 *   Turn and body selectors cannot be confirmed on an empty page - everything reports
 *   "no match", which proves nothing. Verify those with calibrate-messages.js after a
 *   conversation actually has turns.
 *
 * Usage: node discover.js [--out <file>]
 */

const fs = require('node:fs');

const { SELECTORS, compose, runCode, RESOLVE_SRC } = require('./lib.js');
const { detectState } = require('./state.js');

/** Every registry group that carries a candidate list, keyed for the probe. */
function registryGroups() {
  return Object.fromEntries(
    Object.entries(SELECTORS)
      .filter(([, v]) => v && typeof v === 'object' && Array.isArray(v.candidates))
      .map(([k, v]) => [k, v.candidates]),
  );
}

const PROBE = compose({
  groups: registryGroups(),
  stripBody: SELECTORS.stripFromBody.tagGroup,
  loginPatterns: SELECTORS.blockingStateText.loginRequired.patterns,
  captchaPatterns: SELECTORS.blockingStateText.captcha.patterns,
  ratePatterns: SELECTORS.blockingStateText.rateLimit.patterns,
  errorPatterns: SELECTORS.blockingStateText.errorFatal.patterns,
  contextPatterns: SELECTORS.blockingStateText.contextWarning.patterns,
}, `
  const tagGroups = args.tagGroups;
  const vis = el => __CW.isVisible(el);

  const resolveOne = (c, root) => {
    const scope = root || document;
    let els = [];
    try {
      if (c.kind === 'css') els = Array.from(scope.querySelectorAll(c.value));
      else if (c.kind === 'self') return [scope];
      else if (c.kind === 'role') {
        const tags = tagGroups[c.role] || tagGroups.any;
        els = Array.from(scope.querySelectorAll(tags)).filter(el => {
          const al = el.getAttribute('aria-label') || '';
          const tx = (el.textContent || '').trim();
          const nm = c.name || '';
          return al === nm || tx === nm || al.includes(nm) || tx.includes(nm);
        });
      }
    } catch (e) { return null; }
    return els;
  };

  // 1. semantic attribute inventory
  const tally = (sel, attr) => {
    const out = {};
    for (const el of document.querySelectorAll(sel)) {
      if (!vis(el)) continue;
      const k = el.getAttribute(attr);
      if (k) out[k] = (out[k] || 0) + 1;
    }
    return out;
  };
  const testIds = tally('[data-testid]', 'data-testid');

  // 2. controls by accessible name
  const controls = [];
  for (const el of document.querySelectorAll(tagGroups.button + ',' + tagGroups.link)) {
    if (!vis(el)) continue;
    controls.push({
      role: el.tagName === 'A' ? 'link' : 'button',
      label: el.getAttribute('aria-label') || '',
      text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 50),
      testid: el.getAttribute('data-testid') || '',
      disabled: !!el.disabled,
    });
  }

  // 3. composer facts
  const composers = [];
  for (const el of document.querySelectorAll(tagGroups.textbox)) {
    if (!vis(el)) continue;
    composers.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      cls: String(el.className || '').slice(0, 80),
      ariaLabel: el.getAttribute('aria-label') || '',
      testid: el.getAttribute('data-testid') || '',
      editable: el.getAttribute('contenteditable') || '',
    });
  }

  // 4. candidate resolution, using the SAME resolver the adapter uses
  const resolution = {};
  for (const [gk, cands] of Object.entries(args.groups)) {
    resolution[gk] = cands.map(c => {
      if (c.kind === 'self') {
        return { kind: c.kind, value: '(self)', status: c.status, matched: -1, visible: -1 };
      }
      const els = resolveOne(c);
      if (els === null) {
        return { kind: c.kind, value: c.value ?? c.name ?? '', status: c.status, matched: -1, visible: -1 };
      }
      return { kind: c.kind, value: c.value ?? c.name ?? '', status: c.status,
               matched: els.length, visible: els.filter(vis).length };
    });
  }

  // 5. assistant body shape inside the last assistant turn
  let bodyShape = null;
  const aCands = args.groups.assistantTurn || [];
  let turns = [];
  for (const c of aCands) { const e = resolveOne(c); if (e && e.length) { turns = e; break; } }
  const lastTurn = __CW.last(turns);
  if (lastTurn) {
    let bodyEl = null;
    for (const c of args.groups.assistantBody || []) {
      const e = resolveOne(c, lastTurn);
      if (e && e.length) { bodyEl = e[0]; break; }
    }
    bodyShape = {
      turnTag: lastTurn.tagName.toLowerCase(),
      turnAttrs: Array.from(lastTurn.attributes).map(a => a.name),
      bodyFound: !!bodyEl,
      bodyTag: bodyEl ? bodyEl.tagName.toLowerCase() : null,
      bodyChildTags: bodyEl
        ? Array.from(new Set(Array.from(bodyEl.querySelectorAll('*')).map(e => e.tagName.toLowerCase()))).slice(0, 30)
        : [],
      hardcodedClassHashes: bodyEl
        ? Array.from(bodyEl.classList).filter(c => /_[A-Za-z0-9]{5,}|^[a-z]+-[0-9a-f]{6,}$/.test(c))
        : [],
      buttonsInsideBody: bodyEl ? bodyEl.querySelectorAll(args.stripBody).length : 0,
      structuredTextChars: bodyEl ? __CW.structuredText(bodyEl).length : 0,
      sample: bodyEl ? __CW.structuredText(bodyEl).slice(0, 300) : '',
    };
  }

  // 6. blocking text
  const txt = __CW.visibleText().toLowerCase();
  const hit = (arr) => arr.filter(p => txt.includes(p.toLowerCase()));

  return {
    url: __CW.url(),
    isConversation: __CW.isConversationUrl(),
    title: document.title,
    testIds,
    assistantTurnCount: turns.length,
    controls: controls.slice(0, 60),
    composers,
    resolution,
    bodyShape,
    blocking: {
      loginRequired: hit(args.loginPatterns),
      captcha: hit(args.captchaPatterns),
      rateLimit: hit(args.ratePatterns),
      errorFatal: hit(args.errorPatterns),
      contextWarning: hit(args.contextPatterns),
    },
  };
`);

async function main() {
  const outFlag = process.argv.indexOf('--out');
  const outFile = outFlag >= 0 ? process.argv[outFlag + 1] : null;

  const state = await detectState();
  const r = runCode(PROBE);

  const report = {
    generatedAt: new Date().toISOString(),
    detectedState: state,
    probeOk: r.ok,
    probeError: r.error ?? null,
    evidence: r.ok ? r.value : null,
  };

  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');

  // A compact summary on stderr keeps stdout pure JSON.
  if (r.ok && r.value) {
    const v = r.value;
    process.stderr.write('\n--- calibration summary ---\n');
    process.stderr.write(`state: ${state.state}\n`);
    process.stderr.write(`url: ${v.url}\n`);
    process.stderr.write(`assistant turns: ${v.assistantTurnCount}\n`);
    for (const [gk, rows] of Object.entries(v.resolution ?? {})) {
      const win = rows.find((x) => x.visible > 0);
      process.stderr.write(`  ${gk}: ${win ? `MATCH ${win.kind}:${win.value} (${win.visible})` : 'NO MATCH'}\n`);
    }
    process.stderr.write(`  composers: ${JSON.stringify(v.composers)}\n`);
  }
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.stack ? e.stack : e) }, null, 2) + '\n');
  process.exit(1);
});
