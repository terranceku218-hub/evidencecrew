# Contributing to EvidenceCrew

EvidenceCrew 0.3.1 (release candidate)

Thank you for considering a contribution. This document explains what the project is,
how to run it locally, and which rules a reviewer will enforce. The architecture rules
below are not style preferences; changes that violate them are rejected in code review.

## Table of Contents

- [What This Project Is](#what-this-project-is)
- [What This Project Is Not](#what-this-project-is-not)
- [Development Setup](#development-setup)
- [Architecture Rules](#architecture-rules)
- [The No-Provider-Branching Rule](#the-no-provider-branching-rule)
- [Adding a New Seat or Transport](#adding-a-new-seat-or-transport)
- [Test Tiers](#test-tiers)
- [Evidence Semantics You Must Not Break](#evidence-semantics-you-must-not-break)
- [Pull Request Expectations](#pull-request-expectations)
- [Code Style](#code-style)
- [Security](#security)

## What This Project Is

EvidenceCrew is a local control plane for verifiable multi-agent work: a human
submits a Goal, a supervisor agent (DeepSeek, over its HTTP API) decomposes it into a
Task with explicit success criteria, a worker agent (ChatGPT, driven through a real
logged-in browser session) performs the work, and the supervisor reviews the result
and answers PASS, RETRY or BLOCKED. Every run produces an Evidence Record that states
what actually happened, and the whole thing is a single Node.js process serving a
local web UI with all state stored as JSON on disk.

## What This Project Is Not

- It is not a chat UI. The interface exists to submit Goals, watch a run, and read
  evidence, not to hold a conversation.
- It is not a browser-automation framework. DOM automation is one transport among
  several, not the product.
- It is not an autonomous agent swarm. There is no unbounded fan-out of agents; there
  is a supervisor, a worker, and deliberate stop conditions that exist so the system
  stops rather than guesses.

Keeping those boundaries is part of the review. A change that turns the workbench into
one of the three things above is a change to what the project is, and needs an explicit
maintainer decision rather than a pull request.

## Development Setup

1. Install Node.js 18 or later.
2. There are no dependencies to install. The shipped code has zero npm dependencies and
   uses Node.js built-in modules only.
3. Start the local server and open the local URL it prints. The server is a single
   Node.js process; the web UI and API bind to 127.0.0.1 only, because this is a
   single-user local tool and must never be exposed to a network or the internet.
4. Run the test tiers below. Which tier you run depends on the kind of change you
   made, not on how confident you feel.

The DeepSeek key is read from a local credentials file that is never committed and
never logged. The workbench never stores ChatGPT credentials, cookies or session
tokens: the browser session belongs to the user and lives in the browser profile. When
the worker drives the browser, you log in yourself and you complete any CAPTCHA or
two-factor challenge yourself; the software never automates or bypasses a login, a
CAPTCHA or a 2FA prompt, and never copies or reads your everyday browser profile.

## Architecture Rules

These rules are enforced in code review. Read them before writing code, not after a
reviewer asks for a rewrite.

1. **Provider and transport are independent axes.** `provider` is who answers
   (deepseek, chatgpt, openai-codex, human, openai-compatible). `transport` is how it
   is reached (deepseek-api, playwright-dom, codex-app-server, human, openai-http).
   They vary independently, and code must treat them as independent.
2. **No provider-name branching above the transport layer.** Orchestration code must
   never contain `if (provider === ...)`. Behaviour differences are expressed as
   transport CAPABILITIES: `can_deliver_synchronously`, `confirms_delivery`,
   `supports_readback`, `needs_human`, `supplies_source_content`, `can_run_commands`,
   `is_reasoning_model`. Adding a provider must require zero changes to the
   orchestrator. See the dedicated subsection below.
3. **A transport implements exactly five methods:** `open`, `health`, `dispatch`,
   `observe`, `read`. Not four, not six. If a transport seems to need a sixth method,
   the need belongs to a capability, not to the interface.
4. **There is no blind retry, anywhere.** The delivery state machine is
   `IDLE -> SUBMITTING -> SEND_PENDING -> USER_TURN_CONFIRMED -> ASSISTANT_PENDING ->
   COMPLETE`, with `SEND_UNCERTAIN` as a terminal state that has NO outgoing
   transitions. A message that may or may not have been sent stops the automation and
   requires a human decision; it is never re-sent automatically. One message in flight
   per seat.
5. **Every dispatched packet carries a run id and a source hash, and the reply must
   echo them** (RUN_ID_ACK, SOURCE_HASH_ACK) exactly. A reply that does not correlate
   is discarded, never guessed at. Forbidden: case-insensitive matching, substring
   matching, "use the latest reply", or proceeding without an acknowledgement.
6. **Evidence semantics are fixed.** The JSON record is the source of truth; the
   Markdown view and the UI card are generated views. A field that was never recorded
   renders as NOT RECORDED (a dash), never as a pass. An independent reviewer that is
   switched off is recorded as DISABLED_BY_POLICY (not applicable), which is
   explicitly NOT the same as missing evidence. The system distinguishes STATIC
   verification from RUNTIME verification and never claims runtime verification it did
   not perform.
7. **Zero npm dependencies in the shipped code.** Node.js built-in modules only.
8. **New and edited sources are ASCII-only, deliberately.** On Windows, PowerShell's `Get-Content`
   uses the system ANSI code page and a scripted read/write round-trip silently
   destroys non-ASCII characters. Keeping sources ASCII makes such an accident a no-op
   instead of data loss.
   *Measured caveat, so the rule is not mistaken for a description of the tree:* a few files that
   predate it still contain non-ASCII characters (some are Chinese comments, some are em dashes in
   prose, and one browser selector table contains non-ASCII text). That is a pre-existing state, not a
   licence to add more: anything you write or touch should be ASCII. If you deliberately need
   non-ASCII, say why in the pull request.

## The No-Provider-Branching Rule

This rule gets its own section because it is the one most likely to be broken by an
otherwise reasonable change. If a provider needs different behaviour, that difference
is a capability of its transport, declared by the transport itself. The orchestrator
asks the transport what it can do; it does not ask who the provider is.

Wrong:

```js
if (provider === 'chatgpt') {
  await waitForAssistantTurn();
}
```

Correct:

```js
if (transport.capabilities.confirms_delivery) {
  await waitForDeliveryConfirmation();
}
```

The wrong version hard-codes one provider into shared orchestration code, which means
the next provider needs an edit to the same block, and the one after that needs
another. The correct version moves the decision to the only place that actually knows
the answer. Every new `if (provider === ...)` in orchestration code is a review
blocker, including one that is currently correct for every provider that exists today.

Capabilities must be declared honestly. Declaring `confirms_delivery` on a transport
that cannot confirm delivery is worse than declaring nothing, because the orchestrator
will trust it and the Evidence Record will then be wrong.

## Adding a New Seat or Transport

To add a new seat or transport:

1. Implement the five transport methods: `open`, `health`, `dispatch`, `observe`,
   `read`.
2. Declare capabilities honestly, from the list in the architecture rules. Declare only
   what the transport can actually do and actually verify.
3. Provide the `provider` and `transport` identifiers. They are separate values; do not
   encode one inside the other.
4. Never special-case the orchestrator. No `if (provider === ...)` above the transport
   layer, and no "temporary" exception. Adding a provider must require zero changes to
   the orchestrator; if your change requires one, the design is wrong.
5. Add the seat to the registry.
6. Run the transport contract check, which verifies that the transport honours the
   interface, its declared capabilities, the run id and source hash acknowledgement
   rule, and the delivery state machine.

If your transport cannot confirm delivery or cannot read back, say so in its
capabilities rather than emulating a confirmation. An uncertain delivery is a terminal
state that stops the automation for a human decision; it is never something to paper
over inside a new transport.

## Test Tiers

The tiers are defined in the workbench's test policy. Run the tier that matches your
change:

- **DAILY** - fast, seconds. Zero module suites; only per-project checks such as "the
  server responds" and "the repository root contains no stray scripts".
- **CORE_CHANGE** - roughly 30 to 60 seconds. The seat and protocol suites, the
  workbench smoke suite, the send-path integration suite, the worker turn-detection
  suite, and offline worker checks.
- **RELEASE** - slow, up to about 30 minutes. Adds harness acceptance suites,
  throwaway-project end-to-end runs, a freeze-manifest drift check, and a suite that
  posts REAL messages to ChatGPT.

Which tier for which change:

| Change | Tier to run |
| --- | --- |
| Documentation or packaging only | DAILY |
| Any code change | The affected suites, plus DAILY |
| Before tagging a release | RELEASE |

The RELEASE tier posts real messages to ChatGPT. Treat it as a real, externally visible
action: it needs a logged-in browser session that you control, and it must not be run
casually on someone else's account or in someone else's environment.

## Evidence Semantics You Must Not Break

If you change anything that records or renders a result, these rules apply:

- **NOT RECORDED is not a pass.** A field that was never recorded renders as NOT
  RECORDED (a dash). Never let a missing observation render as success, and never make
  absent data default to a passing value.
- **DISABLED_BY_POLICY is not missing evidence.** An independent reviewer that is
  switched off is recorded as DISABLED_BY_POLICY (not applicable), which is explicitly
  NOT the same as missing evidence. Do not collapse those two states into one, in
  either direction.
- **Never claim runtime verification without a runtime.** The system distinguishes
  STATIC verification from RUNTIME verification. A static check must be recorded as
  static even when it is strongly suggestive of runtime behaviour.
- **The JSON record is the source of truth.** The Markdown view and the UI card are
  generated views. If a generated view disagrees with the record, the view is wrong.
- **No correlating, no proceeding.** A reply that does not echo the run id and source
  hash exactly is discarded, never guessed at. Case-insensitive matching, substring
  matching, "use the latest reply", and proceeding without an acknowledgement are all
  forbidden.

For definition changes in the architecture itself, see [SECURITY.md](SECURITY.md) for
the user-facing statement of these guarantees.

## Pull Request Expectations

- Keep changes small and focused. One concern per pull request.
- State the reason for the change. A reviewer needs to know what problem it solves and
  how you know it is solved.
- Include tests for behaviour changes, at the tier that matches the change.
- State explicitly what was NOT verified. "I ran DAILY and CORE_CHANGE; I did not run
  RELEASE, so the real-ChatGPT suite is unverified" is exactly the kind of statement
  that makes a pull request reviewable. Silence about what you did not check is worse
  than an honest gap.
- Do not include credentials, tokens, cookies, session data or personal data, and do
  not paste the matched value of anything a safety scanner flagged. The repository's
  safety scanner reports the LOCATION and CLASS of anything that looks like a secret
  and deliberately never prints the matched value, because printing it copies the
  secret somewhere new.
- Never edit a generated view by hand to make output look better. Fix the record or fix
  the generator.

## Code Style

- ASCII-only sources. This is deliberate: on Windows, PowerShell's `Get-Content` uses
  the system ANSI code page, and a scripted read/write round-trip silently destroys
  non-ASCII characters. ASCII sources make that accident a no-op instead of data loss.
- Node.js built-in modules only.
- No new dependencies without an explicit maintainer decision.
- Comments explain WHY rather than restating WHAT. Restating the code adds a second
  copy of the truth that will drift; explaining the reason preserves the reason.
- No blind retry, and no code path that resolves an uncertain delivery by guessing.

## Security

Do not report vulnerabilities in a public issue. See [SECURITY.md](SECURITY.md) for the
security model and the private reporting route.
