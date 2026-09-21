'use strict';
/**
 * index.js - the workbench HTTP surface. Zero dependencies, loopback only.
 *
 * PURE node:http ON PURPOSE
 *   The whole harness stack has no third-party dependencies, and a UI layer is not a good
 *   reason to break that: it would add an install step, a lockfile and an upgrade surface to
 *   something whose entire job is to sit still and be reliable. node:http plus a small router
 *   is enough for a single-user local tool.
 *
 * LOOPBACK ONLY
 *   The listener refuses anything that is not a loopback address. This is a local control
 *   surface for a tool that can drive a logged-in browser; it must not be reachable from the
 *   network, and that is enforced in code rather than by convention.
 *
 * READ VS COMMAND
 *   GET  = read. POST = command. Every command that could touch a project requires an explicit
 *   project_id, and the harness re-validates everything anyway; this layer only makes the
 *   requirement impossible to forget.
 *
 * WHAT THE APPROVAL GATE ACTUALLY GATES IN V0.1
 *   Only two workbench-initiated things can change the outside world: sending a turn to a
 *   worker (a prompt - ChatGPT still cannot write files) and recording a task decision. Both
 *   require a resolved project, and both are refused while a project is paused. There is no
 *   auto-apply path in V0.1 at all: file changes only ever happen through the harness's own
 *   reviewed flow, which is exactly what was accepted in V2.1.
 *
 * ASCII-ONLY source.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const adapter = require(path.join(__dirname, '..', 'adapters', 'harness-adapter.js'));
const store = require('./store.js');
const guidedPolicy = require('../protocol/guided-policy.js');
const events = require('./events.js');
const jobs = require('./jobs.js');
const sendState = require('./send-state.js');

// ---- V0.2 protocol layer ----
const protocol = require(path.join(__dirname, '..', 'protocol', 'protocol.js'));
const evidence = require(path.join(__dirname, '..', 'protocol', 'evidence.js'));
const evidenceCard = require(path.join(__dirname, '..', 'protocol', 'evidence-card.js'));
const runs = require(path.join(__dirname, '..', 'protocol', 'runs.js'));
const seatRegistry = require(path.join(__dirname, '..', 'seats', 'registry.js'));
const seatModule = require(path.join(__dirname, '..', 'seats', 'seat.js'));

/**
 * The seat registry and run orchestrator are built once, at module load.
 *
 * A seat is a LONG-LIVED identity - rebuilding it per request would hand out a new seat object on
 * every call and lose the conversation, the round count and the delivery state that make it a seat.
 * The registry is therefore process-scoped, which is exactly why the orchestrator can refuse a second
 * dispatch while a run is in flight.
 */
const REGISTRY = seatRegistry.buildRegistry('demo', 'default');
const ORCHESTRATOR = runs.newOrchestrator({
  registry: REGISTRY,
  projectRootOf: (projectId) => {
    const p = adapter.listProjects().find((x) => x.project_id === projectId);
    return p?.root_path ?? null;
  },
});

const CONFIG = adapter.CONFIG;
const PUBLIC_DIR = CONFIG.paths.publicDir;
// PUBLIC RELEASE ADDITION: honour PORT like every other Node service, so a second instance can run
// beside the first and a port clash during evaluation does not require editing a tracked file.
const PORT = Number(process.env.PORT ?? CONFIG.server.port);
const HOST = CONFIG.server.host;

// Per-turn worker wait; deliberately shorter than the config ceiling so the UI surfaces a
// BLOCKED result well before a browser hiccup turns into a ten-minute hang.
const TURN_TIMEOUT_MS = Math.min(CONFIG.jobs.turnTimeoutMs, 300000);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error(`invalid JSON body: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

function logEvent(event, detail, projectId) {
  try {
    fs.mkdirSync(CONFIG.paths.logsDir, { recursive: true });
    fs.appendFileSync(
      path.join(CONFIG.paths.logsDir, 'workbench.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), project_id: projectId ?? null, event, detail: detail ?? null })}\n`,
      'utf8',
    );
  } catch { /* never fatal */ }
}

/**
 * The approval gate.
 *
 * Returns a refusal object when an action is not permitted right now, otherwise null. Kept in
 * one place so the rule cannot drift between endpoints.
 */
function gate(projectId) {
  if (!projectId) {
    return {
      status: 400,
      body: {
        ok: false,
        error: 'project_id is required for every command; the workbench refuses to guess which project to act on',
      },
    };
  }
  const project = adapter.getProject(projectId);
  if (!project) return { status: 404, body: { ok: false, error: `no such project: ${projectId}` } };

  if (store.isPaused(projectId)) {
    return {
      status: 409,
      body: {
        ok: false,
        paused: true,
        error: `project ${projectId} is PAUSED: resume before starting new automated work`,
      },
    };
  }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Endpoints that exist only as POST.
 *
 * Listed so the router can answer a read verb aimed at one with 405 rather than 404. Without
 * this the distinction is lost: "that endpoint takes POST only" and "no such endpoint" are
 * different problems and the UI should not have to guess which one it hit.
 */
const POST_ONLY = new Set([
  '/api/goal/submit',
  '/api/job/pause',
  '/api/job/resume',
  '/api/autonomy',
  '/api/task/transition',
  '/api/task/decision',
  '/api/worker/create',
  '/api/worker/rotate',
  '/api/worker/send',
]);

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const publicRoot = path.resolve(PUBLIC_DIR);
  const target = path.resolve(publicRoot, rel);

  // Containment check FIRST, independent of method. A resolved path must stay inside
  // PUBLIC_DIR; without it a crafted path could read arbitrary files through this handler.
  if (target !== publicRoot && !target.startsWith(publicRoot + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }

  // A real file reached by the wrong method is a genuine 405. Reporting 405 for a path that
  // does not exist at all would be misleading - it implies the endpoint is there.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
    res.end('method not allowed');
    return;
  }

  const body = fs.readFileSync(target);
  res.writeHead(200, {
    'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'content-length': body.length,
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

async function handle(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;
  const isGet = req.method === 'GET';
  const isPost = req.method === 'POST';

  // ---- reads ------------------------------------------------------------
  // Dispatch on PATH first, then on method. A page requested with the wrong method must be a
  // 405 (the resource is really there), while an unknown path must be a 404 whatever the
  // method. Deciding the status from the method alone conflates the two and produces a
  // misleading 405 for paths that do not exist.
  /**
   * The page allowlist.
   *
   * The localisation engine and its catalogues live in a subdirectory, so the list accepts the `/i18n/`
   * PREFIX rather than naming five files that will grow. This widens which file paths may be served, not
   * which directories are reachable: `serveStatic` still resolves the request under PUBLIC_DIR and refuses
   * anything that escapes it, which is the check that actually matters and which the smoke suite exercises
   * with a traversal attempt.
   */
  const isPage = p === '/' || p === '/index.html' || p === '/styles.css' || p === '/app.js'
    || p === '/protocol-ui.js' || p === '/guided.js' || p === '/favicon.svg' || p === '/favicon.ico'
    || p.startsWith('/i18n/');
  if (isPage) return serveStatic(req, res, p);

  if (isGet && p === '/api/health') {
    return sendJson(res, 200, adapter.getHealth({
      probeWorker: q.get('probeWorker') === '1',
      projectId: q.get('projectId') ?? undefined,
    }));
  }

  if (isGet && p === '/api/projects') {
    return sendJson(res, 200, { projects: adapter.listProjects(), workbench: CONFIG.workbench });
  }

  if (isGet && p === '/api/project') {
    const id = q.get('projectId');
    if (!id) return sendJson(res, 400, { ok: false, error: 'projectId is required' });
    const project = adapter.getProject(id);
    if (!project) return sendJson(res, 404, { ok: false, error: `no such project: ${id}` });
    return sendJson(res, 200, { ...project, workbench: store.view(id) });
  }

  if (isGet && p === '/api/workspaces') {
    const id = q.get('projectId');
    if (!id) return sendJson(res, 400, { ok: false, error: 'projectId is required' });
    return sendJson(res, 200, { workspaces: adapter.listWorkspaces(id) });
  }

  if (isGet && p === '/api/tasks') {
    const id = q.get('projectId');
    if (!id) return sendJson(res, 400, { ok: false, error: 'projectId is required' });
    return sendJson(res, 200, {
      tasks: adapter.listTasks(id, {
        workspaceId: q.get('workspaceId') ?? undefined,
        status: q.get('status') ?? undefined,
        includeClosed: q.get('includeClosed') !== '0',
      }),
    });
  }

  if (isGet && p === '/api/task') {
    const taskId = q.get('taskId');
    if (!taskId) return sendJson(res, 400, { ok: false, error: 'taskId is required' });
    const task = adapter.getTask(taskId, q.get('projectId') ?? undefined);
    if (!task) return sendJson(res, 404, { ok: false, error: `no such task: ${taskId}` });
    return sendJson(res, 200, task);
  }

  if (isGet && p === '/api/workers') {
    const id = q.get('projectId');
    if (!id) return sendJson(res, 400, { ok: false, error: 'projectId is required' });
    const project = adapter.getProject(id);
    if (!project) return sendJson(res, 404, { ok: false, error: `no such project: ${id}` });
    return sendJson(res, 200, { workers: project.workers, sends: adapter.listSends().slice(0, 10) });
  }

  /** READ - read a completed turn back out of the conversation, by its index. */
  if (isGet && p === '/api/worker/reply') {
    const workerId = q.get('workerId');
    const turnIndex = Number(q.get('turnIndex'));
    if (!workerId) return sendJson(res, 400, { ok: false, error: 'workerId is required' });
    if (!Number.isInteger(turnIndex)) return sendJson(res, 400, { ok: false, error: 'turnIndex must be an integer' });
    const r = adapter.readWorkerReply(workerId, turnIndex);
    return sendJson(res, r.ok ? 200 : 409, r);
  }

  if (isGet && p === '/api/send/status') {
    const sendId = q.get('sendId');
    if (!sendId) return sendJson(res, 400, { ok: false, error: 'sendId is required' });
    const s = adapter.getSend(sendId);
    if (!s) return sendJson(res, 404, { ok: false, error: `no such send: ${sendId}` });
    return sendJson(res, 200, { ok: true, ...s });
  }

  /**
   * READ - the send lifecycle for a project.
   *
   * This is where SEND_PENDING is visible. It answers the two questions a caller actually has:
   * what state is this send in, and may I send again? The second answer is always no while a send
   * is pending - that refusal is the mechanism that prevents duplicate messages, so it is served
   * as data rather than left to the caller's memory.
   */
  if (isGet && p === '/api/send/state') {
    const id = q.get('projectId');
    if (!id) return sendJson(res, 400, { ok: false, error: 'projectId is required' });
    const sendStateId = q.get('sendStateId');
    if (sendStateId) {
      const s = sendState.get(sendStateId);
      if (!s) return sendJson(res, 404, { ok: false, error: `no such send state: ${sendStateId}` });
      return sendJson(res, 200, { ok: true, send: s, retry: sendState.refuseRetry(sendStateId) });
    }
    return sendJson(res, 200, {
      ok: true,
      sends: sendState.listForProject(id, 10),
      live_reconciliations: sendState.liveReconciliations(),
      fast_window_ms: sendState.FAST_WINDOW_MS,
      reconcile_budget_ms: sendState.RECONCILE_BUDGET_MS,
      states: sendState.STATE,
      note: 'SEND_PENDING is neither success nor failure. Automatic re-sending is prohibited in every non-terminal state.',
    });
  }

  if (isGet && p === '/api/diff') {
    const id = q.get('projectId');
    if (!id) return sendJson(res, 400, { ok: false, error: 'projectId is required' });
    const paths = q.getAll('path').filter(Boolean);
    return sendJson(res, 200, adapter.getDiff(id, { paths, staged: q.get('staged') === '1' }));
  }

  if (isGet && p === '/api/state') {
    const id = q.get('projectId');
    if (!id) return sendJson(res, 400, { ok: false, error: 'projectId is required' });
    return sendJson(res, 200, {
      ...store.view(id),
      job: jobs.status(),
      goals: store.listGoals(id, 20),
      decisions: store.listDecisions(id, 50),
    });
  }

  if (isGet && p === '/api/events') {
    const id = q.get('projectId') ?? undefined;
    const limit = Math.min(Math.max(Number(q.get('limit') ?? 100) || 100, 1), 500);
    const tl = events.timeline(id, limit);
    const since = q.get('since');
    return sendJson(res, 200, since
      ? { ...tl, events: tl.events.filter((e) => String(e.at) > since) }
      : tl);
  }

  if (isGet && p === '/api/job') {
    return sendJson(res, 200, jobs.status());
  }

  // ======================================================================
  // V0.2 protocol surface: seats, runs, evidence
  // ======================================================================

  /**
   * READ - the seats that exist, their providers, transports and delivery state.
   *
   * Unavailable seats are returned WITH their reason. The distinction between "we chose not to
   * connect this" and "it could not be built" is the difference between a roadmap and a bug, and a
   * reader looking at this endpoint needs to be able to tell them apart.
   */
  if (isGet && p === '/api/seats') {
    return sendJson(res, 200, {
      ok: true,
      protocol_version: protocol.PROTOCOL_VERSION,
      seats: REGISTRY.seats.map(seatModule.view),
      unavailable: REGISTRY.unavailable,
      independence_facts: REGISTRY.independenceFacts(),
      note: 'A seat is a long-lived identity: role, provider, transport, conversation, permissions, '
        + 'health, rounds and delivery state. provider and transport are independent axes.',
    });
  }

  if (isGet && p === '/api/runs') {
    return sendJson(res, 200, { ok: true, runs: ORCHESTRATOR.list() });
  }

  if (isGet && p === '/api/run') {
    const runId = q.get('runId');
    if (!runId) return sendJson(res, 400, { ok: false, error: 'runId is required' });
    const run = ORCHESTRATOR.get(runId);
    if (!run) return sendJson(res, 404, { ok: false, error: `no such run: ${runId}` });
    return sendJson(res, 200, { ok: true, run });
  }

  /** READ - every Evidence Record, newest first. */
  if (isGet && p === '/api/evidence') {
    const recordId = q.get('recordId');
    if (recordId) {
      const rec = evidence.loadRecord(recordId);
      if (!rec) return sendJson(res, 404, { ok: false, error: `no such evidence record: ${recordId}` });
      return sendJson(res, 200, { ok: true, record: rec, card: evidenceCard.buildCard(rec) });
    }
    const all = evidence.listRecords(Number(q.get('limit') ?? 25));
    return sendJson(res, 200, {
      ok: true,
      records: all.map((r) => ({ record_id: r.record_id, task_id: r.task_id, final_status: r.final_status, origin: r.record_origin, completed_at: r.completed_at })),
      statuses: evidence.EVIDENCE_STATUS,
      note: 'JSON is the source of truth; the card is a projection. A dash means NOT RECORDED, never a pass.',
    });
  }

  /** READ - the card for one record, already projected and honesty-checked. */
  if (isGet && p === '/api/evidence/card') {
    const recordId = q.get('recordId');
    if (!recordId) return sendJson(res, 400, { ok: false, error: 'recordId is required' });
    const rec = evidence.loadRecord(recordId);
    if (!rec) return sendJson(res, 404, { ok: false, error: `no such evidence record: ${recordId}` });
    return sendJson(res, 200, { ok: true, card: evidenceCard.buildCard(rec), record: rec });
  }

  if (isGet && p === '/api/plan') {
    const goalId = q.get('goalId');
    if (!goalId) return sendJson(res, 400, { ok: false, error: 'goalId is required' });
    const goal = store.getGoal(goalId);
    if (!goal) return sendJson(res, 404, { ok: false, error: `no such goal: ${goalId}` });
    return sendJson(res, 200, goal);
  }

  if (isGet && p === '/api/packet') {
    const id = q.get('projectId');
    const taskId = q.get('taskId');
    if (!id || !taskId) return sendJson(res, 400, { ok: false, error: 'projectId and taskId are required' });
    const r = adapter.buildTaskPacket(id, taskId, { files: q.getAll('file').filter(Boolean) });
    if (!r.ok) return sendJson(res, 400, r);
    // packet.js returns {ok, text, task_id, workspace_id, bytes}; surface it under a stable
    // `packet` name for the UI without changing the harness's own shape.
    return sendJson(res, 200, {
      ok: true,
      packet: r.text,
      bytes: Buffer.byteLength(r.text ?? '', 'utf8'),
      task_id: r.task_id ?? taskId,
      workspace_id: r.workspace_id ?? null,
    });
  }

  /** READ - packets waiting for a human operator, aggregated across EVERY human seat. */
  if (isGet && p === '/api/human/inbox') {
    const pending = [];
    for (const h of REGISTRY.humanTransports()) {
      for (const item of h.transport.pending()) pending.push({ ...item, seat_id: h.seat_id, seat_role: h.role });
    }
    return sendJson(res, 200, {
      ok: true,
      pending,
      seats: REGISTRY.humanTransports().map((h) => ({ seat_id: h.seat_id, role: h.role })),
      note: 'A human seat is a real transport, not a fallback. Its answers go through the same '
        + 'correlation and verification path as a machine\'s.',
    });
  }

  if (!isPost) {
    // A read verb aimed at a command endpoint is a genuine 405: the endpoint exists, the
  /**
   * The guided-goal catalogue.
   *
   * Served rather than duplicated into the UI, so the presets, the policies they map to and the preview come
   * from ONE definition. A copy in the browser would drift from the resolver the server enforces, and the
   * drift would be invisible: the UI would promise a restriction the Workbench does not apply.
   *
   * PLACEMENT MATTERS. The read-route block below ends with a 404 for anything it did not match, so a handler
   * registered after it is unreachable - which is exactly what happened on the first attempt, and the
   * symptom was a confident "unknown endpoint" for a route that existed further down the file.
   */
  if (isGet && p === '/api/goal/presets') {
    return sendJson(res, 200, {
      ok: true,
      presets: guidedPolicy.PRESETS,
      examples: guidedPolicy.EXAMPLES,
      file_policies: guidedPolicy.FILE_POLICY,
      autonomy_levels: guidedPolicy.AUTONOMY_LEVEL,
      review_policies: guidedPolicy.REVIEW_POLICY,
      autonomy_limits: guidedPolicy.AUTONOMY_LIMITS,
      default_limits: guidedPolicy.AUTONOMY_LIMITS.recommended,
      /**
       * Execution intensity, served like every other policy value so the browser holds no copy of it.
       *
       * `intensities` is the catalogue (id, icon, message keys, budgets, tier) and `validation_tiers` is the
       * tier list, so the Advanced view can show real budgets without the UI hardcoding what each level means.
       */
      intensities: guidedPolicy.intensity.INTENSITIES,
      default_intensity: guidedPolicy.intensity.DEFAULT_INTENSITY,
      validation_tiers: guidedPolicy.intensity.VALIDATION_TIER,
      global_ceiling: guidedPolicy.intensity.GLOBAL_CEILING,
    });
  }

  /**
   * READ - resolve guided choices into the REAL policy, without starting anything.
   *
   * This exists so the beginner UI never has to compute a policy of its own. The preview panel, the
   * permission wording and the "what will happen" list are all rendered from THIS response, which comes
   * from the same resolver `/api/goal/submit` uses. A copy of the mapping in the browser would be able to
   * drift from what the Workbench enforces, and the drift would be invisible in exactly the way that
   * matters: the screen would promise a restriction that the run does not have.
   *
   * It resolves and returns; it does not submit, does not touch the store, and does not change a mode.
   * `?projectId=`/`?workspaceId=` are optional and only supply the workspace write scope that the
   * `read_only` and `ask` branches are computed against.
   */
  if (isGet && p === '/api/goal/preview') {
    const q = url.searchParams;
    const projectId = q.get('projectId') ?? null;
    const workspaceId = q.get('workspaceId') ?? 'default';
    let seatScope = [];
    if (projectId) {
      try {
        const seats = require('../seats/registry.js').buildRegistry(projectId, workspaceId);
        const workerSeat = seats.byId(`seat:${projectId}/${workspaceId}/coder`)
          ?? seats.seats.find((s) => s.role === 'coder');
        seatScope = workerSeat?.permissions?.write_scope ?? [];
      } catch (e) {
        // A project that cannot build a registry has no permitted writes. That is the narrow answer, and
        // `notes` says so rather than silently previewing an empty scope as if it were the whole truth.
        return sendJson(res, 200, {
          ok: false,
          error: `cannot read the workspace write scope: ${e.message}`,
          permissions: { write_scope: [], approval_required: [] },
        });
      }
    }
    const resolved = guidedPolicy.resolveGuidedPolicy({
      presetId: q.get('presetId') ?? undefined,
      filePolicy: q.get('filePolicy') ?? undefined,
      autonomy: q.get('autonomy') ?? undefined,
      reviewPolicy: q.get('reviewPolicy') ?? undefined,
      executionIntensity: q.get('executionIntensity') ?? undefined,
    }, { workerSeatWriteScope: seatScope });
    if (!resolved.ok) return sendJson(res, 400, { ok: false, error: resolved.error });
    return sendJson(res, 200, {
      ...resolved,
      file_policies: guidedPolicy.FILE_POLICY,
      autonomy_levels: guidedPolicy.AUTONOMY_LEVEL,
      review_policies: guidedPolicy.REVIEW_POLICY,
      autonomy_limits: guidedPolicy.AUTONOMY_LIMITS,
      intensities: guidedPolicy.intensity.INTENSITIES,
      default_intensity: guidedPolicy.intensity.DEFAULT_INTENSITY,
      validation_tiers: guidedPolicy.intensity.VALIDATION_TIER,
      preview: guidedPolicy.describeGuidedPolicy(resolved),
    });
  }

  /** READ - the policy a goal was actually submitted under, or null when it was not a guided goal. */
  if (isGet && p === '/api/goal/policy') {
    const goalId = url.searchParams.get('goalId');
    if (!goalId) return sendJson(res, 400, { ok: false, error: 'goalId is required' });
    const goal = store.getGoal(goalId);
    if (!goal) return sendJson(res, 404, { ok: false, error: `no such goal: ${goalId}` });
    return sendJson(res, 200, {
      ok: true,
      goal_id: goalId,
      guided: goal.guided_policy ?? null,
      guided_permissions: goal.guided_permissions ?? null,
      note: 'The policy this goal was submitted under, as resolved at submit time. Read back from the '
        + 'goal record rather than recomputed, so a later change to the presets cannot rewrite history.',
    });
  }

  /**
   * READ - what a goal actually used, for the cost report.
   *
   * HONESTY IS THE WHOLE DESIGN HERE. The workbench counts some things (worker dispatches it performed, task
   * records it created) and does NOT count others (the supervisor runs inside this process, so its turns are
   * not instrumented). Uncounted fields are returned as `null` and the panel omits them, rather than being
   * reported as zero. `token_usage` is absent with a note, because no provider reports usage.
   */
  if (isGet && p === '/api/goal/cost') {
    const goalId = url.searchParams.get('goalId');
    if (!goalId) return sendJson(res, 400, { ok: false, error: 'goalId is required' });
    const goal = store.getGoal(goalId);
    if (!goal) return sendJson(res, 404, { ok: false, error: `no such goal: ${goalId}` });

    const guided = goal.guided_policy ?? null;
    // The counters the workbench really has: tasks created for this goal, and the goal's own lifecycle times.
    const tasksForGoal = (goal.plan ?? []).length;
    const elapsedMs = goal.created_at && goal.updated_at
      ? Math.max(0, Date.parse(goal.updated_at) - Date.parse(goal.created_at))
      : null;
    const report = guidedPolicy.describeCostReport(guided, {
      subagentsUsed: goal.subagents_used ?? null,
      retries: goal.retries ?? null,
      workerDispatches: goal.worker_dispatches ?? null,
      supervisorReviews: goal.supervisor_reviews ?? null,
      validationTier: goal.validation_tier ?? null,
      elapsedMs,
    });
    return sendJson(res, 200, {
      ok: true,
      goal_id: goalId,
      status: goal.status ?? null,
      task_count: tasksForGoal,
      cost: report,
      note: 'Counts the workbench performed. Fields it did not count are null and are omitted rather than '
        + 'shown as zero. No token usage is reported because no provider in this stack measures it.',
    });
  }

  // ---- reads that need no body ------------------------------------------
  {
    // Anything that is not a known read path is a 404, unless it is a POST-only route being asked with the
    // wrong method - in which case the route exists and the method does not belong to it. Anything else is an
    // unknown path and therefore a 404.
    if (POST_ONLY.has(p)) {
      res.writeHead(405, {
        'content-type': 'application/json; charset=utf-8',
        allow: 'POST',
      });
      res.end(JSON.stringify({ ok: false, error: `${p} accepts POST only` }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: `unknown endpoint: ${req.method} ${p}` }));
    return;
  }
  }

  // ---- commands ---------------------------------------------------------
  const body = await readBody(req);

  /**
   * The guided-goal catalogue.
   *
   * Served rather than duplicated into the UI, so the presets, the policies they map to and the preview are
   * one definition. A copy in the browser would drift from the resolver the server enforces, and the drift
   * would be invisible: the UI would promise a restriction the Workbench does not apply.
   */

  if (p === '/api/goal/submit') {
    const refusal = gate(body.projectId);
    if (refusal) return sendJson(res, refusal.status, refusal.body);

    /**
     * A guided submission resolves its choices into REAL policy before anything is dispatched.
     *
     * The beginner's three answers become `write_scope`, `approval_required`, the autonomy mode and the
     * Codex mode here, on the server, so the restriction exists in the policy the Workbench enforces rather
     * than in the sentence the worker was sent. An unrecognised choice is REFUSED rather than silently
     * treated as read-only: a user who asked for something the Workbench does not understand must be told,
     * not quietly given a different policy.
     */
    let guided = null;
    if (body.guided && typeof body.guided === 'object') {
      const registryModule = require('../seats/registry.js');
      const seats = registryModule.buildRegistry(body.projectId, body.workspaceId || 'default');
      const workerSeat = seats.byId(`seat:${body.projectId}/${body.workspaceId || 'default'}/coder`)
        ?? seats.seats.find((s) => s.role === 'coder');
      guided = guidedPolicy.resolveGuidedPolicy(body.guided, {
        workerSeatWriteScope: workerSeat?.permissions?.write_scope ?? [],
      });
      if (!guided.ok) return sendJson(res, 400, { ok: false, error: guided.error });
      // Apply the two policies the workbench already owns, so the guided choice is not merely recorded.
      store.setCodexReviewMode(body.projectId, guided.codex_review_mode);
      store.setAutonomy(body.projectId, guided.autonomy_mode);
    }

    const r = await jobs.submitGoal({
      projectId: body.projectId,
      workspaceId: body.workspaceId ?? null,
      text: String(body.text ?? '').trim(),
      createTasks: body.createTasks !== false,
      // The RESOLVED policy travels with the goal all the way to its record, so the restriction a
      // beginner chose can be read back from the goal later instead of being reconstructed from what
      // the UI happened to display at the time.
      guided,
    });
    if (r.ok && guided && r.goal_id) {
      store.updateGoal(r.goal_id, {
        guided_policy: guided,
        // Flattened, so reading the restriction back does not require knowing the resolver's shape, and so
        // the Evidence/limit code has one obvious field to check.
        guided_permissions: {
          file_policy: guided.file_policy,
          write_scope: guided.permissions.write_scope,
          approval_required: guided.permissions.approval_required,
          autonomy: guided.autonomy,
          limits: guided.limits,
        },
      });
    }
    logEvent('http.goal.submit', {
      ok: r.ok, goal_id: r.goal_id ?? null, workspace: body.workspaceId ?? null,
      preset: guided?.preset_id ?? null, file_policy: guided?.file_policy ?? null,
      autonomy: guided?.autonomy ?? null, codex: guided?.codex_review_mode ?? null,
    }, body.projectId);
    return sendJson(res, r.ok ? 200 : 400, guided ? { ...r, guided_policy: guided } : r);
  }

  if (p === '/api/job/pause') {
    if (!body.projectId) return sendJson(res, 400, { ok: false, error: 'projectId is required' });
    return sendJson(res, 200, jobs.pause(body.projectId));
  }

  if (p === '/api/job/resume') {
    if (!body.projectId) return sendJson(res, 400, { ok: false, error: 'projectId is required' });
    return sendJson(res, 200, jobs.resume(body.projectId));
  }

  if (p === '/api/autonomy') {
    if (!body.projectId) return sendJson(res, 400, { ok: false, error: 'projectId is required' });
    const r = store.setAutonomy(body.projectId, body.mode);
    if (r.ok) logEvent('http.autonomy.set', { mode: body.mode }, body.projectId);
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  if (p === '/api/review/mode') {
    if (!body.projectId) return sendJson(res, 400, { ok: false, error: 'projectId is required' });
    const r = store.setCodexReviewMode(body.projectId, body.mode);
    if (r.ok) logEvent('http.review.mode.set', { requested: r.requested, effective: r.mode }, body.projectId);
    // The requested and effective modes are BOTH returned: a UI that silently rewrote ON into OFF would
    // hide the exact mistake this endpoint exists to prevent.
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  if (p === '/api/task/transition') {
    const refusal = gate(body.projectId);
    if (refusal) return sendJson(res, refusal.status, refusal.body);
    if (!body.taskId || !body.verb) {
      return sendJson(res, 400, { ok: false, error: 'taskId and verb are required' });
    }
    const r = adapter.taskTransition(body.taskId, body.verb, {
      projectId: body.projectId,
      note: body.note,
      worker: body.worker,
      verified: body.verified === true,
    });
    logEvent('http.task.transition', { task_id: body.taskId, verb: body.verb, ok: r.ok }, body.projectId);
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  if (p === '/api/task/decision') {
    const refusal = gate(body.projectId);
    if (refusal) return sendJson(res, refusal.status, refusal.body);
    const action = String(body.action ?? '').toUpperCase();
    if (!['APPROVE', 'REJECT', 'RETRY'].includes(action)) {
      return sendJson(res, 400, { ok: false, error: 'action must be APPROVE, REJECT or RETRY' });
    }

    let verb = null;
    if (body.taskId) {
      verb = action === 'APPROVE' ? 'done' : action === 'REJECT' ? 'block' : 'retry';
    }

    let r = { ok: true };
    if (verb && !body.dryRun) {
      r = adapter.taskTransition(body.taskId, verb, {
        projectId: body.projectId,
        note: body.reason,
        verified: body.verified === true,
      });
      if (!r.ok) return sendJson(res, 400, r);
    }
    if (action === 'REJECT' && body.taskId) {
      adapter.rejectTask(body.taskId, { projectId: body.projectId, reason: body.reason });
    }

    const decision = store.addDecision({
      project_id: body.projectId, goal_id: body.goal_id ?? null,
      task_id: body.taskId ?? null, action, reason: body.reason ?? null,
    });
    logEvent('http.task.decision', { task_id: body.taskId ?? null, action }, body.projectId);
    return sendJson(res, 200, { ok: true, decision, task: body.taskId ? adapter.getTask(body.taskId, body.projectId) : null });
  }

  if (p === '/api/worker/create') {
    const refusal = gate(body.projectId);
    if (refusal) return sendJson(res, refusal.status, refusal.body);
    const r = adapter.createWorker(body.projectId, {
      role: body.role ?? 'general',
      workspaceId: body.workspaceId ?? null,
    });
    logEvent('http.worker.create', { ok: r.ok, worker_id: r.worker?.worker_id ?? null }, body.projectId);
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  if (p === '/api/worker/rotate') {
    const refusal = gate(body.projectId);
    if (refusal) return sendJson(res, refusal.status, refusal.body);
    if (!body.workerId) return sendJson(res, 400, { ok: false, error: 'workerId is required' });
    const r = adapter.rotateWorker(body.workerId, body.reason);
    logEvent('http.worker.rotate', { ok: r.ok, worker_id: body.workerId }, body.projectId);
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  /**
   * Start a turn for a worker. Returns immediately with a send id.
   *
   * The turn takes minutes and runs in its own process; the client polls /api/send/status.
   * Holding the HTTP response open for the length of a ChatGPT turn is what made the UI look
   * frozen, so the request deliberately does not wait for the outcome.
   */
  if (p === '/api/worker/send') {
    const refusal = gate(body.projectId);
    if (refusal) return sendJson(res, refusal.status, refusal.body);
    if (!body.workerId) return sendJson(res, 400, { ok: false, error: 'workerId is required' });

    if (body.mode === 'open') {
      const r = adapter.openWorkerConversation(body.workerId);
      logEvent('http.worker.open', { ok: r.ok, worker_id: body.workerId }, body.projectId);
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    const text = String(body.text ?? '');
    if (!text.trim()) return sendJson(res, 400, { ok: false, error: 'text is required' });

    const started = adapter.startSendToWorker(body.workerId, text, {
      projectId: body.projectId,
      resolveTimeoutMs: TURN_TIMEOUT_MS,
    });
    if (!started.ok) return sendJson(res, 500, started);

    logEvent('http.worker.send.started', {
      worker_id: body.workerId, send_id: started.send_id, chars: text.length,
    }, body.projectId);

    return sendJson(res, 202, {
      ok: true,
      accepted: true,
      send_id: started.send_id,
      status: 'RUNNING',
      note: 'the turn is running in the background; poll /api/send/status?sendId=... for the outcome',
    });
  }

  if (p === '/api/send/reconcile') {
    const sendStateId = body.sendStateId;
    if (!sendStateId) return sendJson(res, 400, { ok: false, error: 'sendStateId is required' });
    const r = await sendState.reconcileOnce(sendStateId, adapter);
    if (!r.ok && r.error) return sendJson(res, 404, r);
    logEvent('http.send.reconcile', { send_state_id: sendStateId, state: r.record?.state }, body.projectId);
    return sendJson(res, 200, {
      ok: true,
      send: r.record,
      terminal: sendState.TERMINAL.includes(r.record?.state),
      retry: sendState.refuseRetry(sendStateId),
    });
  }

  if (p === '/api/human/answer') {
    if (!body.runId) return sendJson(res, 400, { ok: false, error: 'runId is required' });

    // Route to whichever human seat actually holds this packet. Answering into the wrong seat would
    // store the reply where nothing reads it, and the run would sit pending forever.
    const candidates = REGISTRY.humanTransports();
    const holder = candidates.find((h) => h.transport.pending().some((p) => p.run_id === body.runId))
      ?? (body.seatId ? candidates.find((h) => h.seat_id === body.seatId) : null)
      ?? candidates[0];
    if (!holder) return sendJson(res, 400, { ok: false, error: 'no human seat is registered' });
    const ht = holder.transport;

    // Hand the text to the human transport, which only STORES it. Nothing here may add an ack, and
    // nothing here decides whether the answer is acceptable - that is the protocol's call, applied to
    // a human exactly as it would be to a model.
    const stored = ht.answer(body.runId, body.replyText);
    if (!stored.ok) return sendJson(res, 400, stored);

    // Then continue the run through the SAME path a machine reply takes. If the operator omitted or
    // mistyped the ack, correlation quarantines it.
    const r = await ORCHESTRATOR.completeFromReply(body.runId, body.replyText);

    // An unattributable answer is REFUSED, not consumed: the packet stays in the inbox with the
    // reason, so the operator can correct the ack and try again. Marking it answered would strand the
    // run with nothing on screen to explain why.
    if (r.ok) ht.accept(body.runId);
    else ht.quarantine(body.runId, r.detail);

    logEvent('http.human.answer', {
      run_id: body.runId, correlated: r.ok === true, disposition: r.disposition ?? null,
    }, body.projectId);
    return sendJson(res, r.ok ? 200 : 409, {
      ok: r.ok === true,
      correlated: r.ok === true,
      accepted: r.ok === true,
      retained_in_inbox: r.ok !== true,
      detail: r.ok
        ? `correlated (${r.correlation}); the run is ${r.status}`
        : r.detail,
      status: r.status ?? null,
      disposition: r.disposition ?? null,
    });
  }

  /** READ - packets waiting for a human operator, across every human seat. */
  if (isGet && p === '/api/human/inbox') {
    const ht = REGISTRY.humanTransport();
    const pending = ht ? ht.pending() : [];
    return sendJson(res, 200, {
      ok: true,
      pending,
      note: 'A human seat is a real transport, not a fallback. Its answers go through the same '
        + 'correlation and verification path as a machine\'s.',
    });
  }

  if (p === '/api/run/open') {
    const refusal = gate(body.projectId);
    if (refusal) return sendJson(res, refusal.status, refusal.body);
    const r = await ORCHESTRATOR.open({
      goalId: body.goalId ?? null,
      taskId: body.taskId,
      projectId: body.projectId,
      workspaceId: body.workspaceId ?? 'default',
      workerSeatId: body.workerSeatId ?? null,
      workerRole: body.workerRole ?? 'coder',
      sourceRelPaths: body.sourceRelPaths ?? [],
      successCriteria: body.successCriteria ?? [],
      expectedOutput: body.expectedOutput ?? null,
      reviewRequirements: body.reviewRequirements ?? { required: true, independent_provider: false },
      taskTitle: body.taskTitle ?? null,
      taskDescription: body.taskDescription ?? null,
      request: body.request ?? null,
      renderer: body.renderer ?? null,
    });
    logEvent('http.run.open', { ok: r.ok, run_id: r.run_id ?? null, delivery_state: r.delivery_state ?? null }, body.projectId);
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  /** Observe only. There is deliberately no "resend" endpoint at any path. */
  if (p === '/api/run/observe') {
    if (!body.runId) return sendJson(res, 400, { ok: false, error: 'runId is required' });
    const r = await ORCHESTRATOR.observe(body.runId);
    return sendJson(res, 200, r);
  }

  if (p === '/api/run/complete') {
    if (!body.runId) return sendJson(res, 400, { ok: false, error: 'runId is required' });
    let replyText = body.replyText;
    // Convenience: if no text is supplied, read it through the worker seat's own transport. The
    // protocol does not care where the text came from - only that it carries a matching ack.
    if (!replyText && body.readFromTransport !== false) {
      const run = ORCHESTRATOR.get(body.runId);
      const seat = run ? REGISTRY.byId(run.worker_seat) : null;
      if (seat) {
        const env = body.envelopeForRead ?? null;
        const read = seat._transport.read(env ?? { run_id: body.runId, task_id: run.task_id });
        if (read.ok) replyText = read.text;
      }
    }
    if (!replyText) return sendJson(res, 400, { ok: false, error: 'no reply text available; pass replyText explicitly' });
    const r = await ORCHESTRATOR.completeFromReply(body.runId, replyText);
    logEvent('http.run.complete', { run_id: body.runId, ok: r.ok, status: r.status, disposition: r.disposition ?? null }, body.projectId);
    return sendJson(res, r.ok ? 200 : 409, r);
  }

  if (p === '/api/run/review') {
    if (!body.runId) return sendJson(res, 400, { ok: false, error: 'runId is required' });
    const r = ORCHESTRATOR.recordReview(body.runId, {
      verdict: body.verdict, summary: body.summary ?? null, reviewerSeatId: body.reviewerSeatId ?? null,
    });
    return sendJson(res, r.ok ? 200 : 409, r);
  }

  if (p === '/api/run/approve') {
    if (!body.runId) return sendJson(res, 400, { ok: false, error: 'runId is required' });
    const r = ORCHESTRATOR.recordApproval(body.runId, { decision: body.decision, reason: body.reason ?? null, by: body.by ?? 'user' });
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  if (p === '/api/run/finalize') {
    if (!body.runId) return sendJson(res, 400, { ok: false, error: 'runId is required' });
    const r = ORCHESTRATOR.finalize(body.runId, {
      changedFiles: body.changedFiles ?? null,
      diffSummary: body.diffSummary ?? null,
      diffScopeOk: body.diffScopeOk ?? null,
      validationResults: body.validationResults ?? null,
      runtimeValidation: body.runtimeValidation ?? null,
      commit: body.commit ?? null,
    });
    return sendJson(res, r.ok ? 200 : 400, { ok: r.ok, record_id: r.record_id ?? null, final_status: r.record?.final_status ?? null, missing_evidence: r.missing_evidence ?? [], error: r.error });
  }

  if (p === '/api/send/status') {
    const sendId = body.sendId;
    if (!sendId) return sendJson(res, 400, { ok: false, error: 'sendId is required' });
    const s = adapter.getSend(sendId);
    if (!s) return sendJson(res, 404, { ok: false, error: `no such send: ${sendId}` });
    return sendJson(res, 200, { ok: true, ...s });
  }

  if (p === '/api/job') {
    return sendJson(res, 200, jobs.status());
  }

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: `unknown endpoint: ${req.method} ${p}` }));
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

/**
 * Build the HTTP server without binding a port.
 *
 * Split from start() so the module can be required by tests: requiring a file must never
 * have the side effect of occupying a port or spawning a listener.
 */
function createServer() {
  const server = http.createServer((req, res) => {
    // Inspect the RAW request target before URL parsing. The WHATWG URL parser normalises
    // "/../config.json" and "/..%2Fconfig.json" into "/config.json" during resolution, so a
    // traversal attempt is invisible after parsing - the request would simply look like a
    // request for a file that is not in public/. Refusing the raw target keeps the refusal
    // explicit and logs what was actually asked for.
    const rawTarget = req.url ?? '';
    if (/%2e|%2f|%5c/i.test(rawTarget) || rawTarget.includes('..')) {
      logEvent('http.traversal.refused', { raw: rawTarget.slice(0, 200) });
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'path traversal is not allowed' }));
      return;
    }

    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }

    handle(req, res, url).catch((e) => {
      logEvent('http.error', { path: url.pathname, error: String(e && e.message ? e.message : e) });
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
      else res.end();
    });
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      process.stderr.write(
        `\nworkbench: port ${PORT} is already in use.\n` +
        `Another workbench (or another program) owns it. Nothing was started.\n` +
        `Check with:  netstat -ano | findstr :${PORT}\n\n`,
      );
    } else {
      process.stderr.write(`\nworkbench: server error: ${e.message}\n\n`);
    }
    process.exit(1);
  });

  // Loopback enforcement: a request arriving on a non-loopback local address is refused even
  // if the listener were somehow reachable from the network.
  server.on('connection', (socket) => {
    const addr = socket.remoteAddress;
    if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') socket.destroy();
  });

  return server;
}

function start() {
  const server = createServer();

  /**
   * Event-loop lag watchdog.
   *
   * This server must answer while a ChatGPT turn is in flight. A synchronous call anywhere in a
   * request path silently breaks that, and the symptom (the UI hanging with no error) is easy to
   * misread as a browser problem. Measuring the lag turns it into a log line with a timestamp,
   * so a block can be attributed instead of guessed at. Anything over 2s is written to the
   * workbench log.
   */
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const lag = now - last - 1000;
    last = now;
    if (lag > 2000) logEvent('server.eventloop.blocked', { lag_ms: lag });
  }, 1000).unref();

  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    logEvent('workbench.started', { url, pid: process.pid });
    process.stdout.write(
      `\n  EvidenceCrew v${CONFIG.workbench.version}\n` +
      `  ${url}\n\n` +
      `  harness : ${CONFIG.paths.harnessRoot}\n` +
      `  state   : ${CONFIG.paths.stateFile}\n` +
      `  bind    : ${HOST} (loopback only)\n\n` +
      `  Ctrl+C to stop. No files in any project are changed without the harness's reviewed flow.\n\n`,
    );
  });

  const shutdown = (sig) => {
    process.stdout.write(`\nworkbench: ${sig} - stopping\n`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

if (require.main === module) start();

module.exports = { start, createServer, handle, gate };
