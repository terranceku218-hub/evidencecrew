'use strict';
/**
 * packet.js - PHASE 7: the structured task packet.
 *
 * WHY A FIXED FORMAT
 *   The remote worker has NO access to this session's context and no cheap way to ask
 *   follow-up questions. A vague delegation ("look at this bug") therefore fails in the
 *   most expensive way possible: it burns a full round and returns something unusable.
 *   The sections below force the supervisor to state what it wants, what it already
 *   knows, and what must not break BEFORE spending a round.
 *
 * WHY IT IS BUILT IN CODE RATHER THAN TYPED EACH TIME
 *   Two failure modes disappear when the envelope is generated:
 *     - a section silently omitted under time pressure (build refuses instead);
 *     - packet drift between rounds, which makes a RETRY incomparable to the attempt it
 *       is correcting.
 *
 * THE [IMPORTANT] BLOCK IS NOT DECORATION
 *   It is what stops a helpful model from inventing plausible-looking code for files it
 *   was never shown. That is the single largest correctness risk in this design, so the
 *   prohibition is part of every packet, unconditionally.
 *
 * ENCODING: this file intentionally contains Chinese, because the worker is instructed
 * in the project's working language and the section markers are part of the protocol the
 * operator reads. Comments are ASCII-only; see the encoding note in lib.js.
 */

const fs = require('node:fs');

/**
 * Compose the [FILES] section from real file contents.
 *
 * Reading from disk (rather than accepting prose descriptions) is deliberate: the
 * supervisor is required to confirm actual file content before delegating, and this is
 * the mechanism that makes that rule enforceable instead of aspirational.
 *
 * @param {Array<{path: string, note?: string, maxChars?: number}>} files
 * @returns {{text: string, included: string[], missing: string[]}}
 */
function readFiles(files) {
  const included = [];
  const missing = [];
  const chunks = [];

  for (const f of files ?? []) {
    const p = f.path;
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      missing.push(p);
      chunks.push(`--- FILE: ${p} ---\n(UNREADABLE: path does not exist - reported rather than guessed)`);
      continue;
    }
    if (stat.isDirectory()) {
      missing.push(p);
      chunks.push(`--- FILE: ${p} ---\n(NOT A FILE: this is a directory)`);
      continue;
    }

    let body;
    try {
      body = fs.readFileSync(p, 'utf8');
    } catch (e) {
      missing.push(p);
      chunks.push(`--- FILE: ${p} ---\n(UNREADABLE: ${e.message})`);
      continue;
    }

    const cap = f.maxChars ?? 60000;
    if (body.length > cap) {
      // Truncation is stated explicitly so the worker knows the file continues and can
      // say so, rather than reasoning over a silently incomplete view.
      body = body.slice(0, cap) +
        `\n\n[... TRUNCATED at ${cap} of ${body.length} characters. ` +
        `The remainder was NOT provided; do not assume its contents.]`;
    }

    included.push(p);
    chunks.push(
      `--- FILE: ${p} ---` +
      (f.note ? `\n(${f.note})` : '') +
      `\n${body}\n--- END FILE: ${p} ---`,
    );
  }

  return { text: chunks.join('\n\n'), included, missing };
}

/**
 * Build a complete task packet.
 *
 * @param {object} spec
 * @param {string} spec.task             the single concrete task
 * @param {string} spec.context          only the background this task needs
 * @param {Array}  spec.files            [{path, note?, maxChars?}]
 * @param {string[]} spec.knownFacts     established facts, including ruled-out theories
 * @param {string[]} spec.doNotBreak     invariants the change must preserve
 * @param {string[]} spec.successCriteria objectively checkable completion conditions
 * @param {string} spec.request          what the worker should actually do
 * @param {string} [spec.outputFormat]   override the default output contract
 * @param {string} [spec.revisionNote]   for RETRY rounds: what was wrong and what to fix
 * @returns {{ok:boolean, text?:string, error?:string, included?:string[], missing?:string[]}}
 */
function build(spec) {
  const required = ['task', 'context', 'knownFacts', 'doNotBreak', 'successCriteria', 'request'];
  const absent = required.filter((k) => {
    const v = spec?.[k];
    if (v === undefined || v === null) return true;
    if (Array.isArray(v)) return v.length === 0;
    return String(v).trim().length === 0;
  });
  if (absent.length) {
    return {
      ok: false,
      error: `packet is incomplete; missing or empty: ${absent.join(', ')}. ` +
             `A packet without these sections is a defective delegation.`,
    };
  }

  const fileSection = readFiles(spec.files ?? []);
  const list = (arr) => arr.map((x, i) => `${i + 1}. ${x}`).join('\n');

  const sections = [
    '[ROLE]',
    '你是本项目的 Expert Worker。你只依据本任务包中提供的信息作答。',
    '',
    '[TASK]',
    String(spec.task).trim(),
    '',
    '[PROJECT CONTEXT]',
    String(spec.context).trim(),
  ];

  if (spec.revisionNote) {
    sections.push(
      '',
      '[REVISION REQUEST]',
      '这是同一任务的修正轮。上一轮结果未被接受，原因与要求如下：',
      String(spec.revisionNote).trim(),
    );
  }

  sections.push(
    '',
    '[FILES]',
    fileSection.text || '(未提供文件内容。若完成任务必须阅读文件，请明确指出。)',
    '',
    '[KNOWN FACTS]',
    list(spec.knownFacts),
    '',
    '[DO NOT BREAK]',
    list(spec.doNotBreak),
    '',
    '[SUCCESS CRITERIA]',
    list(spec.successCriteria),
    '',
    '[REQUEST]',
    String(spec.request).trim(),
    '',
    '[OUTPUT FORMAT]',
    (spec.outputFormat ?? [
      '用 Markdown 输出，结构固定如下：',
      '',
      '## 结论',
      '（直接回答问题本身，不要复述任务）',
      '',
      '## 依据',
      '（逐条列出你的判断依据，指明来自哪个文件/哪段内容）',
      '',
      '## 方案 / 分析',
      '（必要的细节；涉及代码时给出完整可用的片段或补丁）',
      '',
      '## 风险与副作用',
      '（可能被破坏的东西、边界情况、不确定之处）',
      '',
      '## 不确定项',
      '（信息不足的地方必须写在这里，禁止猜测后当作事实陈述）',
    ].join('\n')),
    '',
    '[IMPORTANT]',
    '- 不要假设未提供的代码。只依据 [FILES] 中的真实内容与 [KNOWN FACTS] 作答。',
    '- 发现信息不足必须明确指出，写在「不确定项」中，不要编造。',
    '- 不要自行扩展任务边界；只完成 [REQUEST] 要求的事。',
    '- 不要修改任何文件；你的输出是分析与方案，落地由 Supervisor 执行。',
    '- 不要调用外部工具。',
  );

  return {
    ok: true,
    text: sections.join('\n'),
    included: fileSection.included,
    missing: fileSection.missing,
  };
}

/**
 * Build the handoff packet used when rotating to a fresh worker.
 *
 * Rotation exists to bound context growth, so the handoff must NOT replay the old
 * transcript - that would reproduce exactly the growth it is meant to avoid. It carries
 * distilled state only: project state files, the current task, essential real file
 * content, and the previous worker's final conclusion.
 *
 * @param {object} spec
 * @param {string} spec.task
 * @param {string} spec.previousConclusion
 * @param {string[]} [spec.stateFiles] paths to PROJECT_STATE.md / TASKS.md / DECISIONS.md
 * @param {Array} [spec.files]
 * @param {string[]} [spec.knownFacts]
 * @param {string[]} [spec.doNotBreak]
 * @param {string[]} [spec.successCriteria]
 * @param {string} spec.request
 */
function buildHandoff(spec) {
  const stateFiles = (spec.stateFiles ?? []).map((p) => ({ path: p, note: 'project state file' }));
  return build({
    task: spec.task,
    context: [
      '这是一个新开的 Worker 对话，用于接替上一个已归档的 Worker。',
      '你没有上一轮对话的上下文，只有下面提供的材料。',
      '不要要求查看旧对话记录，也不要假设旧对话中的任何内容。',
    ].join('\n'),
    files: [...stateFiles, ...(spec.files ?? [])],
    knownFacts: [
      ...(spec.knownFacts ?? []),
      `上一个 Worker 的最终结论：${spec.previousConclusion}`,
    ],
    doNotBreak: spec.doNotBreak ?? ['不得破坏 PROJECT_STATE.md / TASKS.md / DECISIONS.md 中记录的任何既有行为'],
    successCriteria: spec.successCriteria ?? ['产出可被 Supervisor 直接审核并执行的结论'],
    request: spec.request,
    outputFormat: spec.outputFormat,
  });
}

/**
 * Build the correction packet for a RETRY round.
 *
 * RETRY is only legitimate when it names the unmet requirement, the correction needed,
 * and the criterion for success. This helper makes that shape mandatory - a bare "try
 * again" cannot be produced through it.
 */
function buildRevision(spec, review) {
  if (!review?.unmet || !review?.correction || !review?.criterion) {
    return {
      ok: false,
      error: 'a RETRY must state (1) which requirement was unmet, (2) what to correct, ' +
             '(3) the success criterion - refusing to emit an unspecified retry',
    };
  }
  return build({
    ...spec,
    revisionNote: [
      `1. 未满足的要求：${review.unmet}`,
      `2. 需要修正的内容：${review.correction}`,
      `3. 成功标准：${review.criterion}`,
      review.notes ? `4. 补充说明：${review.notes}` : '',
    ].filter(Boolean).join('\n'),
  });
}

module.exports = { build, buildHandoff, buildRevision, readFiles };
