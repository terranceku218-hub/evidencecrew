'use strict';
/**
 * selftest.js - live self-test for the adapter's page-code layer.
 *
 * WHY THIS EXISTS
 *   The page-code path has one notorious trap: `page.evaluate` serializes the function,
 *   so any helper closed over from Node disappears at the boundary. Relatedly, code
 *   emitted OUTSIDE the inner function runs in Node, where `document` does not exist.
 *   Both failures are invisible until they run, and they surface as
 *   "ReferenceError: X is not defined" inside the browser.
 *
 *   This test asserts the composition contract against the REAL page, so neither trap can
 *   come back silently.
 *
 * READ-ONLY: it probes and injects a detached scratch element, then removes it. It never
 * types into the composer, never clicks, and never navigates.
 *
 * Usage: node selftest.js
 */

const { compose, RESOLVE_SRC, SELECTORS, TAG_GROUPS, runCode, CONFIG } = require('./lib.js');

const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); }

async function main() {
  // 1. composition contract
  const src = compose({ n: 41 }, `
    ${RESOLVE_SRC}
    return { plusOne: args.n + 1 };
  `);
  check('compose emits a page function', /^async page =>/.test(src), 'starts with async page =>');
  check('compose carries args', src.includes('"n":41'), 'args serialized into source');
  check('compose emits an async inner', src.includes('async (args) =>'), 'inner is async');
  check('compose injects tag groups', src.includes('tagGroups'), 'tag groups present in payload');

  // 2. live page: args and helpers survive serialization
  const r = runCode(compose({ n: 41 }, `
    return { plusOne: args.n + 1, hasCW: typeof __CW.visibleText === 'function' };
  `));
  check('page.evaluate receives args', r.ok && r.value?.plusOne === 42, JSON.stringify(r.value ?? r.error));
  check('__CW survives serialization', r.ok && r.value?.hasCW === true, 'helpers defined in page scope');

  // 3. live page: URL and conversation detection
  const u = runCode(compose({}, `
    return { url: __CW.url(), isConv: __CW.isConversationUrl(), title: document.title };
  `));
  check('url reads from page', u.ok && typeof u.value?.url === 'string', u.value?.url ?? u.error);
  check('conversation-url detection works', u.ok && typeof u.value?.isConv === 'boolean',
    `isConversation=${u.value?.isConv}`);

  // 4. live page: structured text extraction
  // A single-cell row legitimately renders with no separator, so the table case uses two
  // columns per row; asserting a separator on a one-cell row would be asserting a bug.
  const st = runCode(compose({}, `
    const d = document.createElement('div');
    d.innerHTML = '<p>alpha</p><ul><li>one</li><li>two</li></ul>' +
                  '<pre><code class="language-js">const x = 1;</code></pre>' +
                  '<table><thead><tr><th>H1</th><th>H2</th></tr></thead>' +
                  '<tbody><tr><td>v1</td><td>v2</td></tr></tbody></table>';
    d.style.display = 'none';
    document.body.appendChild(d);
    const out = __CW.structuredText(d);
    d.remove();
    return { out };
  `));
  const out = st.value?.out ?? '';
  check('structuredText keeps paragraphs', out.includes('alpha'), 'paragraph text present');
  check('structuredText renders lists', out.includes('- one') && out.includes('- two'), 'list markers applied');
  check('structuredText fences code', out.includes('```js') && out.includes('const x = 1;'), 'code fence + language');
  check('structuredText renders header row', out.includes('H1 | H2'), 'two-column header joined with pipe');
  check('structuredText renders body row', out.includes('v1 | v2'), 'two-column body joined with pipe');

  // 5. live page: candidate resolution runs without throwing
  const res = runCode(compose(
    { candidates: SELECTORS.input.candidates, tagGroups: TAG_GROUPS },
    `${RESOLVE_SRC}
     const { candidates, tagGroups } = args;
     const els = resolve(candidates, document, tagGroups);
     return { matched: els.length, visible: els.filter(__CW.isVisible).length };`,
  ));
  check('resolver executes', res.ok, res.ok ? 'no throw' : res.error);

  // 6. registry shape
  for (const key of ['input', 'sendButton', 'stopButton', 'newChat', 'streamingHint']) {
    const g = SELECTORS[key];
    check(`registry group '${key}' valid`,
      Array.isArray(g?.candidates) && g.candidates.length > 0,
      `${g?.candidates?.length ?? 0} candidates`);
  }
  check('messages.assistantTurn valid', Array.isArray(SELECTORS.messages.assistantTurn.candidates));
  check('messages.userTurn valid', Array.isArray(SELECTORS.messages.userTurn.candidates));
  check('assistantBody valid', Array.isArray(SELECTORS.assistantBody.candidates));
  check('tagGroups complete',
    !!TAG_GROUPS.textbox && !!TAG_GROUPS.button && !!TAG_GROUPS.link,
    Object.keys(TAG_GROUPS).join(','));

  // 7. the strict abort list must NOT contain the broad copy that caused a false abort
  const fatal = SELECTORS.blockingStateText.errorFatal.patterns;
  const broad = SELECTORS.blockingStateText.error.patterns;
  check('errorFatal is narrower than error', fatal.length < broad.length,
    `fatal=${fatal.length} broad=${broad.length}`);
  check('errorFatal excludes the ambiguous retry word',
    !fatal.some((p) => p.trim() === '重试'),
    'the word that aborted a healthy run is not an abort trigger');

  // report
  const failed = results.filter((x) => !x.ok);
  process.stdout.write(JSON.stringify({
    ok: failed.length === 0,
    target: CONFIG.worker.baseUrl,
    session: CONFIG.worker.sessionName,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  }, null, 2) + '\n');
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.stack ? e.stack : e) }, null, 2) + '\n');
  process.exit(1);
});
