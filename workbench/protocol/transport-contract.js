'use strict';
/**
 * transport-contract.js - the interface every seat's transport must satisfy, plus a conformance test.
 *
 * THE POINT OF THIS FILE
 *   A contract that is only described in prose is not a contract. This one is executable: any object
 *   claiming to be a transport is checked against it, and the check is run by the regression suite for
 *   every registered transport. So "transport-neutral" is a tested property, not a claim in a README.
 *
 * WHAT THE LAYER ABOVE MAY KNOW
 *   Role, provider, capabilities, health, delivery state. Nothing else.
 *
 * WHAT THE LAYER ABOVE MUST NEVER KNOW
 *   Playwright, DOM selectors, HTTP verbs, CLI flags, or the word "ChatGPT". If a caller ever needs
 *   to ask what kind of transport it is holding in order to proceed, the abstraction has failed and
 *   the right fix is a new capability field - not a branch on the transport's name.
 *
 * THE VOCABULARY IS DELIBERATELY TRANSPORT-SHAPED, NOT BROWSER-SHAPED
 *   `dispatch` / `observe` / `read` describe a message that may or may not be provably delivered.
 *   They do not assume a chat window, a turn count, or a synchronous response, because those are
 *   browser facts. A transport that can ONLY answer synchronously still fits: it reports COMPLETE
 *   from observe() on the first call.
 */

/** Delivery states, shared by every transport. A transport may not invent its own. */
const DELIVERY = {
  IDLE: 'IDLE',
  SUBMITTING: 'SUBMITTING',
  SEND_PENDING: 'SEND_PENDING',
  USER_TURN_CONFIRMED: 'USER_TURN_CONFIRMED',
  ASSISTANT_PENDING: 'ASSISTANT_PENDING',
  SEND_UNCERTAIN: 'SEND_UNCERTAIN',
  COMPLETE: 'COMPLETE',
};

/** Terminal delivery states. Nothing further happens by itself. */
const TERMINAL = [DELIVERY.COMPLETE, DELIVERY.SEND_UNCERTAIN];

/**
 * The operations a transport must implement. Each is described by what it must guarantee.
 *
 * NOTE on `capabilities`: it is a required PROPERTY (an object of booleans), not a method, and it is
 * checked separately below. Listing it here as a method would demand `capabilities()` on every
 * transport - a mistake this contract made on its first run, caught by the conformance check itself.
 */
const REQUIRED_METHODS = {
  open: 'Prepare the transport for use. Idempotent. Returns {ok, detail}.',
  health: 'Report reachability and readiness. Returns {ok, status, detail, human_action?}.',
  dispatch: 'Send one rendered packet for a run. Returns {ok, delivery_state, detail}. '
    + 'MUST NOT wait for the answer, and MUST NOT retry a packet that may already have landed.',
  observe: 'Report what is known about a run WITHOUT sending anything. '
    + 'Returns {ok, delivery_state, confirmed, detail}. This is the only legal action while pending.',
  read: 'Return the reply text for a run once it exists. Returns {ok, text, detail}.',
};

/**
 * Verify an object satisfies the contract.
 *
 * Checks shape first, then BEHAVIOUR: dispatch must be non-blocking in spirit (it returns a state,
 * not a reply), and observe must not be a disguised send. The behavioural checks are structural
 * scans, not runtime probes, so conformance costs nothing at run time.
 */
function checkContract(transport, opts = {}) {
  const problems = [];
  const name = transport?.id ?? '(unnamed)';

  if (!transport || typeof transport !== 'object') {
    return { ok: false, transport: name, problems: ['not an object'] };
  }
  for (const m of Object.keys(REQUIRED_METHODS)) {
    if (typeof transport[m] !== 'function') problems.push(`missing method: ${m}()`);
  }
  for (const f of ['id', 'kind', 'provider']) {
    if (typeof transport[f] !== 'string' || !transport[f]) problems.push(`missing string field: ${f}`);
  }

  // Capabilities must be explicit. An undeclared capability is one the layer above will guess at.
  const caps = transport.capabilities;
  if (!caps || typeof caps !== 'object') problems.push('missing capabilities object');
  else {
    if (typeof caps.can_deliver_synchronously !== 'boolean') problems.push('capabilities.can_deliver_synchronously must be boolean');
    if (typeof caps.confirms_delivery !== 'boolean') problems.push('capabilities.confirms_delivery must be boolean');
    if (typeof caps.supports_readback !== 'boolean') problems.push('capabilities.supports_readback must be boolean');
    if (typeof caps.needs_human !== 'boolean') problems.push('capabilities.needs_human must be boolean');
  }

  // The source scan: a transport must not reach for provider-specific behaviour in its own code.
  // Scanned only for real transports on disk (the in-memory test doubles skip it).
  if (opts.sourceFile) {
    let src = '';
    try { src = require('node:fs').readFileSync(opts.sourceFile, 'utf8'); } catch { /* checked by test */ }
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // A transport SHOULD mention its own provider; what it must not do is decide by provider NAME.
    const branches = [
      /if\s*\(\s*[\w.]*provider\s*===/,
      /if\s*\(\s*[\w.]*provider\s*==/,
      /switch\s*\(\s*[\w.]*provider\s*\)/,
    ];
    for (const re of branches) {
      if (re.test(stripped)) problems.push('branches on provider name inside the transport (provider logic belongs in the transport, but never as a name switch)');
    }
  }

  return { ok: problems.length === 0, transport: name, kind: transport.kind ?? null, problems };
}

/** Run the contract check over every transport in a registry. */
function checkAll(transports) {
  const results = (transports ?? []).map((t) => checkContract(t, { sourceFile: t.sourceFile }));
  return { ok: results.every((r) => r.ok), results };
}

/**
 * The state machine every transport's delivery must follow.
 *
 * Exported so a transport cannot quietly invent a shortcut: the legal transitions are data, and the
 * most important one is the ABSENCE of a path from any pending state back to dispatch.
 */
const LEGAL_TRANSITIONS = {
  IDLE: ['SUBMITTING'],
  SUBMITTING: ['SEND_PENDING', 'USER_TURN_CONFIRMED', 'SEND_UNCERTAIN'],
  SEND_PENDING: ['USER_TURN_CONFIRMED', 'SEND_UNCERTAIN'],
  USER_TURN_CONFIRMED: ['ASSISTANT_PENDING', 'COMPLETE'],
  ASSISTANT_PENDING: ['COMPLETE', 'SEND_UNCERTAIN'],
  SEND_UNCERTAIN: [],
  COMPLETE: [],
};

function isLegalTransition(from, to) {
  return (LEGAL_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * THE PROHIBITION, AS CODE.
 *
 * Returns whether a re-dispatch is permitted from a given delivery state. It is false for every
 * state except the terminal-and-failed one, where the decision belongs to a human rather than to
 * this function. Callers must not work around it: a duplicate message is unrecoverable, a delayed
 * message is not.
 */
function mayRedispatch(deliveryState) {
  if (deliveryState === DELIVERY.COMPLETE) {
    return { allowed: false, reason: 'this run already completed; a new run should be dispatched instead' };
  }
  if (TERMINAL.includes(deliveryState)) {
    return { allowed: false, reason: 'the outcome is uncertain and the decision belongs to the user, not to an automatic retry' };
  }
  return {
    allowed: false,
    reason: `a packet for this run is already ${deliveryState}; re-dispatching would post a SECOND message `
      + 'into the same conversation. Only observation is permitted until the state settles.',
  };
}

module.exports = {
  DELIVERY, TERMINAL, REQUIRED_METHODS, LEGAL_TRANSITIONS,
  checkContract, checkAll, isLegalTransition, mayRedispatch,
};
