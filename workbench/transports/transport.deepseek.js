'use strict';
/**
 * transport.deepseek.js - the DeepSeek seat's transport.
 *
 * WHY THIS IS THIN INSTEAD OF A NEW CLIENT
 *   V0.2 already built and conformance-tested an OpenAI-compatible HTTP transport. DeepSeek's
 *   official API speaks the same surface, which was verified directly before this file was written:
 *   `GET /models` on https://api.deepseek.com returns exactly the model ids this deployment is
 *   configured with (`deepseek-flash`, `deepseek-v4-pro`), and a completion round-trips in under a
 *   second. So this file is a CONFIGURATION of the existing transport, not a second implementation.
 *   Writing a DeepSeek-specific client would have duplicated the HTTP handling and, worse, started
 *   the seat layer down the road of special-casing a provider.
 *
 * WHAT IS ACTUALLY DIFFERENT ABOUT DEEPSEEK, AND WHERE THAT LIVES
 *   Three things, and all three are capability or configuration rather than branch logic:
 *     1. It is a REASONING model. Measured: a 20-token budget produced ZERO visible content because
 *        all 20 tokens went to `reasoning_tokens`. So the token budget must be generous, and the
 *        transport must be able to see that it was truncated rather than report an empty answer.
 *     2. It is synchronous AND reliable: one request, one answer.
 *     3. It needs a credential, which this deployment keeps in .credentials.yaml rather than in the
 *        environment.
 *
 * THE CREDENTIAL IS NEVER LOGGED
 *   Only its presence and length are reportable. A leaked prefix is still a leaked secret, so no
 *   part of the value is written to a log, an evidence record, or an error message.
 */

const fs = require('node:fs');
const path = require('node:path');

const { createOpenAiHttpTransport } = require('./transport.openai-http.js');

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const CREDENTIALS_FILE = path.resolve(require('node:os').homedir(), '.dsh', '.credentials.yaml');

/**
 * Read a named credential from the DSH credentials file.
 *
 * The file is FLOW-STYLE (`{ KEY: value }` on one line), which is why the value is captured up to
 * whitespace or the closing brace: a block-style `\S+\s*$` pattern silently matches nothing here.
 * That mistake cost one probe run; it is recorded because the failure mode is a mystery "no key".
 */
function loadCredential(name) {
  /**
   * PUBLIC RELEASE ADDITION: the environment wins over the file.
   *
   * The credential file stays the documented default, because that is where this stack has always kept
   * it and a local file does not end up in a shell history or a CI variable list. But a container, a CI
   * runner or a scheduled task has no interactive prompt to write that file, and an API key that can
   * only be supplied one way is a key somebody will end up hard-coding instead.
   */
  const fromEnv = process.env[name];
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return { ok: true, value: fromEnv.trim(), source: 'environment' };
  }
  if (process.env[name]) return { ok: true, value: process.env[name], source: 'environment' };
  if (!fs.existsSync(CREDENTIALS_FILE)) return { ok: false, error: `no credential file at ${CREDENTIALS_FILE}` };
  const raw = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
  const m = raw.match(new RegExp(`${name}\\s*:\\s*([^\\s}]+)`));
  if (!m) return { ok: false, error: `${name} is not present in the credential file` };
  return { ok: true, value: m[1], source: 'credentials file' };
}

/**
 * Build the DeepSeek transport.
 *
 * @param {{id?, model?, baseUrl?, maxTokens?, timeoutMs?, jsonMode?}} opts
 */
function createDeepSeekTransport(opts = {}) {
  const model = opts.model ?? 'deepseek-flash';
  const baseUrl = opts.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL;
  // Generous by default BECAUSE IT IS A REASONING MODEL: a small budget silently produces an empty
  // string, which would look like a broken transport rather than a truncated one.
  const maxTokens = opts.maxTokens ?? 16000;

  const cred = loadCredential('DEEPSEEK_API_KEY');
  if (!cred.ok) {
    return {
      ok: false,
      error: `DeepSeek credential unavailable: ${cred.error}`,
      id: `deepseek:${model}`,
    };
  }

  const inner = createOpenAiHttpTransport({
    id: opts.id ?? `deepseek-http:${model}`,
    provider: 'deepseek',
    baseUrl,
    model,
    apiKey: cred.value,
    timeoutMs: opts.timeoutMs ?? 180000,
    extraHeaders: opts.extraHeaders,
  });

  /**
   * Wrap the inner transport so the deepseek-specific facts are surfaced as capability and as
   * evidence, never as a branch in a caller.
   */
  return {
    ...inner,
    kind: 'deepseek-api',
    provider: 'deepseek',
    sourceFile: __filename,
    credential_source: cred.source,
    model,

    capabilities: {
      ...inner.capabilities,
      // Stated explicitly so the orchestrator can adapt WITHOUT knowing the provider name.
      can_deliver_synchronously: true,
      confirms_delivery: true,
      supports_readback: true,
      needs_human: false,
      is_reasoning_model: true,
      consumes_reasoning_tokens: true,
      notes: `DeepSeek ${model} over the official OpenAI-compatible API. Synchronous and reliable; `
        + 'it is a reasoning model, so the token budget must accommodate hidden reasoning tokens '
        + 'before any visible content is produced.',
    },

    async dispatch(envelope, packetText, dispatchOpts = {}) {
      const started = Date.now();
      const r = await inner.dispatch(envelope, packetText, { ...dispatchOpts, maxTokens });
      return {
        ...r,
        transport_evidence: {
          ...(r.transport_evidence ?? {}),
          latency_ms: Date.now() - started,
          reasoning_model: true,
          credential_source: cred.source,
        },
      };
    },

    /**
     * The inner transport reports "answered but produced no readable text" when a reasoning model
     * exhausts its budget. That is a TRUNCATION, not a silent empty answer, and saying so is the
     * difference between a debuggable failure and a mystery.
     */
    async read(envelope) {
      const r = await inner.read(envelope);
      if (r.ok) return r;
      return {
        ...r,
        detail: `${r.detail ?? 'no answer'} (model ${model} is a reasoning model: if this was an empty `
          + 'completion, the token budget was consumed by reasoning tokens rather than by content)',
      };
    },

    /** Test/diagnostic helper. Never exposes the credential. */
    _credentialInfo() {
      return { present: true, source: cred.source, length: cred.value.length };
    },
  };
}

module.exports = { createDeepSeekTransport, loadCredential, DEFAULT_BASE_URL };
