'use strict';
/**
 * state.js - page state detection for the ChatGPT Web Worker adapter.
 *
 * WHY THIS IS A SEPARATE LAYER
 *   Every dangerous situation in this integration is a STATE, not an error return:
 *   the session expired, a human-verification challenge appeared, the account hit a
 *   usage cap. None of those raise; they just change the page. If the adapter only
 *   checked "did I get a reply", it would wait minutes for a reply that will never
 *   come and then report a half-empty transcript as success.
 *
 *   So state detection runs FIRST on every operation, and it is deliberately
 *   conservative: when a blocking state is detected the adapter stops and hands off to
 *   the human instead of attempting anything clever. It never types credentials, never
 *   solves or bypasses a challenge, and never tries to read hidden reasoning.
 *
 * DETECTION ORDER MATTERS: captcha > login > rateLimit > error.
 *   A captcha page can also contain the words of a login page; the most severe and most
 *   human-actionable state must win so the handoff message is correct.
 *
 * ASCII-ONLY: see the encoding note in lib.js.
 */

const {
  CONFIG, SELECTORS, RESOLVE_SRC, compose, runCode, nowIso,
} = require('./lib.js');

/** States the adapter can report. */
const STATE = {
  READY: 'READY',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  CAPTCHA: 'CAPTCHA',
  RATE_LIMIT: 'RATE_LIMIT',
  ERROR: 'ERROR',
  CONTEXT_WARNING: 'CONTEXT_WARNING',
  COMPOSER_MISSING: 'COMPOSER_MISSING',
  UNKNOWN: 'UNKNOWN',
};

/**
 * Probe the live page and classify it.
 *
 * @returns {Promise<{state:string, url:string, detail?:string, matched?:string[], severity:number}>}
 */
async function detectState() {
  const patterns = SELECTORS.blockingStateText;
  const probe = compose({
    inputCandidates: SELECTORS.input.candidates,
    groups: {
      loginRequired: patterns.loginRequired.patterns,
      captcha: patterns.captcha.patterns,
      rateLimit: patterns.rateLimit.patterns,
      // The STRICT list: see errorFatal's rationale in selectors.json.
      error: patterns.errorFatal.patterns,
      contextWarning: patterns.contextWarning.patterns,
    },
  }, `
    ${RESOLVE_SRC}
    const tagGroups = args.tagGroups;
    const text = __CW.visibleText();
    const lower = text.toLowerCase();
    const hits = {};
    for (const key of Object.keys(args.groups)) {
      hits[key] = args.groups[key].filter(p => lower.includes(p.toLowerCase()));
    }
    // Composer presence is tested structurally through the registry, never by text.
    const composer = resolve(args.inputCandidates, document, tagGroups).filter(__CW.isVisible).length;
    return { url: __CW.url(), hits, composer,
             isConversation: __CW.isConversationUrl(), title: document.title };
  `);

  const r = runCode(probe);
  if (!r.ok) {
    return {
      state: STATE.ERROR,
      url: null,
      detail: `page probe failed: ${r.error}`,
      severity: 3,
      at: nowIso(),
    };
  }

  const v = r.value ?? {};
  const hits = v.hits ?? {};
  const lowerUrl = String(v.url ?? '').toLowerCase();

  // Most-severe-first. Severity is what the caller ranks on.
  if (hits.captcha?.length) {
    return { state: STATE.CAPTCHA, url: v.url, matched: hits.captcha, severity: 5,
      detail: 'human-verification page detected - stopping for manual handling' };
  }
  if (hits.loginRequired?.length || /\/(auth|login)/.test(lowerUrl)) {
    return { state: STATE.LOGIN_REQUIRED, url: v.url, matched: hits.loginRequired ?? [], severity: 5,
      detail: 'not signed in - stopping; the adapter never enters credentials' };
  }
  if (hits.rateLimit?.length) {
    return { state: STATE.RATE_LIMIT, url: v.url, matched: hits.rateLimit, severity: 4,
      detail: 'usage cap or throttling detected - stopping rather than retrying into a wall' };
  }
  if (hits.error?.length) {
    return { state: STATE.ERROR, url: v.url, matched: hits.error, severity: 3,
      detail: 'fatal error surface detected on the page' };
  }
  if (!v.composer) {
    return { state: STATE.COMPOSER_MISSING, url: v.url, severity: 3,
      detail: 'no visible composer found - page may still be loading, or the UI changed' };
  }
  if (hits.contextWarning?.length) {
    return { state: STATE.CONTEXT_WARNING, url: v.url, matched: hits.contextWarning, severity: 2,
      detail: 'context-pressure signal present; a worker rotation is likely warranted' };
  }
  return { state: STATE.READY, url: v.url, severity: 0, detail: 'composer present, no blocking state' };
}

/** True when the state means "a human must act before anything else happens". */
function requiresHuman(state) {
  return state === STATE.LOGIN_REQUIRED || state === STATE.CAPTCHA;
}

/** True when the adapter must not proceed, whether or not a human can fix it quickly. */
function isBlocking(state) {
  return state !== STATE.READY && state !== STATE.CONTEXT_WARNING;
}

module.exports = { STATE, detectState, requiresHuman, isBlocking };
