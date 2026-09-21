'use strict';
/**
 * smoke-test.js - Workbench V0.1 acceptance, runnable end to end without a real ChatGPT turn.
 *
 * WHAT IT PROVES
 *   Everything the UI depends on that does NOT require driving a browser: the module graph
 *   loads, the harness adapter really reads the Game project, the pause gate actually refuses
 *   commands while paused, path traversal is refused, the planner prompt is fully substituted,
 *   and the plan parser turns a realistic reply into task candidates (and refuses to invent
 *   tasks from a malformed one).
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   It never sends a turn to ChatGPT and never submits a goal, so it cannot damage project
 *   state. The one place it does change real workbench state - pause - it restores.
 *
 * Runs the real HTTP handler over an ephemeral port, so the routes are exercised as the
 * browser will exercise them, not by calling functions directly.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const WB = path.resolve(__dirname, '..', '..', 'workbench');

const adapter = require(path.join(WB, 'adapters', 'harness-adapter.js'));
const store = require(path.join(WB, 'server', 'store.js'));
const events = require(path.join(WB, 'server', 'events.js'));
const jobs = require(path.join(WB, 'server', 'jobs.js'));
const srv = require(path.join(WB, 'server', 'index.js'));

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else {
    fail += 1;
    failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

function section(t) { console.log(`\n=== ${t} ===`); }

// ---------------------------------------------------------------------------
// HTTP client against the real handler
// ---------------------------------------------------------------------------

let base = null;

function req(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    // Use the options-object form with an explicit `path`, NOT a URL string. Handing
    // http.request a full URL makes the WHATWG parser normalise "/../x" to "/x" on the client
    // side, so a traversal test written that way never puts the traversal on the wire and
    // passes for the wrong reason.
    const port = Number(new URL(base).port);
    const r = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// ---------------------------------------------------------------------------

async function main() {
  section('1. module graph loads');
  check('adapter exports listProjects', typeof adapter.listProjects === 'function');
  check('store exports setPaused', typeof store.setPaused === 'function');
  check('events exports timeline', typeof events.timeline === 'function');
  check('jobs exports submitGoal/pause/resume', ['submitGoal', 'pause', 'resume'].every((k) => typeof jobs[k] === 'function'));
  check('server exports createServer', typeof srv.createServer === 'function');
  check('zero third-party deps', Object.keys(require(path.join(WB, 'package.json')).dependencies ?? {}).length === 0);

  section('2. harness adapter reads the real project');
  const projects = adapter.listProjects();
  check('at least one project registered', projects.length >= 1, `got ${projects.length}`);
  const game = projects.find((p) => p.project_id === 'demo');
  check('project "game" is visible to the workbench', !!game, projects.map((p) => p.project_id).join(','));
  if (game) {
    check('game root exists on disk', game.root_exists === true, game.root_path);
    check('game has workspaces', game.workspace_count >= 1, `count=${game.workspace_count}`);
    check('game has tasks', game.task_count >= 1, `count=${game.task_count}`);
    check('game has workers', game.worker_count >= 1, `count=${game.worker_count}`);
  }

  const detail = adapter.getProject('demo');
  check('getProject returns git state', !!detail && detail.git && detail.git.enabled === true);
  check('git head is a short sha', !!(detail && /^[0-9a-f]{7,}$/.test(detail.git.head ?? '')), detail && detail.git.head);
  check('workspace summaries include a worker slot', (detail.workspaces ?? []).every((w) => 'worker' in w));
  const resolved = (detail.workers ?? []).filter((w) => w.conversation_resolved);
  check('at least one worker conversation is RESOLVED', resolved.length >= 1,
    (detail.workers ?? []).map((w) => `${w.worker_id}=${w.conversation_state}`).join(','));

  const tasks = adapter.listTasks('demo');
  check('task views carry history arrays', tasks.every((t) => Array.isArray(t.history)));
  check('task views carry success_criteria', tasks.every((t) => Array.isArray(t.success_criteria)));

  const diff = adapter.getDiff('demo');
  check('getDiff works on the game repo', diff.ok === true && diff.present === true);

  section('3. destructive git is refused by name');
  const bad = adapter.git(detail.root_path, ['reset', '--hard']);
  check('reset --hard refused', bad.ok === false && bad.blocked === true, JSON.stringify(bad).slice(0, 120));
  const bad2 = adapter.git(detail.root_path, ['push', '--force']);
  check('push --force refused', bad2.ok === false && bad2.blocked === true);

  section('4. planner prompt substitution');
  const wsId = (detail.workspaces[0] ?? {}).workspace_id ?? 'default';
  const prompt = jobs.buildPlannerPrompt('demo', wsId, 'GOAL-MARKER-XYZ');
  check('no unsubstituted {{PLACEHOLDER}} remains', !/\{\{[A-Z_]+\}\}/.test(prompt), (prompt.match(/\{\{[A-Z_]+\}\}/g) ?? []).join(','));
  check('goal text appears verbatim', prompt.includes('GOAL-MARKER-XYZ'));
  check('project name substituted', prompt.includes('demo'));
  check('workspace substituted', prompt.includes(wsId), wsId);
  check('prompt states the no-modification rule', /不修改任何文件|不修改/.test(prompt));
  check('prompt demands a strict output format', prompt.includes('TASK:') && prompt.includes('CRITERIA:'));

  section('5. plan parser');
  const good = [
    '[some preamble the model might add]',
    'TASK:',
    'TITLE: Fix the pulse colour reset',
    'TYPE: coding',
    'MODIFIES_FILES: yes',
    'PRIORITY: high',
    'CRITERIA:',
    '- the graphic is initialised once',
    '- PlayScale does not overwrite Inspector colour',
    '',
    'TASK:',
    'TITLE: Review hud-pulse.js for similar issues',
    'TYPE: review',
    'MODIFIES_FILES: no',
    'PRIORITY: normal',
    'CRITERIA:',
    '- every field assignment to graphic is accounted for',
    '',
    'NOTES:',
    'Runtime verification needs a Unity project; none is available.',
  ].join('\n');
  const p1 = jobs.parsePlan(good);
  check('two tasks parsed', p1.tasks.length === 2, `got ${p1.tasks.length}`);
  check('first task title parsed', p1.tasks[0]?.title === 'Fix the pulse colour reset', p1.tasks[0]?.title);
  check('MODIFIES_FILES yes -> true', p1.tasks[0]?.modifies_files === true);
  check('MODIFIES_FILES no -> false', p1.tasks[1]?.modifies_files === false);
  check('criteria list parsed', (p1.tasks[0]?.successCriteria ?? []).length === 2, JSON.stringify(p1.tasks[0]?.successCriteria));
  check('bullets stripped from criteria', p1.tasks[0]?.successCriteria?.[0] === 'the graphic is initialised once');
  check('NOTES captured', p1.notes.length === 1 && p1.notes[0].includes('Unity'));
  check('no warnings for a well formed plan', p1.warnings.length === 0, p1.warnings.join('|'));

  const p2 = jobs.parsePlan('I could not find enough information to break this down.');
  check('malformed reply yields zero tasks', p2.tasks.length === 0);
  check('malformed reply yields an explicit warning', p2.warnings.length >= 1, p2.warnings.join('|'));

  const p3 = jobs.parsePlan('TASK:\nTYPE: coding\nCRITERIA:\n- x\n');
  check('task without TITLE is skipped with a warning', p3.tasks.length === 0 && p3.warnings.some((w) => w.includes('TITLE')));

  const p4 = jobs.parsePlan('TASK:\nTITLE: No criteria here\nTYPE: coding\n');
  check('task without CRITERIA still parsed but warned', p4.tasks.length === 1 && p4.warnings.some((w) => w.includes('CRITERIA')));

  const many = Array.from({ length: 9 }, (_, i) => `TASK:\nTITLE: T${i}\nTYPE: general\nCRITERIA:\n- c\n`).join('\n');
  check('plan is capped at 5 tasks', jobs.parsePlan(many).tasks.length === 5, String(jobs.parsePlan(many).tasks.length));

  section('6. timeline projection');
  const tl = events.timeline('demo', 50);
  check('timeline returns events', Array.isArray(tl.events) && tl.events.length > 0, `count=${tl.events.length}`);
  check('timeline is newest first', tl.events.every((e, i, a) => i === 0 || String(a[i - 1].at) >= String(e.at)));
  check('every event has a level', tl.events.every((e) => ['info', 'warn', 'error', 'ok'].includes(e.level)),
    [...new Set(tl.events.map((e) => e.level))].join(','));
  check('timeline declares its sources', !!tl.sources && !!tl.note);
  const harnessOnly = tl.events.filter((e) => e.source === 'harness').length;
  check('harness log contributes events', harnessOnly > 0, `harness events=${harnessOnly}`);

  section('7. HTTP surface');
  const server = srv.createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(`  (ephemeral port ${server.address().port})`);

  const ui = await req('GET', '/');
  /**
   * The brand name is no longer a literal in the shell: it comes from the English catalogue and is replaced
   * on load, so asserting `includes('EvidenceCrew')` was asserting a fallback string - and it broke the
   * moment the product was renamed. What matters is that the shell serves the mount points the app needs and
   * loads the localisation engine BEFORE the UI code, which is what these two assertions check.
   */
  check('GET / serves the shell',
    ui.status === 200 && ui.text.includes('id="goalText"') && ui.text.includes('id="language"'));
  check('the shell loads the localisation engine before the UI',
    ui.text.indexOf('/i18n/index.js') > 0 && ui.text.indexOf('/i18n/index.js') < ui.text.indexOf('/app.js'));
  const catalogues = await Promise.all(['en', 'zh-CN', 'zh-TW', 'ja'].map((l) => req('GET', `/i18n/locales/${l}.js`)));
  check('all four locale catalogues are served',
    catalogues.every((c) => c.status === 200 && c.text.includes('I18N.register')),
    catalogues.map((c) => c.status).join(','));
  const css = await req('GET', '/styles.css');
  check('GET /styles.css serves', css.status === 200 && css.text.includes('#bar'));
  const js = await req('GET', '/app.js');
  check('GET /app.js serves', js.status === 200 && js.text.includes('submitGoal'));

  /**
   * ---- V0.3.3: the guided layer ----------------------------------------------------------------
   *
   * Three things have to be true together or the beginner layer is broken in a way that shows up only on a
   * real first visit: the file must be SERVED (a script tag pointing at a path the allowlist refuses 404s
   * silently, and `?.` on the missing global swallows it), the mount point must be in the shell, and the
   * layer must load AFTER the app it decorates.
   */
  const guided = await req('GET', '/guided.js');
  check('GET /guided.js serves', guided.status === 200 && guided.text.includes('window.GuidedUI'),
    `status=${guided.status}`);
  check('the shell carries the guided mount point', ui.text.includes('id="guidedRoot"'));
  /**
   * `lastIndexOf`, not `indexOf`: `/guided.js` is also named in a COMMENT above the mount point, so the first
   * match sits thousands of characters before the script tag and an ordering check built on it compares the
   * wrong positions. This exact mistake produced a false failure in the acceptance suite first.
   */
  const lastTagOf = (s) => ui.text.lastIndexOf(`<script src="${s}">`);
  check('the guided layer loads after the app and the protocol layer',
    lastTagOf('/guided.js') > lastTagOf('/app.js') && lastTagOf('/guided.js') > lastTagOf('/protocol-ui.js'),
    `app=${lastTagOf('/app.js')} protocol=${lastTagOf('/protocol-ui.js')} guided=${lastTagOf('/guided.js')}`);
  check('the guided script tag is a real tag, not just a mention in a comment',
    ui.text.slice(lastTagOf('/guided.js')).startsWith('<script src="/guided.js">'),
    JSON.stringify(ui.text.slice(lastTagOf('/guided.js'), lastTagOf('/guided.js') + 40)));

  /**
   * The layer must NOT contain a policy of its own.
   *
   * This is the defect the review found and removed: an earlier version hardcoded the nine presets, the
   * autonomy limits, the mode map and a full replica of the resolver, so the screen could promise a
   * restriction the Workbench did not enforce. A copy is only visible in a diff, so the absence of one is
   * asserted here - if a future change reintroduces a preset table in the browser, this fails.
   */
  check('the guided layer embeds no preset table of its own',
    !/const\s+PRESETS\s*=/.test(guided.text) && !/guidedPolicyShim\s*\(\s*\)\s*\{/.test(guided.text));
  check('the guided layer embeds no own copy of the autonomy limits',
    !/const\s+AUTONOMY_LIMITS\s*=/.test(guided.text) && !/const\s+AUTONOMY_MODE\s*=/.test(guided.text));
  check('the guided layer reads the policy from the server',
    guided.text.includes('/api/goal/presets') && guided.text.includes('/api/goal/preview'));

  /**
   * ---- V0.3.3: the guided catalogue ------------------------------------------------------------
   *
   * Served, not duplicated into the shell, so the preset list the user clicks and the mapping the server
   * enforces come from one definition.
   */
  const presets = await req('GET', '/api/goal/presets');
  const plist = presets.json?.presets ?? [];
  check('GET /api/goal/presets serves the nine presets', presets.status === 200 && plist.length === 9,
    `count=${plist.length}`);
  check('the preset ids are unique', new Set(plist.map((p) => p.id)).size === plist.length);
  check('GET /api/goal/presets serves the four examples', (presets.json?.examples ?? []).length === 4);
  check('every preset carries a policy, a title key and a description key',
    plist.every((p) => p.title_key && p.description_key && p.file_policy && p.autonomy && p.review_policy),
    plist.filter((p) => !(p.title_key && p.description_key && p.file_policy && p.autonomy && p.review_policy))
      .map((p) => p.id).join(','));
  check('no preset asks for a REQUIRED independent review',
    plist.every((p) => p.review_policy !== 'REQUIRED'),
    plist.filter((p) => p.review_policy === 'REQUIRED').map((p) => p.id).join(','));

  /**
   * ---- V0.3.3: the resolved preview ------------------------------------------------------------
   *
   * The endpoint the UI renders from. What matters is not that it answers, but that its answer is REAL
   * policy: an empty write scope for read-only, and an approval list that is exactly the permitted paths
   * for ask-before-write.
   */
  const preview = await req('GET', '/api/goal/preview?projectId=game&workspaceId=default&presetId=inspect');
  check('GET /api/goal/preview resolves a read-only preset',
    preview.status === 200 && preview.json.file_policy === 'read_only',
    `status=${preview.status} file=${preview.json?.file_policy}`);
  check('read-only really resolves to an EMPTY write scope',
    Array.isArray(preview.json?.permissions?.write_scope)
    && preview.json.permissions.write_scope.length === 0,
    JSON.stringify(preview.json?.permissions));
  check('the preview returns the derived line keys rather than a hand-written list',
    Array.isArray(preview.json?.preview) && preview.json.preview.length > 0
    && preview.json.preview.every((i) => typeof i.key === 'string' && typeof i.state === 'string'));

  const askPreview = await req('GET', '/api/goal/preview?projectId=game&workspaceId=default&presetId=bug_fix');
  check('ask-before-write resolves approval_required to the permitted paths',
    askPreview.status === 200 && askPreview.json.file_policy === 'ask'
    && Array.isArray(askPreview.json.permissions.approval_required)
    && askPreview.json.permissions.approval_required.length > 0
    && askPreview.json.permissions.approval_required.join(',')
      === askPreview.json.permissions.write_scope.join(','),
    JSON.stringify(askPreview.json?.permissions));

  const badPreview = await req('GET', '/api/goal/preview?presetId=not-a-preset');
  check('an unknown preset is refused rather than silently resolved',
    badPreview.status === 400, `status=${badPreview.status}`);

  const noGoalPolicy = await req('GET', '/api/goal/policy');
  check('GET /api/goal/policy refuses without a goalId', noGoalPolicy.status === 400);

  /**
   * ---- V0.3.4: execution intensity ------------------------------------------------------------
   *
   * The intensity is served like every other policy value, so the browser holds no copy of the mapping. What
   * matters for a smoke test is that the three levels arrive with their budgets, that the default is the middle
   * one, and that the resolver honours a request for each.
   */
  const intensities = presets.json?.intensities ?? [];
  check('the preset catalogue serves the three intensities', intensities.length === 3,
    `count=${intensities.length}`);
  check('the canonical intensity ids are FAST, BALANCED, STRICT',
    JSON.stringify(intensities.map((i) => i.id)) === JSON.stringify(['FAST', 'BALANCED', 'STRICT']),
    intensities.map((i) => i.id).join(','));
  check('the default intensity is BALANCED', presets.json?.default_intensity === 'BALANCED', String(presets.json?.default_intensity));
  check('every intensity carries budgets, a tier and a context mode',
    intensities.every((i) => i.budgets && i.validation_tier && i.context),
    JSON.stringify(intensities.map((i) => i.id)));
  check('the served ceiling matches policy.js DEFAULT_LIMITS',
    JSON.stringify(presets.json?.global_ceiling) === JSON.stringify({ max_worker_rounds: 8, max_task_retries: 3, max_goal_iterations: 12, no_progress_limit: 2 }),
    JSON.stringify(presets.json?.global_ceiling));
  check('no preset recommends STRICT',
    plist.every((p) => p.recommended_intensity !== 'STRICT'),
    plist.filter((p) => p.recommended_intensity === 'STRICT').map((p) => p.id).join(','));
  check('every preset recommends an intensity',
    plist.every((p) => ['FAST', 'BALANCED', 'STRICT'].includes(p.recommended_intensity)),
    plist.map((p) => `${p.id}=${p.recommended_intensity}`).join(' '));

  for (const [level, expected] of [['FAST', 1], ['BALANCED', 2], ['STRICT', 8]]) {
    const r = await req('GET', `/api/goal/preview?projectId=game&presetId=bug_fix&executionIntensity=${level}`);
    check(`preview resolves ${level} with ${expected} worker dispatch(es)`,
      r.status === 200 && r.json?.limits?.max_worker_dispatches_per_task === expected,
      `status=${r.status} got=${r.json?.limits?.max_worker_dispatches_per_task}`);
  }
  const fastPreview = await req('GET', '/api/goal/preview?projectId=game&presetId=inspect&executionIntensity=FAST');
  check('FAST resolves with no subagents', fastPreview.json?.limits?.max_subagents === 0,
    String(fastPreview.json?.limits?.max_subagents));
  check('FAST is not eligible for an AUTO Codex review', fastPreview.json?.codex_auto_eligible === false);
  check('the cost bands are words, never a token figure',
    ['few', 'moderate', 'many'].includes(fastPreview.json?.cost?.ai_calls)
    && !/token/i.test(JSON.stringify(fastPreview.json?.cost)),
    JSON.stringify(fastPreview.json?.cost));

  const costNoGoal = await req('GET', '/api/goal/cost');
  check('GET /api/goal/cost refuses without a goalId', costNoGoal.status === 400);
  const costGhost = await req('GET', '/api/goal/cost?goalId=GOAL-does-not-exist');
  check('GET /api/goal/cost reports a missing goal as 404', costGhost.status === 404, `status=${costGhost.status}`);

  const trav = await req('GET', '/../config.json');
  check('path traversal is refused', trav.status === 403 || trav.status === 404 || trav.status === 400, `status=${trav.status}`);
  const trav2 = await req('GET', '/..%2Fconfig.json');
  check('encoded traversal is refused', trav2.status === 403 || trav2.status === 404 || trav2.status === 400, `status=${trav2.status}`);
  const trav3 = await req('GET', '/../app.js');
  check('traversal toward a real public file is still refused',
    trav3.status === 403 || trav3.status === 404 || trav3.status === 400, `status=${trav3.status}`);

  const h = await req('GET', '/api/health');
  check('GET /api/health reports the harness version', h.status === 200 && h.json.harness.status === 'READY', JSON.stringify(h.json.harness));
  // Three states, and the difference matters: true = a baseline exists and matches, false = a baseline
  // exists and the tree does NOT match it, null = no baseline in this tree, so nothing can be claimed.
  // An earlier assertion demanded a boolean, which forced "no baseline" to masquerade as DRIFT.
  check('health reports frozen state from the manifest',
    h.json.harness.frozen === true || h.json.harness.frozen === false || h.json.harness.frozen === null,
    String(h.json.harness.frozen));

  const ps = await req('GET', '/api/projects');
  check('GET /api/projects lists game', ps.status === 200 && ps.json.projects.some((p) => p.project_id === 'demo'));

  const pd = await req('GET', '/api/project?projectId=game');
  check('GET /api/project includes workbench state', pd.status === 200 && !!pd.json.workbench);
  check('project view carries autonomy mode', pd.json.workbench.autonomy_mode === 'ADVISOR', pd.json.workbench.autonomy_mode);
  check('project view carries paused flag', typeof pd.json.workbench.paused === 'boolean');

  const p404 = await req('GET', '/api/project?projectId=does-not-exist');
  check('unknown project -> 404', p404.status === 404, `status=${p404.status}`);

  const nob = await req('GET', '/api/tasks');
  check('tasks without projectId -> 400', nob.status === 400, `status=${nob.status}`);

  const ws = await req('GET', '/api/workspaces?projectId=game');
  check('GET /api/workspaces works', ws.status === 200 && ws.json.workspaces.length >= 1);

  const tk = await req('GET', '/api/tasks?projectId=game');
  check('GET /api/tasks works', tk.status === 200 && Array.isArray(tk.json.tasks));

  // Both Game tasks are DONE, and the UI asks for open-only by default. That is correct
  // behaviour, so the filter itself is what needs asserting - and the task to inspect has to
  // be fetched with closed work included.
  const openOnly = await req('GET', '/api/tasks?projectId=game&includeClosed=0');
  check('includeClosed=0 hides closed tasks (filter is not ignored)',
    openOnly.json.tasks.every((t) => t.status !== 'DONE' && t.status !== 'CANCELLED'),
    openOnly.json.tasks.map((t) => t.status).join(','));
  check('includeClosed=0 returns fewer tasks than the unfiltered list',
    openOnly.json.tasks.length < tk.json.tasks.length,
    `closed=${openOnly.json.tasks.length} all=${tk.json.tasks.length}`);

  const oneTask = tk.json.tasks[0];
  if (oneTask) {
    const t1 = await req('GET', `/api/task?taskId=${encodeURIComponent(oneTask.task_id)}&projectId=game`);
    check('GET /api/task resolves a real task', t1.status === 200 && t1.json.task_id === oneTask.task_id);

    const pk = await req('GET', `/api/packet?projectId=game&taskId=${encodeURIComponent(oneTask.task_id)}`);
    check('GET /api/packet builds a packet', pk.status === 200 && typeof pk.json.packet === 'string' && pk.json.packet.length > 200,
      `status=${pk.status} bytes=${pk.json && pk.json.bytes}`);
    check('packet carries workspace context', !!(pk.json && pk.json.workspace_id));
  } else {
    check('a task exists to inspect', false, 'no tasks returned');
  }

  const ev = await req('GET', '/api/events?projectId=game&limit=20');
  check('GET /api/events returns a timeline', ev.status === 200 && Array.isArray(ev.json.events));
  check('events honour the limit', ev.json.events.length <= 20, String(ev.json.events.length));

  const st = await req('GET', '/api/state?projectId=game');
  check('GET /api/state returns the job snapshot', st.status === 200 && st.json.job && typeof st.json.job.running === 'boolean');

  const jb = await req('GET', '/api/job');
  check('GET /api/job returns the singleton snapshot', jb.status === 200 && 'running' in jb.json);

  const url = await req('GET', '/api/workers?projectId=game');
  check('GET /api/workers lists workers', url.status === 200 && url.json.workers.length >= 1);
  check('worker views include conversation state', url.json.workers.every((w) => typeof w.conversation_state === 'string'));

  const d = await req('GET', '/api/diff?projectId=game');
  check('GET /api/diff returns a diff object', d.status === 200 && d.json.ok === true);

  section('8. the approval gate refuses what it must');
  const noProj = await req('POST', '/api/task/transition', { taskId: 'X', verb: 'start' });
  check('transition without projectId -> 400', noProj.status === 400, `status=${noProj.status}`);
  check('refusal explains why', String(noProj.json.error).includes('project_id'), noProj.json.error);

  const ghost = await req('POST', '/api/task/transition', { projectId: 'nope', taskId: 'X', verb: 'start' });
  check('transition on an unknown project -> 404', ghost.status === 404, `status=${ghost.status}`);

  const badVerb = await req('POST', '/api/task/transition', { projectId: 'demo', taskId: oneTask ? oneTask.task_id : 'X' });
  check('transition without verb -> 400', badVerb.status === 400, `status=${badVerb.status}`);

  const badAct = await req('POST', '/api/task/decision', { projectId: 'demo', action: 'DESTROY' });
  check('unknown decision action -> 400', badAct.status === 400, `status=${badAct.status}`);

  const badAuto = await req('POST', '/api/autonomy', { projectId: 'demo', mode: 'FULL_AUTO' });
  check('unknown autonomy mode -> 400', badAuto.status === 400, `status=${badAuto.status}`);

  const sendNoText = await req('POST', '/api/worker/send', { projectId: 'demo', workerId: (url.json.workers[0] ?? {}).worker_id });
  check('send without text -> 400', sendNoText.status === 400, `status=${sendNoText.status}`);

  const emptyGoal = await req('POST', '/api/goal/submit', { projectId: 'demo', text: '' });
  check('empty goal -> 400', emptyGoal.status === 400, `status=${emptyGoal.status}`);

  const unknownEp = await req('POST', '/api/nope', {});
  check('unknown endpoint -> 404', unknownEp.status === 404, `status=${unknownEp.status}`);

  const wrongMethod = await req('GET', '/api/job/pause');
  check('GET on a command endpoint -> 405', wrongMethod.status === 405, `status=${wrongMethod.status}`);
  check('405 names the allowed method', String(wrongMethod.json.error ?? '').includes('POST'), wrongMethod.json.error);

  const postPage = await req('POST', '/index.html', {});
  check('POST on a real page -> 405, not 404', postPage.status === 405, `status=${postPage.status}`);

  section('9. pause refuses new work, and is restored');
  const wasPaused = store.isPaused('demo');

  const pr = await req('POST', '/api/job/pause', { projectId: 'demo' });
  check('pause succeeds', pr.status === 200 && pr.json.paused === true);
  check('pause explains the checkpoint rule', String(pr.json.note).includes('checkpoint'), pr.json.note);

  check('store now reports paused', store.isPaused('demo') === true);

  const refusedGoal = await req('POST', '/api/goal/submit', { projectId: 'demo', text: 'this must be refused while paused' });
  check('goal submission is refused while paused', refusedGoal.status === 409, `status=${refusedGoal.status}`);
  check('refusal says PAUSED', String(refusedGoal.json.error).includes('PAUSED'), refusedGoal.json.error);

  const refusedTx = await req('POST', '/api/task/transition', { projectId: 'demo', taskId: 'ANY', verb: 'start' });
  check('task transition is refused while paused', refusedTx.status === 409, `status=${refusedTx.status}`);

  const refusedDecision = await req('POST', '/api/task/decision', { projectId: 'demo', action: 'APPROVE' });
  check('task decision is refused while paused', refusedDecision.status === 409, `status=${refusedDecision.status}`);

  const refusedSend = await req('POST', '/api/worker/send', { projectId: 'demo', workerId: 'X', text: 'nope' });
  check('worker send is refused while paused', refusedSend.status === 409, `status=${refusedSend.status}`);

  const rr = await req('POST', '/api/job/resume', { projectId: 'demo' });
  check('resume succeeds', rr.status === 200 && rr.json.paused === false);
  check('store no longer reports paused', store.isPaused('demo') === false);

  const afterResume = await req('POST', '/api/goal/submit', { projectId: 'demo', workspaceId: 'default', text: '' });
  check('gate is open again after resume (empty text still 400, not 409)', afterResume.status === 400, `status=${afterResume.status}`);

  if (wasPaused !== store.isPaused('demo')) store.setPaused('demo', wasPaused);
  check('pause state restored to its original value', store.isPaused('demo') === wasPaused, `was=${wasPaused}`);

  section('10. the send state machine (SEND_PENDING is neither success nor failure)');
  {
    const sendState = require(path.join(WB, 'server', 'send-state.js'));
    const S = sendState.STATE;

    check('all six lifecycle states exist',
      ['SUBMITTING', 'SEND_PENDING', 'USER_TURN_CONFIRMED', 'ASSISTANT_PENDING', 'COMPLETE', 'SEND_UNCERTAIN']
        .every((k) => S[k] === k),
      Object.values(S).join(','));

    // ---- the structural prohibition on duplicate sends ----
    // The only route to a second message is a send call. Reconciliation must not contain one, so
    // this asserts the source rather than trusting the behaviour: a future edit that "helpfully"
    // retries from the pending path fails here.
    //
    // It strips comments first. The module's own documentation names the adapter functions while
    // explaining why it must not call them, and matching prose instead of code is exactly how a
    // guard becomes noise that someone later deletes.
    const sendStateSrc = fs.readFileSync(path.join(WB, 'server', 'send-state.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .replace(/^\s*\/\/.*$/gm, '');      // line comments
    const callSites = ['startSendToWorker', 'sendToWorker', 'send_packet']
      .filter((fn) => new RegExp(`(^|[^\\w.])${fn}\\s*\\(`, 'm').test(sendStateSrc));
    check('send-state.js never CALLS a send path (no blind retry by construction)',
      callSites.length === 0,
      `send call(s) found in code: ${callSites.join(', ')}`);

    // begin + refuseRetry across the states that must block a resend
    const rec = sendState.begin('demo', 'default', 'GPT-TEST-WORKER', 'GOAL-TEST', { userTurnsBefore: 2 });
    check('a send begins in SUBMITTING', rec.state === S.SUBMITTING, rec.state);

    const r1 = sendState.refuseRetry(rec.send_state_id);
    check('SUBMITTING refuses a retry', r1.refused === true, JSON.stringify(r1));
    check('the refusal explains that it would post a SECOND message',
      /second message/i.test(r1.reason), r1.reason);

    sendState.transition(rec.send_state_id, S.SEND_PENDING, 'test');
    const r2 = sendState.refuseRetry(rec.send_state_id);
    check('SEND_PENDING refuses a retry', r2.refused === true, JSON.stringify(r2));
    check('SEND_PENDING is not treated as terminal', !sendState.TERMINAL.includes(S.SEND_PENDING));

    sendState.transition(rec.send_state_id, S.SEND_UNCERTAIN, 'test');
    const r3 = sendState.refuseRetry(rec.send_state_id);
    check('SEND_UNCERTAIN refuses a retry and hands the decision to the user',
      r3.refused === true && /user/i.test(r3.reason), r3.reason);
    check('SEND_UNCERTAIN is terminal', sendState.TERMINAL.includes(S.SEND_UNCERTAIN));

    // ---- reconciliation transitions, with a fake adapter ----
    const rec2 = sendState.begin('demo', 'default', 'GPT-TEST-WORKER', 'GOAL-TEST-2', { userTurnsBefore: 2 });
    sendState.transition(rec2.send_state_id, S.SEND_PENDING, 'test');
    let bumped = 0;
    const fakeAdapter = {
      countUserTurnsAsync: async () => ({ ok: true, user_turns: 2, assistant_turns: 3 }),
      bumpWorkerRound: () => { bumped += 1; return { ok: true, rounds: 9 }; },
    };
    const pending = await sendState.reconcileOnce(rec2.send_state_id, fakeAdapter);
    check('no new user turn keeps it in SEND_PENDING',
      pending.record.state === S.SEND_PENDING, pending.record.state);
    check('nothing is counted while pending', bumped === 0, `bumped=${bumped}`);

    fakeAdapter.countUserTurnsAsync = async () => ({ ok: true, user_turns: 3, assistant_turns: 3 });
    const confirmed = await sendState.reconcileOnce(rec2.send_state_id, fakeAdapter);
    check('an observed user turn moves it to USER_TURN_CONFIRMED',
      confirmed.record.state === S.USER_TURN_CONFIRMED, confirmed.record.state);
    check('the round is counted exactly once, at confirmation', bumped === 1, `bumped=${bumped}`);

    // A turn the ADAPTER already counted must not be counted again by the workbench.
    const rec3 = sendState.begin('demo', 'default', 'GPT-TEST-WORKER', 'GOAL-TEST-3',
      { userTurnsBefore: 2, roundAlreadyCounted: true });
    sendState.transition(rec3.send_state_id, S.SEND_PENDING, 'test');
    let bumped3 = 0;
    await sendState.reconcileOnce(rec3.send_state_id, {
      countUserTurnsAsync: async () => ({ ok: true, user_turns: 3, assistant_turns: 3 }),
      bumpWorkerRound: () => { bumped3 += 1; return { ok: true, rounds: 5 }; },
    });
    check('a round the adapter already counted is NOT double-counted', bumped3 === 0, `bumped=${bumped3}`);

    // ---- the budget: no evidence for long enough becomes SEND_UNCERTAIN, and stops ----
    const rec4 = sendState.begin('demo', 'default', 'GPT-TEST-WORKER', 'GOAL-TEST-4', { userTurnsBefore: 2 });
    sendState.transition(rec4.send_state_id, S.SEND_PENDING, 'test');
    // Backdate it past the budget instead of waiting 15 minutes.
    const backdated = store.getSendState(rec4.send_state_id);
    backdated.created_at = new Date(Date.now() - (sendState.RECONCILE_BUDGET_MS + 60000)).toISOString();
    store.upsertSendState(backdated);
    const uncertain = await sendState.reconcileOnce(rec4.send_state_id, {
      countUserTurnsAsync: async () => ({ ok: true, user_turns: 2, assistant_turns: 3 }),
      bumpWorkerRound: () => ({ ok: true, rounds: 1 }),
    });
    check('budget exhausted with no evidence -> SEND_UNCERTAIN',
      uncertain.record.state === S.SEND_UNCERTAIN, uncertain.record.state);
    check('SEND_UNCERTAIN records that automatic processing stopped',
      !!uncertain.record.stopped_at, JSON.stringify(uncertain.record.stopped_at));
    check('evidence is recorded so the user can judge',
      (uncertain.record.evidence ?? []).length >= 1, `evidence=${(uncertain.record.evidence ?? []).length}`);

    // a terminal send is not reconciled further
    const afterTerminal = await sendState.reconcileOnce(rec4.send_state_id, {
      countUserTurnsAsync: async () => ({ ok: true, user_turns: 99, assistant_turns: 99 }),
      bumpWorkerRound: () => { throw new Error('must not be called'); },
    });
    check('a terminal send is left alone', afterTerminal.terminal === true);
  }

  section('11. a finished goal keeps its terminal status');

  // Regression: `store.updateGoal({status:'AWAITING_APPROVAL'})` was followed by
  // `checkpoint('AWAITING_APPROVAL')`, which wrote IN_PROGRESS straight back over it. The goal had
  // created its task and was waiting for approval while the UI showed it as still running. It was
  // invisible until a goal actually reached that checkpoint - every earlier goal was blocked first.
  {
    const jobsSrc = fs.readFileSync(path.join(WB, 'server', 'jobs.js'), 'utf8');
    check('checkpoint() accepts a terminal status instead of always writing IN_PROGRESS',
      /function checkpoint\(name, finalStatus/.test(jobsSrc),
      'checkpoint() still has no finalStatus parameter');
    check('the AWAITING_APPROVAL checkpoint passes its own terminal status',
      /checkpoint\('AWAITING_APPROVAL',\s*'AWAITING_APPROVAL'\)/.test(jobsSrc),
      'the terminal checkpoint does not preserve its status');

    // And the actual behaviour, through the real store. The probe goal is removed afterwards:
    // this test drives a state transition, it must not leave a fake goal behind for a reader to
    // mistake for a real one - and leaving it behind also pollutes the pointer-store assertion.
    const g = store.addGoal({ project_id: 'demo', workspace_id: 'default', text: 'terminal-status probe' });
    store.updateGoal(g.goal_id, { status: 'AWAITING_APPROVAL', plan: [{ task_id: 'X' }] });
    check('a terminal status survives a subsequent checkpoint write',
      store.getGoal(g.goal_id).status === 'AWAITING_APPROVAL',
      store.getGoal(g.goal_id).status);

    const st = store.load();
    st.goals = st.goals.filter((x) => x.goal_id !== g.goal_id);
    store.save(st);
    check('the probe goal is cleaned up', store.getGoal(g.goal_id) === null);
  }

  section('12. state file remains a pointer store');
  const raw = JSON.parse(fs.readFileSync(store.STATE_FILE, 'utf8'));
  check('state file has no task payloads', !JSON.stringify(raw).includes('success_criteria'));
  check('state file keeps goals as references', Array.isArray(raw.goals) && raw.goals.every((g) => typeof g.project_id === 'string'));
  check('state file records decisions', Array.isArray(raw.decisions));

  await new Promise((res) => server.close(res));

  section('summary');
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (fail) {
    console.log('  failures:');
    for (const f of failures) console.log(`   - ${f}`);
    console.log('');
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(`\nsmoke test crashed: ${e && e.stack ? e.stack : e}\n`);
  process.exit(2);
});
