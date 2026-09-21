'use strict';
/**
 * transport.openai-http.js - a synchronous HTTP transport for any OpenAI-compatible endpoint.
 *
 * WHY THIS ONE MATTERS
 *   It is the transport that looks NOTHING like the browser one: a URL, a bearer token, a single
 *   request that returns the whole answer. If the seat layer works unchanged across this and the
 *   DOM-scraping transport, then the abstraction is real and the remaining differences are data
 *   (a base url, a model name) rather than code.
 *
 * IT IS ALSO THE ONE THAT LIES MOST EASILY
 *   A synchronous transport has no SEND_PENDING state to report, and it is tempting to let it skip
 *   the delivery state machine entirely. That temptation is refused here: this transport still
 *   walks IDLE -> SUBMITTING -> USER_TURN_CONFIRMED -> COMPLETE explicitly. Behaviour differs
 *   between transports; the vocabulary does not. That is what makes the states comparable at all.
 *
 * NO SDK, NO DEPENDENCIES
 *   node:https only, matching the zero-dependency rule of the rest of the stack. An OpenAI-compatible
 *   surface is small enough that a dependency would cost more than it saves.
 *
 * STATUS: this transport is implemented and conformance-tested against a local stub server. It has
 * NOT been exercised against a paid provider, because no API key exists in this environment. Nothing
 * in the UI or README may claim otherwise.
 */

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

const { DELIVERY } = require('../protocol/transport-contract.js');

/** POST JSON and return the parsed body, with a real timeout rather than a hanging socket. */
function postJson(urlString, body, headers, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlString); } catch (e) { return resolve({ ok: false, error: `bad url: ${e.message}` }); }
    const lib = u.protocol === 'http:' ? http : https;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');

    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length, ...headers },
      timeout: timeoutMs,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; if (text.length > 4_000_000) req.destroy(); });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}: ${text.slice(0, 300)}` });
        }
        try { resolve({ ok: true, status: res.statusCode, json: JSON.parse(text) }); }
        catch { resolve({ ok: false, status: res.statusCode, error: `response was not JSON: ${text.slice(0, 200)}` }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: `no response within ${timeoutMs}ms` }); });
    req.write(payload);
    req.end();
  });
}

/**
 * @param {{id?, provider?, baseUrl, apiKey?, model, path?, timeoutMs?, extraHeaders?}} opts
 */
function createOpenAiHttpTransport(opts = {}) {
  const baseUrl = opts.baseUrl;
  const model = opts.model;
  const apiKey = opts.apiKey ?? null;
  const apiPath = opts.path ?? '/v1/chat/completions';
  const timeoutMs = opts.timeoutMs ?? 180000;

  /** run_id -> the answer text once it exists. Only this transport knows how it got one. */
  const replies = new Map();

  if (!baseUrl) throw new Error('openai-http transport requires a baseUrl');
  if (!model) throw new Error('openai-http transport requires a model');

  function headers() {
    const h = { ...(opts.extraHeaders ?? {}) };
    // A key is optional: a local endpoint commonly needs none. Never log or return it.
    if (apiKey) h.authorization = `Bearer ${apiKey}`;
    return h;
  }

  function extractText(json) {
    const choice = json?.choices?.[0];
    const msg = choice?.message?.content;
    if (typeof msg === 'string') return msg;
    // Some compatible servers return content parts.
    if (Array.isArray(msg)) return msg.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
    if (typeof choice?.text === 'string') return choice.text;
    return null;
  }

  return {
    id: opts.id ?? `openai-http:${model}`,
    kind: 'openai-http',
    provider: opts.provider ?? 'openai-compatible',
    sourceFile: __filename,
    defaultRenderer: 'structured',

    capabilities: {
      // The defining difference from the browser transport, stated as capability rather than
      // inferred from the transport's identity.
      can_deliver_synchronously: true,
      confirms_delivery: true,
      supports_readback: true,
      needs_human: false,
      notes: 'One request returns the whole answer, so delivery and completion arrive together.',
    },

    async open() {
      // A synchronous HTTP transport has no session to open; proving reachability is the honest
      // equivalent, and it keeps `open` from being a lie that returns OK unconditionally.
      const h = await this.health();
      return { ok: h.ok, detail: h.detail ?? 'reachable' };
    },

    async health() {
      // A HEAD-style probe is not portable across compatible servers, so health is inferred from a
      // deliberately tiny completion. That costs one request, which is the honest price of knowing.
      const r = await postJson(`${baseUrl}${apiPath}`, {
        model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1,
      }, headers(), Math.min(timeoutMs, 20000));
      return {
        ok: r.ok,
        status: r.ok ? 'READY' : 'ERROR',
        detail: r.ok ? `reachable at ${baseUrl}` : (r.error ?? 'unreachable'),
        checked_at: new Date().toISOString(),
      };
    },

    /**
     * Send the packet. This transport CAN answer synchronously, so it does - but it still reports an
     * explicit delivery state rather than an implicit success, so the layer above needs no special
     * case for it.
     */
    async dispatch(envelope, packetText) {
      const r = await postJson(`${baseUrl}${apiPath}`, {
        model,
        messages: [{ role: 'user', content: packetText }],
      }, headers(), timeoutMs);

      if (!r.ok) {
        return {
          ok: false,
          delivery_state: DELIVERY.SEND_UNCERTAIN,
          detail: `the request did not complete (${r.error}). Treat as uncertain: a request that failed `
            + 'locally may still have reached the provider.',
          transport_evidence: { status: r.status ?? null, error: r.error },
        };
      }

      const text = extractText(r.json);
      if (typeof text !== 'string' || !text.trim()) {
        return {
          ok: false, delivery_state: DELIVERY.ASSISTANT_PENDING,
          detail: 'the provider answered but produced no readable text',
          transport_evidence: { raw_keys: Object.keys(r.json ?? {}).slice(0, 8) },
        };
      }

      replies.set(envelope.run_id, text);
      return {
        ok: true,
        delivery_state: DELIVERY.USER_TURN_CONFIRMED,
        detail: 'request accepted and answered',
        transport_evidence: { model: r.json?.model ?? model, usage: r.json?.usage ?? null },
      };
    },

    async observe(envelope) {
      const text = replies.get(envelope.run_id);
      if (typeof text === 'string') {
        return { ok: true, delivery_state: DELIVERY.COMPLETE, confirmed: true, detail: 'the answer is available' };
      }
      // No stored answer and nothing to poll: this transport cannot observe an in-flight request it
      // has already returned from. Saying so is better than pretending it might arrive.
      return {
        ok: true, delivery_state: DELIVERY.SEND_UNCERTAIN, confirmed: false,
        detail: 'this transport does not retain in-flight requests; no answer was stored for this run',
      };
    },

    async read(envelope) {
      const text = replies.get(envelope.run_id);
      if (typeof text !== 'string') return { ok: false, text: null, detail: 'no answer stored for this run' };
      return { ok: true, text, detail: `reply from ${model}` };
    },

    _reset() { replies.clear(); },
  };
}

module.exports = { createOpenAiHttpTransport, postJson };
