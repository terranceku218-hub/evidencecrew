'use strict';
/**
 * read-reply.js - read one assistant turn and save it as UTF-8 JSON.
 *
 * WHY THIS EXISTS AS A FILE
 *   `node cw.js read 0 > out.json` goes through PowerShell's redirection, which writes
 *   UTF-16LE with a BOM on this system. The reply is Chinese markdown, so that corrupts
 *   it twice over. Writing the file from inside Node keeps the encoding correct.
 *
 * Usage: node read-reply.js <assistantTurnIndex> [outFile]
 */

const fs = require('node:fs');
const path = require('node:path');

const W = require('./chatgpt-worker.js');

const idx = Number(process.argv[2] ?? 0);
const outFile = process.argv[3] ?? path.join(
  path.resolve(__dirname, '..', 'state', `reply-${idx}.json`),
);

const r = W.read_reply(idx);
const payload = { readAt: new Date().toISOString(), index: idx, ...r };

if (r.ok) fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');

process.stdout.write(JSON.stringify({
  ok: r.ok,
  index: idx,
  chars: (r.text || '').length,
  savedTo: r.ok ? outFile : null,
  detail: r.detail ?? null,
  preview: r.ok ? r.text.slice(0, 400) : null,
}, null, 2) + '\n');
