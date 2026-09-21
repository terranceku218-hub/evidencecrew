'use strict';
/**
 * seat.js - the Agent Seat: a long-lived, transport-neutral identity for one agent.
 *
 * THE CLAIM BEING TESTED IN V0.2
 *   "Agent Seat abstraction is not a ChatGPT wrapper."
 *
 *   A seat is not a connection, not an API key, and not a conversation. It is an ADDRESSABLE
 *   IDENTITY that outlives any of those: it has a role, a provider, a transport, a workspace it is
 *   allowed to see, capabilities, permissions, a health state, a context budget, and a delivery
 *   state. When a conversation dies, the seat gets a new conversation. When a transport breaks, the
 *   seat gets a new transport. The seat id does not change, because the seat is the thing the
 *   protocol addresses.
 *
 * PROVIDER AND TRANSPORT ARE SEPARATE FIELDS
 *   provider = who answers      (chatgpt, claude, deepseek, human, openai-compatible...)
 *   transport = how it is reached (playwright-dom, openai-http, acp, mcp, human...)
 *
 *   Those are independent axes. The same provider can be reached two ways; the same transport can
 *   carry two providers. Collapsing them is what makes an "abstraction" into a wrapper, so they are
 *   two fields and the pairing is recorded as a fact rather than implied by a type name.
 *
 * NO PROVIDER BRANCHING ABOVE THIS FILE
 *   Nothing in this module reads `provider` to decide behaviour. It is carried and reported, never
 *   switched on. Behaviour differences are expressed as `capabilities`, which is data a caller can
 *   adapt to without knowing who is on the other end.
 */

const protocol = require('../protocol/protocol.js');
const contract = require('../protocol/transport-contract.js');

const ROLES = {
  SUPERVISOR: 'supervisor',
  CODER: 'coder',
  REVIEWER: 'reviewer',
  RESEARCHER: 'researcher',
  WRITER: 'writer',
};

/**
 * Create a seat around a transport.
 *
 * The transport is validated here rather than trusted: a seat built on a non-conforming transport
 * would fail later, in the middle of a run, where the failure is expensive and confusing.
 */
function createSeat(spec) {
  const {
    seatId, role, transport,
    projectId = null, workspaceId = null,
    capabilities: capabilityOverrides = null,
    permissions = {},
    contextLimit = null,
    rotationThreshold = null,
  } = spec ?? {};

  if (!seatId) throw new Error('a seat needs a seat_id');
  if (!role) throw new Error('a seat needs a role');
  if (!transport) throw new Error('a seat needs a transport');

  const conformance = contract.checkContract(transport, { sourceFile: transport.sourceFile });
  if (!conformance.ok) {
    throw new Error(`transport ${transport.id ?? '(unnamed)'} does not satisfy the transport contract: ${conformance.problems.join('; ')}`);
  }

  const seat = {
    seat_id: seatId,
    role,
    provider: transport.provider,
    transport: transport.kind,
    transport_id: transport.id,
    project_id: projectId,
    workspace_id: workspaceId,

    // Conversation is a SEAT property, not a transport property: two seats may share a transport
    // implementation while owning completely separate conversations.
    conversation: {
      id: spec.conversationId ?? null,
      url: spec.conversationUrl ?? null,
      state: spec.conversationState ?? 'NEW',
      resolved_at: spec.conversationResolvedAt ?? null,
    },

    capabilities: {
      ...transport.capabilities,
      ...(capabilityOverrides ?? {}),
    },

    permissions: {
      read_scope: permissions.read_scope ?? [],
      write_scope: permissions.write_scope ?? [],
      deny: permissions.deny ?? [],
      approval_required: permissions.approval_required ?? [],
    },

    health: { status: 'UNKNOWN', checked_at: null, detail: null, human_action: null },

    rounds: {
      recorded: Number.isFinite(spec.rounds) ? spec.rounds : 0,
      observed: null,
      context_limit: contextLimit,
      rotation_threshold: rotationThreshold,
    },

    delivery_state: 'IDLE',
    current_task: null,
    current_run: null,

    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    _transport: transport,
  };

  return seat;
}

/**
 * Attach a run to a seat for the duration of that run.
 *
 * THE ENVELOPE IS NOT MUTATED HERE. An earlier version did `envelope.run_id = ...`, which looked
 * harmless and was not: a supervisor turn dispatches with a caller-supplied envelope, and overwriting
 * its `run_id` replaced the id its prompt had told the model to echo. The next turn then failed
 * validation with "run_id must be a non-empty string" - a symptom three layers away from the cause.
 * A run is recorded on the SEAT, which is where run state belongs; the caller's envelope is left alone.
 */
function bindRun(seat, envelope) {
  seat.current_run = {
    run_id: envelope.run_id,
    task_id: envelope.task_id,
    started_at: new Date().toISOString(),
  };
  seat.current_task = envelope.task_id;
  seat.delivery_state = 'SUBMITTING';
  seat.updated_at = new Date().toISOString();
  return seat;
}

/** Record a delivery-state transition, refusing illegal ones. */
function setDeliveryState(seat, next, detail) {
  const from = seat.delivery_state;
  if (from === next) return { ok: true, seat, unchanged: true };
  if (!contract.isLegalTransition(from, next)) {
    return {
      ok: false,
      error: `illegal delivery transition for seat ${seat.seat_id}: ${from} -> ${next}`,
      legal: contract.LEGAL_TRANSITIONS[from] ?? [],
    };
  }
  seat.delivery_state = next;
  seat.updated_at = new Date().toISOString();
  seat.delivery_detail = detail ?? null;
  /**
   * A terminal state releases the seat's run - but it must not DESTROY it.
   *
   * MEASURED DEFECT: every terminal state cleared `current_run` outright, so entering SEND_UNCERTAIN
   * erased the run id at the exact moment it becomes the most valuable fact in the system. SEND_UNCERTAIN
   * means "we do not know whether this message landed", and the only way a human can resolve that is to
   * search the conversation for THAT run's ack. Throwing the id away left the operator with a doubt and
   * no way to look into it, and a later retry with no way to check whether it was a duplicate.
   *
   * So a terminal state files the run instead of dropping it:
   *   SEND_UNCERTAIN -> `unresolved_run`, because it needs a human decision, not an audit trail
   *   COMPLETE       -> `last_completed_run`, the normal end of a successful turn
   */
  if (contract.TERMINAL.includes(next)) {
    const filed = seat.current_run
      ? { ...seat.current_run, closed_at: new Date().toISOString(), terminal_state: next, detail: detail ?? null }
      : null;
    if (next === 'SEND_UNCERTAIN') seat.unresolved_run = filed ?? seat.unresolved_run ?? null;
    else if (filed) seat.last_completed_run = filed;
    seat.current_run = null;
  }
  return { ok: true, seat, from, to: next };
}

async function refreshHealth(seat) {
  const h = await seat._transport.health();
  seat.health = {
    status: h.status ?? (h.ok ? 'READY' : 'ERROR'),
    ok: h.ok === true,
    checked_at: h.checked_at ?? new Date().toISOString(),
    detail: h.detail ?? null,
    human_action: h.human_action ?? null,
  };
  seat.updated_at = new Date().toISOString();
  return seat.health;
}

/** What the layer above is allowed to see. The transport itself is deliberately withheld. */
function view(seat) {
  const { _transport, ...rest } = seat;
  return { ...rest };
}

/**
 * The one place a run is dispatched from.
 *
 * It enforces, in order: the seat has no run in flight, the envelope matches the seat, and the
 * packet is rendered from the envelope rather than passed in as prose - so no caller can smuggle a
 * hand-written prompt past the protocol.
 */
async function dispatch(seat, envelope, opts = {}) {
  // ---- guard: one run at a time per seat, and never a re-dispatch ----
  if (seat.current_run) {
    const gate = contract.mayRedispatch(seat.delivery_state);
    if (!gate.allowed) {
      return { ok: false, refused: true, delivery_state: seat.delivery_state, error: gate.reason };
    }
  }
  // ---- guard: the envelope must belong to this seat ----
  const mismatches = [];
  if (envelope.seat_id !== seat.seat_id) mismatches.push(`envelope.seat_id=${envelope.seat_id} vs seat ${seat.seat_id}`);
  if (seat.project_id && envelope.project_id !== seat.project_id) mismatches.push(`project ${envelope.project_id} vs seat ${seat.project_id}`);
  if (seat.workspace_id && envelope.workspace_id !== seat.workspace_id) mismatches.push(`workspace ${envelope.workspace_id} vs seat ${seat.workspace_id}`);
  if (mismatches.length) {
    return { ok: false, refused: true, error: `envelope does not belong to seat ${seat.seat_id}: ${mismatches.join('; ')}` };
  }

  const validation = protocol.validateEnvelope(envelope);
  if (!validation.ok) {
    return { ok: false, refused: true, error: `envelope is invalid: ${validation.problems.join('; ')}` };
  }

  // ---- render: protocol -> packet ----
  //
  // A caller may supply `rawPacket` instead of letting the envelope be rendered. Exactly one category
  // of caller does: a SUPERVISOR seat. The supervisor is the thing that GENERATES envelopes, so it
  // cannot be handed one describing its own work; its packet is its instruction. Ordinary task
  // dispatch still goes through a renderer, which is what keeps prompts a projection of the protocol.
  const renderers = require('../protocol/renderers.js');
  // A worker whose transport cannot read files must be GIVEN the content it is asked to verify,
  // otherwise the most it can honestly answer is SOURCE_HASH_ACK: UNREADABLE. The decision is made from
  // the transport's declared capability, so nothing here needs to know which provider this is.
  let sourceAttachment = null;
  if (seat.capabilities.supplies_source_content === false && (envelope.source_files ?? []).length && opts.projectRoot) {
    const { buildSourceAttachment } = require('../transports/source-attachment.js');
    const att = buildSourceAttachment(envelope, opts.projectRoot);
    if (att.text) {
      sourceAttachment = att.text;
      if (att.skipped.length) {
        // Warn rather than throw: a partially attached source is still a usable packet, but the packet
        // says which files are missing, so the worker is not misled about what it was given.
        process.stderr.write(`seat ${seat.seat_id}: source attachment incomplete for run ${envelope.run_id}: `
          + `${att.skipped.map((s) => `${s.path} (${s.reason})`).join('; ')}\n`);
      }
    }
  }

  const rendered = opts.rawPacket
    ? { ok: true, renderer: 'raw', text: String(opts.rawPacket) }
    : renderers.render(envelope, {
      renderer: opts.renderer,
      defaultRenderer: seat._transport.defaultRenderer,
      sourceAttachment,
    });

  bindRun(seat, envelope);

  const result = await seat._transport.dispatch(envelope, rendered.text, opts);
  const legal = setDeliveryState(seat, result.delivery_state, result.detail);

  return {
    ok: result.ok === true,
    run_id: envelope.run_id,
    seat_id: seat.seat_id,
    renderer: rendered.renderer,
    packet_chars: rendered.text.length,
    delivery_state: result.delivery_state,
    detail: result.detail,
    transport_evidence: result.transport_evidence ?? null,
    state_transition_legal: legal.ok,
  };
}

/** Observe only. Never sends - that is the entire reason it is a separate function. */
async function observe(seat, envelope) {
  const r = await seat._transport.observe(envelope);
  if (r.delivery_state) setDeliveryState(seat, r.delivery_state, r.detail);
  return r;
}

async function read(seat, envelope, opts = {}) {
  return seat._transport.read(envelope, opts);
}

/**
 * Close the current turn: the run is over and the seat may take the next one.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A LOOPHOLE
 *   The anti-duplicate rule is "one message in flight per seat". It is enforced by keeping
 *   `current_run` set, and it is what stops a retry from posting a second message into a conversation.
 *   But a seat also legitimately takes SEQUENTIAL turns: a supervisor plans and then reviews, and those
 *   are two different runs. Without a way to close a finished turn, the guard turned into a deadlock -
 *   measured: the plan turn left the seat in USER_TURN_CONFIRMED and the review turn was refused with
 *   "re-dispatching would post a SECOND message".
 *
 *   So this closes a turn ONLY when the reply has actually been obtained, and it records why. It cannot
 *   be used to escape a pending or uncertain state: those are exactly the states where a second message
 *   might duplicate the first, and they are refused here.
 */
function completeTurn(seat, detail) {
  const from = seat.delivery_state;
  const closable = ['USER_TURN_CONFIRMED', 'ASSISTANT_PENDING', 'COMPLETE'];
  if (!closable.includes(from)) {
    return {
      ok: false,
      error: `refusing to close a turn in state ${from}: only a confirmed or completed turn may be closed`,
      hint: 'a pending or uncertain turn must be observed or left alone - closing it would allow a duplicate send',
    };
  }
  seat.last_completed_run = seat.current_run
    ? { ...seat.current_run, closed_at: new Date().toISOString(), detail: detail ?? null }
    : seat.last_completed_run ?? null;
  seat.current_run = null;
  seat.current_task = null;
  seat.delivery_state = 'IDLE';
  seat.updated_at = new Date().toISOString();
  return { ok: true, seat, closed_from: from };
}

/**
 * Settle a finished turn so the seat can take the next one.
 *
 * MEASURED DEFECT THIS EXISTS FOR
 *   A live two-task goal completed TASK 1: the transport reported SEND_PENDING (the send had executed
 *   but the render was not observable yet), `observe` agreed, and `read` then returned a 6,464-character
 *   reply carrying the right run id. TASK 2's dispatch was then refused - correctly - with "a packet for
 *   this run is already SEND_PENDING; re-dispatching would post a SECOND message". So a two-task goal
 *   stopped at BLOCKED after one task. The guard was right; what was missing was a LEGAL way to close a
 *   turn that had demonstrably landed.
 *
 * WHAT THIS CLAIMS, AND WHAT IT DOES NOT
 *   It claims exactly one thing: the dispatched turn LANDED, because a reply carrying this run's id was
 *   observed. It does NOT claim the reply is correct (the supervisor decides that), and it cannot be
 *   used on SEND_UNCERTAIN, which has no outgoing transitions at all.
 *
 * PROOF IS REQUIRED, NOT OPTIONAL
 *   A caller must pass the observed reply text, and it must contain the CURRENT run id. Without that
 *   requirement this would be a general-purpose "close a pending turn" call, which is precisely the hole
 *   the anti-duplicate rule exists to plug. A pending send is closed only when something proves it was
 *   answered.
 *
 * The transition used is SEND_PENDING -> USER_TURN_CONFIRMED -> COMPLETE, both legal in the contract.
 * Nothing here invents an edge: an illegal shortcut would be a second bug, not a fix.
 */
function settleTurn(seat, evidence = {}) {
  const from = seat.delivery_state;
  const runId = seat.current_run?.run_id ?? null;

  if (['USER_TURN_CONFIRMED', 'ASSISTANT_PENDING', 'COMPLETE'].includes(from)) {
    return completeTurn(seat, evidence.detail ?? 'turn finished');
  }
  if (from !== 'SEND_PENDING') {
    return {
      ok: false,
      error: `refusing to settle a turn in state ${from}`,
      hint: from === 'SEND_UNCERTAIN'
        ? 'SEND_UNCERTAIN has no outgoing transitions: a human must confirm whether the message landed'
        : 'only a pending send with proof, or an already-answerable turn, may be settled',
    };
  }

  const text = typeof evidence.replyText === 'string' ? evidence.replyText : '';
  if (!runId) {
    return { ok: false, error: 'refusing to settle: the seat has no current run id to match the proof against' };
  }
  if (!text.includes(runId)) {
    return {
      ok: false,
      error: `refusing to settle a pending send: the supplied proof does not carry run id ${runId}`,
      hint: 'a pending send may only be closed by a reply that identifies this run, never by a timeout',
    };
  }

  const confirmed = setDeliveryState(seat, 'USER_TURN_CONFIRMED',
    `landed: the observed reply carries run id ${runId}`);
  if (!confirmed.ok) return confirmed;
  const closed = completeTurn(seat, evidence.detail ?? 'turn settled after its reply landed');
  return { ok: true, from, via: 'USER_TURN_CONFIRMED', closed_from: closed.closed_from, seat };
}

module.exports = {
  ROLES, createSeat, view, bindRun, setDeliveryState, refreshHealth,
  dispatch, observe, read, completeTurn, settleTurn,
};
