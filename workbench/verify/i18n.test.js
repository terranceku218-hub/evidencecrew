'use strict';
/**
 * i18n.test.js - the localisation suite.
 *
 * WHAT THIS PROTECTS
 *   A UI in four languages has four ways to be wrong, and none of them show up as a crash:
 *
 *     1. a key that exists in English and nowhere else, which silently renders English in a Chinese UI
 *     2. a canonical machine value that gets translated, which breaks the product's central promise that
 *        the receipt says what the protocol actually wrote
 *     3. a mark whose meaning drifts: "not recorded" quietly becoming "unknown" or "failed"
 *     4. a key the UI asks for that nobody ever defined, which renders [MISSING: key] on screen
 *
 *   Each is asserted directly. The suite runs with no browser: the engine is a plain script that attaches
 *   itself to `window`, so a small shim is enough to exercise the real code rather than a copy of it.
 */

const path = require('node:path');
const fs = require('node:fs');

const WB = path.resolve(__dirname, '..', '..', 'workbench');
const PUBLIC_DIR = path.join(WB, 'public');
const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja'];

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name} :: ${detail}`); console.log(`  FAIL  ${name} :: ${detail}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

/** Load the engine and every catalogue into a fake browser global. */
function loadEngine(storage = {}) {
  const g = global;
  g.window = g;
  g.localStorage = {
    _v: { ...storage },
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
    setItem(k, v) { this._v[k] = String(v); },
  };
  g.document = undefined;
  delete require.cache[require.resolve(path.join(PUBLIC_DIR, 'i18n', 'index.js'))];
  require(path.join(PUBLIC_DIR, 'i18n', 'index.js'));
  for (const l of LOCALES) {
    const p = path.join(PUBLIC_DIR, 'i18n', 'locales', `${l}.js`);
    delete require.cache[require.resolve(p)];
    require(p);
  }
  return g.I18N;
}

/** Read a catalogue's key set straight from the source file, so a broken locale cannot hide behind the API. */
function keysOf(locale) {
  const src = fs.readFileSync(path.join(PUBLIC_DIR, 'i18n', 'locales', `${locale}.js`), 'utf8');
  return new Set([...src.matchAll(/^\s*'([a-zA-Z0-9_.]+)':/gm)].map((m) => m[1]));
}
function valuesOf(locale) {
  const src = fs.readFileSync(path.join(PUBLIC_DIR, 'i18n', 'locales', `${locale}.js`), 'utf8');
  const out = {};
  for (const m of src.matchAll(/^\s*'([a-zA-Z0-9_.]+)':\s*'((?:[^'\\]|\\.)*)'/gm)) out[m[1]] = m[2];
  return out;
}

const I18N = loadEngine();

// ======================================================================
section('A. Every locale has the same key set as English');
{
  const base = keysOf('en');
  check('the English catalogue is not empty', base.size > 100, `${base.size} keys`);
  for (const locale of LOCALES) {
    const keys = keysOf(locale);
    const missing = [...base].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !base.has(k));
    check(`${locale}: no missing keys`, missing.length === 0, `${missing.length} missing, e.g. ${missing.slice(0, 5).join(', ')}`);
    // Extra keys are allowed but reported: they usually mean a rename that missed one file.
    if (extra.length) console.log(`  WARN  ${locale}: ${extra.length} extra key(s): ${extra.slice(0, 5).join(', ')}`);
    check(`${locale}: key count matches English`, keys.size === base.size, `${keys.size} vs ${base.size}`);
  }
  check('the engine reports no gaps for any locale',
    LOCALES.every((l) => I18N.gaps(l).length === 0),
    JSON.stringify(LOCALES.map((l) => [l, I18N.gaps(l).length])));
}

// ======================================================================
section('A2. A translation must not FLATTEN a distinction English draws');
{
  /**
   * WHY THIS EXISTS, AND WHY IT IS NOT HYPOTHETICAL
   *
   * Two keys that mean different things in English must not come out as the SAME string in another language,
   * because the interface can show both at once. That is exactly what happened to Japanese in this milestone:
   * `ev.summary.absent` ("N item(s) were not recorded", from element MARKS) and `ev.summary.missing` ("N never
   * recorded", from `missing_evidence`) were both rendered as "{count} 件が記録されていません", and `guided.js`
   * pushes all four summary counts into ONE paragraph - so a real card displayed the identical line twice and
   * the reader could not tell a not-recorded mark from a missing-evidence entry.
   *
   * NO SINGLE-LOCALE REVIEW CAN CATCH THIS. Every locale passed key-completeness, placeholder parity and
   * "is it translated" checks. It was found by printing the same keys across four languages side by side. So
   * the check is mechanical: for every pair of distinct keys whose ENGLISH values differ, the locale values
   * must differ too.
   *
   * Deliberate collisions are allowed through ALLOWED, one entry per collision with its reason. The list is
   * short and every item is a case where English differs only in CASE or in grammatical role - the same
   * sentence doing two jobs - rather than in meaning. Anything not on the list fails, so a NEW flattened
   * distinction has to be argued for in a diff instead of shipping unnoticed.
   */
  /**
   * Pairs that legitimately share a value, declared explicitly and PAIRWISE.
   *
   * Every one of these is a case where English differs only in CASE, in grammatical role, or in the singular
   * label a role already carries elsewhere - the same sentence doing two jobs rather than two different facts.
   * They are declared one pair at a time instead of as a family, so that adding a key to a family later cannot
   * inherit an exemption it was never granted.
   *
   * These are all PRE-EXISTING: they shipped in V0.3.2 and earlier, and none of them is an Evidence-summary
   * count that can collide inside a single sentence. The two that COULD do that - `ev.summary.absent` vs
   * `ev.summary.missing`, and `ev.summary.bad` vs `ev.summary.warnings` - were the real defect this check was
   * written for, and they are now worded apart in Japanese rather than listed here.
   */
  const SAME_MEANING_PAIRS = [
    // "Not recorded" - one phrase, used as a mark legend, a table cell, a verdict and a run note.
    ['evidence.notRecorded', 'evidence.missing'],
    ['evidence.notRecorded', 'mark.absent'],
    ['evidence.notRecorded', 'run.notRecorded'],
    ['evidence.notRecorded', 'evidence.verdict.absent'],
    ['evidence.missing', 'mark.absent'],
    ['evidence.missing', 'run.notRecorded'],
    ['evidence.missing', 'evidence.verdict.absent'],
    ['mark.absent', 'run.notRecorded'],
    ['mark.absent', 'evidence.verdict.absent'],
    ['run.notRecorded', 'evidence.verdict.absent'],
    // "Confirmed" / "Acknowledged" - the same verdict shown as a headline and as a row.
    ['evidence.verdict.ok', 'evidence.element.run_correlation.ok'],
    ['evidence.verdict.ok', 'evidence.element.source_ack.ok'],
    ['evidence.element.run_correlation.ok', 'evidence.element.source_ack.ok'],
    // "Disabled by policy" / "Off by policy" - one configured choice, phrased as a state and as a seat note.
    ['seat.disabled.policy', 'status.disabled_by_policy'],
    ['seat.disabled.policy', 'evidence.element.independent_review.na'],
    ['status.disabled_by_policy', 'evidence.element.independent_review.na'],
    // "Independent review" as a label and as a lowercase note.
    ['evidence.review.independent', 'run.independentReview'],
    // ja only: 完了 for Complete / Completed / Done, which English separates only by verb form.
    ['status.complete', 'status.completed'],
    ['status.complete', 'status.done'],
    ['status.completed', 'status.done'],
    // "read-only" as a permission label and "Read-only" as the verdict for a zero write scope.
    ['seat.permissions.readOnly', 'evidence.element.write_scope.na'],
    // Unrelated English words that share one translation, which is correct: "OFF" vs "Close" are both 关闭,
    // "none" vs "None" differ only in case, and a panel named Run vs a button named Start are both 実行 in ja.
    ['codex.off', 'common.close'],
    ['common.none', 'status.none'],
    ['panel.run', 'goal.submit'],
    /**
     * V0.3.4 intensity. Three kinds of cross-context repeat, each declared rather than waved through.
     *
     * 1. The MODE name and the BAND word for the same degree. "Strict" is the chosen intensity;
     *    "Validation: 厳格" is the band in a measurement sentence. The prefix `Validation:` carries the
     *    distinction, and forcing two different words for one degree would be worse, not clearer. The
     *    reverse case WAS a real defect and was fixed instead of declared: `intensity.balanced` and
     *    `band.moderate` were both 標準, and 標準 was also `band.standard` - one word doing three jobs in a
     *    single panel - so the mode label moved off the band vocabulary (`ふつう`).
     * 2. `band.moderate` and `band.standard` are the same word on purpose: for AI calls 標準 is the middle of
     *    few/moderate/many, and for validation 標準 is the middle of basic/standard/strict. The sentences are
     *    "AI calls: 標準" and "Validation: 標準", and one word for one degree is correct.
     * 3. A budget label and a cost-report row for the same quantity ("subagents", "validation tier"), and a
     *    review count against the review-verdict label. These appear in different panels and name the same
     *    thing, which is consistency rather than a flattened distinction.
     */
    ['intensity.strict', 'band.strict'],
    ['band.moderate', 'band.standard'],
    ['intensity.subagents', 'cost.subagents'],
    ['intensity.validationTier', 'cost.validationTier'],
    ['intensity.reviews', 'evidence.review.supervisor'],
    ['intensity.reviews', 'status.supervisor_review'],
    ['evidence.review.supervisor', 'status.supervisor_review'],
  ];
  const allowedPair = (a, b) => SAME_MEANING_PAIRS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

  const en = valuesOf('en');
  const enKeys = Object.keys(en);
  for (const locale of LOCALES) {
    if (locale === 'en') continue;
    const vals = valuesOf(locale);
    const byValue = new Map();
    for (const k of enKeys) {
      const v = String(vals[k] ?? '');
      if (!v.trim()) continue;
      if (!byValue.has(v)) byValue.set(v, []);
      byValue.get(v).push(k);
    }
    const unexplained = [];
    for (const [value, ks] of byValue) {
      if (ks.length < 2) continue;
      // Does English draw a distinction here? If every English value is identical, there is nothing to flatten.
      if (new Set(ks.map((k) => en[k])).size === 1) continue;
      const pairs = [];
      for (let i = 0; i < ks.length; i += 1) {
        for (let j = i + 1; j < ks.length; j += 1) pairs.push([ks[i], ks[j]]);
      }
      const bad = pairs.filter(([a, b]) => !allowedPair(a, b));
      if (bad.length) unexplained.push({ value, keys: ks, bad });
    }
    check(`${locale}: no flattened distinction beyond the declared ones`,
      unexplained.length === 0,
      unexplained.map((u) => `${JSON.stringify(u.value)} collapses ${u.bad.map(([a, b]) => `${a}=${b}`).join(' / ')}`).join(' ; '));
    if (unexplained.length) {
      for (const u of unexplained) {
        console.log(`       value ${JSON.stringify(u.value)} is used by ${u.keys.join(', ')}`);
        for (const [a, b] of u.bad) console.log(`         ${a} (${JSON.stringify(en[a])}) vs ${b} (${JSON.stringify(en[b])})`);
      }
    }
  }
  /**
   * Staleness guard, written per-locale rather than across all locales.
   *
   * A declared pair that collides in NO locale is an exemption nobody needs, and leaving it in place invites
   * the next reader to assume it still describes something. `status.complete` and `status.done` collide only in
   * Japanese, `panel.run` and `goal.submit` only in Japanese, and `codex.off` and `common.close` in the two
   * Chinese catalogues - so requiring a collision in EVERY locale would flag three correct entries as stale.
   */
  const stalePairs = SAME_MEANING_PAIRS.filter(([a, b]) =>
    !LOCALES.some((l) => { const v = valuesOf(l); return v[a] === v[b]; }));
  check('every declared same-meaning pair still collides somewhere',
    stalePairs.length === 0,
    `stale: ${stalePairs.map(([a, b]) => `${a}=${b}`).join(', ')}`);
}

// ======================================================================
section('B. Language detection and persistence');
{
  const cases = [
    [['zh-CN'], 'zh-CN'], [['zh-SG'], 'zh-CN'], [['zh-Hans'], 'zh-CN'], [['zh'], 'zh-CN'],
    [['zh-TW'], 'zh-TW'], [['zh-HK'], 'zh-TW'], [['zh-MO'], 'zh-TW'], [['zh-Hant'], 'zh-TW'],
    [['ja'], 'ja'], [['ja-JP'], 'ja'], [['en'], 'en'], [['en-GB'], 'en'],
  ];
  for (const [nav, want] of cases) {
    check(`navigator ${nav[0]} resolves to ${want}`, I18N.resolveLocale(null, nav) === want, I18N.resolveLocale(null, nav));
  }
  check('a Hong Kong browser does NOT get Simplified Chinese',
    I18N.resolveLocale(null, ['zh-HK']) === 'zh-TW', I18N.resolveLocale(null, ['zh-HK']));
  check('an unmapped browser language falls back to the build default (zh-CN)',
    I18N.resolveLocale(null, ['de-DE']) === 'zh-CN', I18N.resolveLocale(null, ['de-DE']));
  check('a saved choice beats the browser language',
    I18N.resolveLocale('ja', ['zh-CN']) === 'ja', I18N.resolveLocale('ja', ['zh-CN']));
  check('an unknown saved value is ignored rather than trusted',
    I18N.resolveLocale('klingon', ['ja']) === 'ja', I18N.resolveLocale('klingon', ['ja']));

  // Persistence through the real engine, against a fake localStorage.
  const engine = loadEngine({});
  engine.setLocale('ja', { persist: true, render: false });
  check('a deliberate switch is written to localStorage',
    global.localStorage.getItem(engine.STORAGE_KEY) === 'ja', String(global.localStorage.getItem(engine.STORAGE_KEY)));
  check('a fresh load reads the saved choice back',
    loadEngine({ [engine.STORAGE_KEY]: 'ja' }).detect() === 'ja', 'saved choice not honoured');

  const engine2 = loadEngine({});
  engine2.setLocale(engine2.detect(), { persist: false, render: false });
  check('detecting a language does NOT write it as a user choice',
    global.localStorage.getItem(engine2.STORAGE_KEY) === null, String(global.localStorage.getItem(engine2.STORAGE_KEY)));
}

// ======================================================================
section('C. Canonical machine values are never translated');
{
  const engine = loadEngine({});
  const canonical = [
    'GOAL_COMPLETE', 'BLOCKED', 'SEND_PENDING', 'SEND_UNCERTAIN', 'USER_TURN_CONFIRMED',
    'ASSISTANT_PENDING', 'IDLE', 'SUBMITTING', 'COMPLETE',
    'DISABLED_BY_POLICY', 'SUPERVISOR_REVIEW', 'INDEPENDENT_PROVIDER_REVIEW',
    'NOT_REQUESTED', 'REQUESTED', 'UNAVAILABLE', 'SATISFIED', 'NOT_SATISFIED',
    'VERIFIED', 'PARTIAL', 'UNVERIFIED', 'CORRELATED', 'LEGACY_RUN', 'IN_PROGRESS',
  ];
  for (const locale of ['zh-CN', 'zh-TW', 'ja', 'en']) {
    engine.setLocale(locale, { persist: false, render: false });
    let kept = 0;
    for (const value of canonical) {
      const r = engine.ts(value);
      if (r.canonical === value) kept += 1;
    }
    check(`${locale}: ts() returns the canonical value unchanged for all ${canonical.length} values`,
      kept === canonical.length, `${kept}/${canonical.length}`);
  }
  engine.setLocale('zh-CN', { persist: false, render: false });
  const gc = engine.ts('GOAL_COMPLETE');
  check('the Chinese display text is translated', gc.text === '目标已完成', gc.text);
  check('the canonical value is still available beside it', gc.canonical === 'GOAL_COMPLETE', gc.canonical);
  const unknown = engine.ts('SOME_FUTURE_STATE');
  check('an unknown protocol value is displayed as itself, never as a placeholder',
    unknown.text === 'SOME_FUTURE_STATE', unknown.text);
}

// ======================================================================
section('D. Evidence marks keep their meaning');
{
  const zh = valuesOf('zh-CN');
  const zhTW = valuesOf('zh-TW');
  const ja = valuesOf('ja');
  const en = valuesOf('en');

  check('en: "not recorded" is its own word', /not recorded/i.test(en['mark.absent']), en['mark.absent']);
  for (const [locale, values, forbidden] of [
    ['zh-CN', zh, ['未知', '失败', '缺失', '不确定']],
    ['zh-TW', zhTW, ['未知', '失敗', '缺失', '不確定']],
    ['ja', ja, ['不明', '失敗', '欠落']],
  ]) {
    const absent = values['mark.absent'];
    check(`${locale}: mark.absent is present`, Boolean(absent), 'missing key');
    for (const word of forbidden) {
      check(`${locale}: "not recorded" is NOT translated as ${word}`, !String(absent).includes(word), String(absent));
    }
    check(`${locale}: mark.na differs from mark.absent`, values['mark.na'] !== values['mark.absent'],
      `${values['mark.na']} vs ${values['mark.absent']}`);
    check(`${locale}: mark.ok differs from mark.bad`, values['mark.ok'] !== values['mark.bad'], 'same text');
  }

  check('en: DISABLED_BY_POLICY reads as a policy choice, not an error',
    !/error|fail|missing/i.test(en['status.disabled_by_policy']), en['status.disabled_by_policy']);
  check('zh-CN: DISABLED_BY_POLICY reads as a policy choice, not an error',
    !/错误|失败|缺失/.test(zh['status.disabled_by_policy']), zh['status.disabled_by_policy']);
  check('en: SEND_UNCERTAIN is a state, not a crash',
    !/crash|error/i.test(en['status.send_uncertain']), en['status.send_uncertain']);
}

// ======================================================================
section('E. Status vocabulary is complete in every locale');
{
  const required = [
    'goal_complete', 'blocked', 'send_pending', 'send_uncertain', 'disabled_by_policy',
    'supervisor_review', 'independent_provider_review', 'verified', 'partial', 'unverified',
    'correlated', 'idle', 'in_progress', 'todo', 'done', 'review', 'failed', 'active', 'archived',
  ];
  for (const locale of LOCALES) {
    const keys = keysOf(locale);
    const missing = required.filter((k) => !keys.has(`status.${k}`));
    check(`${locale}: every required status has a translation`, missing.length === 0, missing.join(', '));
  }

  // The engine's key derivation must match how the catalogue spells the keys, or every lookup misses.
  const engine = loadEngine({});
  engine.setLocale('ja', { persist: false, render: false });
  const jaValues = valuesOf('ja');
  const samples = [['GOAL_COMPLETE', 'goal_complete'], ['SEND_UNCERTAIN', 'send_uncertain'], ['DISABLED_BY_POLICY', 'disabled_by_policy'], ['IN_PROGRESS', 'in_progress']];
  for (const [value, key] of samples) {
    check(`ts('${value}') finds status.${key} rather than falling through`,
      engine.ts(value).text === jaValues[`status.${key}`], `${engine.ts(value).text} vs ${jaValues[`status.${key}`]}`);
  }
}

// ======================================================================
section('F. Every key the UI asks for exists');
{
  /**
   * `guided.js` is scanned too, and it was NOT before.
   *
   * That omission is why this suite reported 147 "dead" keys the moment the V0.3.3 layer landed: every
   * `preset.*`, `file.*`, `autonomy.*`, `review.*`, `preview.*`, `onboarding.*`, `help.*`, `guided.*` and
   * `example.*` string is referenced from the guided layer, and a scan that does not read that file sees the
   * whole vocabulary as unused. The check was measuring its own blind spot.
   *
   * Template-literal keys are collected as their PREFIX (`tr(\`help.${id}.title\`)` -> `help.`), because the
   * full key is only known at runtime. That is enough to stop the false "dead" report and is honest about what
   * a static scan can and cannot see.
   */
  const files = ['app.js', 'protocol-ui.js', 'guided.js'];
  const referenced = new Set();
  const dynamicPrefixes = new Set();
  for (const file of files) {
    const src = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    for (const m of src.matchAll(/\btr\('([^']+)'/g)) referenced.add(m[1]);
    // `tr(`help.${id}.title`)` and friends: record the literal prefix before the first interpolation.
    for (const m of src.matchAll(/\btr\(`([^`$]*)\$\{/g)) {
      const prefix = m[1];
      if (prefix) dynamicPrefixes.add(prefix);
    }
  }
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n[a-z-]*="([^"]+)"/g)) referenced.add(m[1]);

  check('the UI references a substantial number of keys', referenced.size > 80, `${referenced.size} keys`);
  const base = keysOf('en');
  const undefinedKeys = [...referenced].filter((k) => !base.has(k)).sort();
  check('every key the UI references is defined in the catalogue',
    undefinedKeys.length === 0, `${undefinedKeys.length}: ${undefinedKeys.slice(0, 8).join(', ')}`);

  // A literal key built by concatenation (`tr('file.' + value)`) is also a real reference.
  const reachable = (k) => referenced.has(k) || [...dynamicPrefixes].some((p) => k.startsWith(p))
    || declaredByUi.has(k) || declaredByServer.has(k);
  /** A .desc entry is reached as key + '.desc' in renderControl, a concatenation a static scan cannot follow. */

  /**
   * The option labels are reached as `key` and `key + '.desc'`.
   *
   * `renderControl` resolves one label key and then asks for its description with `${key}.desc`, so the
   * description keys are real catalogue entries reached through a string concatenation a static scan cannot
   * follow. Recording the suffix here is what stops `file.readOnly.desc` and its siblings being reported as
   * dead: they are rendered on every template card.
   */
  const uiDescReachable = (k) => k.endsWith('.desc') && declaredByUi.has(k.slice(0, -'.desc'.length));

  /**
   * Keys the UI is REQUIRED to reach, asserted by name.
   *
   * A count-based "unused keys" assertion was wrong here: several key families are built at runtime
   * (`tr(`evidence.element.${e.key}`)`, `tr(`seat.role.${s.role}`)`), so a static scan cannot see them and
   * reported a hundred keys as unused while they were on screen. Naming the keys that must be wired is both
   * checkable and meaningful, and the rest is reported as information rather than as a failure.
   */
  /**
   * THE V0.3.3 LAYER DOES NOT NAME MOST OF ITS KEYS LITERALLY, AND THAT IS THE POINT OF IT.
   *
   * The presets are served from `/api/goal/presets`, so `guided.js` writes `tr(p.title_key)` rather than
   * `tr('preset.inspect.title')` - the whole design is that the browser does not carry a copy of the
   * catalogue. A static scan of the UI therefore CANNOT see those keys, and an earlier version of this check
   * reported all 27 `preset.*` keys, plus `file.*`, `autonomy.*`, `review.*`, `preview.*`, `example.*` and
   * `plain.*`, as dead. They are on screen; the scan was blind to how they get there.
   *
   * So the keys that must exist are collected from the SOURCES THAT DECLARE them, which is checkable:
   *   - `protocol/guided-policy.js`, which names every `title_key`, `description_key`, `goal_template` and
   *     `example.goal` it serves - the server's own contract with the catalogue;
   *   - `guided.js`'s explicit value-to-label map and its preview/limit/stop-state keys, which are the only
   *     keys it names directly because they are presentation, not policy.
   */
  const policySrc = fs.readFileSync(path.join(WB, 'protocol', 'guided-policy.js'), 'utf8');
  const declaredByServer = new Set();
  /**
   * The server's contract with the catalogue, in BOTH of the shapes it uses.
   *
   * The PRESETS are OBJECT LITERALS, and they are camelCase (`title_key: 'preset.bugFix.title'`), while the
   * EXAMPES are `{ id, goal, preset }` where the catalogue key is the VALUE of `goal:`. The first version of
   * this pattern matched neither: it demanded `[^']+` after the colon with no camelCase allowance in the value,
   * and it assumed `preset.exampleLabel` existed so the example keys never showed up as missing. A pattern that
   * silently matches a third of the contract reports success while checking almost nothing.
   */
  for (const m of policySrc.matchAll(/\b(?:title_key|description_key|goal_template|goal):\s*'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)'/g)) {
    declaredByServer.add(m[1]);
  }
  // The preview lines the resolver emits as data.
  for (const m of policySrc.matchAll(/key:\s*'(preview\.[A-Za-z0-9_]+)'/g)) declaredByServer.add(m[1]);
  const guidedSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'guided.js'), 'utf8');
  const declaredByUi = new Set();
  /**
   * A quoted dotted string counts as a UI-declared key ONLY if it really is one.
   *
   * The question this set answers is "which catalogue keys does the UI name?", so the test is membership in
   * the catalogue - not a prefix list. A prefix list pulled in `file.read_only` and `review.codex_auto`, which
   * are POLICY VALUES and deliberately NOT catalogue keys (translating a machine value is the exact defect
   * this layer avoids), and reporting them as missing entries was a false alarm about a correct design.
   */
  for (const m of guidedSrc.matchAll(/'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)+)'/g)) {
    if (base.has(m[1])) declaredByUi.add(m[1]);
  }
  /**
   * Two sets of keys are built from PARTS and cannot be found by any literal scan, so they are named here WITH
   * the reason they are reachable, which is the honest way to assert them:
   *
   *   - the three control headings: `controlDefs` holds `heading: 'file.heading'` as a LITERAL, but the renderer
   *     reads it back as `tr(c.heading)`, so a scan sees the string without seeing the call;
   *   - the preview lines: `protocol/guided-policy.js` returns `{ key: 'preview.noWrite', state }` and the panel
   *     renders `tr(i.key)`, so the key arrives from the server as DATA.
   *
   * Both are exactly the indirection the design wants - the browser holds no copy of the catalogue - so the
   * test declares what it cannot trace instead of weakening the assertion.
   */
  for (const k of ['file.heading', 'autonomy.heading', 'review.heading']) declaredByUi.add(k);
  for (const m of policySrc.matchAll(/key:\s*'(preview\.[a-zA-Z0-9_]+)'/g)) declaredByServer.add(m[1]);

  /**
   * V0.3.4. The intensity catalogue declares its own label keys exactly as the presets do.
   *
   * `protocol/intensity.js` holds `title_key` and `description_key` for FAST/BALANCED/STRICT and serves them
   * through `/api/goal/presets`, so `guided.js` renders them as `tr(labelKey(o))` - a computed call no literal
   * scan can follow. The cost-report labels are built from a data table in `costReportHtml` for the same
   * reason. Both are named here, with the mechanism, rather than left to look like dead keys.
   */
  const intensitySrc = fs.readFileSync(path.join(WB, 'protocol', 'intensity.js'), 'utf8');
  for (const m of intensitySrc.matchAll(/\b(?:title_key|description_key):\s*'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)'/g)) {
    declaredByServer.add(m[1]);
  }
  for (const k of [
    'intensity.recommended', 'preview.noTokenEstimate',
    'cost.heading', 'cost.supervisorTurns', 'cost.workerTurns', 'cost.reviewerTurns', 'cost.subagents',
    'cost.retries', 'cost.validationTier', 'cost.elapsed', 'cost.tokens', 'cost.tokensNote',
  ]) declaredByUi.add(k);

  /**
   * The assertion is against what the server ACTUALLY declares, not a remembered total: a hard-coded number
   * would have to be edited every time a preset is added, which is how an assertion becomes a chore people
   * delete instead of a test.
   */
  check('the server declares the preset keys, its goal templates and the examples',
    declaredByServer.size >= 26
    && [...declaredByServer].some((k) => k.startsWith('preset.'))
    && [...declaredByServer].some((k) => k.startsWith('example.')),
    `${declaredByServer.size} declared`);
  for (const [name, set] of [['the server', declaredByServer], ['the guided UI', declaredByUi]]) {
    const missing = [...set].filter((k) => !base.has(k)).sort();
    check(`every key ${name} declares exists in the English catalogue`,
      missing.length === 0, `${missing.length}: ${missing.slice(0, 8).join(', ')}`);
  }
  for (const locale of ['zh-CN', 'zh-TW', 'ja']) {
    const cat = keysOf(locale);
    const missing = [...declaredByServer, ...declaredByUi].filter((k) => !cat.has(k)).sort();
    check(`every declared key exists in ${locale}`, missing.length === 0,
      `${missing.length}: ${missing.slice(0, 8).join(', ')}`);
  }

  const mustBeWired = [
    'goal.prompt', 'goal.submit', 'goal.placeholder', 'panel.seats', 'panel.evidence', 'panel.timeline',
    'codex.label', 'codex.off', 'codex.on', 'evidence.technical', 'logs.expand', 'logs.collapse',
    'task.none', 'seat.none', 'evidence.none', 'action.pause', 'common.refresh', 'header.language',
    // V0.3.3: the guided layer's own high-visibility strings, all named literally in guided.js.
    'guided.emptyTitle', 'guided.emptyHint', 'guided.needProject', 'guided.loading',
    'preview.heading', 'file.heading', 'autonomy.heading', 'review.heading',
    'onboarding.title', 'onboarding.start', 'onboarding.skip', 'onboarding.reopen',
    'view.advanced', 'view.basic', 'ev.summary.heading',
  ];
  const unwired = mustBeWired.filter((k) => !reachable(k));
  check('every high-visibility key is wired into the UI', unwired.length === 0, unwired.join(', '));

  /**
   * The families that must be complete in every locale are asserted by NAME, not by a dead-key count: a whole
   * feature area can be added to the catalogue and translated only in English, which is exactly the
   * half-translated UI this milestone forbids, and a count cannot see it.
   */
  const v033Families = ['preset.', 'file.', 'autonomy.', 'review.', 'preview.', 'guided.', 'onboarding.', 'help.', 'view.', 'example.', 'plain.', 'taskx.', 'ev.summary.'];
  for (const fam of v033Families) {
    const keys = [...base].filter((k) => k.startsWith(fam));
    check(`the ${fam}* family is populated`, keys.length > 0, `${keys.length} key(s)`);
    for (const locale of ['zh-CN', 'zh-TW', 'ja']) {
      const cat = keysOf(locale);
      const missing = keys.filter((k) => !cat.has(k));
      check(`the ${fam}* family is complete in ${locale}`, missing.length === 0,
        `${missing.length} missing: ${missing.slice(0, 6).join(', ')}`);
    }
  }

  const dynamicFamilies = ['evidence.element.', 'evidence.verdict.', 'seat.role.', 'status.', 'mark.', 'evidence.detail.'];
  /**
   * A key is reachable if the UI names it, the UI builds it from a template literal, or the SERVER declares it
   * and hands it over through the catalogue. The third clause is what makes this honest for the guided layer.
   */
  const serverDeclared = (k) => declaredByServer.has(k) || declaredByUi.has(k);
  const dynamicOnly = [...base].filter((k) => !referenced.has(k) && dynamicFamilies.some((p) => k.startsWith(p))).length;
  const trulyUnused = [...base].filter((k) => !reachable(k) && !serverDeclared(k) && !uiDescReachable(k) && !dynamicFamilies.some((p) => k.startsWith(p)));
  console.log(`  INFO  ${dynamicOnly} key(s) are reached through a computed key, which a static scan cannot see`);
  console.log(`  INFO  ${declaredByServer.size} key(s) are declared by the server catalogue and reached through it`);
  if (trulyUnused.length) console.log(`  WARN  ${trulyUnused.length} key(s) are defined but never referenced: ${trulyUnused.slice(0, 10).join(', ')}`);
  check('no large block of dead keys has accumulated', trulyUnused.length < 60, `${trulyUnused.length} unused`);
}

// ======================================================================
section('G. Placeholders survive translation');
{
  const en = valuesOf('en');
  const tokenRe = /\{(\w+)\}/g;
  for (const locale of ['zh-CN', 'zh-TW', 'ja']) {
    const values = valuesOf(locale);
    const mismatched = [];
    for (const [key, value] of Object.entries(en)) {
      const want = [...String(value).matchAll(tokenRe)].map((m) => m[1]).sort().join(',');
      if (!want) continue;
      const got = [...String(values[key] ?? '').matchAll(tokenRe)].map((m) => m[1]).sort().join(',');
      if (want !== got) mismatched.push(`${key}: {${want}} vs {${got}}`);
    }
    check(`${locale}: every placeholder token is preserved`, mismatched.length === 0, mismatched.slice(0, 3).join(' | '));
  }
}

// ======================================================================
section('H. Nothing is left in English that should not be');
{
  // These are the strings a Chinese user reads first. If a translation file accidentally copied the English
  // through, it shows up here rather than on a screenshot.
  const mustDiffer = [
    'goal.prompt', 'goal.submit', 'panel.goals', 'panel.tasks', 'panel.evidence', 'panel.timeline',
    'codex.label', 'codex.off', 'codex.on', 'mark.absent', 'mark.na', 'mark.ok', 'mark.bad',
    'evidence.technical', 'logs.expand', 'action.pause', 'action.refresh', 'goal.hint',
  ].filter((k) => keysOf('en').has(k));
  const en = valuesOf('en');
  for (const locale of ['zh-CN', 'zh-TW', 'ja']) {
    const values = valuesOf(locale);
    const same = mustDiffer.filter((k) => values[k] === en[k]);
    check(`${locale}: key strings that must be translated are translated`, same.length === 0, same.join(', '));
  }
  // Values that MUST stay identical to English because they are not prose.
  const mustMatch = ['codex.required', 'evidence.legacy', 'evidence.legacy.short'].filter((k) => keysOf('en').has(k));
  for (const locale of ['zh-CN', 'zh-TW', 'ja']) {
    const values = valuesOf(locale);
    const drifted = mustMatch.filter((k) => values[k] !== en[k]);
    check(`${locale}: canonical tokens are identical to English`, drifted.length === 0,
      drifted.map((k) => `${k}: ${values[k]} vs ${en[k]}`).join(' | '));
  }
}

// ======================================================================
console.log(`\n${'='.repeat(70)}`);
console.log(`I18N SUITE: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
