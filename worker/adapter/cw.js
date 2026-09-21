'use strict';
/**
 * cw.js - command-line entry point the DeepSeek Supervisor calls through the shell tool.
 *
 * Every command prints ONE JSON object on stdout and exits non-zero only for
 * adapter-level failures. A BLOCKED state is a normal, well-formed result - the
 * supervisor must be able to distinguish "the worker says no" from "the adapter broke".
 *
 * Usage:
 *   node cw.js health_check
 *   node cw.js open [--headless]
 *   node cw.js close
 *   node cw.js url
 *   node cw.js new
 *   node cw.js open_conversation <url>
 *   node cw.js send <packetFile>
 *   node cw.js await <baselineTurns>
 *   node cw.js read <assistantTurnIndex>
 *   node cw.js user_turns                # live user/assistant turn counts + url (reconciliation)
 *   node cw.js confirm_send <before> [ms] # short-window confirmation; never sends
 *   node cw.js ask <packetFile>          # send + await + read, one round
 *   node cw.js round <specJsonFile>      # build packet from spec, then send+await+read
 *   node cw.js round_raw <promptFile>    # send raw prompt, then await + read
 *   node cw.js packet <specJsonFile>     # build a packet without sending it
 *   node cw.js handoff <specJsonFile>    # build a worker-rotation handoff packet
 *   node cw.js ledger <subcommand>       # list | active | new | url | round | success | archive | rotate | check
 *
 * ASCII-ONLY: see the encoding note in lib.js.
 */

const fs = require('node:fs');

const W = require('./chatgpt-worker.js');
const { CONFIG } = require('./lib.js');
const ledger = require('./ledger.js');
const packet = require('./packet.js');

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

/**
 * Read a JSON file, tolerating a UTF-8 BOM.
 *
 * Spec files are usually authored with PowerShell or Notepad on this machine, both of
 * which happily emit a BOM, and JSON.parse rejects a leading U+FEFF. Stripping it here
 * is more useful than making every caller remember.
 */
function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

/** One supervised round: send -> wait_complete -> read_reply. */
async function loopRound(text) {
  const loop = require('./loop.js');
  return loop.oneRound(text);
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd) {
    emit({ ok: false, error: 'no command; try: health_check | open | close | url | new | open_conversation | send | await | read | ask | round | round_raw | packet | handoff | ledger' });
    process.exit(2);
  }

  switch (cmd) {
    case 'health_check':
      emit(await W.health_check());
      break;

    case 'open': {
      const res = W.openWorker(!process.argv.includes('--headless'));
      if (!res.ok) { emit(res); process.exit(1); }
      const h = await W.health_check();
      emit({ ok: res.ok, opened: true, health: h });
      break;
    }

    case 'close':
      emit(W.closeWorker());
      break;

    case 'url':
      emit(W.getConversationUrl());
      break;

    case 'new':
      emit(await W.new_conversation());
      break;

    case 'open_conversation': {
      const url = process.argv[3];
      if (!url) { emit({ ok: false, error: 'usage: open_conversation <url>' }); process.exit(2); }
      emit(await W.open_conversation(url));
      break;
    }

    case 'send': {
      const file = process.argv[3];
      if (!file || !fs.existsSync(file)) { emit({ ok: false, error: `packet file not found: ${file}` }); process.exit(2); }
      emit(await W.send_packet(fs.readFileSync(file, 'utf8')));
      break;
    }

    case 'await': {
      const baseline = Number(process.argv[3]);
      if (!Number.isFinite(baseline)) { emit({ ok: false, error: 'usage: await <baselineTurns>' }); process.exit(2); }
      emit(await W.wait_complete(baseline));
      break;
    }

    case 'read': {
      const idx = Number(process.argv[3]);
      if (!Number.isFinite(idx)) { emit({ ok: false, error: 'usage: read <assistantTurnIndex>' }); process.exit(2); }
      emit(W.read_reply(idx));
      break;
    }

    /**
     * The reconciliation signal for the send state machine.
     *
     * Reports how many user and assistant turns the conversation REALLY contains right now, plus
     * the URL. The workbench uses it to decide whether a SUBMITTING/SEND_PENDING packet actually
     * landed - which a DOM read taken immediately after the click cannot answer when the ChatGPT
     * web client is rendering late. Read-only: it navigates nowhere and sends nothing.
     */
    case 'user_turns': {
      const u = W.countUserTurns();
      const a = W.countAssistantTurns();
      const url = W.getConversationUrl();
      emit({
        ok: u.ok && a.ok,
        user_turns: u.count,
        assistant_turns: a.count,
        user_turns_ok: u.ok,
        assistant_turns_ok: a.ok,
        url: url.url,
        is_conversation: url.isConversation,
        error: u.ok && a.ok ? null : (u.error || a.error || 'count failed'),
      });
      break;
    }

    /**
     * One full round: send -> wait -> read.
     * Baseline and reply index come from the SAME count, so a failed send can never
     * cause a previous round's answer to be returned as this round's result.
     */
    /**
     * Short-window confirmation: did the packet that was ALREADY sent appear as a user turn?
     *
     * Never sends anything. Reports USER_TURN_CONFIRMED, or SEND_PENDING when the page has not
     * rendered it yet, or MEASUREMENT_UNAVAILABLE when the counter itself is failing. Absence is
     * reported as pending rather than as failure because the ChatGPT client is known to render new
     * turns very late.
     */
    case 'confirm_send': {
      const before = Number(process.argv[3]);
      const windowMs = Number(process.argv[4]) || 12000;
      if (!Number.isFinite(before)) { emit({ ok: false, error: 'usage: confirm_send <userTurnsBefore> [windowMs]' }); process.exit(2); }
      emit(await W.confirm_send(before, windowMs));
      break;
    }

    case 'ask': {
      const file = process.argv[3];
      if (!file || !fs.existsSync(file)) { emit({ ok: false, error: `packet file not found: ${file}` }); process.exit(2); }
      emit(await loopRound(fs.readFileSync(file, 'utf8')));
      break;
    }

    /**
     * Build a task packet without sending it, so the supervisor can inspect it (and its
     * truncation / missing-file warnings) before spending a round.
     */
    case 'packet': {
      const specFile = process.argv[3];
      if (!specFile || !fs.existsSync(specFile)) { emit({ ok: false, error: 'usage: packet <specJsonFile>' }); process.exit(2); }
      const p = packet.build(readJson(specFile));
      emit(p.ok ? { ok: true, included: p.included, missing: p.missing, text: p.text } : p);
      break;
    }

    /** Build the handoff packet used when rotating to a fresh worker (PHASE 6). */
    case 'handoff': {
      const specFile = process.argv[3];
      if (!specFile || !fs.existsSync(specFile)) { emit({ ok: false, error: 'usage: handoff <specJsonFile>' }); process.exit(2); }
      const p = packet.buildHandoff(readJson(specFile));
      emit(p.ok ? { ok: true, included: p.included, missing: p.missing, text: p.text } : p);
      break;
    }

    /**
     * Run one full supervised round (PHASE 8) from a spec.
     * The REVIEW verdict is the supervisor's decision and is recorded afterwards via
     * `ledger round` / `ledger success`; this command yields the raw reply to review.
     */
    case 'round': {
      const specFile = process.argv[3];
      if (!specFile || !fs.existsSync(specFile)) { emit({ ok: false, error: 'usage: round <specJsonFile>' }); process.exit(2); }
      const built = packet.build(readJson(specFile));
      if (!built.ok) { emit(built); process.exit(2); }
      emit(await loopRound(built.text));
      break;
    }

    /** Run one supervised round from a raw prompt file (used for smoke tests). */
    case 'round_raw': {
      const promptFile = process.argv[3];
      if (!promptFile || !fs.existsSync(promptFile)) { emit({ ok: false, error: 'usage: round_raw <promptFile>' }); process.exit(2); }
      emit(await loopRound(fs.readFileSync(promptFile, 'utf8')));
      break;
    }

    case 'ledger': {
      emit(ledger.dispatch(process.argv[3], process.argv.slice(4)));
      break;
    }

    default:
      emit({ ok: false, error: `unknown command: ${cmd}` });
      process.exit(2);
  }
}

main().catch((e) => {
  emit({ ok: false, error: `unhandled: ${e && e.stack ? e.stack : String(e)}` });
  process.exit(1);
});
