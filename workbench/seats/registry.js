'use strict';
/**
 * registry.js - the seats that actually exist, and how they are built.
 *
 * WHY A REGISTRY AND NOT HARD-CODED SEATS
 *   The claim under test is that a seat is independent of its provider and transport. The cheapest
 *   way to falsify that claim is to have the seat list wire providers together in code. So seats are
 *   built from a declaration: a role, a provider, a transport and its connection details. Adding a
 *   provider is editing a declaration, and the only code that runs is the transport's.
 *
 * WHAT IS DECLARED HERE IS WHAT EXISTS
 *   V0.2 declares exactly the seats it can actually run: one ChatGPT seat over the browser DOM
 *   transport, one human operator seat, and an OpenAI-compatible HTTP seat that is configured but
 *   NOT connected (no credentials exist in this environment). The unconnected one is registered so
 *   the shape is real and conformance-tested, and it is flagged `connected: false` so nothing in the
 *   UI or a README can present it as working.
 */

const path = require('node:path');

const { createSeat, ROLES } = require('./seat.js');
const { createPlaywrightDomTransport } = require(path.join(__dirname, '..', 'transports', 'transport.playwright-dom.js'));
const { createHumanTransport } = require(path.join(__dirname, '..', 'transports', 'transport.human.js'));
const { createOpenAiHttpTransport } = require(path.join(__dirname, '..', 'transports', 'transport.openai-http.js'));
const { createDeepSeekTransport, loadCredential } = require(path.join(__dirname, '..', 'transports', 'transport.deepseek.js'));
const contract = require('../protocol/transport-contract.js');

/**
 * Whether DeepSeek can actually be reached from here.
 *
 * Checked once, at registry build time, so the seat is either genuinely available or reported with the
 * reason. A seat that silently fails on first use is worse than one that says up front it is not wired.
 */
function deepseekAvailability() {
  const cred = loadCredential('DEEPSEEK_API_KEY');
  if (!cred.ok) return { ok: false, reason: cred.error };
  try {
    const t = createDeepSeekTransport({ id: 'probe' });
    if (t.ok === false) return { ok: false, reason: t.error };
    return { ok: true, credential_source: cred.source };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * Seat declarations.
 *
 * `connected` is the honesty field: it says whether this seat can be used right now. A declaration
 * with connected:false exists to keep the schema and the contract honest, and must never be
 * presented as an available seat.
 */
const DECLARATIONS = [
  {
    seat_id: 'seat:demo/default/supervisor',
    role: ROLES.SUPERVISOR,
    provider: 'deepseek',
    transport: 'deepseek-api',
    connected: true,
    why: 'The Supervisor seat, on DeepSeek over its official OpenAI-compatible API. This is the second '
      + 'REAL AI provider in the roster, and the one a demo should lead with: it plans, generates the '
      + 'Verified Task Envelope, and reviews the worker result.',
    connection: {
      model: process.env.AWB_DEEPSEEK_MODEL || 'deepseek-flash',
      baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    },
    permissions: {
      // A supervisor PLANS and REVIEWS. It is given no write scope at all, so it cannot become a
      // back door around the worker's own permissions.
      read_scope: [], write_scope: [], deny: ['*'], approval_required: [],
    },
    contextLimit: 1000000,
    rotationThreshold: null,
  },
  {
    seat_id: 'seat:demo/default/coder',
    role: ROLES.CODER,
    provider: 'chatgpt',
    transport: 'playwright-dom',
    connected: true,
    why: 'The verified ChatGPT browser worker. Existing, working, and the only automated seat with a live conversation.',
    connection: { workerId: process.env.AWB_WORKER_ID || 'GPT-WORKER-demo-default-001' },
    permissions: {
      read_scope: ['src/hud-pulse.js', 'src/hud-pulse.fixed.js'],
      write_scope: ['src/hud-pulse.js'],
      deny: ['*.meta', 'ProjectSettings/**'],
      approval_required: ['src/hud-pulse.js'],
    },
    contextLimit: 8,
    rotationThreshold: 8,
  },
  {
    seat_id: 'seat:demo/default/human-supervisor',
    role: ROLES.SUPERVISOR,
    provider: 'human',
    transport: 'human',
    connected: true,
    why: 'A human supervisor. Kept deliberately: useful for manual approval, manual input, debugging and '
      + 'offline tests. It is no longer the primary supervisor a demo should show - DeepSeek is - and its '
      + 'distinct seat id keeps it from colliding with the DeepSeek supervisor.',
    connection: {},
    permissions: { read_scope: [], write_scope: [], deny: [], approval_required: [] },
    contextLimit: null,
    rotationThreshold: null,
  },
  {
    seat_id: 'seat:demo/default/researcher',
    role: ROLES.RESEARCHER,
    provider: 'human',
    transport: 'human',
    connected: true,
    why: 'A read-only research seat. A human operator is the correct transport for a read-only task '
      + 'whose answer needs no code execution, and it gives V0.2 a worker seat that is NOT the browser - '
      + 'which is the point of the demonstration.',
    connection: {},
    permissions: {
      read_scope: ['src/hud-pulse.js', 'src/hud-pulse.fixed.js'],
      // Read-only on purpose. A research seat that could write would blur the boundary this whole
      // version exists to make explicit.
      write_scope: [],
      deny: ['*'],
      approval_required: [],
    },
    contextLimit: null,
    rotationThreshold: null,
  },
  {
    seat_id: 'seat:demo/default/reviewer-codex',
    role: ROLES.REVIEWER,
    provider: 'openai-codex',
    transport: 'codex-app-server',
    /**
     * CONNECTED as of the isolated upgrade validation.
     *
     * The global codex-cli 0.120.0 could not complete a turn (it failed to decode its own model
     * metadata: `unknown variant 'max'`). A side-by-side isolated install of 0.155.1 in
     * `agent-workspaces\codex-lab` was validated by a minimal probe - initialize, account/read,
     * thread/start, turn/start, turn/completed, output `CODEX-SEAT-OK`, ZERO stderr bytes - and the
     * app-server schema was re-checked for compatibility before the transport was pointed at it.
     * The global 0.120.0 install is untouched.
     */
    connected: true,
    connection: {
      model: process.env.AWB_CODEX_MODEL || 'gpt-5.6-sol',
      cwd: (process.env.AWB_PROJECT_ROOT || path.resolve(__dirname, '..', '..', 'examples', 'demo-project')),
    },
    why: 'Codex independent reviewer. Reads the repository itself, runs safe static commands, and '
      + 'writes nothing. Connected over the validated isolated 0.155.1 app-server install.',
    // Phase 3 permissions, recorded as declared intent so the shape is right the moment it connects.
    permissions: {
      read_scope: ['src/hud-pulse.js', 'src/hud-pulse.fixed.js'],
      // A reviewer writes NOTHING. Stated as an empty write scope plus a deny-all, and the transport
      // additionally runs the app server sandboxed read-only, so the restriction holds at three levels.
      write_scope: [],
      deny: ['*', 'git commit', 'git push', 'git reset', 'git clean', 'config.toml', 'ProjectSettings/**'],
      approval_required: [],
    },
    /**
     * DECLARATION ONLY - THIS FIELD HAS NO EFFECT, AND SAYS SO ON PURPOSE.
     *
     * Measured: this object is written here and read nowhere. `buildRegistry` does not pass it to
     * `createSeat`, so a seat's `capabilities` come from its TRANSPORT (plus an explicit
     * `capabilities` override), which is the only source that cannot drift from what the transport
     * actually does. These six flags describe what a reader of the repository would expect a reviewer to
     * be able to do, and they are kept as intent rather than deleted, because the alternative is worse:
     * a reader who finds no capability list at all will assume the seat can do anything.
     *
     * The trap this comment removes is a reader believing it takes effect. If you want to change what a
     * seat can do, change its transport's declared capabilities - see docs/AGENT_SEAT.md section 4.
     */
    declared_capabilities: {
      can_read_files: true,
      can_read_git_diff: true,
      can_run_safe_tests: true,
      can_write_files: false,
      can_commit: false,
      can_push: false,
    },
    contextLimit: null,
    rotationThreshold: null,
  },
  {
    seat_id: 'seat:demo/default/reviewer-http',
    role: ROLES.REVIEWER,
    provider: 'openai-compatible',
    transport: 'openai-http',
    // NO CREDENTIALS EXIST IN THIS ENVIRONMENT. Declared so the schema and contract are exercised;
    // never presented as usable.
    connected: false,
    why: 'A synchronous HTTP seat. Declared to prove the seat shape is not browser-shaped, but NOT '
      + 'connected: this environment has no provider credentials.',
    connection: {
      baseUrl: process.env.AWB_HTTP_BASE_URL || null,
      model: process.env.AWB_HTTP_MODEL || null,
      apiKey: process.env.AWB_HTTP_API_KEY || null,
    },
    permissions: { read_scope: [], write_scope: [], deny: [], approval_required: [] },
    contextLimit: null,
    rotationThreshold: null,
  },
];

/** Build the transport for a declaration, or explain why it cannot be built. */
function buildTransport(decl) {
  const c = decl.connection ?? {};
  if (decl.transport === 'playwright-dom') {
    return { ok: true, transport: createPlaywrightDomTransport({ id: `pw-dom:${c.workerId}`, workerId: c.workerId, provider: decl.provider }) };
  }
  if (decl.transport === 'human') {
    return { ok: true, transport: createHumanTransport({ id: `human:${decl.seat_id}`, provider: decl.provider }) };
  }
  if (decl.transport === 'codex-app-server') {
    const { createCodexAppServerTransport } = require(path.join(__dirname, '..', 'transports', 'transport.codex-app-server.js'));
    const t = createCodexAppServerTransport({
      id: `codex:${decl.connection.model}`,
      model: decl.connection.model,
      cwd: decl.connection.cwd,
    });
    if (t.ok === false) return { ok: false, error: `not connected: ${t.error}` };
    return { ok: true, transport: t };
  }
  if (decl.transport === 'deepseek-api') {
    const avail = deepseekAvailability();
    if (!avail.ok) return { ok: false, error: `not connected: ${avail.reason}` };
    const t = createDeepSeekTransport({
      id: `deepseek:${decl.connection.model}`,
      model: decl.connection.model,
      baseUrl: decl.connection.baseUrl,
    });
    if (t.ok === false) return { ok: false, error: t.error };
    return { ok: true, transport: t };
  }
  if (decl.transport === 'openai-http') {
    if (!c.baseUrl || !c.model) {
      return { ok: false, error: 'not connected: no baseUrl/model configured (set AWB_HTTP_BASE_URL and AWB_HTTP_MODEL)' };
    }
    return { ok: true, transport: createOpenAiHttpTransport({ baseUrl: c.baseUrl, model: c.model, apiKey: c.apiKey, provider: decl.provider }) };
  }
  return { ok: false, error: `unknown transport kind: ${decl.transport}` };
}

/**
 * Instantiate every declared seat.
 *
 * A seat that cannot be built is reported as unavailable WITH ITS REASON rather than skipped. The
 * difference between "we chose not to have this" and "we could not build this" is exactly what a
 * reader needs, and silently omitting it would misrepresent the system's coverage.
 */
function buildRegistry(projectId = 'demo', workspaceId = 'default') {
  const seats = [];
  const unavailable = [];

  for (const decl of DECLARATIONS) {
    if (!decl.connected) {
      unavailable.push({ seat_id: decl.seat_id, role: decl.role, provider: decl.provider, transport: decl.transport, reason: decl.why });
      continue;
    }
    const built = buildTransport(decl);
    if (!built.ok) { unavailable.push({ seat_id: decl.seat_id, role: decl.role, provider: decl.provider, transport: decl.transport, reason: built.error }); continue; }

    const seat = createSeat({
      seatId: decl.seat_id,
      role: decl.role,
      transport: built.transport,
      projectId,
      workspaceId,
      permissions: decl.permissions,
      contextLimit: decl.contextLimit,
      rotationThreshold: decl.rotationThreshold,
    });
    seats.push(seat);
  }

  return {
    seats,
    unavailable,
    byId: (id) => seats.find((s) => s.seat_id === id) ?? null,
    byRole: (role) => seats.find((s) => s.role === role) ?? null,
    /**
     * Every human seat's transport.
     *
     * A human seat has operations no other transport has - `pending()` and `answer()` - because a
     * person needs an inbox and a way to reply. Those are deliberately NOT part of the transport
     * contract: the layer above must keep working without them, which is what makes the human seat a
     * real test of the abstraction rather than a special case baked into it.
     *
     * ALL human seats, not the first one: with two human seats (a researcher and a supervisor) a
     * first-match lookup returned the wrong inbox and the operator saw an empty queue while a packet
     * sat waiting in the other seat.
     */
    humanTransports: () => seats.filter((x) => x.transport === 'human').map((x) => ({ seat_id: x.seat_id, role: x.role, transport: x._transport })),
    /** The first human seat's transport. Kept for single-human-seat callers. */
    humanTransport: () => {
      const s = seats.find((x) => x.transport === 'human');
      return s ? s._transport : null;
    },
    /** The cross-vendor facts the Evidence Card needs, without exposing transports. */
    independenceFacts: () => seats.map((s) => ({ seat_id: s.seat_id, role: s.role, provider: s.provider, transport: s.transport })),
  };
}

/**
 * Conformance for every transport this registry can build.
 *
 * This is the executable form of "transport-neutral": if a transport stops satisfying the contract,
 * it fails here rather than during a run.
 */
function conformance() {
  const results = [];
  const candidates = [];

  try { candidates.push(createPlaywrightDomTransport({ id: 'conformance:pw', workerId: 'conformance' })); } catch (e) { results.push({ transport: 'playwright-dom', ok: false, problems: [e.message] }); }
  try { candidates.push(createHumanTransport({ id: 'conformance:human' })); } catch (e) { results.push({ transport: 'human', ok: false, problems: [e.message] }); }
  try { candidates.push(createOpenAiHttpTransport({ baseUrl: 'http://127.0.0.1:1/v1/chat/completions', model: 'conformance-model', provider: 'openai-compatible' })); } catch (e) { results.push({ transport: 'openai-http', ok: false, problems: [e.message] }); }

  // DeepSeek is checked when its credential resolves. When it does not, the gap is REPORTED rather
  // than skipped - a conformance list that silently omits an unbuildable transport would overstate
  // how much of the roster is verified.
  const ds = createDeepSeekTransport({ id: 'conformance:deepseek' });
  if (ds.ok === false) {
    results.push({ transport: 'deepseek-api', ok: false, problems: [`not built: ${ds.error}`] });
  } else {
    candidates.push(ds);
  }

  return contract.checkAll(candidates).results.concat(results);
}

module.exports = { DECLARATIONS, buildRegistry, conformance, buildTransport };
