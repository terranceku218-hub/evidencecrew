'use strict';
/**
 * looptest.js - offline proof of the PHASE 7/8 protocol guarantees.
 *
 * WHY THIS IS OFFLINE
 *   The retry cap is PROTOCOL logic, not browser logic. Waiting for a live round trip to
 *   observe it would make the most important safety property in the whole design the
 *   least frequently tested. The loop accepts an injected `transport`, so every branch
 *   below is exercised deterministically with no browser and no network.
 *
 * What it proves:
 *   1. an always-RETRY reviewer still TERMINATES (the cap is structural)
 *   2. the cap is exactly MAX_RETRY_PER_TASK corrections
 *   3. a RETRY with no stated requirement is REJECTED, not executed
 *   4. PASS stops immediately without spending further rounds
 *   5. BLOCKED from review stops immediately
 *   6. a transport failure ends the loop instead of consuming retry budget
 *   7. an incomplete packet is refused before any round is spent
 *   8. a correction round carries the unmet requirement into the same conversation
 *   9. the packet envelope contains every mandated section
 *  10. a missing file is surfaced, never silently omitted
 *
 * Usage: node looptest.js
 */

const { CONFIG } = require('./lib.js');
const packet = require('./packet.js');
const loop = require('./loop.js');

const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); }

const SPEC = {
  task: 'test task',
  context: 'test context',
  files: [],
  knownFacts: ['fact one'],
  doNotBreak: ['nothing'],
  successCriteria: ['criterion one'],
  request: 'do the thing',
};

const GOOD_REVIEW = { verdict: 'PASS' };
const BAD_REVIEW = {
  verdict: 'RETRY',
  review: { unmet: 'requirement A unmet', correction: 'fix A', criterion: 'A satisfied' },
};

/** Counting transport that always answers. */
function countingTransport(reply = 'a reply') {
  const calls = [];
  const fn = async (text, attempt) => {
    calls.push({ attempt, text });
    return { ok: true, reply };
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  const maxRetry = CONFIG.limits.maxRetryPerTask;

  // 1 & 2. always-RETRY terminates at exactly maxRetry corrections
  {
    const transport = countingTransport();
    const out = await loop.run({ spec: SPEC, transport, review: async () => BAD_REVIEW });
    const expectedAttempts = maxRetry + 1; // first attempt + corrections
    check('always-RETRY terminates', out.status === 'BLOCKED', `status=${out.status}`);
    check('termination flagged as cap-reached', out.capReached === true, `capReached=${out.capReached}`);
    check(`exactly MAX_RETRY_PER_TASK+1 (${expectedAttempts}) attempts`,
      transport.calls.length === expectedAttempts, `attempts=${transport.calls.length}`);
  }

  // 3. unspecified RETRY is rejected, not executed
  {
    const transport = countingTransport();
    const out = await loop.run({
      spec: SPEC, transport,
      review: async () => ({ verdict: 'RETRY', review: { unmet: '', correction: '', criterion: '' } }),
    });
    check('unspecified RETRY rejected',
      out.status === 'BLOCKED' && /must specify/.test(out.reason ?? ''), out.reason);
    check('unspecified RETRY spends only one round', transport.calls.length === 1,
      `attempts=${transport.calls.length}`);
  }

  // 4. PASS stops immediately
  {
    const transport = countingTransport();
    const out = await loop.run({ spec: SPEC, transport, review: async () => GOOD_REVIEW });
    check('PASS returns PASS', out.status === 'PASS', `status=${out.status}`);
    check('PASS spends exactly one round', transport.calls.length === 1, `attempts=${transport.calls.length}`);
  }

  // 5. BLOCKED from review stops immediately
  {
    const transport = countingTransport();
    const out = await loop.run({
      spec: SPEC, transport,
      review: async () => ({ verdict: 'BLOCKED', review: { unmet: 'missing file X' } }),
    });
    check('review BLOCKED stops', out.status === 'BLOCKED', `status=${out.status}`);
    check('review BLOCKED spends one round', transport.calls.length === 1, `attempts=${transport.calls.length}`);
  }

  // 6. transport failure does not consume retry budget
  {
    const transport = async () => ({ ok: false, error: 'browser gone' });
    const out = await loop.run({ spec: SPEC, transport, review: async () => GOOD_REVIEW });
    check('transport failure stops the loop',
      out.status === 'BLOCKED' && /browser gone/.test(out.reason ?? ''), out.reason);
  }

  // 7. incomplete packet refused before any round
  {
    const transport = countingTransport();
    const out = await loop.run({ spec: { task: 'x' }, transport, review: async () => GOOD_REVIEW });
    check('incomplete packet refused',
      out.status === 'BLOCKED' && transport.calls.length === 0,
      `status=${out.status} rounds=${transport.calls.length}`);
  }

  // 8. RETRY carries the unmet requirement into the correction packet
  {
    const transport = countingTransport();
    await loop.run({ spec: SPEC, transport, review: async () => BAD_REVIEW });
    const second = transport.calls[1]?.text ?? '';
    check('RETRY re-sends in the same conversation', transport.calls.length >= 2,
      `rounds=${transport.calls.length}`);
    check('correction packet includes REVISION REQUEST', second.includes('[REVISION REQUEST]'), 'section present');
    check('correction packet states the unmet requirement', second.includes('requirement A unmet'), 'requirement carried');
    check('correction packet states the success criterion', second.includes('A satisfied'), 'criterion carried');
  }

  // 9. packet envelope completeness
  {
    const p = packet.build(SPEC);
    const need = ['[ROLE]', '[TASK]', '[PROJECT CONTEXT]', '[FILES]', '[KNOWN FACTS]',
                  '[DO NOT BREAK]', '[SUCCESS CRITERIA]', '[REQUEST]', '[OUTPUT FORMAT]', '[IMPORTANT]'];
    const missing = need.filter((s) => !p.text.includes(s));
    check('packet has every required section', missing.length === 0, missing.join(',') || 'all present');
    check('packet forbids inventing code', p.text.includes('不要假设未提供的代码'), 'IMPORTANT block present');
    check('packet forbids hidden-tool use', p.text.includes('不要调用外部工具'), 'tool prohibition present');
  }

  // 10. missing file is reported, never silently omitted
  {
    const p = packet.build({ ...SPEC, files: [{ path: 'C:/definitely/not/here.md' }] });
    check('missing file surfaced', p.missing.length === 1 && p.text.includes('UNREADABLE'),
      `missing=${p.missing.length}`);
  }

  // report
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(JSON.stringify({
    ok: failed.length === 0,
    maxRetryPerTask: maxRetry,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  }, null, 2) + '\n');
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.stack ? e.stack : e) }, null, 2) + '\n');
  process.exit(1);
});
