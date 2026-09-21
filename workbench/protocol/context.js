'use strict';
/**
 * context.js - the compact task context, and the handoff built from it.
 *
 * THE PROBLEM
 *   "Send the conversation so far" is the default shape of an agent loop, and it is the most expensive mistake
 *   available: the transcript grows with every turn, so each turn costs more than the last while the new
 *   INFORMATION in it stays roughly constant. A supervisor that re-reads a finished task's whole exchange in
 *   order to plan the next one is paying for history it has already acted on.
 *
 * WHAT REPLACES IT
 *   Long-term state lives in the WORKBENCH - goals, tasks, decisions, evidence - not in a chat window. So the
 *   context a turn needs is assembled from those records: what is being done, what was decided, what the code
 *   looks like, and what the latest evidence says. This module builds exactly that, and it is a pure function of
 *   records, which means it can be tested without a model, a browser or a clock.
 *
 * WHAT IS DELIBERATELY EXCLUDED, AND WHY EACH ONE COSTS MONEY
 *   completed_tasks   their conversations are settled; re-reading them buys nothing and costs everything
 *   logs              operational noise, not state, and it grows without bound
 *   prior_reports     a summary that has already become a decision is a duplicate
 *   other_providers   output from a seat that is not part of this task is irrelevant context with a price
 *
 * WHY IT REPORTS A SIZE
 *   A context budget nobody can measure is a context budget nobody enforces. `chars` is exact - it is a string
 *   length. `approx_tokens` is an ESTIMATE and is labelled as one in the field name, because a field called
 *   `tokens` would be quoted as a measurement. Both are reported so that "the context got smaller" is a
 *   checkable claim rather than a feeling.
 */

/** The six sections, in the order a reader needs them: what, why, what was settled, what the code is, proof, gaps. */
const SECTIONS = ['goal', 'current_task', 'decisions', 'source', 'evidence', 'open_findings'];

/** Caps, so a single large input cannot silently become the whole context. */
const CAPS = {
  decisions: 8,
  source_files: 12,
  evidence: 3,
  open_findings: 8,
  text_chars: 1200,
};

function clip(text, max = CAPS.text_chars) {
  const s = String(text ?? '').trim();
  return s.length <= max ? s : `${s.slice(0, max)}\u2026`;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Build the compact context for one turn.
 *
 * @param {object} input
 * @param {{goal_id?:string, text?:string, status?:string}} input.goal
 * @param {{task_id?:string, title?:string, status?:string, success_criteria?:string[]}} input.task
 * @param {Array<{action?:string, reason?:string, task_id?:string, created_at?:string}>} input.decisions
 * @param {Array<{path:string, sha256?:string, note?:string}>} input.sourceFiles
 * @param {Array<{record_id?:string, task_id?:string, status?:string, headline?:string, review_level?:string}>} input.evidence
 * @param {string[]} input.openFindings
 * @param {object} [input.excluded] counts of what the caller dropped, reported for auditing
 * @returns {{sections:object, chars:number, approx_tokens:number, caps:object, excluded:object}}
 */
function buildCompactContext(input = {}) {
  const goal = input.goal ?? {};
  const task = input.task ?? {};

  const decisions = asArray(input.decisions)
    .slice(-CAPS.decisions)
    .map((d) => ({
      action: d.action ?? null,
      task_id: d.task_id ?? null,
      reason: d.reason ? clip(d.reason, 240) : null,
      at: d.created_at ?? null,
    }));

  const source = asArray(input.sourceFiles)
    .slice(0, CAPS.source_files)
    .map((f) => ({
      path: f.path ?? null,
      // The hash is carried because it is what makes a later verification possible; it costs 64 characters and
      // saves a whole re-read of the file.
      sha256: f.sha256 ?? null,
      note: f.note ? clip(f.note, 200) : null,
    }));

  /**
   * ONLY THE LATEST EVIDENCE, because evidence is a STATE not a JOURNAL.
   *
   * A record's verdict supersedes the one before it for the same task - that is what "final_status" means. So
   * the context carries the last few records and not the history of them, which is the difference between
   * knowing whether the task passed and re-reading every attempt it took.
   */
  const evidence = asArray(input.evidence)
    .slice(0, CAPS.evidence)
    .map((e) => ({
      record_id: e.record_id ?? null,
      task_id: e.task_id ?? null,
      status: e.status ?? null,
      review_level: e.review_level ?? null,
      headline: e.headline ? clip(e.headline, 240) : null,
    }));

  const sections = {
    goal: {
      goal_id: goal.goal_id ?? null,
      text: clip(goal.text, CAPS.text_chars),
      status: goal.status ?? null,
    },
    current_task: task && (task.task_id || task.title) ? {
      task_id: task.task_id ?? null,
      title: task.title ? clip(task.title, 240) : null,
      status: task.status ?? null,
      // The criteria ARE the definition of done, so they are carried whole rather than summarised: a
      // summarised acceptance condition is one nobody can be held to.
      success_criteria: asArray(task.success_criteria).map((c) => clip(c, 240)),
    } : null,
    decisions,
    source,
    evidence,
    open_findings: asArray(input.openFindings).slice(0, CAPS.open_findings).map((f) => clip(f, 240)),
  };

  const serialised = JSON.stringify(sections);
  return {
    sections,
    chars: serialised.length,
    /**
     * An ESTIMATE, and named so. Roughly four characters per token for mixed English and CJK source, which is
     * accurate enough to compare two contexts and not accurate enough to bill anyone for.
     */
    approx_tokens: Math.ceil(serialised.length / 4),
    caps: { ...CAPS },
    excluded: {
      completed_tasks: input.excluded?.completedTasks ?? 0,
      logs: input.excluded?.logs ?? 0,
      prior_reports: input.excluded?.priorReports ?? 0,
      other_providers: input.excluded?.otherProviders ?? 0,
    },
    /** Named so a caller cannot mistake the assembled object for something else. */
    context_version: '0.1.0',
  };
}

/** Render the context for a prompt. Arrays become bullet lists so a model can read them without JSON noise. */
function renderCompactContext(ctx) {
  if (!ctx?.sections) return '';
  const s = ctx.sections;
  const lines = [];
  lines.push('[GOAL]');
  lines.push(`- id: ${s.goal.goal_id ?? '(none)'}  status: ${s.goal.status ?? '(unknown)'}`);
  lines.push(`- text: ${s.goal.text || '(empty)'}`);

  lines.push('', '[CURRENT TASK]');
  if (!s.current_task) lines.push('- (no task selected)');
  else {
    lines.push(`- id: ${s.current_task.task_id ?? '(none)'}  status: ${s.current_task.status ?? '(unknown)'}`);
    lines.push(`- title: ${s.current_task.title ?? '(none)'}`);
    if (s.current_task.success_criteria.length) {
      lines.push('- done when:');
      for (const c of s.current_task.success_criteria) lines.push(`  - ${c}`);
    } else {
      lines.push('- done when: (no criteria recorded)');
    }
  }

  lines.push('', '[RELEVANT DECISIONS]');
  if (!s.decisions.length) lines.push('- (none recorded)');
  else for (const d of s.decisions) lines.push(`- ${d.action ?? '?'}${d.task_id ? ` ${d.task_id}` : ''}${d.reason ? `: ${d.reason}` : ''}`);

  lines.push('', '[RELEVANT SOURCE]');
  if (!s.source.length) lines.push('- (no files bound)');
  else for (const f of s.source) lines.push(`- ${f.path ?? '?'}${f.sha256 ? ` sha256:${String(f.sha256).slice(0, 12)}` : ''}${f.note ? ` (${f.note})` : ''}`);

  lines.push('', '[LATEST EVIDENCE]');
  if (!s.evidence.length) lines.push('- (none recorded)');
  else for (const e of s.evidence) lines.push(`- ${e.status ?? '?'}${e.task_id ? ` ${e.task_id}` : ''}${e.review_level ? ` review=${e.review_level}` : ''}${e.headline ? `: ${e.headline}` : ''}`);

  lines.push('', '[OPEN FINDINGS]');
  if (!s.open_findings.length) lines.push('- (none)');
  else for (const f of s.open_findings) lines.push(`- ${f}`);

  return lines.join('\n');
}

/**
 * The handoff for a new conversation after rotation.
 *
 * WHY THIS LIVES HERE: the thing a fresh conversation must receive is the SAME compact context, phrased as a
 * continuation. Writing a second, different summariser for handoffs is how the two drift until a rotated
 * conversation is working from a different picture of the task than the one it replaced.
 *
 * The rotation itself is NOT implemented - `shouldRotate` in `protocol/policy.js` already computes the
 * threshold, and the workbench does not yet act on it. This function is the piece that would be needed, built
 * now because it is the same assembly, and it is asserted by test so it cannot rot.
 */
function handoffFor(ctx) {
  if (!ctx?.sections) return null;
  const s = ctx.sections;
  return {
    goal_id: s.goal.goal_id,
    reason: 'conversation rotated: this handoff replaces the previous window, which is not carried forward',
    // Long-term state lives in the Workbench, so the handoff points at it rather than reproducing it.
    state_source: 'project, goal, task, decision and evidence records',
    task_id: s.current_task?.task_id ?? null,
    task_status: s.current_task?.status ?? null,
    done_when: s.current_task?.success_criteria ?? [],
    latest_evidence: s.evidence[0] ?? null,
    open_findings: s.open_findings,
    chars: ctx.chars,
  };
}

module.exports = {
  SECTIONS, CAPS,
  buildCompactContext, renderCompactContext, handoffFor,
};
