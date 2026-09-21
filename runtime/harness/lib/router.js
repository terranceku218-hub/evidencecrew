'use strict';
/**
 * router.js - rule-based task routing.
 *
 * WHY RULES AND NOT SOMETHING CLEVERER
 *   The router's job is to decide two things: which KIND of work this is, and whether the
 *   Supervisor should do it alone or delegate to a ChatGPT Worker. That decision is cheap
 *   and explainable, and a misroute is recoverable in one step. A learned classifier would
 *   add a dependency, an unexplainable failure mode, and no accuracy that matters here.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   It does not decide whether the task is EASY. Difficulty is a judgement the Supervisor
 *   makes after reading the real files; a keyword scan cannot know that a one-line change
 *   touches a load-bearing invariant. The router classifies TYPE and offers a default
 *   delegation stance, which the Supervisor may override.
 *
 * ASCII-ONLY source: see the encoding note in ../config.json.
 */

const TASK_TYPES = ['coding', 'writing', 'research', 'project-management', 'review', 'general'];

/**
 * Keyword sets per type. Bilingual because this operator works in Chinese and the tasks
 * arriving here will be written in either language.
 */
const SIGNALS = {
  coding: [
    'bug', 'debug', 'compile', 'compiler', 'build', 'refactor', 'function', 'class',
    'api', 'stack trace', 'exception', 'null', 'crash', 'test', 'unit test', 'lint',
    'performance', 'memory leak', 'regex', 'sql', 'type error', 'import', 'module',
    '.cs', '.js', '.ts', '.py', '.java', '.cpp', '.go', '.rs', '.shader', '.json', '.yaml',
    '代码', '函数', '类', '报错', '编译', '重构', '调试', '崩溃', '异常', '单元测试',
    '性能', '内存', '接口', '脚本', '变量', '语法', '依赖',
  ],
  writing: [
    'write', 'rewrite', 'edit', 'draft', 'prose', 'chapter', 'paragraph', 'tone',
    'style', 'proofread', 'grammar', 'narrative', 'character', 'plot', 'outline',
    'documentation', 'readme', 'blog', 'article', 'copy', 'translation',
    '写作', '改写', '润色', '文风', '语法', '校对', '章节', '段落', '剧情', '人物',
    '设定', '大纲', '文案', '翻译', '文档', '说明',
  ],
  research: [
    'research', 'investigate', 'compare', 'survey', 'find out', 'look up', 'sources',
    'citation', 'evidence', 'state of the art', 'benchmark', 'evaluate options',
    '调研', '调查', '比较', '对比', '查一下', '搜一下', '资料', '来源', '引用',
    '证据', '综述', '现状', '选型', '评估',
  ],
  'project-management': [
    'plan', 'schedule', 'roadmap', 'milestone', 'priority', 'prioritise', 'prioritize',
    'deadline', 'break down', 'estimate', 'backlog', 'status report',
    '计划', '排期', '路线图', '里程碑', '优先级', '里程碑', '拆解', '估时', '进度',
    '待办', '排期',
  ],
  review: [
    'review', 'audit', 'critique', 'check my', 'second opinion', 'sanity check',
    'code review', 'look over', 'find problems', 'what could go wrong',
    '审查', '审核', '复查', '评审', '挑错', '检查一下', '有没有问题', '风险',
  ],
};

/** Signal weights: a filename or extension is stronger evidence than a common word. */
function score(text, keys) {
  const lower = ` ${String(text).toLowerCase()} `;
  let total = 0;
  const matched = [];
  for (const k of keys) {
    const needle = k.toLowerCase();
    if (lower.includes(needle)) {
      // Extensions and dotted tokens are precise; bare words are weak.
      const weight = /^\.|^[a-z]+\.(cs|js|ts|py|java|cpp|go|rs|shader|json|yaml)$/.test(k) ? 3 : 1;
      total += weight;
      matched.push(k);
    }
  }
  return { total, matched };
}

/**
 * Classify a task.
 *
 * @param {string} text
 * @param {string} [projectType] the project's declared type, used as a tie-breaker
 * @returns {{type:string, confidence:'high'|'medium'|'low', matched:string[], scores:object}}
 */
function classify(text, projectType) {
  const scores = {};
  for (const t of Object.keys(SIGNALS)) {
    const r = score(text, SIGNALS[t]);
    scores[t] = r.total;
  }

  let best = 'general';
  let bestScore = 0;
  for (const [t, s] of Object.entries(scores)) {
    if (s > bestScore) { bestScore = s; best = t; }
  }

  // With no signal at all, fall back to the project's own nature rather than "general":
  // a coding project's unlabelled task is far more likely to be coding.
  if (bestScore === 0 && projectType && projectType !== 'general') {
    return { type: projectType === 'coding' ? 'coding' : projectType, confidence: 'low',
             matched: [], scores, note: 'no keyword signal; defaulted to the project type' };
  }
  if (bestScore === 0) {
    return { type: 'general', confidence: 'low', matched: [], scores, note: 'no keyword signal' };
  }

  const all = Object.values(scores).filter((s) => s > 0).length;
  const confidence = bestScore >= 3 ? 'high' : all > 1 ? 'medium' : 'low';

  // Prefer the project's declared type when the raw scores are close.
  let chosen = best;
  if (projectType && scores[projectType] !== undefined && best !== projectType) {
    if (scores[projectType] >= bestScore - 1 && scores[projectType] > 0) chosen = projectType;
  }

  return { type: chosen, confidence, matched: score(text, SIGNALS[chosen] ?? []).matched, scores };
}

/**
 * Decide whether the Supervisor should handle this alone or bring in a Worker.
 *
 * Delegate on TYPE, never on a guess about difficulty. `review` always delegates, because
 * a review performed only by the author of a change is not an independent review.
 *
 * @returns {{delegate:boolean, workerRole:string, reason:string}}
 */
function delegationFor(type, opts = {}) {
  switch (type) {
    case 'coding':
      return { delegate: true, workerRole: 'coding',
               reason: 'code analysis and change design benefit from an independent worker' };
    case 'review':
      return { delegate: true, workerRole: 'review',
               reason: 'a review must come from outside the author of the change' };
    case 'research':
      return { delegate: !!opts.webAvailable, workerRole: 'research',
               reason: opts.webAvailable
                 ? 'research needs source gathering, which the worker can drive'
                 : 'no web capability available; supervisor handles it directly' };
    case 'writing':
      return { delegate: true, workerRole: 'writing',
               reason: 'long-form text quality benefits from a dedicated pass' };
    case 'project-management':
      return { delegate: false, workerRole: 'general',
               reason: 'planning against the state files is the supervisor\'s own job' };
    default:
      return { delegate: false, workerRole: 'general',
               reason: 'general task; supervisor decides after reading the real files' };
  }
}

/**
 * Full routing decision for one task.
 *
 * V1 signature `route(text, {projectType, webAvailable})` keeps working unchanged: with no
 * workspaces supplied, the workspace stage is simply skipped.
 *
 * @param {string} text
 * @param {{
 *   projectType?:string,
 *   webAvailable?:boolean,
 *   projectId?:string,
 *   workspaces?:Array<{workspace_id:string,name?:string,type?:string,paths?:string[],default_worker_role?:string}>,
 *   workspaceId?:string,
 * }} [opts]
 */
function route(text, opts = {}) {
  const c = classify(text, opts.projectType);

  // ---- stage 2: workspace resolution -----------------------------------
  const wsResult = resolveWorkspace(text, opts);

  // ---- stage 3: task type ----------------------------------------------
  //
  // The workspace's declared type is DECISIVE when the text itself is vague. A workspace
  // is a narrower domain than the project, and its type was declared deliberately by the
  // project author - so "rewrite her motive in chapter 3" lands in a `writing` workspace
  // and is writing work, even though the sentence contains no writing keyword.
  //
  // The text still wins when it carries explicit evidence, because a coding task can
  // legitimately appear inside a writing workspace (fixing the build script for the docs
  // site), and silently reclassifying it would misroute the worker role.
  let taskType = c.type;
  let confidence = c.confidence;
  let matched = c.matched;

  const ws = wsResult.workspace;
  if (ws && ws.type && ws.type !== 'general') {
    const textScore = c.scores[ws.type] ?? 0;
    if (textScore >= 2) {
      // The text already points at the same domain; adopt it and raise confidence.
      taskType = ws.type;
      matched = score(text, SIGNALS[ws.type] ?? []).matched;
      confidence = 'high';
    } else if (c.type === 'general' || c.confidence === 'low' || c.type === 'research') {
      // The text is weak or gave a spurious hit (e.g. the word "check" reading as
      // research). The declared workspace domain is the better guide.
      taskType = ws.type;
      matched = [];
      confidence = 'medium';
    }
  }

  const d = delegationFor(taskType, opts);

  // A workspace may name the role it wants; that beats the type-derived default.
  let workerRole = d.workerRole;
  if (wsResult.workspace?.default_worker_role) workerRole = wsResult.workspace.default_worker_role;

  return {
    project_id: opts.projectId ?? null,
    workspace_id: wsResult.workspace?.workspace_id ?? null,
    workspace_status: wsResult.status,
    workspace_candidates: wsResult.candidates,
    task_type: taskType,
    confidence,
    matched_signals: matched,
    scores: c.scores,
    delegate: d.delegate,
    worker_role: workerRole,
    reason: d.reason,
    note: c.note,
    advisory: 'Routing is advisory. The supervisor may override it after reading the real files.',
  };
}

/**
 * Stage 2: work out which workspace a task belongs to.
 *
 * REFUSING TO GUESS IS THE FEATURE
 *   A wrong workspace is not a cosmetic error - it means the worker receives the wrong
 *   context and may touch the wrong files. So when a project declares more than one
 *   workspace and none of them clearly claims the task, the honest answer is
 *   WORKSPACE_REQUIRED, and the Supervisor (or the user) decides. Inventing a best guess
 *   would be the single most damaging thing this function could do.
 *
 * @returns {{status:string, workspace?:object, candidates?:string[]}}
 */
function resolveWorkspace(text, opts = {}) {
  const all = (opts.workspaces ?? []).filter((w) => (w.status ?? 'ACTIVE') !== 'ARCHIVED');

  if (!all.length) return { status: 'NO_WORKSPACES' };

  // An explicit choice always wins.
  if (opts.workspaceId) {
    const hit = all.find((w) => w.workspace_id === opts.workspaceId);
    if (hit) return { status: 'EXPLICIT', workspace: hit };
    return { status: 'WORKSPACE_UNKNOWN', candidates: all.map((w) => w.workspace_id) };
  }

  const lower = ` ${String(text).toLowerCase()} `;
  const scored = [];

  for (const w of all) {
    let s = 0;
    const id = String(w.workspace_id).toLowerCase();
    const name = String(w.name ?? '').toLowerCase();

    // A literal mention of the workspace id or name is decisive evidence.
    if (lower.includes(id)) s += 10;
    if (name && name !== id && lower.includes(name)) s += 8;

    // Project-declared vocabulary is the strongest domain signal available. The router
    // cannot know that a given project calls its combat code "战斗" or "天台" belongs to
    // the story domain - only the project can say that, so it says it in WORKSPACE.yaml
    // and this stage consumes it. Hardcoding such words here would make the router
    // project-specific, which is exactly what it must not be.
    for (const kw of w.keywords ?? []) {
      if (kw && lower.includes(String(kw).toLowerCase())) s += 7;
    }

    // Declared paths mentioned in the text are strong evidence too.
    for (const p of w.paths ?? []) {
      const seg = String(p).split('/').filter(Boolean).pop();
      if (seg && lower.includes(seg.toLowerCase())) s += 6;
    }

    // The workspace's type keywords are weaker, but they add up across a sentence.
    if (w.type && SIGNALS[w.type]) {
      s += score(text, SIGNALS[w.type]).total;
    }

    if (s > 0) scored.push({ workspace: w, score: s });
  }

  if (!scored.length) {
    // A single-workspace project needs no disambiguation.
    if (all.length === 1) return { status: 'ONLY_WORKSPACE', workspace: all[0] };
    return { status: 'WORKSPACE_REQUIRED', candidates: all.map((w) => w.workspace_id) };
  }

  scored.sort((a, b) => b.score - a.score);

  // A tie at the top means the text genuinely fits two domains; ask rather than pick.
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    return {
      status: 'WORKSPACE_AMBIGUOUS',
      candidates: scored.filter((x) => x.score === scored[0].score).map((x) => x.workspace.workspace_id),
    };
  }

  return { status: 'RESOLVED', workspace: scored[0].workspace, score: scored[0].score };
}

module.exports = { TASK_TYPES, SIGNALS, classify, delegationFor, route, resolveWorkspace };
