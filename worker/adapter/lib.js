'use strict';
/**
 * lib.js - transport + selector-resolution core for the ChatGPT Web Worker adapter.
 *
 * DESIGN CONSTRAINTS (why this is built the way it is)
 *
 * 1. ZERO npm dependencies.
 *    The adapter must run from the DeepSeek Harness shell with nothing installed
 *    beyond what already exists. Everything here uses only Node built-ins.
 *
 * 2. The browser is driven through the `pwc.ps1` CLI launcher, not the Playwright API.
 *    playwright-cli keeps a DETACHED DAEMON per workspace holding the live browser, so
 *    the browser survives between separate CLI invocations. That gives a persistent,
 *    stateful browser while each individual call stays a short-lived, observable
 *    process - exactly what a supervisor loop wants.
 *
 * 3. Page code is passed via `run-code --filename`, never as an inline argument.
 *    Inline passing forces the JS through PowerShell's argument parser and then the
 *    CLI's own, where quotes/backticks/$ get re-interpreted. A temp file removes that
 *    entire class of bug.
 *
 * 4. Every page function RETURNS a JSON-serializable value and the CLI is asked for
 *    JSON output. The adapter never scrapes human-readable CLI text for data.
 *
 * 5. THIS FILE IS ASCII-ONLY, INCLUDING COMMENTS.
 *    On Windows, PowerShell's Get-Content defaults to the system ANSI code page. A
 *    single scripted Get-Content/Set-Content round-trip on UTF-8 source silently
 *    destroys non-ASCII characters, and that damage is lossy and unrecoverable. Keeping
 *    adapter source pure ASCII makes such a round-trip a no-op instead of a disaster.
 *    Chinese text the adapter must genuinely match against the page lives in
 *    selectors.json (written only through UTF-8-safe tooling), never in code comments.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ADAPTER_DIR = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(ADAPTER_DIR, 'config.json'), 'utf8'));

// PUBLIC RELEASE ADDITION: resolve relative configured paths against the worker directory and allow an
// environment override, so a cloned repository runs from any location. Absolute values are honoured
// unchanged, which keeps the maintainer instance's behaviour identical.
const WORKER_ROOT = path.resolve(ADAPTER_DIR, '..');
const WORKER_PATH_ENV = {
  profileDir: 'AWB_WORKER_PROFILE_DIR',
  stateDir: 'AWB_WORKER_STATE_DIR',
  logsDir: 'AWB_WORKER_LOGS_DIR',
  workerLedger: 'AWB_WORKER_LEDGER',
  pwcLauncher: 'AWB_WORKER_PWC_LAUNCHER',
};
for (const [key, envName] of Object.entries(WORKER_PATH_ENV)) {
  const value = process.env[envName] ?? CONFIG.paths[key];
  if (typeof value !== 'string' || value === '') { CONFIG.paths[key] = value ?? null; continue; }
  CONFIG.paths[key] = path.isAbsolute(value) ? value : path.resolve(WORKER_ROOT, value);
}

const SELECTORS = JSON.parse(fs.readFileSync(path.join(ADAPTER_DIR, 'selectors.json'), 'utf8'));

// ---------------------------------------------------------------------------
// CLI transport
// ---------------------------------------------------------------------------

let _pageCodeSeq = 0;

/**
 * Run a page function in the live browser and return its value.
 *
 * The function source is written to a temp file and handed to `run-code --filename`.
 *
 * @param {string} fnSource - an async arrow function, e.g. `async page => { ... }`
 * @returns {{ok: boolean, value?: any, error?: string, raw?: string}}
 */
function runCode(fnSource) {
  const tmp = path.join(os.tmpdir(), `cw-pagecode-${process.pid}-${++_pageCodeSeq}.js`);
  fs.writeFileSync(tmp, fnSource, 'utf8');
  try {
    return cli(['run-code', `--filename=${tmp}`, '--json']);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* temp cleanup is best-effort */ }
  }
}

/**
 * Invoke the playwright-cli launcher.
 *
 * @param {string[]} args
 * @param {{timeoutMs?: number}} [opts]
 * @returns {{ok: boolean, value?: any, error?: string, raw?: string, code?: number}}
 */
function cli(args, opts = {}) {
  const launcher = CONFIG.paths.pwcLauncher;
  if (!fs.existsSync(launcher)) {
    return { ok: false, error: `launcher missing: ${launcher}` };
  }

  const timeout = opts.timeoutMs ?? CONFIG.limits.cliTimeoutMs;
  const full = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, ...args];

  const res = spawnSync('powershell.exe', full, {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });

  if (res.error) {
    return { ok: false, error: `spawn failed: ${res.error.message}` };
  }
  if (res.status !== 0) {
    const errText = (res.stderr || '').trim();
    const outText = (res.stdout || '').trim();
    return {
      ok: false,
      code: res.status,
      error: errText || outText || `exit ${res.status}`,
      raw: `${outText}\n${errText}`.trim(),
    };
  }

  const raw = (res.stdout || '').trim();
  const parsed = tryParseJson(raw);
  if (parsed === undefined) {
    return { ok: true, raw, value: undefined };
  }
  return unwrapCliJson(parsed, raw);
}

/**
 * Extract the payload from the CLI's JSON envelope.
 * The envelope shape is not contractually documented, so several plausible shapes are
 * accepted and the original is preserved in `raw` for inspection.
 */
function unwrapCliJson(node, raw) {
  if (node && typeof node === 'object') {
    if (typeof node.result === 'string') {
      const inner = tryParseJson(node.result);
      return { ok: true, value: inner === undefined ? node.result : inner, raw };
    }
    if (node.result !== undefined && typeof node.result === 'object') {
      return { ok: true, value: node.result, raw };
    }
    if (node.value !== undefined) return { ok: true, value: node.value, raw };
  }
  return { ok: true, value: node, raw };
}

function tryParseJson(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const trimmed = text.trim();
  const first = trimmed[0];
  if (first !== '{' && first !== '[' && first !== '"') return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// Page-side code generation
// ---------------------------------------------------------------------------

/**
 * TAG CATEGORIES, read from the registry rather than written inline.
 * These are markup tag sets that can carry a given ARIA role - they identify no
 * specific element, so they belong with the other targeting knowledge.
 */
const TAG_GROUPS = {
  textbox: SELECTORS.roleTextboxGroup.tagGroup,
  button: SELECTORS.roleButtonGroup.tagGroup,
  link: SELECTORS.roleLinkGroup.tagGroup,
  any: '*',
};

/**
 * Page-side utility source.
 *
 * CRITICAL CONTRACT: everything here must be SELF-CONTAINED.
 * `page.evaluate` does not run the function in Node - it serializes the function to
 * source text and evaluates it in the browser realm. Any closure over a Node-side
 * variable is therefore LOST, and reading one throws ReferenceError inside the page.
 * (Verified empirically: referencing an outer const yields "outer is not defined".)
 *
 * `args` is in scope because the emitted inner function takes it as its parameter and
 * the IIFE below runs INSIDE that function body.
 */
const PAGE_HELPERS = `
const __CW = (() => {
  const doc = document;
  const win = doc.defaultView;
  const STRIP = args.stripSelector;
  const TAG_GROUPS = args.tagGroups;
  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = win.getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const visibleText = () => {
    const clone = doc.body.cloneNode(true);
    clone.querySelectorAll(STRIP).forEach(n => n.remove());
    return (clone.innerText || '').replace(/\\s+/g, ' ').trim();
  };
  const url = () => win.location.href;
  const isConversationUrl = () => /\\/c\\/[0-9a-z-]{8,}/i.test(win.location.pathname);
  const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);
  const textOf = (el) => (el ? (el.innerText || el.textContent || '') : '');
  const structuredText = (root) => {
    if (!root) return '';
    const out = [];
    const push = (s) => { if (s !== undefined && s !== null) out.push(s); };
    const FENCE = String.fromCharCode(96).repeat(3);
    const emitCode = (pre) => {
      const code = pre.querySelector('code');
      const cls = code ? String(code.className || '') : '';
      const m = cls.match(/language-([A-Za-z0-9_+-]+)/);
      const body = (code ? textOf(code) : textOf(pre)).replace(/\\n+$/, '');
      push('');
      push(FENCE + (m ? m[1] : ''));
      push(body);
      push(FENCE);
      push('');
    };
    const emitTable = (tbl) => {
      // Walk the section elements explicitly: HTML parsing auto-inserts tbody, so a
      // direct 'tr' query can miss header rows the parser relocated.
      const rows = Array.from(tbl.querySelectorAll('thead > tr, tbody > tr, tfoot > tr, tr'))
        .map(tr => Array.from(tr.querySelectorAll('th,td'))
          .map(td => textOf(td).trim().replace(/\\s+/g, ' '))
          .join(' | '))
        .filter(r => r.length > 0);
      push('');
      rows.forEach(r => push(r));
      push('');
    };
    const emitList = (list, ordered) => {
      Array.from(list.children).forEach((li, i) => {
        const marker = ordered ? (i + 1) + '. ' : '- ';
        push(marker + textOf(li).trim().replace(/\\s+/g, ' '));
      });
      push('');
    };
    const walk = (node) => {
      if (!node || node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if (tag === 'button' || tag === 'nav' || tag === 'menu' || tag === 'svg') return;
      if (tag === 'pre') return emitCode(node);
      if (tag === 'table') return emitTable(node);
      if (tag === 'ul') return emitList(node, false);
      if (tag === 'ol') return emitList(node, true);
      if (/^h[1-6]$/.test(tag)) { push(''); push('#'.repeat(+tag[1]) + ' ' + textOf(node).trim()); push(''); return; }
      if (tag === 'p') { push(textOf(node).trim()); push(''); return; }
      if (tag === 'br') { push(''); return; }
      Array.from(node.childNodes).forEach(walk);
    };
    Array.from(root.childNodes).forEach(walk);
    return out.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  };
  return { isVisible, visibleText, url, isConversationUrl, last, textOf, structuredText };
})();
`;

/**
 * Resolve a registry candidate list, as page-side source.
 * Emitted inline (not injected) so it is part of the serialized function body.
 */
const RESOLVE_SRC = `
  const resolve = (cands, root, tagGroups) => {
    const groups = tagGroups || TAG_GROUPS;
    const scope = root || document;
    for (const c of cands) {
      let els = [];
      try {
        if (c.kind === 'css') els = Array.from(scope.querySelectorAll(c.value));
        else if (c.kind === 'self') return [scope];
        else if (c.kind === 'role') {
          const tags = groups[c.role] || groups.any;
          els = Array.from(scope.querySelectorAll(tags)).filter(el => {
            const al = el.getAttribute('aria-label') || '';
            const tx = (el.textContent || '').trim();
            const nm = c.name || '';
            return al === nm || tx === nm || al.includes(nm) || tx.includes(nm);
          });
        }
      } catch (e) { continue; }
      if (els.length) return els;
    }
    return [];
  };
`;

/**
 * Compose an executable page function.
 *
 * WHERE THINGS MAY LIVE - this boundary is subtle and was verified empirically:
 *
 *   The text between `async page => {` and the page.evaluate call runs in NODE, where
 *   `document` and `window` DO NOT EXIST. Only the body inside the inner function is
 *   serialized and re-evaluated in the browser.
 *
 *   Therefore the helpers must be emitted INSIDE the inner function (they touch
 *   `document`), and everything they need - the strip list, the tag groups - must
 *   arrive through `args` rather than by closing over a Node-side const, because
 *   serialization drops the closure. The inner function is `async` so call bodies may
 *   await.
 *
 * Getting this wrong surfaces as "ReferenceError: document is not defined", which is
 * why selftest.js pins the contract on the live page.
 *
 * @param {any} args  JSON-serializable payload, delivered as the evaluate argument
 * @param {string} inner  body source using `__CW`, `args`
 */
function compose(args, inner) {
  const payload = Object.assign({}, args, {
    stripSelector: SELECTORS.stripFromVisibleText.tagGroup,
    tagGroups: TAG_GROUPS,
  });
  return `async page => {
    const __args = ${JSON.stringify(payload)};
    const __inner = async (args) => {
${PAGE_HELPERS}
${inner}
    };
    return await page.evaluate(__inner, __args);
  }`;
}

/**
 * Build the calibration probe for one selector group.
 * Reports, per candidate, how many elements matched and how many are visible -
 * evidence for marking a candidate `verified` rather than a boolean.
 */
function probeSource(groupKey) {
  const group = SELECTORS[groupKey] ?? SELECTORS.messages?.[groupKey];
  if (!group) throw new Error(`unknown selector group: ${groupKey}`);
  const candidates = group.candidates ?? [];
  return compose({ candidates, tagGroups: TAG_GROUPS }, `
    ${RESOLVE_SRC}
    const { candidates, tagGroups } = args;
    return candidates.map(c => {
      let matched = 0, visible = 0;
      try {
        const els = resolve([c], document, tagGroups);
        matched = els.length;
        visible = els.filter(__CW.isVisible).length;
      } catch (e) { /* a bad candidate must not abort the probe */ }
      return { kind: c.kind, value: c.value ?? c.name ?? '', status: c.status, matched, visible };
    });
  `);
}

/**
 * Resolve a selector group against the live page.
 * @returns {{ok:boolean, winner?:object, candidates?:object[], error?:string}}
 */
function resolveGroup(groupKey) {
  const r = runCode(probeSource(groupKey));
  if (!r.ok) return { ok: false, error: r.error };
  const list = Array.isArray(r.value) ? r.value : null;
  if (!list) return { ok: false, error: `unexpected probe output: ${String(r.raw).slice(0, 400)}` };
  const winner = list.find((c) => c.visible > 0);
  return { ok: true, winner: winner ?? null, candidates: list };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(event, detail) {
  const dir = CONFIG.paths.logsDir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* noop */ }
  const line = JSON.stringify({ at: new Date().toISOString(), event, detail }) + '\n';
  try { fs.appendFileSync(path.join(dir, 'adapter.jsonl'), line, 'utf8'); } catch { /* logging must never break the loop */ }
}

function nowIso() { return new Date().toISOString(); }

module.exports = {
  ADAPTER_DIR,
  CONFIG,
  SELECTORS,
  PAGE_HELPERS,
  TAG_GROUPS,
  RESOLVE_SRC,
  compose,
  cli,
  runCode,
  probeSource,
  resolveGroup,
  log,
  nowIso,
  tryParseJson,
};
