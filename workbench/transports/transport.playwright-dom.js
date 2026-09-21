'use strict';
/**
 * transport.playwright-dom.js - browser transport, wrapping the existing verified worker adapter.
 *
 * WHY IT WRAPS RATHER THAN REIMPLEMENTS
 *   The ChatGPT browser adapter is verified, protected and already owns H1 (conversation-url
 *   lifecycle) and H2 (round accounting). Rewriting any of that to fit a new interface would throw
 *   away the guarantees to gain nothing. So this transport is a thin shape-adapter: it translates the
 *   contract's vocabulary into the adapter's vocabulary and back.
 *
 * WHAT IT ADDS THAT THE ADAPTER DOES NOT HAVE
 *   The adapter returns "sent / not sent". The contract needs "and if not, we do not know yet" -
 *   SEND_PENDING. The measured reality is that this transport cannot always tell promptly whether a
 *   packet landed, so it says so instead of claiming failure. That distinction is the difference
 *   between a retry that duplicates a message and a wait that resolves.
 *
 * PROVIDER-SPECIFIC CODE IS ENTIRELY HERE
 *   Nothing above this file mentions ChatGPT, DOM, turns, or selectors. That is the property being
 *   proven, so this file is where all of it is allowed to live - and where it must stay.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const { DELIVERY } = require('../protocol/transport-contract.js');

const WORKER = path.resolve(__dirname, '..', '..', 'worker');
const CW = path.join(WORKER, 'adapter', 'cw.js');

/** Ask the worker adapter one question and parse its JSON answer. */
function cw(args, timeoutMs = 120000) {
  if (!fs.existsSync(CW)) return { ok: false, error: `worker adapter not found: ${CW}` };
  const r = spawnSync(process.execPath, [CW, ...args], {
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  const text = (r.stdout || '').trim();
  try {
    return { ok: true, ...JSON.parse(text.replace(/^\uFEFF/, '')) };
  } catch {
    return { ok: false, error: (r.stderr || text || `exit ${r.status}`).slice(0, 400) };
  }
}

function createPlaywrightDomTransport(opts = {}) {
  const workerId = opts.workerId;
  /** Per-run bookkeeping. The transport owns this because only it knows what its own transport had
   *  to do to make a run observable. */
  const runs = new Map();

  return {
    id: opts.id ?? `pw-dom:${workerId}`,
    kind: 'playwright-dom',
    // Provider and transport are separate fields on purpose: this is the CHATGPT provider reached
    // over a DOM transport. The same provider over a different transport would be a different seat.
    provider: opts.provider ?? 'chatgpt',
    sourceFile: __filename,
    defaultRenderer: 'structured',

    capabilities: {
      can_deliver_synchronously: false,
      confirms_delivery: false,      // measured: the page can lag minutes behind the conversation
      supports_readback: true,
      needs_human: false,
      /**
       * A browser chat session has NO FILESYSTEM. When an envelope binds source, the packet must carry
       * the content, or the worker can only answer `SOURCE_HASH_ACK: UNREADABLE` - which is what
       * happened on every cross-provider run until this was made explicit. Declaring the limitation as
       * a capability lets the packet builder accommodate it without any caller asking which provider it
       * is holding.
       */
      supplies_source_content: false,
      notes: 'Browser DOM. New turns have been measured rendering minutes late, so delivery '
        + 'confirmation is slow and sometimes not obtainable within any practical window. The worker '
        + 'cannot read files, so source content must be embedded in the packet.',
    },

    async open() {
      const r = cw(['open'], 300000);
      return { ok: r.ok === true && r.launched !== false, detail: r.error ?? 'opened' };
    },

    async health() {
      const r = cw(['health_check'], 60000);
      const status = r.status ?? (r.ok ? 'UNKNOWN' : 'ERROR');
      return {
        ok: status === 'READY',
        status,
        detail: r.detail ?? r.error ?? null,
        human_action: r.humanAction ?? null,
        url: r.url ?? null,
        checked_at: new Date().toISOString(),
      };
    },

    /**
     * Send one packet. Returns a delivery STATE, never a reply.
     *
     * The adapter is asked for a short-window confirmation (`confirm_send`) AFTER the packet has been
     * committed, because the contract forbids holding a caller for the length of a turn. A packet that
     * is not yet visible is reported SEND_PENDING - which is not a failure, and from which the only
     * legal next action is observe().
     */
    async dispatch(envelope, packetText, dispatchOpts = {}) {
      const before = cw(['user_turns'], 90000);
      const userTurnsBefore = Number.isFinite(before.user_turns) ? before.user_turns : null;

      const rec = {
        run_id: envelope.run_id,
        user_turns_before: userTurnsBefore,
        assistant_turns_before: Number.isFinite(before.assistant_turns) ? before.assistant_turns : null,
        dispatched_at: new Date().toISOString(),
        packet_chars: String(packetText ?? '').length,
        observed: [],
      };
      runs.set(envelope.run_id, rec);

      // The send itself runs in the workbench's own runner when called from there; here it is the
      // adapter's send path, which commits the packet and then waits for the turn.
      const tmpDir = path.join(path.resolve(__dirname, '..', '..', 'workbench'), 'temp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const packetFile = path.join(tmpDir, `run-${envelope.run_id}.packet.txt`);
      fs.writeFileSync(packetFile, packetText, 'utf8');

      let sent;
      try {
        sent = cw(['send', packetFile], dispatchOpts.timeoutMs ?? 300000);
      } finally {
        try { fs.unlinkSync(packetFile); } catch { /* best effort */ }
      }

      if (sent.ok === true && sent.sentConfirmed === true) {
        rec.user_turns_after = before.user_turns + 1;
        return {
          ok: true,
          delivery_state: DELIVERY.USER_TURN_CONFIRMED,
          detail: `packet committed and the new user turn was observed (${sent.outcome ?? 'confirmed'})`,
          transport_evidence: { outcome: sent.outcome ?? null, baseline_turns: sent.baselineTurns ?? null },
        };
      }

      // Not confirmed. This is the case the whole state machine exists for.
      return {
        ok: true,
        delivery_state: DELIVERY.SEND_PENDING,
        detail: `the send was executed but the new turn is not observable yet (${sent.outcome ?? sent.status ?? 'no outcome'}). `
          + 'This is not a failure: this transport renders late. Observe; never re-dispatch.',
        transport_evidence: {
          outcome: sent.outcome ?? sent.status ?? null,
          detail: sent.detail ?? sent.error ?? null,
          measurement_failure: sent.measurement_failure === true,
        },
      };
    },

    /**
     * Report what is known about a run. NEVER sends.
     *
     * The only legal action while a run is pending, which is why it is a separate operation rather
     * than a flag on dispatch.
     */
    async observe(envelope) {
      const rec = runs.get(envelope.run_id);
      const now = cw(['user_turns'], 90000);
      if (now.ok !== true || !Number.isFinite(now.user_turns)) {
        return {
          ok: false, delivery_state: DELIVERY.SEND_PENDING, confirmed: false,
          detail: `cannot read the conversation right now (${now.error ?? 'no count'}); still pending, still not a failure`,
        };
      }
      const sample = { at: new Date().toISOString(), user_turns: now.user_turns, assistant_turns: now.assistant_turns ?? null };
      if (rec) rec.observed.push(sample);

      const before = rec?.user_turns_before ?? null;
      const grew = before !== null && now.user_turns > before;
      return {
        ok: true,
        delivery_state: grew ? DELIVERY.USER_TURN_CONFIRMED : DELIVERY.SEND_PENDING,
        confirmed: grew,
        detail: grew
          ? `the packet is in the conversation (user turns ${before} -> ${now.user_turns})`
          : `no new user turn yet (user turns ${before ?? '?'} -> ${now.user_turns}); still pending`,
        observed: sample,
      };
    },

    /** Read the reply text out of the conversation, by the assistant-turn index recorded at dispatch. */
    async read(envelope, readOpts = {}) {
      const rec = runs.get(envelope.run_id);
      const index = readOpts.index ?? rec?.assistant_turns_before ?? null;
      if (index === null) return { ok: false, text: null, detail: 'no assistant-turn index is recorded for this run' };

      const primary = cw(['read', String(index)], 90000);
      if (primary.ok === true && typeof primary.text === 'string' && primary.text.trim()) {
        return { ok: true, text: primary.text, detail: `assistant turn ${index}`, index };
      }

      /**
       * FALLBACK: the newest assistant turn.
       *
       * The index recorded at dispatch is only meaningful while the page renders in step with the
       * conversation. This transport is measured rendering MINUTES late: a dispatch can record
       * `assistant_turns_before = 3` while the page still shows 3 turns, and by the time the answer
       * exists the page may hold 5. Reading at 3 then fails with "index 3 out of range (page has 5)"
       * even though the reply is sitting right there - which is exactly what happened on the first
       * cross-provider run, where the worker had in fact answered correctly.
       *
       * The newest assistant turn is the right fallback because THE CALLER CHECKS `run_id_ack`. A reply
       * belonging to a different run cannot pass correlation, so trying the last turn cannot smuggle a
       * stale answer through - the protocol, not the index, is what guarantees the right answer. Where
       * that guarantee does not exist (no ack in the text), the caller must not accept it, and the
       * cross-provider run records which path produced the text.
       */
      const count = cw(['user_turns'], 90000);
      const present = Number.isFinite(count.assistant_turns) ? count.assistant_turns : null;
      if (present === null || present < 1) {
        return { ok: false, text: null, detail: `index ${index} unavailable and the page reports no assistant turns (${primary.error ?? primary.detail ?? 'no detail'})` };
      }
      const lastIndex = present - 1;
      const fallback = cw(['read', String(lastIndex)], 90000);
      if (fallback.ok === true && typeof fallback.text === 'string' && fallback.text.trim()) {
        return {
          ok: true,
          text: fallback.text,
          detail: `assistant turn ${lastIndex} (index fallback: ${index} was unavailable while the page held ${present})`,
          index: lastIndex,
          index_fallback: true,
        };
      }
      return { ok: false, text: null, detail: `neither index ${index} nor the newest turn (${lastIndex}) could be read: ${fallback.error ?? fallback.detail ?? 'no detail'}` };
    },

    /** Test/诊断 helper: what this transport remembers about a run. */
    _runRecord(runId) { return runs.get(runId) ?? null; },
  };
}

module.exports = { createPlaywrightDomTransport };
