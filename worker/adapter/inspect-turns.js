'use strict';
/**
 * inspect-turns.js - enumerate every turn in the open conversation, read-only.
 *
 * WHY: after a restart the turn counts no longer matched what PHASE 9 recorded (1 user /
 * 1 assistant became 2 / 3). Before trusting any explanation, look at what is actually
 * there. This reads and reports only - it never sends, edits, or navigates.
 *
 * Usage: node inspect-turns.js
 */

const { SELECTORS, compose, runCode, RESOLVE_SRC } = require('./lib.js');

const r = runCode(compose({
  userCands: SELECTORS.messages.userTurn.candidates,
  assistantCands: SELECTORS.messages.assistantTurn.candidates,
  anyCands: SELECTORS.messages.anyTurn.candidates,
  bodyCands: SELECTORS.assistantBody.candidates,
}, `
  ${RESOLVE_SRC}
  const tagGroups = args.tagGroups;

  // Resolve the ANY-turn selector once, then read each element's own author role.
  // Resolving user and assistant candidate lists separately and concatenating would
  // return all users followed by all assistants - not document order - and a list whose
  // first candidates already matched would mask the second role entirely.
  const all = resolve(args.anyCands, document, tagGroups);

  const turns = all.map((el, i) => {
    const role = el.getAttribute('data-message-author-role') || 'unknown';
    const bodies = resolve(args.bodyCands, el, tagGroups);
    const bodyEl = bodies.length ? bodies[0] : null;
    const text = bodyEl ? __CW.structuredText(bodyEl) : (el.innerText || '').trim();
    return {
      order: i,
      role,
      chars: text.length,
      head: text.slice(0, 140).replace(/\\s+/g, ' '),
      tail: text.slice(-90).replace(/\\s+/g, ' '),
    };
  });

  return { url: __CW.url(), title: document.title, turnCount: turns.length, turns };
`));

if (!r.ok) {
  process.stdout.write(JSON.stringify({ ok: false, error: r.error }, null, 2) + '\n');
  process.exit(1);
}

const v = r.value;
process.stdout.write(`url:   ${v.url}\n`);
process.stdout.write(`title: ${v.title}\n`);
process.stdout.write(`turns: ${v.turnCount}\n\n`);
for (const t of v.turns) {
  process.stdout.write(`[${t.order}] ${t.role.padEnd(9)} ${String(t.chars).padStart(6)} chars\n`);
  process.stdout.write(`      head: ${t.head}\n`);
  process.stdout.write(`      tail: ${t.tail}\n\n`);
}

const counts = {};
for (const t of v.turns) counts[t.role] = (counts[t.role] || 0) + 1;
process.stdout.write('counts: ' + JSON.stringify(counts) + '\n');
