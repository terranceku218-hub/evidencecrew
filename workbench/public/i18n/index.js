'use strict';
/**
 * EvidenceCrew i18n engine.
 *
 * DESIGN RULES, AND WHY EACH ONE EXISTS
 *
 * 1. ONE REGISTRY, NO PER-COMPONENT TRANSLATION. Every string comes from a locale catalogue through
 *    `t()`. There is no `if (lang === 'zh')` anywhere in the UI, and there is no component that keeps
 *    its own strings, because that is how half a screen ends up in one language.
 *
 * 2. CANONICAL MACHINE VALUES ARE NEVER TRANSLATED. `GOAL_COMPLETE`, `SEND_PENDING`,
 *    `DISABLED_BY_POLICY`, `SUPERVISOR_REVIEW` and every other protocol value stays exactly as the
 *    protocol wrote it - in JSON, in the Evidence Record, in the API, in tests and in the log. The UI
 *    shows a translation through `ts()` and keeps the canonical value next to it as a tooltip, so a
 *    reader can always see what the machine actually said. Translation is a presentation concern and it
 *    stops at the presentation boundary.
 *
 * 3. A MISSING KEY IS LOUD IN DEVELOPMENT AND VISIBLE IN PRODUCTION. A silent empty string hides bugs
 *    until a user reports a blank button. A missing key renders as the English fallback when one exists,
 *    and as `[MISSING: key]` when it does not.
 *
 * 4. LANGUAGE NAME IN THE LANGUAGE ITSELF. The picker shows "简体中文", "繁體中文", "English", "日本語".
 *    A user looking for their own language should not have to read a language they do not have.
 */

(function attachI18n(global) {
  const FALLBACK = 'en';

  /**
   * Language codes, their self-names, and which BCP-47 tags map onto them.
   *
   * ORDER MATTERS, AND A BARE `zh` IS NOT A MATCH. `zh-HK` and `zh-MO` are Traditional, so they must reach
   * the zh-TW entry; a catch-all `'zh'` in the zh-CN entry would swallow them first, because the entries are
   * scanned in order and `zh-hk` starts with `zh-`. That bug was real: a Hong Kong browser was served
   * Simplified. A bare `zh` is handled explicitly at the end of `resolveLocale` instead.
   */
  const LANGUAGES = [
    { code: 'zh-CN', name: '简体中文', englishName: 'Chinese (Simplified)', match: ['zh-cn', 'zh-sg', 'zh-hans'] },
    { code: 'zh-TW', name: '繁體中文', englishName: 'Chinese (Traditional)', match: ['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant'] },
    { code: 'en', name: 'English', englishName: 'English', match: ['en'] },
    { code: 'ja', name: '日本語', englishName: 'Japanese', match: ['ja'] },
  ];

  const DEFAULT_LOCALE = 'zh-CN';
  const STORAGE_KEY = 'evidencecrew.locale';

  const catalogues = {};
  let current = FALLBACK;

  function register(code, catalogue) {
    catalogues[code] = catalogue;
  }

  /**
   * Which language should this browser start in?
   *
   * The maintainer environment prefers Chinese, so when nothing is saved and no tag matches, the fallback
   * is zh-CN rather than en. A saved choice always wins: a user who picked a language has answered this
   * question already, and asking it again on every reload is the behaviour people complain about.
   *
   * A bare `zh` with no region is treated as Simplified, which is the common case, and it is handled here
   * rather than as a catch-all entry so that `zh-HK` and `zh-MO` reach Traditional.
   */
  function resolveLocale(savedLocale, navigatorLanguages) {
    // Validated against the KNOWN codes rather than against the loaded catalogues: a saved choice must not
    // be ignored just because the locale script has not executed yet, which would silently reset a user's
    // language on a slow load. If the catalogue really is missing, `t()` falls back to English at lookup.
    if (savedLocale && LANGUAGES.some((l) => l.code === savedLocale)) return savedLocale;
    const list = Array.isArray(navigatorLanguages) ? navigatorLanguages : [navigatorLanguages];
    for (const raw of list) {
      const tag = String(raw ?? '').toLowerCase();
      if (!tag) continue;
      for (const lang of LANGUAGES) {
        if (lang.match.some((m) => tag === m || tag.startsWith(`${m}-`))) return lang.code;
      }
      if (tag === 'zh') return 'zh-CN';
    }
    return DEFAULT_LOCALE;
  }

  function readSaved() {
    try { return global.localStorage?.getItem(STORAGE_KEY) ?? null; } catch { return null; }
  }
  function writeSaved(code) {
    try { global.localStorage?.setItem(STORAGE_KEY, code); } catch { /* private mode: keep it in memory */ }
  }

  function detect() {
    const navLangs = global.navigator?.languages ?? [global.navigator?.language];
    return resolveLocale(readSaved(), navLangs);
  }

  function locale() { return current; }

  function setLocale(code, opts = {}) {
    const next = catalogues[code] ? code : FALLBACK;
    const changed = next !== current;
    current = next;
    /**
     * Persist ONLY when the caller says this is a deliberate choice.
     *
     * A detected default is not a user decision, so writing it on every load would overwrite a choice made
     * in another tab or set by hand, and would make `localStorage` claim the user picked something they
     * never picked. One condition, not two: an earlier version had a second `persist === true` line that
     * made the first one dead and the behaviour unreadable.
     */
    if (opts.persist === true) writeSaved(next);
    if (changed && opts.render !== false) render();
    return next;
  }

  /**
   * Translate a key.
   *
   * `vars` interpolates `{name}` placeholders. Interpolation happens AFTER lookup, so a value may contain
   * braces it did not intend as placeholders and only the ones passed in are substituted.
   */
  function t(key, vars) {
    const active = catalogues[current] ?? {};
    const fallback = catalogues[FALLBACK] ?? {};
    let value = active[key];
    let fromFallback = false;
    if (value === undefined) {
      value = fallback[key];
      fromFallback = value !== undefined;
    }
    if (value === undefined) return `[MISSING: ${key}]`;
    if (vars && typeof value === 'string') {
      value = value.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
    }
    if (fromFallback && current !== FALLBACK) {
      // A key that exists in English but not in the active locale is a translation gap. It renders the
      // English rather than an empty string, and it is countable, which is what the completeness test
      // checks. Marking it inline would be worse for the user than the English text itself.
      missing.set(key, (missing.get(key) ?? 0) + 1);
    }
    return value;
  }

  const missing = new Map();

  /**
   * Translate a canonical machine value for display.
   *
   * Returns an object so a caller can show the localized text and keep the canonical value as a tooltip:
   *   { text: '目标已完成', canonical: 'GOAL_COMPLETE' }
   * An unknown value falls through unchanged rather than becoming a placeholder, because a protocol value
   * this build does not know about still has to be displayed honestly.
   */
  function ts(value) {
    if (value === null || value === undefined || value === '') return { text: '', canonical: value ?? null };
    /**
     * The lookup key is LOWERCASED. MEASURED DEFECT: this used `.toUpperCase()`, which asked for
     * `status.GOAL_COMPLETE` while the catalogues store `status.goal_complete`, so every single status
     * lookup missed and fell through to the raw English value - all 35 translations dead, silently,
     * because a miss is indistinguishable from a missing translation at the call site. Canonical values
     * are still displayed in their original case through `canonical`, which is the whole point of
     * separating the two.
     */
    const key = `status.${String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
    const active = catalogues[current] ?? {};
    const fallback = catalogues[FALLBACK] ?? {};
    const hit = active[key] ?? fallback[key];
    return { text: hit ?? String(value), canonical: String(value) };
  }

  /** Every locale's catalogue size, for the completeness test and the About line. */
  function stats() {
    return Object.fromEntries(Object.entries(catalogues).map(([code, c]) => [code, Object.keys(c).length]));
  }

  /** Keys the active locale is missing relative to English. */
  function gaps(code = current) {
    const base = Object.keys(catalogues[FALLBACK] ?? {});
    const target = catalogues[code] ?? {};
    return base.filter((k) => !(k in target));
  }

  function missingKeys() { return [...missing.entries()].map(([key, count]) => ({ key, count })); }
  function resetMissing() { missing.clear(); }

  // ------------------------------------------------------------------ DOM application

  /**
   * Apply the active locale to the document.
   *
   * Static markup carries `data-i18n` (text), `data-i18n-title` and `data-i18n-placeholder`. Dynamic
   * panels re-render themselves through their own render functions, which call `t()` directly. Both
   * paths end in the same catalogue.
   */
  function applyToDom(root = global.document) {
    if (!root?.querySelectorAll) return 0;
    // Keep the document language in sync: it drives font selection, hyphenation and screen readers, and a
    // page that says lang="en" while rendering Chinese is read aloud in the wrong voice.
    if (root.documentElement) root.documentElement.setAttribute('lang', current);
    let applied = 0;
    for (const el of root.querySelectorAll('[data-i18n]')) {
      const value = t(el.getAttribute('data-i18n'));
      if (el.textContent !== value) el.textContent = value;
      applied += 1;
    }
    for (const el of root.querySelectorAll('[data-i18n-title]')) {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
      applied += 1;
    }
    for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
      applied += 1;
    }
    for (const el of root.querySelectorAll('[data-i18n-aria-label]')) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
      applied += 1;
    }
    return applied;
  }

  /** Called after a language change: re-apply static markup and let the app re-render its panels. */
  const listeners = [];
  function onChange(fn) { listeners.push(fn); }
  function render() {
    applyToDom();
    for (const fn of listeners) { try { fn(current); } catch (e) { console.error('[i18n] render listener failed', e); } }
  }

  global.I18N = {
    LANGUAGES, DEFAULT_LOCALE, STORAGE_KEY,
    register, t, ts, locale, setLocale, detect, resolveLocale,
    stats, gaps, missingKeys, resetMissing,
    applyToDom, onChange, render,
  };
}(typeof window !== 'undefined' ? window : globalThis));
