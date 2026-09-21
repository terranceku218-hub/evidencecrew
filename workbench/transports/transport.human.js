'use strict';
/**
 * transport.human.js - a HUMAN OPERATOR as a first-class seat.
 *
 * WHY THIS IS A REAL TRANSPORT AND NOT A TEST DOUBLE
 *   It is tempting to treat "a person answers" as a fallback or a stub. It is neither. A human
 *   operator is the one seat that is genuinely synchronous, genuinely reliable, and genuinely
 *   different in kind from every automated path - and modelling it proves something a second API
 *   transport cannot: that the transport contract is not secretly shaped like a request/response
 *   network call.
 *
 *   Concretely, this transport has no URL, no credentials, no latency, and no failure mode except
 *   "the person has not answered yet". Yet it satisfies the same six operations and drives the same
 *   delivery state machine. If the layers above work with this and with a DOM-scraping browser, the
 *   abstraction is doing real work.
 *
 * IT ALSO MAKES THE PROTOCOL USEFUL TODAY
 *   There are no API keys in this environment. A human seat means the Supervisor role can be filled
 *   for real, right now, with a different transport from the worker seat - which is exactly the V0.2
 *   demonstration requirement, and honest rather than a mock.
 *
 * HOW A HUMAN "DELIVERS"
 *   A packet is rendered (the `human` dialect), queued, and surfaced in the UI. The operator reads it
 *   and pastes an answer back. The answer is correlated by the same run_id_ack rule as any machine -
 *   which is the point: the protocol does not care who is on the other end.
 */

const { DELIVERY } = require('../protocol/transport-contract.js');
const protocol = require('../protocol/protocol.js');

/**
 * @param {{store?:object}} opts  optional persistence hook so a queue survives a restart
 */
function createHumanTransport(opts = {}) {
  /** run_id -> { packetText, envelope, replyText, state, queuedAt, answeredAt } */
  const queue = new Map();
  const store = opts.store ?? null;

  function persist() {
    if (store && typeof store.saveHumanQueue === 'function') {
      try { store.saveHumanQueue([...queue.values()]); } catch { /* queue persistence is a convenience */ }
    }
  }

  return {
    id: opts.id ?? 'human:operator',
    kind: 'human',
    provider: opts.provider ?? 'human',
    sourceFile: __filename,
    defaultRenderer: 'human',

    capabilities: {
      // A person can answer the moment they choose to, so delivery and completion are knowable
      // immediately - the opposite end of the spectrum from the browser transport.
      can_deliver_synchronously: true,
      confirms_delivery: true,
      supports_readback: true,
      needs_human: true,
      notes: 'A human operator. Delivery is confirmed by the act of answering; there is no transport '
        + 'uncertainty, only the possibility that nobody has answered yet.',
    },

    async open() {
      return { ok: true, detail: 'human seats need no connection' };
    },

    async health() {
      const pending = [...queue.values()].filter((r) => r.state !== DELIVERY.COMPLETE).length;
      return {
        ok: true,
        status: pending > 0 ? 'AWAITING_OPERATOR' : 'READY',
        detail: pending > 0 ? `${pending} packet(s) waiting for a human answer` : 'no packets waiting',
        checked_at: new Date().toISOString(),
      };
    },

    /**
     * Queue a packet for the operator.
     *
     * Delivery is confirmed immediately: the packet is in the operator's queue, which IS the
     * conversation for this transport. Reporting SEND_PENDING here would be false suspense.
     */
    async dispatch(envelope, packetText) {
      queue.set(envelope.run_id, {
        run_id: envelope.run_id,
        envelope,
        packetText,
        replyText: null,
        state: DELIVERY.USER_TURN_CONFIRMED,
        queuedAt: new Date().toISOString(),
        answeredAt: null,
      });
      persist();
      return {
        ok: true,
        delivery_state: DELIVERY.USER_TURN_CONFIRMED,
        detail: 'packet queued for the human operator; delivery is confirmed by queueing',
        transport_evidence: { transport: 'human', queued: true },
      };
    },

    async observe(envelope) {
      const rec = queue.get(envelope.run_id);
      if (!rec) return { ok: false, delivery_state: DELIVERY.SEND_UNCERTAIN, confirmed: false, detail: 'this run was never queued' };
      if (rec.quarantined) {
        // The operator DID answer, but the answer could not be attributed to this run. That is not
        // completion and it is not silence - it is a delivery we cannot accept, which is exactly what
        // SEND_UNCERTAIN means. Reporting COMPLETE here would let an unattributable answer proceed.
        return { ok: true, delivery_state: DELIVERY.SEND_UNCERTAIN, confirmed: true, detail: rec.quarantine_detail };
      }
      const answered = typeof rec.replyText === 'string' && rec.replyText.trim().length > 0;
      return {
        ok: true,
        delivery_state: answered ? DELIVERY.COMPLETE : DELIVERY.ASSISTANT_PENDING,
        confirmed: true,
        detail: answered ? 'the operator has answered' : 'waiting for the operator to answer',
      };
    },

    async read(envelope) {
      const rec = queue.get(envelope.run_id);
      if (!rec) return { ok: false, text: null, detail: 'no such queued run' };
      if (!rec.replyText) return { ok: false, text: null, detail: 'the operator has not answered yet' };
      return { ok: true, text: rec.replyText, detail: 'operator reply' };
    },

    // ---------------------------------------------------------------------
    // operator-facing operations. These are how the human seat is USED, and
    // they are deliberately not part of the transport contract: the layer
    // above must keep working without ever calling them.
    // ---------------------------------------------------------------------

    /**
     * What the operator currently has to answer, or has answered but could not be attributed.
     *
     * A quarantined packet stays visible on purpose. It must not disappear: the operator needs to see
     * that their answer was refused and why, and needs the packet to try again with a correct ack.
     * Silently consuming it would leave the run pending forever with nothing on screen to explain it.
     */
    pending() {
      return [...queue.values()]
        .filter((r) => r.state !== DELIVERY.COMPLETE && !r.accepted)
        .map((r) => ({
          run_id: r.run_id, task_id: r.envelope.task_id, workspace_id: r.envelope.workspace_id,
          queued_at: r.queuedAt, packet: r.packetText,
          quarantined: r.quarantined === true,
          quarantine_detail: r.quarantine_detail ?? null,
          previous_attempt: r.replyText ?? null,
        }));
    },

    /**
     * Store the operator's answer. It does NOT decide whether the answer is acceptable.
     *
     * Correlation belongs to the protocol, and it is applied to a human exactly as to a model. The
     * transport's only job is to hold the text. Accepting or rejecting happens in the layer above,
     * through `accept` / `quarantine`, which is what keeps a human seat from being a privileged path.
     */
    answer(runId, replyText) {
      const rec = queue.get(runId);
      if (!rec) return { ok: false, error: `no queued run: ${runId}` };
      if (typeof replyText !== 'string' || !replyText.trim()) return { ok: false, error: 'an empty answer is not an answer' };
      if (rec.accepted) {
        return { ok: false, error: `this packet was already answered and accepted; re-submitting does not create a second run` };
      }
      rec.replyText = replyText;
      rec.answeredAt = new Date().toISOString();
      // Still awaiting adjudication. `pending()` keeps showing it until accepted.
      rec.state = DELIVERY.ASSISTANT_PENDING;
      rec.quarantined = false;
      persist();
      return { ok: true, run_id: runId, ack: protocol.parseAck(replyText) };
    },

    /** The protocol accepted the answer: the run is answered and the packet leaves the inbox. */
    accept(runId) {
      const rec = queue.get(runId);
      if (!rec) return { ok: false, error: `no queued run: ${runId}` };
      rec.accepted = true;
      rec.quarantined = false;
      rec.state = DELIVERY.COMPLETE;
      persist();
      return { ok: true };
    },

    /** The protocol refused the answer. Kept, with the reason, and the packet stays answerable. */
    quarantine(runId, detail) {
      const rec = queue.get(runId);
      if (!rec) return { ok: false, error: `no queued run: ${runId}` };
      rec.accepted = false;
      rec.quarantined = true;
      rec.quarantine_detail = detail ?? 'the answer could not be attributed to this run';
      rec.state = DELIVERY.ASSISTANT_PENDING;
      persist();
      return { ok: true };
    },

    /** Test helper. */
    _reset() { queue.clear(); },
  };
}

module.exports = { createHumanTransport };
