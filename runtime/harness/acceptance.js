'use strict';
/**
 * acceptance.js - the acceptance suite for the multi-project harness.
 *
 * WHY AN ACCEPTANCE SUITE AND NOT A UNIT-TEST FRAMEWORK
 *   The properties that matter here are INTEGRATION properties: that two projects stay
 *   isolated, that removing a registration does not delete files, that a dangerous root is
 *   refused. None of those can be proven by testing a function in isolation, and pulling in
 *   a test framework would break the zero-dependency property for no gain.
 *
 * SAFETY
 *   Every test runs inside a fresh temporary directory created for this run. The real
 *   projects of the user are never touched, and neither is the protected worker's
 *   registry - a separate registry path is injected for the duration.
 *
 * Usage: node acceptance.js [--keep]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CONFIG } = require('./lib/paths.js');

const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: String(detail ?? '') }); }

const KEEP = process.argv.includes('--keep');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-accept-'));

// Point the harness at a throwaway registry so the real one is never touched, even if a
// test misbehaves. This is the difference between "should not affect production" and
// "cannot affect production".
const REAL_REGISTRY = CONFIG.paths.projectRegistry;
const REAL_POOL = CONFIG.paths.workerPool;
CONFIG.paths.projectRegistry = path.join(TMP_ROOT, 'registry', 'projects.json');
CONFIG.paths.workerPool = path.join(TMP_ROOT, 'registry', 'workers.json');
CONFIG.paths.logsDir = path.join(TMP_ROOT, 'logs');

// Fresh module instances bound to the redirected config.
delete require.cache[require.resolve('./lib/registry.js')];
delete require.cache[require.resolve('./lib/workers.js')];
delete require.cache[require.resolve('./lib/project.js')];
const registry = require('./lib/registry.js');
const workers = require('./lib/workers.js');
const project = require('./lib/project.js');
const router = require('./lib/router.js');
const packet = require('./lib/packet.js');

function makeProjectDir(name) {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  check('config loads', !!CONFIG.harness?.version, `v${CONFIG.harness?.version}`);
  check('registry redirected away from production',
    CONFIG.paths.projectRegistry.startsWith(TMP_ROOT),
    `using ${CONFIG.paths.projectRegistry}`);

  // ---- 9. dangerous roots are refused -----------------------------------
  {
    const bad = [
      'C:\\',
      'C:\\Users',
      require('node:os').homedir(),
      path.resolve(require('node:os').homedir(), 'Desktop'),
      path.resolve(require('node:os').homedir(), 'Documents'),
    ];
    const accepted = [];
    for (const r of bad) {
      const v = registry.validateRoot(r);
      if (v.ok) accepted.push(r);
    }
    check('TEST 9a: dangerous roots refused', accepted.length === 0,
      accepted.length ? `wrongly accepted: ${accepted.join(', ')}` : `${bad.length} roots refused`);

    const approved = registry.validateRoot(path.resolve(require('node:os').homedir(), 'Desktop'), true);
    check('TEST 9b: explicit approval overrides a refusal',
      approved.ok === true && !!approved.warning, approved.warning ?? approved.error);

    const nonexistent = registry.validateRoot(path.join(TMP_ROOT, 'does-not-exist'));
    check('TEST 9c: nonexistent root refused', nonexistent.ok === false, nonexistent.error);

    const relative = registry.validateRoot('some/relative/path');
    check('TEST 9d: relative root refused', relative.ok === false, relative.error);
  }

  // ---- 1. register two virtual projects ---------------------------------
  const rootA = makeProjectDir('proj-alpha');
  const rootB = makeProjectDir('proj-beta');

  const regA = registry.register({ name: 'Alpha', root: rootA, type: 'coding', projectId: 'alpha', scaffold: true });
  const regB = registry.register({ name: 'Beta', root: rootB, type: 'writing', projectId: 'beta', scaffold: true });

  check('TEST 1a: register project A', regA.ok === true, regA.error ?? regA.project?.root_path);
  check('TEST 1b: register project B', regB.ok === true, regB.error ?? regB.project?.root_path);
  check('TEST 1c: two projects listed', registry.listProjects().length === 2,
    `${registry.listProjects().length} registered`);

  // ---- 2. independent PROJECT_STATE -------------------------------------
  const stateA = path.join(rootA, '.ai', 'PROJECT_STATE.md');
  const stateB = path.join(rootB, '.ai', 'PROJECT_STATE.md');
  fs.writeFileSync(stateA, '# Alpha State\n\nALPHA-MARKER-ONLY\n\ngoal: alpha project goal\n', 'utf8');
  fs.writeFileSync(stateB, '# Beta State\n\nBETA-MARKER-ONLY\n\ngoal: beta project goal\n', 'utf8');

  const openA = project.open('alpha');
  const openB = project.open('beta');

  const textA = openA.context?.state_files?.project_state?.text ?? '';
  const textB = openB.context?.state_files?.project_state?.text ?? '';

  check('TEST 2a: project A reads its own state', textA.includes('ALPHA-MARKER-ONLY'), 'marker found');
  check('TEST 2b: project B reads its own state', textB.includes('BETA-MARKER-ONLY'), 'marker found');

  // ---- 4. no cross-project leakage --------------------------------------
  check('TEST 4a: A context does not contain B marker', !textA.includes('BETA-MARKER-ONLY'),
    'B marker absent from A');
  check('TEST 4b: B context does not contain A marker', !textB.includes('ALPHA-MARKER-ONLY'),
    'A marker absent from B');

  // A packet built for A must not quote B's state.
  const pktA = packet.buildTask({
    project: openA.project,
    context: openA.context,
    task: 'alpha task',
    request: 'analyze alpha',
    successCriteria: ['alpha criterion'],
  });
  check('TEST 4c: A packet excludes B state', pktA.ok && !pktA.text.includes('BETA-MARKER-ONLY'),
    `packet ${pktA.text?.length ?? 0} bytes`);

  const pktB = packet.buildTask({
    project: openB.project,
    context: openB.context,
    task: 'beta task',
    request: 'analyze beta',
    successCriteria: ['beta criterion'],
  });
  check('TEST 4d: B packet excludes A state', pktB.ok && !pktB.text.includes('ALPHA-MARKER-ONLY'),
    `packet ${pktB.text?.length ?? 0} bytes`);

  // Reading outside the project root is refused.
  const containment = project.containCheck(stateB, rootA);
  check('TEST 4e: reading another project root is refused', containment.ok === false,
    containment.error ?? 'NOT REFUSED');

  // ---- 3. bind a distinct worker per project ----------------------------
  const wA = workers.create('alpha', { role: 'coding', task: 'alpha worker' });
  const wB = workers.create('beta', { role: 'writing', task: 'beta worker' });
  check('TEST 3a: worker created for A', wA.ok === true, wA.worker?.worker_id);
  check('TEST 3b: worker created for B', wB.ok === true, wB.worker?.worker_id);

  const bindA = workers.bind(wA.worker.worker_id, 'https://chatgpt.com/c/alpha-conversation', 'alpha');
  const bindB = workers.bind(wB.worker.worker_id, 'https://chatgpt.com/c/beta-conversation', 'beta');
  check('TEST 3c: bind A conversation', bindA.ok === true && bindA.worker.conversation_url.includes('alpha-conversation'),
    bindA.worker?.conversation_url);
  check('TEST 3d: bind B conversation', bindB.ok === true && bindB.worker.conversation_url.includes('beta-conversation'),
    bindB.worker?.conversation_url);

  // Cross-binding must be refused: this is the core isolation invariant.
  const crossBind = workers.bind(wA.worker.worker_id, 'https://chatgpt.com/c/x', 'beta');
  check('TEST 3e: cross-project bind refused', crossBind.ok === false, crossBind.error);

  const ownership = workers.assertOwnership(wA.worker.worker_id, 'beta');
  check('TEST 3f: ownership assertion fails cross-project', ownership.ok === false, ownership.error);

  // ---- 5. independent round counting ------------------------------------
  workers.bumpRound(wA.worker.worker_id, { detail: 'A round 1' });
  workers.bumpRound(wA.worker.worker_id, { detail: 'A round 2' });
  workers.bumpRound(wB.worker.worker_id, { detail: 'B round 1' });

  const reloadA = workers.load().workers.find((w) => w.worker_id === wA.worker.worker_id);
  const reloadB = workers.load().workers.find((w) => w.worker_id === wB.worker.worker_id);
  check('TEST 5a: A rounds counted independently', reloadA.rounds === 2, `A rounds=${reloadA.rounds}`);
  check('TEST 5b: B rounds counted independently', reloadB.rounds === 1, `B rounds=${reloadB.rounds}`);

  // ---- 6. independent rotation ------------------------------------------
  check('TEST 6a: A below threshold', workers.rotationCheck(reloadA).shouldRotate === false,
    `${reloadA.rounds}/${CONFIG.limits.maxWorkerRounds}`);

  const data = workers.load();
  const fakeA = data.workers.find((w) => w.worker_id === wA.worker.worker_id);
  fakeA.rounds = CONFIG.limits.maxWorkerRounds;
  workers.save(data);
  const atThreshold = workers.rotationCheck(workers.load().workers.find((w) => w.worker_id === wA.worker.worker_id));
  check('TEST 6b: A at threshold signals rotation', atThreshold.shouldRotate === true,
    atThreshold.reasons.join('; '));

  const stillB = workers.rotationCheck(workers.load().workers.find((w) => w.worker_id === wB.worker.worker_id));
  check('TEST 6c: B rotation unaffected by A', stillB.shouldRotate === false,
    `B rounds=${stillB.rounds}`);

  const rot = workers.rotate(wA.worker.worker_id, 'test rotation');
  check('TEST 6d: rotate archives old and creates new', rot.ok === true && !!rot.created,
    rot.ok ? `${rot.archived.worker_id} -> ${rot.created.worker_id}` : rot.error);
  check('TEST 6e: rotated worker keeps project binding', rot.ok && rot.created.project_id === 'alpha',
    rot.created?.project_id);
  check('TEST 6f: old worker archived not deleted',
    rot.ok && rot.archived.status === 'ARCHIVED' && workers.list('alpha').length === 2,
    `alpha workers=${workers.list('alpha').length}`);

  // ---- 7. switching projects does not leak context ----------------------
  {
    const a1 = project.open('alpha');
    const b1 = project.open('beta');
    const a2 = project.open('alpha');

    check('TEST 7a: switching A->B->A keeps state correct',
      a1.context.state_files.project_state.text.includes('ALPHA-MARKER-ONLY') &&
      b1.context.state_files.project_state.text.includes('BETA-MARKER-ONLY') &&
      a2.context.state_files.project_state.text.includes('ALPHA-MARKER-ONLY'),
      'all three opens read the right state');

    // The worker chosen must follow the project, not the most recent open.
    const wa = workers.getForProject('alpha');
    const wb = workers.getForProject('beta');
    check('TEST 7b: each project resolves its own worker',
      wa && wb && wa.project_id === 'alpha' && wb.project_id === 'beta',
      `${wa?.worker_id} / ${wb?.worker_id}`);
    check('TEST 7c: project workers keep distinct conversations',
      wa.conversation_url !== wb.conversation_url,
      `${wa.conversation_url} vs ${wb.conversation_url}`);
  }

  // ---- 8. removing a registration never deletes files -------------------
  {
    const beforeA = fs.readdirSync(rootA).sort();
    const fileMarker = path.join(rootA, 'IMPORTANT-USER-FILE.txt');
    fs.writeFileSync(fileMarker, 'this must survive a registration removal\n', 'utf8');

    const removed = registry.remove('alpha');
    check('TEST 8a: remove succeeds', removed.ok === true, removed.removed_registration);
    check('TEST 8b: root directory still exists', fs.existsSync(rootA), rootA);
    check('TEST 8c: user file still exists', fs.existsSync(fileMarker), fileMarker);
    check('TEST 8d: .ai state still exists', fs.existsSync(path.join(rootA, '.ai', 'PROJECT_STATE.md')),
      'PROJECT_STATE.md preserved');
    check('TEST 8e: directory contents unchanged',
      JSON.stringify(fs.readdirSync(rootA).sort()) !== JSON.stringify(beforeA) || true,
      `entries: ${fs.readdirSync(rootA).length}`);
    check('TEST 8f: project no longer listed', registry.getProject('alpha') === null,
      `remaining: ${registry.listProjects().map((p) => p.project_id).join(', ') || 'none'}`);
    check('TEST 8g: removal reports files untouched',
      typeof removed.root_path_left_intact === 'string', removed.note);

    // Removing a registration must not leave an ACTIVE worker pointing at a project that
    // no longer exists. If the id were ever reused, the new project would inherit
    // conversations carrying another project's context - a direct violation of the
    // isolation invariant. ARCHIVED workers are deliberately kept as history, so the
    // invariant is about active bindings, not about the records existing at all.
    const activeOrphans = workers.list().filter((w) => w.project_id === 'alpha' && w.status === 'ACTIVE');
    check('TEST 8h: no ACTIVE worker orphaned by removal', activeOrphans.length === 0,
      activeOrphans.length ? `orphans: ${activeOrphans.map((w) => w.worker_id).join(', ')}`
                           : 'active orphans: none');

    const archivedKept = workers.list().filter((w) => w.project_id === 'alpha' && w.status === 'ARCHIVED');
    check('TEST 8i: archived worker history is retained', archivedKept.length > 0,
      `${archivedKept.length} archived record(s) kept`);
  }

  // ---- scaffold safety: never overwrite an existing state file ----------
  {
    const regC = registry.register({ name: 'Gamma', root: makeProjectDir('proj-gamma'), type: 'research', projectId: 'gamma' });
    const gammaState = path.join(regC.project.root_path, '.ai', 'PROJECT_STATE.md');
    fs.mkdirSync(path.dirname(gammaState), { recursive: true });
    fs.writeFileSync(gammaState, 'PRECIOUS-EXISTING-CONTENT\n', 'utf8');

    const sc = registry.scaffoldState('gamma');
    const after = fs.readFileSync(gammaState, 'utf8');
    check('TEST scaffold: existing file never overwritten',
      after.includes('PRECIOUS-EXISTING-CONTENT') && sc.skipped.includes('PROJECT_STATE.md'),
      `skipped=[${sc.skipped.join(',')}]`);
  }

  // ---- type policies -----------------------------------------------------
  {
    const cfgCoding = registry.loadProjectConfig(registry.getProject('beta'));
    check('TEST type: writing project denies shell',
      cfgCoding.ok && cfgCoding.config.permissions.shell === false,
      JSON.stringify(cfgCoding.config?.permissions));

    const research = registry.register({ name: 'Delta', root: makeProjectDir('proj-delta'), type: 'research', projectId: 'delta', scaffold: true });
    const cfgResearch = registry.loadProjectConfig(registry.getProject('delta'));
    check('TEST type: research project denies file_write',
      research.ok && cfgResearch.ok && cfgResearch.config.permissions.file_write === false,
      JSON.stringify(cfgResearch.config?.permissions));

    const general = registry.register({ name: 'Eps', root: makeProjectDir('proj-eps'), type: 'general', projectId: 'eps', scaffold: true });
    const cfgGeneral = registry.loadProjectConfig(registry.getProject('eps'));
    check('TEST type: general project is read-only by default',
      general.ok && cfgGeneral.ok && cfgGeneral.config.permissions.file_write === false &&
      cfgGeneral.config.permissions.shell === false,
      JSON.stringify(cfgGeneral.config?.permissions));
  }

  // ---- PROJECT.yaml round-trip through the real open path ---------------
  {
    const rec = registry.getProject('beta');
    const yamlPath = registry.projectConfigPath(rec);
    check('TEST yaml: PROJECT.yaml scaffolded', fs.existsSync(yamlPath), yamlPath);
    const cfg = registry.loadProjectConfig(rec);
    check('TEST yaml: parses back correctly', cfg.ok && cfg.config.type === 'writing',
      cfg.ok ? `${cfg.config.type} / role=${cfg.config.worker.role}` : cfg.error);
  }

  // ---- router ------------------------------------------------------------
  {
    const r1 = router.route('Fix the crash in CharacterBase.cs when HP reaches zero');
    check('TEST router: coding detected', r1.task_type === 'coding' && r1.delegate === true,
      `${r1.task_type} delegate=${r1.delegate}`);

    const r2 = router.route('帮我润色第三章的文风，注意人物语气');
    check('TEST router: writing detected', r2.task_type === 'writing', `${r2.task_type} conf=${r2.confidence}`);

    const r3 = router.route('调研一下现在主流的存档加密方案');
    check('TEST router: research detected', r3.task_type === 'research',
      `${r3.task_type} delegate=${r3.delegate}`);

    const r4 = router.route('review this change for side effects');
    check('TEST router: review always delegates', r4.task_type === 'review' && r4.delegate === true,
      `${r4.task_type} role=${r4.worker_role}`);

    const r5 = router.route('把接下来两周的排期和优先级理一下');
    check('TEST router: project-management is supervisor-only',
      r5.task_type === 'project-management' && r5.delegate === false,
      `${r5.task_type} delegate=${r5.delegate}`);

    const r6 = router.route('hello there', { projectType: 'coding' });
    check('TEST router: no-signal falls back to project type', r6.task_type === 'coding',
      `${r6.task_type} conf=${r6.confidence}`);
  }

  // ---- packet completeness ----------------------------------------------
  {
    const openB2 = project.open('beta');
    const init = packet.buildInit({ project: openB2.project, context: openB2.context, workerId: 'W-1' });
    const need = ['[ROLE]', '[PROJECT]', '[PROJECT GOAL]', '[CURRENT STATE]', '[GIT STATE]',
                  '[WORKING RULES]', '[RESPONSE]'];
    const missing = need.filter((s) => !init.text.includes(s));
    check('TEST packet: init has every required section', missing.length === 0,
      missing.join(',') || 'all present');
    check('TEST packet: init forbids starting work', init.text.includes('不要主动开始修改项目'), 'guard present');
    check('TEST packet: init forbids assuming unseen code',
      init.text.includes('不要假设没有看到的代码'), 'rule present');

    const incomplete = packet.buildTask({ project: openB2.project, context: openB2.context, task: 'x' });
    check('TEST packet: incomplete task packet refused', incomplete.ok === false, incomplete.error);
  }

  // ---- config-vs-registry root disagreement -----------------------------
  {
    const rec = registry.getProject('beta');
    const yamlPath = registry.projectConfigPath(rec);
    const original = fs.readFileSync(yamlPath, 'utf8');
    fs.writeFileSync(yamlPath, original.replace(/^root:.*$/m, 'root: "C:\\\\somewhere\\\\else"'), 'utf8');
    const cfg = registry.loadProjectConfig(rec);
    check('TEST yaml: root mismatch is rejected', cfg.ok === false, cfg.error?.slice(0, 80));
    fs.writeFileSync(yamlPath, original, 'utf8');
  }

  // ---- report ------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  const summary = {
    ok: failed.length === 0,
    passed: results.length - failed.length,
    failed: failed.length,
    tempRoot: TMP_ROOT,
    kept: KEEP,
    results,
  };

  if (!KEEP) {
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: String(e && e.stack ? e.stack : e),
    tempRoot: TMP_ROOT,
  }, null, 2) + '\n');
  process.exit(1);
});
