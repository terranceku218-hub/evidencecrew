'use strict';
/**
 * v2e2e.js - end-to-end exercise of the V2 Workspace + Task layers.
 *
 * WHY THIS IS A SCRIPT AND NOT A SEQUENCE OF SHELL CALLS
 *   The first attempt at this test drove the CLI from a shell loop and produced results
 *   that were wrong for an uninteresting reason: the loop skipped prerequisite lifecycle
 *   states and then misread empty fields. A test that is harder to trust than the code it
 *   tests is worse than no test.
 *
 * SAFETY
 *   Everything happens in a fresh temporary directory. The production registry is never
 *   touched - the harness config is redirected before any module loads it.
 *
 * Usage: node v2e2e.js [--keep]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CONFIG } = require('./lib/paths.js');

const KEEP = process.argv.includes('--keep');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v2e2e-'));

CONFIG.paths.projectRegistry = path.join(TMP, 'registry', 'projects.json');
CONFIG.paths.workerPool = path.join(TMP, 'registry', 'workers.json');
CONFIG.paths.logsDir = path.join(TMP, 'logs');

for (const m of ['./lib/registry.js', './lib/workers.js', './lib/project.js', './lib/workspaces.js', './lib/tasks.js']) {
  delete require.cache[require.resolve(m)];
}
const registry = require('./lib/registry.js');
const workspaces = require('./lib/workspaces.js');
const tasks = require('./lib/tasks.js');
const workers = require('./lib/workers.js');
const router = require('./lib/router.js');
const packet = require('./lib/packet.js');

const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: String(detail ?? '') }); }

/** Walk a task through the states required to reach REVIEW. */
function toReview(record, taskId) {
  for (const step of ['READY', 'IN_PROGRESS', 'REVIEW']) {
    const r = tasks.transition(record, taskId, step);
    if (!r.ok) return r;
  }
  return { ok: true };
}

function main() {
  // ---- setup: project with three workspaces ------------------------------
  const root = path.join(TMP, 'vn');
  for (const d of ['story', 'src/combat', 'art']) fs.mkdirSync(path.join(root, d), { recursive: true });

  const reg = registry.register({ name: 'SchoolMysteryVN', root, type: 'general', projectId: 'visual-novel', scaffold: true });
  const record = registry.getProject('visual-novel');
  check('project registered', reg.ok === true, reg.error ?? record.root_path);

  // ---- TEST 13: V1 project automatically gets the default workspace ------
  const implicit = workspaces.list(record);
  check('TEST 13: V1 project gets implicit default workspace',
    implicit.length === 1 && implicit[0].workspace_id === 'default' && implicit[0].implicit === true,
    implicit.map((w) => `${w.workspace_id}${w.implicit ? '(implicit)' : ''}`).join(','));

  // ---- TEST 1: create three workspaces ----------------------------------
  const wsDefs = [
    { workspaceId: 'game-code', name: 'Game Code', type: 'coding', paths: ['src/combat'], defaultWorkerRole: 'coding', keywords: ['战斗', 'HUD', '空引用', 'combat'] },
    { workspaceId: 'story', name: 'Main Story', type: 'writing', paths: ['story'], defaultWorkerRole: 'writing', keywords: ['剧情', '章节', '动机', 'story'] },
    { workspaceId: 'art', name: 'Art', type: 'art', paths: ['art'], keywords: ['立绘', '素材', 'art'] },
  ];
  for (const def of wsDefs) {
    const r = workspaces.add(record, def);
    check(`TEST 1: workspace added (${def.workspaceId})`, r.ok === true, r.error ?? `${r.workspace.paths.join(',')}`);
  }
  check('TEST 1: declared keywords are persisted',
    (workspaces.get(record, 'game-code').keywords ?? []).includes('战斗'),
    JSON.stringify(workspaces.get(record, 'game-code').keywords));
  check('TEST 1: four workspaces total (3 + implicit default)',
    workspaces.list(record).length === 4, `${workspaces.list(record).length}`);

  check('TEST 1: workspace scaffolded its state dir',
    fs.existsSync(workspaces.workspaceStatePath(record, 'story')),
    workspaces.workspaceStatePath(record, 'story'));

  // ---- TEST 2: workspace state is independent ---------------------------
  fs.writeFileSync(workspaces.workspaceStatePath(record, 'story'), '# Story\nSTORY-DOMAIN-MARKER\n', 'utf8');
  fs.writeFileSync(workspaces.workspaceStatePath(record, 'game-code'), '# Code\nCODE-DOMAIN-MARKER\n', 'utf8');

  const storyText = fs.readFileSync(workspaces.workspaceStatePath(record, 'story'), 'utf8');
  const codeText = fs.readFileSync(workspaces.workspaceStatePath(record, 'game-code'), 'utf8');
  check('TEST 2: workspace state independent',
    storyText.includes('STORY-DOMAIN-MARKER') && codeText.includes('CODE-DOMAIN-MARKER') &&
    !storyText.includes('CODE-DOMAIN-MARKER') && !codeText.includes('STORY-DOMAIN-MARKER'),
    'each workspace holds only its own state');

  // ---- task creation -----------------------------------------------------
  const t1 = tasks.add(record, { workspaceId: 'story', title: 'Rewrite chapter 3 motive', successCriteria: ['motive is foreshadowed'], priority: 'high' });
  const t2 = tasks.add(record, { workspaceId: 'game-code', title: 'Fix HUD null reference', successCriteria: ['no crash'], priority: 'critical' });
  const t3 = tasks.add(record, { workspaceId: 'art', title: 'Redo character art', successCriteria: ['style is consistent'] });
  const tProj = tasks.add(record, { workspaceId: tasks.PROJECT_WORKSPACE, title: 'Release v0.9', successCriteria: ['all acceptance passed'] });

  check('task id format VN-STORY-001', t1.ok && t1.task.task_id === 'VN-STORY-001', t1.task?.task_id);
  check('task id format VN-GAMECODE-001', t2.ok && t2.task.task_id === 'VN-GAMECODE-001', t2.task?.task_id);
  check('task id format VN-ART-001', t3.ok && t3.task.task_id === 'VN-ART-001', t3.task?.task_id);
  check('TEST 16: project-level task uses the "project" pseudo-workspace',
    tProj.ok && tProj.task.workspace_id === 'project', tProj.task?.task_id);

  // ---- TEST 7: lifecycle -------------------------------------------------
  {
    const r = toReview(record, 'VN-STORY-001');
    check('TEST 7a: TODO->READY->IN_PROGRESS->REVIEW', r.ok === true, r.error ?? 'reached REVIEW');

    const bad = tasks.transition(record, 'VN-ART-001', tasks.STATUS.IN_PROGRESS);
    check('TEST 7b: illegal transition refused', bad.ok === false, bad.error?.slice(0, 60));

    const noNote = tasks.transition(record, 'VN-STORY-001', tasks.STATUS.DONE);
    check('TEST 7c: DONE refused without verification', noNote.ok === false, noNote.error?.slice(0, 60));

    const done = tasks.transition(record, 'VN-STORY-001', tasks.STATUS.DONE, { detail: 'reviewed' });
    check('TEST 7d: DONE with verification', done.ok === true && done.task.status === 'DONE', done.task?.status);
  }

  // ---- a task with no success criteria cannot become READY ---------------
  {
    const t = tasks.add(record, { workspaceId: 'story', title: 'Vague task' });
    const r = tasks.transition(record, t.task.task_id, tasks.STATUS.READY);
    check('task without success_criteria cannot become READY', r.ok === false, r.error?.slice(0, 70));
  }

  // ---- TEST 9: dependencies block ---------------------------------------
  {
    const dep = tasks.add(record, {
      workspaceId: 'game-code', title: 'Combat refactor',
      successCriteria: ['perf target met'], dependencies: ['VN-GAMECODE-001'],
    });
    check('TEST 9a: dependent task created', dep.ok === true, dep.error ?? dep.task.task_id);

    const r = tasks.transition(record, dep.task.task_id, tasks.STATUS.READY);
    check('TEST 9b: READY blocked while dependency unfinished',
      r.ok === false && r.status === 'BLOCKED', r.error?.slice(0, 70));

    // Complete the prerequisite, then the dependent task unblocks.
    toReview(record, 'VN-GAMECODE-001');
    tasks.transition(record, 'VN-GAMECODE-001', tasks.STATUS.DONE, { detail: 'fixed and verified' });
    const r2 = tasks.transition(record, dep.task.task_id, tasks.STATUS.READY);
    check('TEST 9c: READY allowed once dependency is DONE', r2.ok === true, r2.error ?? r2.to);
  }

  // ---- TEST 10: cycle detection -----------------------------------------
  {
    const a = tasks.add(record, { workspaceId: 'art', title: 'Cycle A', successCriteria: ['x'] });
    const b = tasks.add(record, { workspaceId: 'art', title: 'Cycle B', successCriteria: ['x'], dependencies: [a.task.task_id] });

    // Pointing A back at B would close the loop; the registry must refuse.
    const data = tasks.load(record);
    data.tasks[a.task.task_id].dependencies = [b.task.task_id];
    const insp = tasks.inspectDependencies(data, [b.task.task_id], a.task.task_id);
    check('TEST 10a: cycle detected', insp.ok === false && !!insp.cycle,
      insp.cycle ? insp.cycle.join(' -> ') : 'NO CYCLE DETECTED');

    const selfDep = tasks.add(record, { workspaceId: 'art', title: 'Self dep', successCriteria: ['x'], dependencies: ['NOPE-001'] });
    check('TEST 10b: nonexistent dependency refused', selfDep.ok === false, selfDep.error?.slice(0, 60));
  }

  // ---- TEST 8: retry cap -------------------------------------------------
  {
    const t = tasks.add(record, { workspaceId: 'art', title: 'Retry me', successCriteria: ['ok'] });
    const id = t.task.task_id;
    toReview(record, id);

    let capHit = false;
    let attempts = 0;
    for (let i = 0; i < 6 && !capHit; i += 1) {
      const r = tasks.transition(record, id, tasks.STATUS.IN_PROGRESS, { detail: `retry ${i + 1}` });
      attempts += 1;
      if (!r.ok && r.status === 'BLOCKED') { capHit = true; break; }
      tasks.transition(record, id, tasks.STATUS.REVIEW);
    }
    const final = tasks.get(record, id);
    check('TEST 8a: retry cap forces BLOCKED', capHit === true, `capHit after ${attempts} retries`);
    check('TEST 8b: retry_count capped at MAX_RETRY',
      final.retry_count === tasks.MAX_RETRY, `retry_count=${final.retry_count} max=${tasks.MAX_RETRY}`);
    check('TEST 8c: task ended BLOCKED not looping', final.status === 'BLOCKED', final.status);
  }

  // ---- TEST 3: workspace workers keep separate conversations -------------
  {
    const wStory = workers.create('visual-novel', { role: 'writing', workspaceId: 'story' });
    const wCode = workers.create('visual-novel', { role: 'coding', workspaceId: 'game-code' });
    check('TEST 3a: story worker created', wStory.ok && wStory.worker.workspace_id === 'story', wStory.worker?.worker_id);
    check('TEST 3b: code worker created', wCode.ok && wCode.worker.workspace_id === 'game-code', wCode.worker?.worker_id);

    workers.bind(wStory.worker.worker_id, 'https://chatgpt.com/c/story-conversation', 'visual-novel', 'story');
    workers.bind(wCode.worker.worker_id, 'https://chatgpt.com/c/code-conversation', 'visual-novel', 'game-code');

    check('TEST 3c: conversations are distinct',
      workers.getForProject('visual-novel', { workspaceId: 'story' }).conversation_url !==
      workers.getForProject('visual-novel', { workspaceId: 'game-code' }).conversation_url,
      'story and game-code hold different URLs');

    const cross = workers.bind(wStory.worker.worker_id, 'https://chatgpt.com/c/other', 'visual-novel', 'game-code');
    check('TEST 3d: cross-workspace conversation bind refused', cross.ok === false, cross.error?.slice(0, 70));

    const own = workers.assertOwnership(wStory.worker.worker_id, 'visual-novel', 'game-code');
    check('TEST 3e: ownership assertion fails cross-workspace', own.ok === false, own.error?.slice(0, 70));

    // Round counting stays per worker, hence per workspace.
    workers.bumpRound(wStory.worker.worker_id, {});
    workers.bumpRound(wStory.worker.worker_id, {});
    workers.bumpRound(wCode.worker.worker_id, {});
    const s = workers.list('visual-novel').find((w) => w.workspace_id === 'story');
    const c = workers.list('visual-novel').find((w) => w.workspace_id === 'game-code');
    check('TEST 3f: independent round counting per workspace',
      s.rounds === 2 && c.rounds === 1, `story=${s.rounds} code=${c.rounds}`);

    // Rotation stays inside its workspace.
    const rot = workers.rotate(wStory.worker.worker_id, 'test');
    check('TEST 3g: rotation stays within the workspace',
      rot.ok === true && rot.created.workspace_id === 'story', rot.created?.workspace_id);
    check('TEST 3h: rotation does not steal another workspace worker',
      workers.getForProject('visual-novel', { workspaceId: 'game-code' }).conversation_url.includes('code-conversation'),
      'game-code worker untouched');
  }

  // ---- TEST 4/5/6: workspace path boundary ------------------------------
  {
    const story = workspaces.get(record, 'story');

    const inside = workspaces.pathAllowed(record, story, 'story/chapter3.md');
    check('TEST 4a: path inside the workspace allowed', inside.ok === true, inside.matched ?? '');

    const outside = workspaces.pathAllowed(record, story, 'src/combat/HUD.cs');
    check('TEST 4b: path outside the workspace refused', outside.ok === false, outside.error?.slice(0, 70));

    // TEST 5: an explicit cross-workspace read is granted by declaration.
    const crossRead = tasks.add(record, {
      workspaceId: 'game-code', title: 'Use story names in combat barks',
      successCriteria: ['barks match character sheet'],
      crossWorkspaceReads: ['story'],
    });
    check('TEST 5a: cross_workspace_reads accepted when declared',
      crossRead.ok === true && crossRead.task.cross_workspace_reads.includes('story'),
      JSON.stringify(crossRead.task?.cross_workspace_reads));

    const badCross = tasks.add(record, {
      workspaceId: 'game-code', title: 'Bad cross read', successCriteria: ['x'],
      crossWorkspaceReads: ['does-not-exist'],
    });
    check('TEST 5b: cross read of unknown workspace refused', badCross.ok === false, badCross.error?.slice(0, 60));

    // TEST 6: cross-workspace WRITE is not granted by the read declaration.
    const writeAttempt = workspaces.pathAllowed(record, story, 'art/portrait.png');
    check('TEST 6: cross-workspace write path refused by default', writeAttempt.ok === false,
      writeAttempt.error?.slice(0, 70));
  }

  // ---- TEST 4 (context): packet carries only this workspace -------------
  {
    const story = workspaces.get(record, 'story');
    const task = tasks.get(record, 'VN-STORY-001');
    const p = packet.buildWorkspaceTask({
      project: record,
      workspace: story,
      task,
      context: { state_files: {}, extra_files: [], missing: [], git: { enabled: false } },
      workspaceState: fs.readFileSync(workspaces.workspaceStatePath(record, 'story'), 'utf8'),
    });
    check('TEST 4c: hierarchical packet builds', p.ok === true, p.error ?? `${p.text.length} bytes`);
    check('TEST 4d: packet carries the workspace state',
      p.text.includes('STORY-DOMAIN-MARKER'), 'story marker present');
    check('TEST 4e: packet does NOT carry another workspace state',
      !p.text.includes('CODE-DOMAIN-MARKER'), 'code marker absent');
    check('TEST 4f: packet uses the layered sections',
      ['[PROJECT]', '[WORKSPACE]', '[TASK]', '[FILES]', '[DECISIONS]', '[DO NOT BREAK]', '[OUTPUT]']
        .every((s) => p.text.includes(s)), 'all sections present');
    check('TEST 4g: packet identifies the task', p.text.includes('VN-STORY-001'), 'task id present');

    const noCriteria = { ...task, success_criteria: [] };
    const bad = packet.buildWorkspaceTask({ project: record, workspace: story, task: noCriteria, context: {} });
    check('TEST 4h: packet refused without success criteria', bad.ok === false, bad.error?.slice(0, 70));
  }

  // ---- TEST 14: router resolves workspace -------------------------------
  {
    const list = workspaces.list(record);
    const r1 = router.route('修一下战斗 HUD 的空引用', { projectId: 'visual-novel', workspaces: list });
    check('TEST 14a: coding task resolves to game-code',
      r1.workspace_id === 'game-code' && r1.worker_role === 'coding', `${r1.workspace_id} role=${r1.worker_role}`);

    const r2 = router.route('把第三章女主的动机重写一下', { projectId: 'visual-novel', workspaces: list });
    check('TEST 14b: writing task resolves to story',
      r2.workspace_id === 'story' && r2.worker_role === 'writing', `${r2.workspace_id} role=${r2.worker_role}`);

    const r3 = router.route('立绘素材需要重做', { projectId: 'visual-novel', workspaces: list });
    check('TEST 14c: art task resolves to art', r3.workspace_id === 'art', `${r3.workspace_id}`);

    // V1 compatibility: no workspaces supplied means workspace stage is skipped.
    const r4 = router.route('Fix the crash', { projectType: 'coding' });
    check('TEST 14d: V1 route() signature still works',
      r4.task_type === 'coding' && r4.workspace_id === null, `${r4.task_type} ws=${r4.workspace_id}`);
  }

  // ---- ambiguous token with no success criteria ---------------------------
  {
    const list = workspaces.list(record);
    const r = router.route('处理一下这个东西', { projectId: 'visual-novel', workspaces: list });
    check('TEST 11: unresolvable workspace reports WORKSPACE_REQUIRED',
      r.workspace_id === null && ['WORKSPACE_REQUIRED', 'WORKSPACE_AMBIGUOUS'].includes(r.workspace_status),
      `${r.workspace_status} candidates=${(r.workspace_candidates ?? []).join(',')}`);
  }

  // ---- TEST 12: workspace removal safety --------------------------------
  {
    // art has ACTIVE workers? No - but it has unfinished tasks.
    const blocked = workspaces.remove(record, 'art', { tasks: tasks.openTasksIn(record, 'art') });
    check('TEST 12a: removal refused while tasks are unfinished', blocked.ok === false, blocked.blockers?.join('; ').slice(0, 80));

    // Close the tasks, add an active worker, and it must still refuse.
    const artTasks = tasks.list(record, { workspaceId: 'art' });
    for (const t of artTasks) {
      if (t.status === 'DONE' || t.status === 'CANCELLED') continue;
      tasks.transition(record, t.task_id, tasks.STATUS.CANCELLED);
    }
    const wArt = workers.create('visual-novel', { role: 'general', workspaceId: 'art' });
    workers.bind(wArt.worker.worker_id, 'https://chatgpt.com/c/art-conversation', 'visual-novel', 'art');

    const blocked2 = workspaces.remove(record, 'art', { tasks: tasks.openTasksIn(record, 'art') });
    check('TEST 12b: removal refused while an ACTIVE worker exists',
      blocked2.ok === false && blocked2.blockers.some((b) => b.includes('ACTIVE')), blocked2.blockers?.join('; ').slice(0, 90));

    // Archive is the sanctioned path, and must preserve everything.
    const stateBefore = fs.readFileSync(workspaces.workspaceStatePath(record, 'art'), 'utf8');
    const archived = workspaces.remove(record, 'art', { archive: true, tasks: tasks.openTasksIn(record, 'art'), reason: 'test archive' });
    check('TEST 12c: archive succeeds', archived.ok === true && archived.action === 'ARCHIVED', archived.error ?? archived.action);
    check('TEST 11: archive preserves state files',
      fs.existsSync(workspaces.workspaceStatePath(record, 'art')) &&
      fs.readFileSync(workspaces.workspaceStatePath(record, 'art'), 'utf8') === stateBefore,
      'WORKSPACE_STATE.md byte-identical');
    check('TEST 11: archive preserves the workspace directory',
      fs.existsSync(workspaces.workspaceDir(record, 'art')), workspaces.workspaceDir(record, 'art'));

    // Unregistering (no --archive) must also leave the directory on disk.
    const storyTasks = tasks.list(record, { workspaceId: 'story' });
    for (const t of storyTasks) {
      if (t.status !== 'DONE' && t.status !== 'CANCELLED') tasks.transition(record, t.task_id, tasks.STATUS.CANCELLED);
    }
    const allWorkers = workers.list('visual-novel');
    for (const w of allWorkers) {
      if (w.workspace_id === 'story' && w.status === 'ACTIVE') workers.archive(w.worker_id, 'test cleanup');
    }
    const storyDir = workspaces.workspaceDir(record, 'story');
    const fileInStory = path.join(storyDir, 'KEEP-ME.txt');
    fs.writeFileSync(fileInStory, 'this file must survive unregistration\n', 'utf8');

    const unreg = workspaces.remove(record, 'story', { tasks: tasks.openTasksIn(record, 'story') });
    check('TEST 12d: unregister succeeds when idle', unreg.ok === true && unreg.action === 'UNREGISTERED', unreg.error ?? unreg.action);
    check('TEST 12e: unregister leaves the state directory on disk',
      fs.existsSync(storyDir) && fs.existsSync(fileInStory), storyDir);
    check('TEST 12f: unregistered workspace is gone from the registry',
      workspaces.get(record, 'story') === null, 'not listed');
  }

  // ---- the implicit default workspace is protected ----------------------
  {
    const r = workspaces.remove(record, 'default', {});
    check('implicit default workspace cannot be removed', r.ok === false, r.error?.slice(0, 70));
  }

  // ---- workspace path escaping the project root -------------------------
  {
    const r = workspaces.add(record, { workspaceId: 'escape', name: 'Escape', type: 'general', paths: ['../../outside'] });
    check('workspace path escaping the project root refused', r.ok === false, r.error?.slice(0, 70));
  }

  // ---- report -----------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  const summary = {
    ok: failed.length === 0,
    passed: results.length - failed.length,
    failed: failed.length,
    tempRoot: TMP,
    kept: KEEP,
    results,
  };
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } }
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.exit(failed.length === 0 ? 0 : 1);
}

try {
  main();
} catch (e) {
  process.stdout.write(JSON.stringify({
    ok: false, error: String(e && e.stack ? e.stack : e), tempRoot: TMP,
  }, null, 2) + '\n');
  process.exit(1);
}
