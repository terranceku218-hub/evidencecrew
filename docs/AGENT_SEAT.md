# The Agent Seat

An Agent Seat is the abstraction that lets several different providers be one team. It is the
addressable identity the protocol talks to, and it is deliberately independent of who is on the
other end and how they are reached.

This document describes the seat object, the transport contract it is built on, the
capabilities that carry every behavioural difference, and the lifecycle a seat goes through in
one run. Field names, state names and function names are the real ones from
`workbench/seats/seat.js`, `workbench/seats/registry.js`,
`workbench/protocol/transport-contract.js` and `workbench/transports/`.

## Table of contents

1. [Seat is not provider](#1-seat-is-not-provider)
2. [What a seat carries](#2-what-a-seat-carries)
3. [The transport contract](#3-the-transport-contract)
4. [Capabilities, not provider names](#4-capabilities-not-provider-names)
5. [Three instances of one abstraction](#5-three-instances-of-one-abstraction)
6. [The seat lifecycle](#6-the-seat-lifecycle)
7. [Adding a new seat or transport](#7-adding-a-new-seat-or-transport)

---

## 1. Seat is not provider

A seat is not a connection, not an API key, and not a conversation. It is an addressable
identity that outlives any of those. When a conversation dies the seat gets a new conversation;
when a transport breaks the seat gets a new transport. The `seat_id` does not change, because
the seat is the thing the protocol addresses.

Two independent axes are carried as two fields, and the pairing is recorded as a fact rather
than implied by a type name:

- `provider` is **who answers**: `chatgpt`, `deepseek`, `human`, `openai-codex`,
  `openai-compatible`.
- `transport` is **how it is reached**: `playwright-dom`, `deepseek-api`, `human`,
  `codex-app-server`, `openai-http`.

Collapsing the two is what turns an abstraction into a wrapper, so they are separate, and the
pairing is recorded as a fact rather than implied by a type name.

The direction of independence that this repository actually instantiates is that **one
transport implementation can carry two provider identities**. `transport.openai-http.js` is
used with `provider: 'openai-compatible'` by the registry, and with `provider: 'deepseek'` by
`transport.deepseek.js`, which wraps `createOpenAiHttpTransport` and overrides `kind` to
`deepseek-api`, `provider` to `deepseek` and its capabilities, rather than writing a second
client. Writing a DeepSeek-specific client would have duplicated the HTTP handling and, as its
source says, started the seat layer down the road of special-casing a provider.

The reverse case - one provider reached over two different transports - is what the two fields
exist to allow, but no such pair is declared in this repository: each declared provider
currently appears over exactly one transport kind.

The declared seats in `DECLARATIONS` (`workbench/seats/registry.js`), with their real
identifiers:

| `seat_id` | `role` | `provider` | `transport` | `connected` |
| --- | --- | --- | --- | --- |
| `seat:demo/default/supervisor` | `supervisor` | `deepseek` | `deepseek-api` | `true` |
| `seat:demo/default/coder` | `coder` | `chatgpt` | `playwright-dom` | `true` |
| `seat:demo/default/human-supervisor` | `supervisor` | `human` | `human` | `true` |
| `seat:demo/default/researcher` | `researcher` | `human` | `human` | `true` |
| `seat:demo/default/reviewer-codex` | `reviewer` | `openai-codex` | `codex-app-server` | `true` |
| `seat:demo/default/reviewer-http` | `reviewer` | `openai-compatible` | `openai-http` | `false` |

`connected` is the honesty field: it says whether the seat can be used right now. The
`openai-http` seat is declared so the seat shape is exercised by the contract while being
explicitly not connected, because no provider credentials exist in that environment; it is
moved into the registry's `unavailable` list with its reason, and must never be presented as an
available seat. A seat that cannot be built is reported **with its reason** rather than
skipped, because "we chose not to have this" and "we could not build this" are different
statements. `buildRegistry(projectId, workspaceId)` returns `{seats, unavailable, byId,
byRole, humanTransports, humanTransport, independenceFacts}`.

Roles come from the `ROLES` table in `workbench/seats/seat.js`: `supervisor`, `coder`,
`reviewer`, `researcher`, `writer`.

### Where provider-specific code is allowed to live

`workbench/transports/transport.playwright-dom.js` states the rule for its own case: nothing
above the transport mentions ChatGPT, DOM, turns, or selectors, and that file is where all of
it is allowed to live. The contract enforces the same rule mechanically - see section 3.

---

## 2. What a seat carries

`createSeat(spec)` builds the seat and validates the transport at construction time, so a seat
built on a non-conforming transport fails immediately rather than in the middle of a run. It
throws when `seatId`, `role` or `transport` is missing.

| Field | What it holds |
| --- | --- |
| `seat_id` | The addressable identity. What the envelope's `seat_id` must equal. |
| `role` | One of `ROLES`: `supervisor`, `coder`, `reviewer`, `researcher`, `writer`. |
| `provider` | Who answers. Copied from `transport.provider`. |
| `transport` | The transport kind, copied from `transport.kind`. |
| `transport_id` | The transport instance id, copied from `transport.id`. |
| `project_id`, `workspace_id` | The scope this seat belongs to. Used by the dispatch ownership guard. |
| `conversation` | `{id, url, state, resolved_at}`, from `conversationId`, `conversationUrl`, `conversationState` (default `'NEW'`) and `conversationResolvedAt`. A conversation is a **seat** property, not a transport property: two seats may share a transport implementation while owning separate conversations. |
| `capabilities` | The transport's `capabilities` object, with any `spec.capabilities` overrides merged over it. |
| `permissions` | `{read_scope, write_scope, deny, approval_required}`, each defaulting to `[]`. Declared per seat in the registry, and copied into the envelope by the orchestrator. |
| `health` | `{status, checked_at, detail, human_action}`, initialised to `status: 'UNKNOWN'`. `refreshHealth(seat)` calls `transport.health()` and fills all of these plus `ok`. |
| `rounds` | `{recorded, observed, context_limit, rotation_threshold}`. `recorded` comes from `spec.rounds`, `observed` starts `null`, and the two limits come from `contextLimit` and `rotationThreshold`. A conversation is treated as a budgeted resource rather than a permanent home. |
| `delivery_state` | Starts as `'IDLE'` and is written only through `setDeliveryState`. |
| `current_task` | The task id currently bound to the seat, or `null`. |
| `current_run` | `{run_id, task_id, started_at}` while a run is in flight, otherwise `null`. This is the anti-duplicate guard. |
| `created_at`, `updated_at` | Timestamps; `updated_at` is refreshed by `bindRun`, `setDeliveryState`, `refreshHealth` and `completeTurn`. |
| `_transport` | The transport object itself. Withheld from callers: `view(seat)` destructures it out and returns everything else. |

Four fields are written later, by the seat itself:

| Field | Written by | Meaning |
| --- | --- | --- |
| `delivery_detail` | `setDeliveryState` | The transport's own explanation of the transition. |
| `unresolved_run` | `setDeliveryState` on `SEND_UNCERTAIN` | The filed run `{run_id, task_id, started_at, closed_at, terminal_state, detail}` that a human must resolve. |
| `last_completed_run` | `setDeliveryState` on `COMPLETE`, and `completeTurn` | The filed run at the normal end of a successful turn. |
| `delivery_state` transitions | `bindRun` sets `'SUBMITTING'` | The seat records the send as started before the transport is called. |

Note on the registry's `declared_capabilities`: the reviewer declaration carries
`can_read_files`, `can_read_git_diff`, `can_run_safe_tests`, `can_write_files`, `can_commit`
and `can_push` as declared intent. `buildRegistry` does not pass that object to `createSeat`,
so a seat's `capabilities` today come from its transport (plus explicit `spec.capabilities`
overrides). It is documentation in the declaration, not a live capability source.

---

## 3. The transport contract

`workbench/protocol/transport-contract.js` is the executable contract. A contract that is only
described in prose is not a contract, so any object claiming to be a transport is checked
against this one, and the check is run for every registered transport by the regression suite.

### The five required methods

`REQUIRED_METHODS` names exactly five, each with the guarantee it must provide:

| Method | What it must do and return |
| --- | --- |
| `open` | Prepare the transport for use. Idempotent. Returns `{ok, detail}`. |
| `health` | Report reachability and readiness. Returns `{ok, status, detail, human_action?}`. |
| `dispatch` | Send one rendered packet for a run. Returns `{ok, delivery_state, detail}`. It MUST NOT wait for the answer, and MUST NOT retry a packet that may already have landed. |
| `observe` | Report what is known about a run **without sending anything**. Returns `{ok, delivery_state, confirmed, detail}`. This is the only legal action while pending. |
| `read` | Return the reply text for a run once it exists. Returns `{ok, text, detail}`. |

The vocabulary is deliberately transport-shaped rather than browser-shaped. `dispatch`,
`observe` and `read` describe a message that may or may not be provably delivered; they do not
assume a chat window, a turn count, or a synchronous response. A transport that can only answer
synchronously still fits, and reports `COMPLETE` from `observe` on the first call.

`capabilities` is a required **property** (an object of booleans), not a method, and is checked
separately. Listing it as a method would demand `capabilities()` on every transport - a mistake
the contract's own source records as having been made on its first run and caught by the
conformance check.

### What conformance checking enforces

`checkContract(transport, opts)` returns `{ok, transport, kind, problems}`, where `problems` is
a list of human-readable strings, and checks (the non-object case returns early with
`{ok: false, transport, problems: ['not an object']}`):

- The argument is an object; otherwise `not an object`.
- Every key of `REQUIRED_METHODS` is a function on the transport, else `missing method: <m>()`.
- `id`, `kind` and `provider` are non-empty strings, else `missing string field: <f>`.
- `capabilities` is an object, else `missing capabilities object`.
- Four capability flags must be booleans, each with its own message:
  `capabilities.can_deliver_synchronously must be boolean`,
  `capabilities.confirms_delivery must be boolean`,
  `capabilities.supports_readback must be boolean`,
  `capabilities.needs_human must be boolean`.
- When `opts.sourceFile` is supplied, the file is read and stripped of block comments and
  full-line `//` comments, then scanned for provider-name branching:
  `if (<provider> ===`, `if (<provider> ==` and `switch (<provider>)`. A transport SHOULD
  mention its own provider; what it must not do is decide by provider name. Any match adds
  `branches on provider name inside the transport (provider logic belongs in the transport, but
  never as a name switch)`.

The behavioural checks are structural scans of the transport's own source, not runtime probes,
so conformance costs nothing at run time. What the contract documents about return shapes is
therefore intent that each transport must honour, while what `checkContract` actually asserts
is method presence, string identity fields and capability typing.

`checkAll(transports)` maps `checkContract` over a list, passing each transport's own
`sourceFile`, and reports `ok` only when every result is ok. `registry.conformance()` is the
registry-level entry point: it builds a candidate of every transport kind it can build and
concatenates the results, reporting an unbuildable transport as
`not built: <reason>` rather than omitting it - a conformance list that silently omitted
something would overstate how much of the roster is verified.

### How a non-conforming transport is rejected

`createSeat` calls `checkContract(transport, {sourceFile: transport.sourceFile})` and throws
before building anything:

```
transport <id> does not satisfy the transport contract: <problems joined by '; '>
```

An unnamed transport is reported as `(unnamed)`. The reason for rejecting at construction
rather than at first use is stated in the source: a seat built on a non-conforming transport
would fail later, in the middle of a run, where the failure is expensive and confusing.

### What the layer above the transport is allowed to know

Role, provider, capabilities, health and delivery state - and nothing else. It must never know
Playwright, DOM selectors, HTTP verbs, CLI flags, or the word "ChatGPT". If a caller ever needs
to ask what kind of transport it is holding in order to proceed, the abstraction has failed,
and the right fix is a new capability field rather than a branch on the transport's name.

---

## 4. Capabilities, not provider names

Behaviour differences between providers are expressed as capabilities, which is data a caller
can adapt to without knowing who is on the other end. The architectural rule, stated in
`workbench/seats/seat.js`: nothing in that module reads `provider` to decide behaviour - it is
carried and reported, never switched on. The same rule is restated in
`workbench/protocol/supervisor.js` and enforced for transports by the source scan in section 3.

There is no `if (provider === ...)` above the transport layer. Provider-specific code lives in
the transport, where the file says it is allowed to be - and even there, a provider *name*
switch is a conformance failure.

| Capability | Required by the contract | Declared by | What the orchestrator does differently |
| --- | --- | --- | --- |
| `can_deliver_synchronously` | Yes, must be boolean | `true` for `human`, `openai-http`, `deepseek`, `codex-app-server`; `false` for `playwright-dom` | `supervisor.runSupervisorTurn` reads the reply directly when it is `true` together with `supports_readback`, and otherwise observes first and reads only when the observation is `confirmed`. It also gates the one-shot retry after `SEND_UNCERTAIN`: a synchronous transport holds no conversation state, so a locally failed request cannot have queued a duplicate, and the retry is capped at one. `autonomous-loop.js` and `cross-provider-run.js` use the same pair to decide whether to observe before reading. |
| `confirms_delivery` | Yes, must be boolean | `true` for `human`, `openai-http`, `deepseek`, `codex-app-server`; `false` for `playwright-dom` | Declared, reported and type-checked. No caller in this repository branches on it: the delivery state returned by `dispatch` and `observe` is what callers actually act on. |
| `supports_readback` | Yes, must be boolean | `true` everywhere, including `playwright-dom` | Paired with `can_deliver_synchronously` by `supervisor.runSupervisorTurn`, `autonomous-loop.js` and `cross-provider-run.js` to decide between reading straight away and observing until the answer is confirmed. |
| `needs_human` | Yes, must be boolean | `true` only for `human`; `false` for the automated transports | Read by the UI (`workbench/public/protocol-ui.js`) to mark the seat as one whose answers are pasted in. |
| `supplies_source_content` | No | `false` for `playwright-dom`, `true` for `codex-app-server` | Read by `seat.dispatch`: when it is exactly `false`, the envelope bound source, and a project root was supplied, `buildSourceAttachment` embeds the verbatim content and its recorded hash into the packet. Anything other than `false` - including absent - means no attachment. This is the flag that stops every cross-provider run from answering `SOURCE_HASH_ACK: UNREADABLE`. |
| `can_run_commands` | No | `true` for `codex-app-server` | Declared only. It is the flag that makes a static review meaningful for a seat that reads the repository itself; no caller branches on it. |
| `is_reasoning_model` | No | `true` for `deepseek` | Declared only. The consequence that is actually implemented sits in the transport: a reasoning model can spend its whole budget on reasoning tokens, so `createDeepSeekTransport` defaults `maxTokens` to a generous value rather than a small one, and its `read` explains a truncation instead of reporting a mystery empty answer. |
| `consumes_reasoning_tokens` | No | `true` for `deepseek` | Declared only. |
| `supports_structured_output` | No | `true` for `codex-app-server` | Declared only. Structured output is obtained by asking for JSON and parsing it tolerantly (`extractJson` in `supervisor.js`) rather than by depending on a provider's structured-output mode. |
| `notes` | No | Every transport declares it | Free text explaining the transport's behaviour to a human reader. |

A capability that is absent means "not claimed", and the default behaviour must stay safe
without it. The retry gate is the clearest example: a missing
`can_deliver_synchronously === true` means no retry, which keeps the browser path's
prohibition on re-dispatch intact by default.

---

## 5. Three instances of one abstraction

DeepSeek over HTTP, ChatGPT over the browser DOM, and Codex over the app-server JSON-RPC are
the same shape. Each is an object with `id`, `kind`, `provider`, `sourceFile`, an optional
`defaultRenderer`, a `capabilities` object, and the five methods `open`, `health`, `dispatch`,
`observe` and `read`. Each returns the shared `DELIVERY` states and never invents one. Each
creates a seat through the same `createSeat`, and each is dispatched to by the same
`seat.dispatch`.

What differs is declared as capability and as measurement, not as a branch:

| | DeepSeek | ChatGPT browser | Codex |
| --- | --- | --- | --- |
| Source file | `transport.deepseek.js` | `transport.playwright-dom.js` | `transport.codex-app-server.js` |
| `provider` | `deepseek` | `chatgpt` | `openai-codex` |
| `kind` (transport) | `deepseek-api` | `playwright-dom` | `codex-app-server` |
| Transport id | `deepseek:<model>` from the registry; the module default is `deepseek-http:<model>` | `pw-dom:<workerId>` | `codex:<model>` from the registry; the module default is `codex-app-server:<model>` |
| Implementation | A configuration of `createOpenAiHttpTransport`, not a second client | A thin shape-adapter over the existing verified worker adapter | A JSON-RPC 2.0 client over the app server's stdio |
| Delivery confirmation | `can_deliver_synchronously: true`, `confirms_delivery: true` | `can_deliver_synchronously: false`, `confirms_delivery: false` | `can_deliver_synchronously: true`, `confirms_delivery: true` |
| Readback | `supports_readback: true` | `supports_readback: true` | `supports_readback: true` |
| Worker can supply source content itself | Not declared; the packet does not carry content by default | `supplies_source_content: false`, so the packet must carry the content | `supplies_source_content: true`, so the packet need not |
| Latency character | Synchronous and reliable: one request, one answer; a completion round-trips in under a second, and `latency_ms` is recorded in `transport_evidence` | Measured rendering **minutes** late, so a send can return `SEND_PENDING` and only `observe` may follow; `read` has a documented newest-turn fallback when the recorded index is unavailable | Returns as soon as the protocol acknowledges the turn with a turn id; no page to wait for, and `latency_ms` is recorded |

Two further differences are worth naming because they are what makes the comparison honest:

- **How identity is established.** Codex returns `thread.id` from `thread/start` and `turn.id`
  from `turn/start`, and routes `turn/completed` notifications back to a run by thread id, so
  correlation identity is bound as data rather than inferred. The browser transport has no such
  handle: it books a baseline of user and assistant turn counts and detects a new user turn.
  That is why the delivery state machine exists in the shape it does, and why `SEND_PENDING` is
  a normal outcome for one transport and an impossibility for another.
- **Where a failure can hide.** `transport.deepseek.js` records that a small token budget on a
  reasoning model produces zero visible content, so its `read` says the budget was consumed by
  reasoning tokens rather than reporting an empty answer. `transport.openai-http.js` reports
  "the provider answered but produced no readable text" for the same situation. Both turn a
  silent empty reply into a named one.

For completeness, the fourth transport in the repository is `human` (`transport.human.js`): a
person as a first-class seat, with no URL, no credentials and no latency, `needs_human: true`
and a default renderer of `human`. It is deliberately not a test double, and it is what proves
the contract is not secretly shaped like a request/response network call.

---

## 6. The seat lifecycle

The module-level functions in `workbench/seats/seat.js` are the whole lifecycle. A caller never
touches the transport directly; the transport object is deliberately withheld behind
`view(seat)`.

### Bind

`bindRun(seat, envelope)` attaches a run to the seat for the duration of that run: it sets
`current_run` to `{run_id, task_id, started_at}`, sets `current_task`, sets `delivery_state` to
`'SUBMITTING'`, and refreshes `updated_at`. It returns the seat.

It does **not** mutate the envelope. An earlier version assigned `envelope.run_id`, which
looked harmless and was not: a supervisor turn dispatches with a caller-supplied envelope, and
overwriting its `run_id` replaced the id its prompt had told the model to echo, so the next turn
failed validation three layers away with "run_id must be a non-empty string". A run is recorded
on the seat, which is where run state belongs.

### Dispatch

`dispatch(seat, envelope, opts)` is the one place a run is dispatched from, and it enforces, in
order:

1. **One run at a time.** If `seat.current_run` is set, `mayRedispatch(seat.delivery_state)` is
   consulted and a refusal is returned.
2. **The envelope belongs to this seat.** `envelope.seat_id` must equal `seat.seat_id`;
   `project_id` and `workspace_id` are compared only when the seat has a non-null value.
3. **The envelope is valid.** `validateEnvelope(envelope)` from the protocol module.
4. **Render, not prose.** The packet is rendered from the envelope by
   `renderers.render(envelope, {...})`, using `opts.renderer` or the transport's declared
   `defaultRenderer`. The one exception is a supervisor seat, which passes `opts.rawPacket`
   because the supervisor is the thing that generates envelopes and cannot be handed one
   describing its own work.
5. **Attach source when the worker cannot read it.** When
   `seat.capabilities.supplies_source_content === false`, source is bound, and `opts.projectRoot`
   is present, `buildSourceAttachment` appends the content; an incomplete attachment is warned
   about on stderr rather than thrown, so the packet still says what is missing.
6. **Bind, send, record.** `bindRun`, then `transport.dispatch(envelope, rendered.text, opts)`,
   then `setDeliveryState(seat, result.delivery_state, result.detail)`.

It returns `{ok, run_id, seat_id, renderer, packet_chars, delivery_state, detail,
transport_evidence, state_transition_legal}`.

### Observe

`observe(seat, envelope)` calls `transport.observe(envelope)` and records the returned
`delivery_state` if there is one. It never sends, and that is the entire reason it is a separate
function rather than a flag on `dispatch`: it is the only legal action while a run is pending.

### Read

`read(seat, envelope, opts)` delegates to `transport.read(envelope, opts)`. The transport owns
what it had to do to make the run readable, which is why the per-run bookkeeping lives there.

### Settle

Two functions close a turn, and neither can escape a pending or uncertain state.

- `completeTurn(seat, detail)` closes a turn **only** in `USER_TURN_CONFIRMED`,
  `ASSISTANT_PENDING` or `COMPLETE`. It files `current_run` into `last_completed_run` with
  `closed_at` and `detail`, clears `current_task` and `current_run`, sets `delivery_state` to
  `'IDLE'`, and returns `{ok, seat, closed_from}`. Anything else is refused.
- `settleTurn(seat, evidence)` is for the case a transport legitimately reports: the send
  executed and the reply has already been read while the state is still `SEND_PENDING`. It
  requires proof - a `replyText` string containing the current run id - and then walks
  `SEND_PENDING -> USER_TURN_CONFIRMED -> COMPLETE`. See the protocol document for the full
  rule; from the seat's point of view, it is the legal way to close a turn that demonstrably
  landed, without weakening the anti-duplicate guard.

### The refusal: a seat asked to carry a run it does not own

`dispatch` compares the envelope against the seat before anything is rendered or sent, and
returns a refusal rather than throwing:

```
{ok: false, refused: true, error: 'envelope does not belong to seat <seat_id>: <mismatches>'}
```

where `mismatches` names each disagreement, in the form
`envelope.seat_id=<x> vs seat <y>`, `project <x> vs seat <y>` and `workspace <x> vs seat <y>`.
The `seat_id` comparison is unconditional; the project and workspace comparisons apply only
when the seat declares one. An invalid envelope is refused in the same shape, with
`envelope is invalid: <problems>`.

### The refusal: a second dispatch while one is in flight

```
{ok: false, refused: true, delivery_state: <current state>, error: <reason from mayRedispatch>}
```

`mayRedispatch` returns `allowed: false` for every state, and the reason it gives is the
policy:

- Already `COMPLETE`: `this run already completed; a new run should be dispatched instead`.
- Any terminal state: `the outcome is uncertain and the decision belongs to the user, not to an
  automatic retry`.
- Anything else: `a packet for this run is already <state>; re-dispatching would post a SECOND
  message into the same conversation. Only observation is permitted until the state settles.`

The guard exists because a duplicate message is unrecoverable while a delayed message is not.
Its measured cost is also recorded: a live two-task goal had its second dispatch refused, quite
correctly, while the first turn was still `SEND_PENDING` even though its reply had been read -
which is why `settleTurn` exists as a proof-gated way for a seat to take its next sequential
turn. The guard was not relaxed; it was given an honest exit.

---

## 7. Adding a new seat or transport

The test of the abstraction is whether a new provider means editing a declaration rather than
editing the layer above. This is the recipe, in order.

1. **Create the transport module** as `workbench/transports/transport.<name>.js`, exporting a
   factory such as `create<Name>Transport(opts)`, following the existing files: `'use strict'`,
   zero dependencies where possible, and a header comment that records the integration decision
   and what was rejected.
2. **Declare its identity.** `id` (non-empty string), `kind` (the transport vocabulary, not the
   provider name), `provider` (who answers), and `sourceFile: __filename` so the conformance
   scan can read the file. Add `defaultRenderer` when the transport has one; otherwise the
   default dialect `structured` is used.
3. **Declare `capabilities`** with the four required booleans -
   `can_deliver_synchronously`, `confirms_delivery`, `supports_readback`, `needs_human` - and
   any additional flags the layer above should adapt to, such as `supplies_source_content`,
   `can_run_commands` or `is_reasoning_model`. Add `notes` explaining the transport to a human.
   Do not add a provider-specific field that a caller would have to know the provider to
   interpret.
4. **Implement the five methods** - `open`, `health`, `dispatch`, `observe`, `read` - returning
   the documented shapes. `dispatch` must not wait for the answer and must not retry a packet
   that may already have landed; `observe` must not send; `read` returns text only.
5. **Use the shared delivery vocabulary.** Import `DELIVERY` from
   `workbench/protocol/transport-contract.js` and report only those states. A transport may not
   invent its own, and every transition it reports must be a legal edge.
6. **Keep provider-specific code inside the transport**, and never branch on a provider name -
   not even there. Behaviour differences for the layer above must be expressed as capabilities.
7. **Declare the seat** by adding an entry to `DECLARATIONS` in
   `workbench/seats/registry.js`: `seat_id`, `role` from `ROLES`, `provider`, `transport`,
   `connected`, `why`, `connection`, `permissions`, `contextLimit` and `rotationThreshold`.
   `connected` must be honest: an unavailable seat is declared with `connected: false` and a
   reason, never presented as usable.
8. **Extend `buildTransport`** with a branch for the new `transport` kind, returning
   `{ok: true, transport}` or `{ok: false, error: 'not connected: <reason>'}`. If the transport
   cannot be built, the seat lands in the registry's `unavailable` list with that reason.
9. **Run the conformance check, and make it pass.** `createSeat` calls
   `checkContract(transport, {sourceFile: transport.sourceFile})` and refuses to build on
   failure, so the seat cannot exist until the contract does. At the registry level,
   `conformance()` builds a candidate of every transport kind it can build and runs
   `contract.checkAll` over them; the new transport must come back as
   `{ok: true, transport, kind, problems: []}`. If the transport is a new rendering dialect as
   well, add an entry to `RENDERERS` in `workbench/protocol/renderers.js` - and remember that
   every renderer must emit the ack block, which the regression suite asserts.
