'use strict';
/**
 * prepare-worker-source.js - give a browser chat worker the source it cannot fetch itself.
 *
 * THE FINDING THIS RESPONDS TO
 *   Every cross-provider run returned a correctly correlated `RUN_ID_ACK` together with
 *   `SOURCE_HASH_ACK: UNREADABLE`. That was not a protocol failure and not a transport failure: the
 *   worker acking honestly. A ChatGPT chat session has no filesystem, so when the envelope binds
 *   `src/hud-pulse.js` and asks the worker to verify it, the worker cannot read it - and it says so
 *   instead of guessing. The protocol then refused the reply as SOURCE_ACK_MISMATCH, which is exactly
 *   the behaviour that makes the ack worth having.
 *
 * THE CAPABILITY, MADE EXPLICIT
 *   A transport either can deliver source content to its worker or it cannot. When it can, the packet
 *   must CARRY the content, because the worker's inability to read files is a fact about the transport
 *   that the envelope author has to accommodate rather than wish away. This module performs that step:
 *   for a bound source file it embeds the verbatim content plus the recorded hash, so the worker can
 *   genuinely check what it was given and the ack becomes meaningful.
 *
 * WHAT IT REFUSES
 *   - It will not embed a file whose hash does not match the envelope's record. Embedding content that
 *     disagrees with the bound hash would manufacture a verification.
 *   - It will not silently truncate a large file; it reports the truncation in the packet, because a
 *     worker reasoning about a partial file must know that.
 *
 * Read-only: it reads the game source and returns text.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_EMBED_BYTES = 120000;

/**
 * Build the source-attachment section for a packet.
 *
 * @returns {{ok:boolean, text:string, embedded:Array, skipped:Array, error?:string}}
 */
function buildSourceAttachment(envelope, projectRoot) {
  const files = (envelope.source_files ?? []).filter((f) => f.sha256 !== null);
  if (!files.length) {
    return { ok: true, text: '', embedded: [], skipped: [] };
  }

  const embedded = [];
  const skipped = [];
  const sections = [
    '[SOURCE CONTENT - VERBATIM]',
    'Your transport cannot open files, so the exact content of every file bound to this run is',
    'reproduced below. Each block states the sha256 recorded at dispatch. Read what is here; do not',
    'assume the file contains anything that is not shown.',
    '',
  ];

  for (const f of files) {
    const abs = path.join(projectRoot, f.path);
    if (!fs.existsSync(abs)) { skipped.push({ path: f.path, reason: 'not present on disk' }); continue; }

    const buf = fs.readFileSync(abs);
    const live = crypto.createHash('sha256').update(buf).digest('hex');
    if (live !== f.sha256) {
      // Refuse rather than embed: content that disagrees with the bound hash would let the worker
      // verify something other than what this run recorded.
      skipped.push({ path: f.path, reason: `hash mismatch: envelope ${String(f.sha256).slice(0, 12)} vs disk ${live.slice(0, 12)}` });
      continue;
    }

    const truncated = buf.length > MAX_EMBED_BYTES;
    const body = buf.subarray(0, MAX_EMBED_BYTES).toString('utf8');
    sections.push(`--- ${f.path} (sha256=${f.sha256}, ${buf.length} bytes) ---`);
    if (truncated) sections.push(`[TRUNCATED at ${MAX_EMBED_BYTES} bytes - the file is longer than this packet carries]`);
    sections.push(body);
    sections.push('');
    embedded.push({ path: f.path, sha256: f.sha256, bytes: buf.length, truncated });
  }

  if (skipped.length) {
    sections.push('[SOURCE NOT EMBEDDED]');
    for (const s of skipped) sections.push(`- ${s.path}: ${s.reason}`);
    sections.push('');
  }

  return { ok: true, text: sections.join('\n'), embedded, skipped };
}

module.exports = { buildSourceAttachment, MAX_EMBED_BYTES };
