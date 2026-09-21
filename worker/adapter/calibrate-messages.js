'use strict';
/**
 * calibrate-messages.js - verifies the message and body selectors against a REAL
 * conversation that already contains at least one exchange.
 *
 * WHY: the standard calibration probe can only report "no match" for message selectors
 * on an empty page, which proves nothing. Turn and body selectors can only be confirmed
 * once a conversation actually has turns - so they are verified here, after PHASE 9.
 *
 * READ-ONLY: it inspects and reports. It never types, clicks, or navigates.
 *
 * Usage: node calibrate-messages.js
 */

const { SELECTORS, compose, runCode, RESOLVE_SRC } = require('./lib.js');

const r = runCode(compose({
  userCands: SELECTORS.messages.userTurn.candidates,
  assistantCands: SELECTORS.messages.assistantTurn.candidates,
  anyCands: SELECTORS.messages.anyTurn.candidates,
  bodyCands: SELECTORS.assistantBody.candidates,
  // The author-role attribute is itself registry knowledge, so the tally below reads it
  // from the first anyTurn candidate instead of repeating the selector here.
  anyTurnSelector: SELECTORS.messages.anyTurn.candidates[0].value,
  authorAttr: 'data-message-author-role',
}, `
  ${RESOLVE_SRC}
  const tagGroups = args.tagGroups;

  const probe = (cands) => cands.map(c => {
    let matched = 0;
    try { matched = resolve([c], document, tagGroups).length; }
    catch (e) { matched = -1; }
    return { kind: c.kind, value: c.value ?? c.name ?? '', status: c.status, matched };
  });

  // Author roles actually present, straight from the attribute the registry selects on.
  const roles = {};
  document.querySelectorAll(args.anyTurnSelector).forEach(el => {
    const k = el.getAttribute(args.authorAttr);
    if (k) roles[k] = (roles[k] || 0) + 1;
  });

  // Body shape inside the last assistant turn.
  const turns = resolve(args.assistantCands, document, tagGroups);
  const last = __CW.last(turns);
  let shape = null;
  if (last) {
    const bodies = resolve(args.bodyCands, last, tagGroups);
    const bodyEl = bodies.length ? bodies[0] : null;
    shape = {
      turnTag: last.tagName.toLowerCase(),
      turnAttrs: Array.from(last.attributes).map(a => a.name),
      bodyFound: !!bodyEl,
      bodyTag: bodyEl ? bodyEl.tagName.toLowerCase() : null,
      bodyClass: bodyEl ? String(bodyEl.className || '').slice(0, 100) : null,
      textChars: bodyEl ? __CW.structuredText(bodyEl).length : 0,
      pipeCountInText: bodyEl ? (__CW.structuredText(bodyEl).match(/\\|/g) || []).length : 0,
    };
  }

  return {
    anyTurn: probe(args.anyCands),
    userTurn: probe(args.userCands),
    assistantTurn: probe(args.assistantCands),
    assistantBody: probe(args.bodyCands),
    authorRolesPresent: roles,
    userTurnCount: resolve(args.userCands, document, tagGroups).length,
    assistantTurnCount: turns.length,
    bodyShape: shape,
    url: __CW.url(),
    isConversation: __CW.isConversationUrl(),
  };
`));

process.stdout.write(JSON.stringify(r.ok ? r.value : { error: r.error }, null, 2) + '\n');
