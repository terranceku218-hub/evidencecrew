'use strict';
/**
 * transport.codex-app-server.js - the Codex seat's transport, over the OFFICIAL app-server protocol.
 *
 * INTEGRATION SURFACE DECISION (recorded, per the brief)
 *
 *   CHOSEN: `codex app-server`, a JSON-RPC 2.0 service over stdio. Verified by generating its own
 *   protocol schema (`codex app-server generate-json-schema`), which exposes `initialize`,
 *   `thread/start`, `turn/start`, `turn/interrupt`, `review/start` and `account/read` as typed
 *   methods with published parameter and response definitions.
 *
 *   REJECTED: CLI stdout scraping. `codex exec` prints human-formatted text; parsing it would break on
 *   any cosmetic change and would give no stable correlation identity. The brief forbade it, and the
 *   app-server makes the prohibition easy to honour.
 *
 *   REJECTED: GUI / Codex App UI automation. No machine-readable protocol, and it would drive the
 *   user's desktop.
 *
 *   ALSO AVAILABLE AND NOT USED: `codex mcp-server` (Codex as an MCP server) would suit a future MCP
 *   transport. Not needed here, and adding it now would be a second integration with no second seat.
 *
 * WHY THIS GIVES STABLE CORRELATION (the point of Phase 4)
 *   The protocol RETURNS `thread.id` from `thread/start` and `turn.id` from `turn/start`, and every
 *   completion notification carries BOTH. So a run's identity is bound to a specific app-server thread
 *   and turn as DATA, not inferred from "the most recent reply". That is the stable
 *   run_id <-> thread/turn mapping the brief requires, and it is why this transport can report
 *   USER_TURN_CONFIRMED the moment `turn/start` returns rather than by watching a page.
 *
 * THE CONFIG PROBLEM, HANDLED WITHOUT TOUCHING THE USER'S FILES
 *   `~/.codex/config.toml` currently sets `model_reasoning_effort = "ultra"`, which the CLI rejects
 *   (it accepts none|minimal|low|medium|high|xhigh), so EVERY codex command fails at startup. That is a
 *   pre-existing condition, not something this work introduced, and editing the user's config was not
 *   authorised. The transport therefore runs the app server under an ISOLATED CODEX_HOME containing a
 *   copied auth.json and a minimal valid config. The user's own config and login are never modified.
 *
 * ZERO DEPENDENCIES. node:child_process only, newline-delimited JSON-RPC over stdin/stdout.
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { DELIVERY } = require('../protocol/transport-contract.js');

const WB = path.resolve(__dirname, '..', '..', 'workbench');
const REAL_CODEX_HOME = path.resolve(require('node:os').homedir(), '.codex');

/**
 * WHERE THE LAUNCHER AND HOME COME FROM (revised after the isolated upgrade validation)
 *
 * The globally installed codex-cli 0.120.0 could not complete a turn: it failed to decode its own
 * model-metadata response (`unknown variant 'max'`), so every turn ended `failed` with an empty
 * rollout. An isolated side-by-side install of 0.155.1 was validated in `agent-workspaces\codex-lab`
 * and completes turns normally, with zero stderr.
 *
 * So the defaults now point at that VALIDATED LAB, and the schema was re-checked for compatibility
 * first: all of `initialize`, `account/read`, `thread/start`, `turn/start`, `thread/read`,
 * `turn/interrupt` and `review/start` are present, `TurnStartParams` still requires `input`+`threadId`,
 * and `TurnStatus` is unchanged. No seat-contract change was needed or made.
 *
 * Overridable by environment so the choice is configuration rather than something baked in.
 */
const LAB_ROOT = path.resolve(require('node:os').homedir(), '.dsh', 'agent-workspaces', 'codex-lab');
const LAB_HOME = path.join(LAB_ROOT, 'home');
const LAB_LAUNCHER = path.join(LAB_ROOT, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
const ISOLATED_HOME = process.env.AWB_CODEX_HOME ?? LAB_HOME;

/**
 * The isolated CODEX_HOME.
 *
 * Uses the lab home when it exists (validated 0.155.1 + reused auth), otherwise falls back to building
 * one under the workbench, so the transport still works if the lab is removed. The real ~/.codex is
 * never modified in either case.
 */
function ensureIsolatedHome() {
  if (fs.existsSync(path.join(ISOLATED_HOME, 'auth.json'))) return ISOLATED_HOME;

  fs.mkdirSync(ISOLATED_HOME, { recursive: true });
  const srcAuth = path.join(REAL_CODEX_HOME, 'auth.json');
  const dstAuth = path.join(ISOLATED_HOME, 'auth.json');
  if (!fs.existsSync(dstAuth) && fs.existsSync(srcAuth)) fs.copyFileSync(srcAuth, dstAuth);

  const cfg = path.join(ISOLATED_HOME, 'config.toml');
  if (!fs.existsSync(cfg)) {
    fs.writeFileSync(cfg, [
      '# Isolated Codex home for the EvidenceCrew reviewer seat.',
      '# The real ~/.codex/config.toml is never modified.',
      '#',
      '# WHY A COPY OF THE HOME EXISTS AT ALL',
      '#   The user config sets model_reasoning_effort = "ultra", which the CLI rejects, so every',
      '#   codex command aborts before doing anything. Rather than edit a file we were not authorised',
      '#   to touch, the app server runs against this isolated home. Authentication is reused by',
      '#   copying auth.json; no credential is created or exposed.',
      '#',
      '# xhigh, not ultra: the goal is a turn that completes, not a demonstration of Ultra.',
      'model = "gpt-5.6-sol"',
      'model_reasoning_effort = "xhigh"',
      '',
      '# The reviewer seat must not be able to change anything. These are the transport-level',
      '# defaults; the seat ALSO binds an empty write scope in its envelope, so the restriction is',
      '# stated twice on purpose.',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      '',
    ].join('\n'), 'utf8');
  }
  return ISOLATED_HOME;
}

/**
 * Resolve the codex launcher: the validated lab install first, then the global one.
 *
 * Returning the lab launcher is what makes this transport usable on this machine; the global 0.120.0
 * is left installed and untouched, and remains the fallback for a machine without a lab.
 */
function codexLauncher() {
  const candidates = [
    process.env.AWB_CODEX_LAUNCHER,
    LAB_LAUNCHER,
    path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    path.join(process.env.APPDATA ?? '', 'npm', 'codex.cmd'),
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/**
 * A minimal JSON-RPC 2.0 client over a child process's stdio.
 *
 * Server notifications arrive unsolicited on stdout interleaved with responses, so they are routed to
 * listeners by method name. This is the only piece of protocol plumbing this transport needs.
 */
function createRpc(child, opts = {}) {
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  let buffer = '';
  const log = opts.log ?? (() => {});

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { log(`non-JSON line on stdout: ${line.slice(0, 160)}`); continue; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
        continue;
      }
      if (msg.method) {
        for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
        for (const fn of listeners.get('*') ?? []) fn(msg);
      }
    }
  });

  return {
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    call(method, params, timeoutMs = 120000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`app-server did not answer ${method} within ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
      return () => {
        const arr = listeners.get(method) ?? [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      };
    },
    get inflight() { return pending.size; },
  };
}

/** Extract the assistant text from a completed turn's items. */
function textFromTurn(turn) {
  const parts = [];
  for (const item of turn?.items ?? []) {
    // The protocol names the assistant's message item; accept the known spellings rather than
    // assuming one, because this is an experimental surface and the name has moved before.
    const type = item?.type ?? item?.kind ?? '';
    if (/agentMessage|assistantMessage|message/i.test(String(type))) {
      if (typeof item.text === 'string') parts.push(item.text);
      else if (Array.isArray(item.content)) {
        for (const c of item.content) if (typeof c?.text === 'string') parts.push(c.text);
      }
    }
  }
  return parts.join('\n').trim();
}

/**
 * @param {{id?, model?, cwd?, log?}} opts
 */
function createCodexAppServerTransport(opts = {}) {
  const model = opts.model ?? 'gpt-5.6-sol';
  const launcher = codexLauncher();
  if (!launcher) {
    return { ok: false, error: 'the codex CLI launcher could not be located' };
  }
  const home = ensureIsolatedHome();

  let child = null;
  let rpc = null;
  let initialised = false;
  const account = { authenticated: null, mode: null };
  /** run_id -> { threadId, turnId, status, text, completedAt, notifications } */
  const runs = new Map();
  /** threadId -> run_id, so a notification can be attributed without guessing. */
  const threadToRun = new Map();
  const log = opts.log ?? ((m) => process.stderr.write(`[codex-transport] ${m}\n`));

  async function start() {
    if (child) return { ok: true, already: true };
    const env = { ...process.env, CODEX_HOME: home };
    child = spawn(process.execPath, [launcher, 'app-server', '--listen', 'stdio://'], {
      env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => log(`stderr: ${String(d).trim().slice(0, 300)}`));
    child.on('exit', (code, signal) => {
      log(`app-server exited code=${code} signal=${signal}`);
      child = null; rpc = null; initialised = false;
    });

    rpc = createRpc(child, { log });

    // Turn completion is attributed by THREAD ID, which the protocol returns at thread creation. That
    // binding is the correlation mechanism; nothing here looks at "the latest" anything.
    rpc.on('turn/completed', (p) => {
      const runId = threadToRun.get(p?.threadId);
      if (!runId) { log(`turn/completed for an unknown thread ${p?.threadId}`); return; }
      const rec = runs.get(runId);
      if (!rec) return;
      rec.status = p.turn?.status ?? 'completed';
      rec.text = textFromTurn(p.turn);
      rec.completedAt = new Date().toISOString();
      rec.delivery_state = rec.status === 'completed' ? DELIVERY.COMPLETE : DELIVERY.SEND_UNCERTAIN;
    });

    const init = await rpc.call('initialize', {
      clientInfo: { name: 'evidencecrew', title: 'EvidenceCrew reviewer seat', version: '0.2.1' },
    }, 60000);
    rpc.notify('initialized', {});
    initialised = true;

    try {
      const acc = await rpc.call('account/read', { refreshToken: false }, 30000);
      account.authenticated = !!(acc?.account);
      account.mode = acc?.account?.type ?? null;
    } catch (e) {
      log(`account/read failed: ${e.message}`);
    }

    return { ok: true, protocol: init?.protocolVersion ?? null, account };
  }

  return {
    id: opts.id ?? `codex-app-server:${model}`,
    kind: 'codex-app-server',
    provider: 'openai-codex',
    sourceFile: __filename,
    defaultRenderer: 'structured',
    model,
    codex_home: home,

    capabilities: {
      // One request, one structured answer, with the thread and turn ids returned as data.
      can_deliver_synchronously: true,
      confirms_delivery: true,
      supports_readback: true,
      needs_human: false,
      /** Codex CAN read files itself, so the packet need not carry content. */
      supplies_source_content: true,
      /** It can run read-only commands, which is what makes a static review meaningful. */
      can_run_commands: true,
      supports_structured_output: true,
      notes: `Codex ${model} over the official app-server JSON-RPC protocol. Thread and turn ids are `
        + 'returned by the protocol, so run correlation is bound as data rather than inferred. '
        + 'The seat is sandboxed read-only.',
    },

    async open() {
      const r = await start();
      return { ok: r.ok, detail: r.ok ? `app-server ready (account=${account.mode ?? 'unknown'})` : r.error };
    },

    async health() {
      try {
        if (!child) await start();
        const acc = await rpc.call('account/read', { refreshToken: false }, 30000);
        const ok = !!(acc?.account);
        account.authenticated = ok;
        account.mode = acc?.account?.type ?? null;
        return {
          ok, status: ok ? 'READY' : 'BLOCKED',
          detail: ok ? `app-server reachable, authenticated as ${account.mode}` : 'app-server reachable but no account is signed in',
          checked_at: new Date().toISOString(),
        };
      } catch (e) {
        return { ok: false, status: 'ERROR', detail: e.message, checked_at: new Date().toISOString() };
      }
    },

    /**
     * Dispatch a packet as a new thread and turn.
     *
     * Returns as soon as the protocol has acknowledged the turn, with the ids recorded. Delivery is
     * confirmed at that point because the app server returned a turn id - there is no page to wait for.
     */
    async dispatch(envelope, packetText, dispatchOpts = {}) {
      const started = Date.now();
      try {
        if (!child) await start();

        const thread = await rpc.call('thread/start', {
          model,
          cwd: dispatchOpts.cwd ?? opts.cwd ?? process.cwd(),
          // The reviewer seat is read-only, stated at the transport level as well as in the envelope.
          sandbox: 'read-only',
          approvalPolicy: 'never',
        }, 120000);
        const threadId = thread?.thread?.id;
        if (!threadId) return { ok: false, delivery_state: DELIVERY.SEND_UNCERTAIN, detail: 'app-server returned no thread id' };

        const turn = await rpc.call('turn/start', {
          threadId,
          input: [{ type: 'text', text: packetText }],
          model,
        }, 120000);
        const turnId = turn?.turn?.id;

        runs.set(envelope.run_id, {
          run_id: envelope.run_id, threadId, turnId,
          dispatched_at: new Date().toISOString(),
          status: 'inProgress', text: null, delivery_state: DELIVERY.USER_TURN_CONFIRMED,
        });
        threadToRun.set(threadId, envelope.run_id);

        return {
          ok: true,
          delivery_state: DELIVERY.USER_TURN_CONFIRMED,
          detail: `turn accepted by the app server (thread ${threadId})`,
          transport_evidence: {
            thread_id: threadId, turn_id: turnId ?? null,
            model: thread?.model ?? model, sandbox: thread?.sandbox ?? 'read-only',
            latency_ms: Date.now() - started,
          },
        };
      } catch (e) {
        return { ok: false, delivery_state: DELIVERY.SEND_UNCERTAIN, detail: e.message, transport_evidence: { latency_ms: Date.now() - started } };
      }
    },

    async observe(envelope) {
      const rec = runs.get(envelope.run_id);
      if (!rec) return { ok: false, delivery_state: DELIVERY.SEND_UNCERTAIN, confirmed: false, detail: 'this run has no app-server thread' };
      if (rec.delivery_state === DELIVERY.COMPLETE) {
        return { ok: true, delivery_state: DELIVERY.COMPLETE, confirmed: true, detail: 'the turn completed' };
      }
      try {
        const read = await rpc.call('thread/read', { threadId: rec.threadId }, 60000);
        const turns = read?.thread?.turns ?? [];
        const last = turns[turns.length - 1];
        if (last && last.status && last.status !== 'inProgress') {
          rec.status = last.status;
          rec.text = textFromTurn(last);
          rec.delivery_state = last.status === 'completed' ? DELIVERY.COMPLETE : DELIVERY.SEND_UNCERTAIN;
        }
      } catch (e) {
        log(`thread/read failed: ${e.message}`);
      }
      return { ok: true, delivery_state: rec.delivery_state, confirmed: true, detail: `turn status ${rec.status}` };
    },

    async read(envelope) {
      const rec = runs.get(envelope.run_id);
      if (!rec) return { ok: false, text: null, detail: 'this run has no app-server thread' };
      if (typeof rec.text === 'string' && rec.text) {
        return { ok: true, text: rec.text, detail: `thread ${rec.threadId}`, thread_id: rec.threadId, turn_id: rec.turnId };
      }
      // Fall back to reading the thread, so a missed notification still yields the answer.
      try {
        const read = await rpc.call('thread/read', { threadId: rec.threadId }, 60000);
        const turns = read?.thread?.turns ?? [];
        const last = turns[turns.length - 1];
        const text = textFromTurn(last);
        if (text) { rec.text = text; return { ok: true, text, detail: `thread ${rec.threadId} (read back)`, thread_id: rec.threadId, turn_id: last?.id ?? null }; }
      } catch { /* reported below */ }
      return { ok: false, text: null, detail: `no assistant text available for thread ${rec.threadId} (status ${rec.status})`, thread_id: rec.threadId };
    },

    /** Stable correlation identity for an Evidence Record. Data, never an inference. */
    correlationOf(runId) {
      const rec = runs.get(runId);
      return rec ? { thread_id: rec.threadId, turn_id: rec.turnId } : null;
    },

    async close() {
      if (child) { try { child.kill(); } catch { /* already gone */ } child = null; rpc = null; initialised = false; }
      return { ok: true };
    },

    _debug() { return { initialised, inflight: rpc ? rpc.inflight : 0, runs: runs.size, home, account }; },
  };
}

module.exports = { createCodexAppServerTransport, ensureIsolatedHome, codexLauncher, textFromTurn, ISOLATED_HOME };
