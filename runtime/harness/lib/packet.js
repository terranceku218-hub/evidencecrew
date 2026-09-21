'use strict';
/**
 * packet.js - build the packets sent to a ChatGPT Worker.
 *
 * TWO PACKET KINDS
 *   init     - the first message in a project's conversation. Introduces the project and
 *              explicitly forbids starting work, so the worker reports understanding
 *              instead of charging ahead.
 *   task     - a scoped task for an established worker.
 *   handoff  - the packet sent to a REPLACEMENT conversation when a worker rotates. It
 *              carries distilled state, never a replay of the old transcript, because
 *              replaying the transcript would recreate the context growth rotation exists
 *              to avoid.
 *
 * THE [WORKING RULES] BLOCK IS UNCONDITIONAL
 *   It is what stops a helpful model from inventing plausible code for files it was never
 *   shown, and from widening the task. Those are the two largest correctness risks in this
 *   design, so the block is present in every packet without exception.
 *
 * ASCII-ONLY source: the packet CONTENT is Chinese because that is the project's working
 * language, but the code that assembles it stays ASCII. See ../config.json.
 */

/** Render the state files a packet carries. */
function renderStateFiles(files) {
  const keys = Object.entries(files ?? {});
  if (!keys.length) return '(none provided)';
  const out = [];
  for (const [key, f] of keys) {
    if (!f || !f.present) {
      out.push(`--- ${key}: ${f?.path ?? 'unconfigured'} ---`);
      out.push(`(NOT AVAILABLE: ${f?.reason ?? 'missing'})`);
      out.push('');
      continue;
    }
    out.push(`--- FILE: ${f.path} ---`);
    out.push(f.text);
    out.push(`--- END FILE: ${f.path} ---`);
    out.push('');
  }
  return out.join('\n');
}

function renderExtraFiles(extra) {
  if (!extra || !extra.length) return '(none)';
  const out = [];
  for (const f of extra) {
    out.push(`--- FILE: ${f.path} ---`);
    if (f.present) out.push(f.text); else out.push(`(UNREADABLE: ${f.reason})`);
    out.push(`--- END FILE: ${f.path} ---`);
    out.push('');
  }
  return out.join('\n');
}

const WORKING_RULES = [
  '1. 不要假设没有看到的代码。',
  '2. 涉及代码时以实际最新文件为准。',
  '3. PROJECT_STATE 与代码冲突时明确指出冲突，不要自行选择相信哪一方。',
  '4. 不擅自扩大任务范围。',
  '5. 明确指出潜在副作用。',
  '6. 不修改与任务无关的功能。',
  '7. 信息不足时明确说明缺什么，不要编造。',
  '8. 输出应方便 DeepSeek Supervisor Review。',
];

/**
 * Build the Worker INITIALIZATION packet.
 *
 * @param {object} spec
 * @param {object} spec.project  resolved project config
 * @param {object} spec.context  from project.buildContext
 */
function buildInit(spec) {
  const p = spec.project;
  const c = spec.context;

  const sections = [];

  sections.push('[ROLE]');
  sections.push('你是这个项目的 Expert Worker。');
  sections.push('');
  sections.push('你的职责主要是：');
  sections.push('- 复杂代码分析');
  sections.push('- Debug');
  sections.push('- 架构检查');
  sections.push('- 跨文件推理');
  sections.push('- 代码 Review');
  sections.push('- 副作用分析');
  sections.push('- 修改方案设计');
  sections.push('');
  sections.push('DeepSeek 是 Supervisor。');
  sections.push('你不是最终决策者。');
  sections.push('');

  sections.push('[PROJECT]');
  sections.push(`项目名称：${p.name}`);
  sections.push(`项目类型：${p.type}`);
  sections.push(`项目根目录：${p.root}`);
  sections.push(`当前 Worker：${spec.workerId ?? '(unassigned)'}`);
  sections.push('');

  sections.push('[PROJECT GOAL]');
  sections.push(spec.goal ?? '（见 PROJECT_STATE.md 的「项目目标」一节）');
  sections.push('');

  sections.push('[CURRENT STATE]');
  sections.push('以下状态文件来自该项目自己的 .ai 目录。不要参照任何其它项目的状态。');
  sections.push('');
  sections.push(renderStateFiles(c.state_files));
  sections.push('');

  if (c.extra_files && c.extra_files.length) {
    sections.push('[ADDITIONAL FILES]');
    sections.push(renderExtraFiles(c.extra_files));
    sections.push('');
  }

  if (c.missing && c.missing.length) {
    sections.push('[MISSING INPUTS]');
    sections.push('以下内容在本次任务包中不可用，请勿推测其内容：');
    c.missing.forEach((m, i) => sections.push(`${i + 1}. ${m}`));
    sections.push('');
  }

  sections.push('[GIT STATE]');
  if (c.git && c.git.enabled && c.git.present) {
    sections.push(`分支：${c.git.branch}`);
    sections.push(`HEAD：${c.git.head}`);
    sections.push(`工作区：${c.git.clean ? '干净' : `有 ${c.git.uncommitted_count} 处未提交改动（属于用户既有改动，不要当作本任务的改动）`}`);
  } else {
    sections.push('该项目未启用 Git，或当前目录不是 Git 仓库。');
  }
  sections.push('');

  sections.push('[WORKING RULES]');
  WORKING_RULES.forEach((r) => sections.push(r));
  sections.push('');

  sections.push('[RESPONSE]');
  sections.push('完成初始化后：');
  sections.push('');
  sections.push('不要主动开始修改项目。');
  sections.push('只回复：');
  sections.push('');
  sections.push('1. 你理解的项目目标。');
  sections.push('2. 当前项目状态。');
  sections.push('3. 当前最重要的任务。');
  sections.push('4. 你认为开始工作前还需要确认的技术事实。');
  sections.push('');

  return { ok: true, text: sections.join('\n') };
}

/**
 * Build a scoped TASK packet.
 *
 * @param {object} spec
 * @param {object} spec.project
 * @param {object} spec.context
 * @param {string} spec.task
 * @param {string} spec.request
 * @param {string[]} spec.successCriteria
 * @param {string[]} [spec.doNotBreak]
 * @param {string[]} [spec.knownFacts]
 * @param {Array}  [spec.files]
 * @param {string} [spec.revisionNote]
 */
function buildTask(spec) {
  const absent = [];
  if (!spec.task?.trim()) absent.push('task');
  if (!spec.request?.trim()) absent.push('request');
  if (!Array.isArray(spec.successCriteria) || !spec.successCriteria.length) absent.push('successCriteria');
  if (absent.length) {
    return {
      ok: false,
      error: `task packet is incomplete; missing or empty: ${absent.join(', ')}. ` +
             `A packet without these is a defective delegation.`,
    };
  }

  const p = spec.project;
  const c = spec.context;
  const sections = [];

  sections.push('[ROLE]');
  sections.push(`你是项目「${p.name}」的 Expert Worker。你只依据本任务包中提供的信息作答。`);
  sections.push('DeepSeek 是 Supervisor，你不是最终决策者。');
  sections.push('');

  sections.push('[TASK]');
  sections.push(spec.task.trim());
  sections.push('');

  sections.push('[PROJECT CONTEXT]');
  sections.push(`项目：${p.name}（${p.type}）`);
  sections.push(`根目录：${p.root}`);
  sections.push('');

  if (spec.revisionNote) {
    sections.push('[REVISION REQUEST]');
    sections.push('这是同一任务的修正轮。上一轮结果未被接受，原因与要求如下：');
    sections.push(spec.revisionNote.trim());
    sections.push('');
  }

  sections.push('[PROJECT STATE]');
  sections.push(renderStateFiles(c.state_files));
  sections.push('');

  if (spec.files?.length || c.extra_files?.length) {
    sections.push('[FILES]');
    sections.push(renderExtraFiles([...(c.extra_files ?? []), ...(spec.files ?? [])]));
    sections.push('');
  }

  if (c.missing?.length) {
    sections.push('[MISSING INPUTS]');
    c.missing.forEach((m, i) => sections.push(`${i + 1}. ${m}`));
    sections.push('');
  }

  if (spec.knownFacts?.length) {
    sections.push('[KNOWN FACTS]');
    spec.knownFacts.forEach((f, i) => sections.push(`${i + 1}. ${f}`));
    sections.push('');
  }

  sections.push('[DO NOT BREAK]');
  const dnb = spec.doNotBreak?.length ? spec.doNotBreak : ['不得破坏 PROJECT_STATE.md / DECISIONS.md 中记录的任何既有行为'];
  dnb.forEach((d, i) => sections.push(`${i + 1}. ${d}`));
  sections.push('');

  sections.push('[SUCCESS CRITERIA]');
  spec.successCriteria.forEach((s, i) => sections.push(`${i + 1}. ${s}`));
  sections.push('');

  sections.push('[REQUEST]');
  sections.push(spec.request.trim());
  sections.push('');

  sections.push('[OUTPUT FORMAT]');
  sections.push(spec.outputFormat ?? [
    '用 Markdown 输出，结构固定如下：',
    '',
    '## 结论',
    '（直接回答问题本身，不要复述任务）',
    '',
    '## 依据',
    '（逐条列出判断依据，指明来自哪个文件/哪段内容）',
    '',
    '## 方案 / 分析',
    '（必要细节；涉及代码时给出完整可用的片段或补丁）',
    '',
    '## 风险与副作用',
    '（可能被破坏的东西、边界情况、不确定之处）',
    '',
    '## 不确定项',
    '（信息不足的地方必须写在这里，禁止猜测后当作事实陈述）',
  ].join('\n'));
  sections.push('');

  sections.push('[WORKING RULES]');
  WORKING_RULES.forEach((r) => sections.push(r));
  sections.push('');

  sections.push('[IMPORTANT]');
  sections.push('- 不要修改任何文件；你的输出是分析与方案，落地由 Supervisor 执行。');
  sections.push('- 不要调用外部工具。');

  return { ok: true, text: sections.join('\n') };
}

/**
 * Build a HANDOFF packet for a replacement worker.
 * Carries distilled state only - never the old transcript.
 */
function buildHandoff(spec) {
  const base = buildInit(spec);
  if (!base.ok) return base;
  return {
    ok: true,
    text: base.text.replace(
      '[RESPONSE]',
      [
        '[HANDOFF NOTE]',
        '这是一个新开的对话，用于接替上一个已达到轮换阈值的 Worker。',
        `上一个 Worker 的最终结论：${spec.previousConclusion ?? '(未提供)'}`,
        '你没有上一轮对话的上下文，只有上面提供的材料。',
        '不要要求查看旧对话记录，也不要假设旧对话中的任何内容。',
        '',
        '[RESPONSE]',
      ].join('\n'),
    ),
  };
}

/**
 * Build a HIERARCHICAL task packet: Project -> Workspace -> Task.
 *
 * WHY THE HIERARCHY MATTERS
 *   The V1 packet attached the whole project state to every task. As a project grows, that
 *   means every delegation carries context for work the worker is not doing - which is both
 *   a token cost and, worse, a correctness risk, because irrelevant context invites
 *   irrelevant suggestions. So the packet now carries:
 *
 *     [PROJECT]      minimal - name, type, goal, global constraints
 *     [WORKSPACE]    the domain's goal, state and rules
 *     [TASK]         this task, its criteria and dependencies
 *     [FILES]        only the files this task needs
 *     [DECISIONS]    only the decisions that bear on this task
 *
 *   It NEVER attaches all workspaces, all decisions and all tasks.
 *
 * @param {object} spec
 * @param {object} spec.project
 * @param {object} spec.workspace        the workspace record
 * @param {object} spec.task             the task record
 * @param {object} spec.context          from project.buildContext
 * @param {string} [spec.workspaceState] text of WORKSPACE_STATE.md
 * @param {string[]} [spec.relevantDecisions]
 * @param {Array}  [spec.files]
 * @param {string} [spec.revisionNote]
 */
function buildWorkspaceTask(spec) {
  const absent = [];
  if (!spec.project) absent.push('project');
  if (!spec.workspace) absent.push('workspace');
  if (!spec.task) absent.push('task');
  if (absent.length) {
    return { ok: false, error: `hierarchical packet requires: ${absent.join(', ')}` };
  }
  const t = spec.task;
  if (!t.success_criteria || !t.success_criteria.length) {
    return {
      ok: false,
      error: `${t.task_id} has no success_criteria. A task without acceptance conditions ` +
             `cannot be delegated, because neither side could tell whether it is done.`,
    };
  }

  const p = spec.project;
  const ws = spec.workspace;
  const c = spec.context ?? {};
  const sections = [];

  // ---- [PROJECT] : minimal ---------------------------------------------
  sections.push('[PROJECT]');
  sections.push(`项目：${p.name}（${p.type}）`);
  sections.push(`项目根目录：${p.root}`);
  sections.push(`项目 ID：${p.project_id}`);
  sections.push('');
  sections.push('你是这个项目的 Expert Worker。DeepSeek 是 Supervisor，你不是最终决策者。');
  sections.push('');

  // ---- [WORKSPACE] : the domain ----------------------------------------
  sections.push('[WORKSPACE]');
  sections.push(`工作域：${ws.name}（workspace_id: ${ws.workspace_id}）`);
  sections.push(`工作域类型：${ws.type}`);
  if (ws.paths && ws.paths.length) {
    sections.push(`允许触及的路径：${ws.paths.join(', ')}`);
  } else {
    sections.push('允许触及的路径：（未限定，整个项目根目录）');
  }
  sections.push('');
  sections.push('该工作域的当前状态：');
  sections.push('');
  if (spec.workspaceState) {
    sections.push(spec.workspaceState);
  } else {
    sections.push('(WORKSPACE_STATE.md 不可用，请在「不确定项」中指出)');
  }
  sections.push('');

  // A cross-workspace read must be visible in the packet, so the worker knows it is
  // looking outside its own domain and the supervisor's approval is on record.
  if (t.cross_workspace_reads && t.cross_workspace_reads.length) {
    sections.push('[CROSS-WORKSPACE READ - APPROVED]');
    sections.push(`本任务已获准读取以下工作域：${t.cross_workspace_reads.join(', ')}`);
    sections.push('只读。不要修改这些工作域的任何内容。');
    sections.push('');
  }
  if (t.cross_workspace_writes && t.cross_workspace_writes.length) {
    sections.push('[CROSS-WORKSPACE WRITE - APPROVED]');
    sections.push(`本任务已获准修改以下工作域：${t.cross_workspace_writes.join(', ')}`);
    sections.push('此项需要 Supervisor 复核，修改前必须说明理由。');
    sections.push('');
  }

  // ---- [TASK] ----------------------------------------------------------
  sections.push('[TASK]');
  sections.push(`task_id：${t.task_id}`);
  sections.push(`标题：${t.title}`);
  if (t.description) sections.push(`说明：${t.description}`);
  sections.push(`优先级：${t.priority}`);
  sections.push(`状态：${t.status}`);
  if (t.dependencies && t.dependencies.length) {
    sections.push(`依赖（均已完成）：${t.dependencies.join(', ')}`);
  }
  sections.push('');
  sections.push('目标：');
  sections.push(t.description || t.title);
  sections.push('');
  sections.push('成功标准（必须逐条满足）：');
  t.success_criteria.forEach((s, i) => sections.push(`${i + 1}. ${s}`));
  sections.push('');

  if (spec.revisionNote) {
    sections.push('[REVISION REQUEST]');
    sections.push('这是同一任务的修正轮。上一轮结果未被接受，原因与要求如下：');
    sections.push(String(spec.revisionNote).trim());
    sections.push('');
  }

  // ---- [FILES] ---------------------------------------------------------
  sections.push('[FILES]');
  const files = [...(c.extra_files ?? []), ...(spec.files ?? [])];
  if (files.length) {
    sections.push(renderExtraFiles(files));
  } else {
    sections.push('(本任务未附带文件内容。若完成任务必须阅读文件，请在「不确定项」中明确指出需要哪些文件。)');
  }
  sections.push('');

  if (c.missing?.length) {
    sections.push('[MISSING INPUTS]');
    c.missing.forEach((m, i) => sections.push(`${i + 1}. ${m}`));
    sections.push('');
  }

  if (spec.knownFacts?.length) {
    sections.push('[KNOWN FACTS]');
    spec.knownFacts.forEach((f, i) => sections.push(`${i + 1}. ${f}`));
    sections.push('');
  }

  // ---- [DECISIONS] : only what bears on this task ----------------------
  sections.push('[DECISIONS]');
  if (spec.relevantDecisions && spec.relevantDecisions.length) {
    spec.relevantDecisions.forEach((d, i) => sections.push(`${i + 1}. ${d}`));
  } else {
    sections.push('(与本任务相关的长期决定：无)');
  }
  sections.push('');

  // ---- [DO NOT BREAK] : project + workspace constraints ----------------
  sections.push('[DO NOT BREAK]');
  sections.push('项目级约束：');
  const projectConstraints = spec.doNotBreak?.length
    ? spec.doNotBreak
    : ['不得破坏 PROJECT_STATE.md / DECISIONS.md 中记录的任何既有行为'];
  projectConstraints.forEach((d, i) => sections.push(`${i + 1}. ${d}`));
  sections.push('');
  sections.push('工作域级约束：');
  const wsConstraints = spec.workspaceDoNotBreak?.length
    ? spec.workspaceDoNotBreak
    : [`不得修改工作域「${ws.workspace_id}」声明路径之外的任何文件`];
  wsConstraints.forEach((d, i) => sections.push(`${i + 1}. ${d}`));
  sections.push('');

  // ---- [REQUEST] / [OUTPUT] --------------------------------------------
  sections.push('[REQUEST]');
  sections.push(spec.request?.trim() || '按 [TASK] 的目标与成功标准完成分析并给出方案。');
  sections.push('');

  sections.push('[OUTPUT]');
  sections.push(spec.outputFormat ?? [
    '用 Markdown 输出，结构固定如下：',
    '',
    '## 结论',
    '## 依据',
    '## 方案 / 分析',
    '## 风险与副作用',
    '## 不确定项',
  ].join('\n'));
  sections.push('');

  sections.push('[WORKING RULES]');
  WORKING_RULES.forEach((r) => sections.push(r));
  sections.push('');

  sections.push('[IMPORTANT]');
  sections.push('- 不要修改任何文件；你的输出是分析与方案，落地由 Supervisor 执行。');
  sections.push('- 不要调用外部工具。');
  sections.push(`- 只处理 task_id ${t.task_id}；不要扩展到其它任务或工作域。`);

  return {
    ok: true,
    text: sections.join('\n'),
    task_id: t.task_id,
    workspace_id: ws.workspace_id,
    bytes: 0,
  };
}

module.exports = {
  buildInit, buildTask, buildHandoff, buildWorkspaceTask,
  WORKING_RULES, renderStateFiles, renderExtraFiles,
};
