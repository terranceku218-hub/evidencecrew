'use strict';
/**
 * renderers.js - Envelope -> transport-specific packet.
 *
 * WHY THIS LAYER EXISTS
 *   The protocol is the envelope. The packet is prose. Conflating them is the mistake this file
 *   exists to prevent: if the protocol were "the prompt we send to ChatGPT", then a second provider
 *   would need a second protocol, and the abstraction would be a wrapper with extra steps.
 *
 *   So: the envelope carries facts. A renderer decides how to SAY those facts to one kind of
 *   recipient. Adding Claude later means adding a renderer, not touching the protocol.
 *
 * RENDERERS ARE PURE
 *   text in, text out, no I/O, no clock, no randomness. That makes them testable, diffable, and safe
 *   to run twice. Anything a renderer needs must already be in the envelope.
 *
 * EVERY RENDERER MUST EMIT THE ACK BLOCK
 *   The ack lines are not decoration and not optional politeness: they are the correlation mechanism.
 *   A renderer that forgets them produces packets whose replies can never be correlated, so the ack
 *   requirement is asserted by test rather than trusted to each renderer's author.
 */

const { hashSourceSet } = require('./protocol.js');

const ACK_RUN = 'RUN_ID_ACK';
const ACK_SOURCE = 'SOURCE_HASH_ACK';

/** The block that must appear in every rendered packet, whatever the dialect. */
function ackBlock(envelope) {
  const bound = (envelope.source_files ?? []).filter((f) => f.sha256 !== null);
  const setHash = bound.length ? hashSourceSet(bound) : 'NO_SOURCE_BOUND';
  return [
    '[ACKNOWLEDGEMENT - REQUIRED]',
    `Begin your reply with these two lines, exactly, before anything else:`,
    `${ACK_RUN}: ${envelope.run_id}`,
    `${ACK_SOURCE}: ${setHash}`,
    '',
    `If you cannot read one of the source files listed above, write ${ACK_SOURCE}: UNREADABLE instead.`,
    `Do not invent these values. They are compared against the dispatch record, and a mismatch`,
    `means your reply cannot be attributed to this task at all.`,
  ].join('\n');
}

function permissionBlock(envelope) {
  const p = envelope.permissions ?? {};
  const lines = ['[PERMISSIONS]'];
  lines.push(`- readable   : ${(p.read_scope ?? []).join(', ') || '(as listed in source)'}`);
  lines.push(`- writable   : ${(p.write_scope ?? []).join(', ') || '(none - this is a read-only task)'}`);
  if ((p.deny ?? []).length) lines.push(`- forbidden  : ${(p.deny ?? []).join(', ')}`);
  if ((p.approval_required ?? []).length) lines.push(`- needs approval before write: ${(p.approval_required ?? []).join(', ')}`);
  lines.push('- These are limits, not suggestions. If the task cannot be done inside them, say so and stop.');
  return lines.join('\n');
}

function sourceBlock(envelope) {
  const files = envelope.source_files ?? [];
  if (!files.length) return '[SOURCE]\nNo source files were bound to this run.';
  const setHash = hashSourceSet(files.filter((f) => f.sha256 !== null));
  const lines = ['[SOURCE - THE VERSION YOU ARE REASONING ABOUT]', `source set: ${setHash}`];
  for (const f of files) {
    lines.push(`- ${f.path}  sha256=${f.sha256 ?? 'ABSENT_AT_DISPATCH'}  ${f.bytes ?? 0} bytes`);
  }
  lines.push('');
  lines.push('This is the exact content recorded at dispatch. If what you read differs from these');
  lines.push('hashes, stop and report the discrepancy rather than proceeding.');
  return lines.join('\n');
}

function criteriaBlock(envelope) {
  if (!(envelope.success_criteria ?? []).length) return '[SUCCESS CRITERIA]\n(none stated - say so in NOTES if the task is under-specified)';
  return ['[SUCCESS CRITERIA]', ...envelope.success_criteria.map((c, i) => `${i + 1}. ${c}`)].join('\n');
}

/**
 * The default renderer: a structured packet for a capable chat model driven through any transport.
 * Used for the ChatGPT browser seat and for any OpenAI-compatible HTTP seat that has no opinion.
 */
function renderStructured(envelope) {
  return [
    '[ROLE]',
    'You are a Worker on a verified task. Your reply is reviewed by a different agent and must be',
    'attributable, so it begins with an acknowledgement and states its own limits.',
    '',
    ackBlock(envelope),
    '',
    '[TASK]',
    `project  : ${envelope.project_id}`,
    `workspace: ${envelope.workspace_id}`,
    `task     : ${envelope.task_id}${envelope.task?.title ? ` - ${envelope.task.title}` : ''}`,
    envelope.task?.description ? `\n${envelope.task.description}` : '',
    '',
    sourceBlock(envelope),
    '',
    permissionBlock(envelope),
    '',
    criteriaBlock(envelope),
    '',
    '[EXPECTED OUTPUT]',
    envelope.expected_output ?? 'State clearly what you did, what you could not verify, and what remains uncertain.',
    '',
    '[RULES]',
    '- Do not modify any file outside the writable list.',
    '- If information is insufficient, say so in NOTES. Do not guess.',
    '- Distinguish what you verified from what you assume.',
    envelope.request ? `\n[REQUEST]\n${envelope.request}` : '',
  ].filter((s) => s !== '').join('\n');
}

/**
 * A terse dialect for a human operator acting as a seat.
 *
 * A person does not need shouting caps and role framing; they need the facts and the ack format so
 * their written answer is still machine-attributable. Same envelope, different register.
 */
function renderForHuman(envelope) {
  const bound = (envelope.source_files ?? []).filter((f) => f.sha256 !== null);
  const setHash = bound.length ? hashSourceSet(bound) : 'NO_SOURCE_BOUND';
  return [
    `TASK ${envelope.task_id}${envelope.task?.title ? `: ${envelope.task.title}` : ''}`,
    `workspace ${envelope.workspace_id}   run ${envelope.run_id}`,
    '',
    envelope.request ?? envelope.task?.description ?? '(no request text)',
    '',
    (envelope.source_files ?? []).length
      ? `Source bound: ${(envelope.source_files ?? []).map((f) => f.path).join(', ')}`
      : 'No source bound.',
    (envelope.permissions?.write_scope ?? []).length
      ? `Writable: ${envelope.permissions.write_scope.join(', ')}`
      : 'Read-only task.',
    '',
    'When you answer, reply in this app rather than in chat, and paste this header first:',
    `${ACK_RUN}: ${envelope.run_id}`,
    `${ACK_SOURCE}: ${setHash}`,
  ].join('\n');
}

/** Dialects available by name. Adding a provider means adding an entry, not a new protocol. */
const RENDERERS = {
  structured: { id: 'structured', description: 'default structured packet for a chat model', render: renderStructured },
  human: { id: 'human', description: 'terse dialect for a human operator seat', render: renderForHuman },
};

/**
 * Choose a renderer.
 *
 * Order: explicit request, then the transport's declared default, then `structured`. It never
 * switches on provider name - a renderer is chosen by what the RECIPIENT needs, which is why
 * "provider === chatgpt" appears nowhere.
 */
function pickRenderer(opts = {}) {
  if (opts.renderer && RENDERERS[opts.renderer]) return RENDERERS[opts.renderer];
  if (opts.defaultRenderer && RENDERERS[opts.defaultRenderer]) return RENDERERS[opts.defaultRenderer];
  return RENDERERS.structured;
}

/** Render an envelope to packet text with the chosen dialect. */
function render(envelope, opts = {}) {
  const r = pickRenderer(opts);
  // `sourceAttachment` is content supplied by the caller on behalf of a worker that cannot read files.
  // It is appended rather than woven in, so the protocol sections stay in a fixed order and the
  // attached content is unmistakably marked as evidence rather than instruction.
  const text = r.render(envelope) + (opts.sourceAttachment ? `\n\n${opts.sourceAttachment}` : '');
  return { ok: true, renderer: r.id, text, source_attached: !!opts.sourceAttachment };
}

module.exports = { RENDERERS, pickRenderer, render, renderStructured, renderForHuman, ackBlock };
