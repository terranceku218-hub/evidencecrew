# ARCHITECTURE

How the pieces fit, and the five rules that keep them apart. The rules matter more than the diagram: a
diagram drifts, and a rule that a reviewer enforces does not.

- [The shape](#the-shape)
- [Layers](#layers)
- [The five rules](#the-five-rules)
- [Where things live](#where-things-live)
- [One task, end to end](#one-task-end-to-end)
- [Why the harness is bundled](#why-the-harness-is-bundled)
- [What is deliberately absent](#what-is-deliberately-absent)

## The shape

```
                      User
                        |
                        v
   +--------------------------------------------+
   |  Workbench           127.0.0.1:3099        |
   |  local UI + HTTP API + goal orchestration  |
   +--------------------------------------------+
                        |
                        v
   +--------------------------------------------+
   |  Goal Orchestrator                         |
   |  limits, stop conditions, retries, rotation |
   +--------------------------------------------+
                        |
                        v
   +--------------------------------------------+
   |  Agent Seats                               |
   |  supervisor   worker    reviewer   human   |
   +--------------------------------------------+
        |             |            |
        v             v            v
   DeepSeek        ChatGPT       Codex          (optional)
   HTTP API        browser DOM   app-server
        \             |            /
         \            v           /
   +--------------------------------------------+
   |  Verified Task Protocol                    |
   |  envelope, run id, source hash, ACK, TOCTOU |
   +--------------------------------------------+
                        |
                        v
   +--------------------------------------------+
   |  Project  /  Git  /  Evidence Records      |
   +--------------------------------------------+
```

One orchestrator. Seats behind one contract. One protocol for every hand-off. Receipts at the end.

## Layers

| Layer | Responsibility | Must not |
|---|---|---|
| **Transport** | reach one endpoint and move one message | contain orchestration, know about roles, or branch on provider |
| **Seat** | one role, one provider, one conversation, permissions, health, delivery state | contain policy about *when* to use it |
| **Protocol** | envelope, correlation, TOCTOU, independence | know which provider is involved |
| **Orchestrator** | plan, dispatch, review, retry, stop | contain provider-specific logic |
| **Evidence** | record what happened, honestly | render an unrecorded field as a success |
| **UI** | show state, accept a goal, take an approval | own business truth |

## The five rules

### 1. Provider and transport are independent axes

`provider` is **who answers**. `transport` is **how you reach them**. They are separate fields on every
seat, and the same transport can serve several providers.

### 2. No provider-name branching above the transport layer

There is no `if (provider === 'chatgpt')` in the orchestrator, and a test fails if one appears. Behaviour
differences are expressed as **capabilities** that a transport declares about itself:

- `can_deliver_synchronously` - can the answer be read immediately after dispatch?
- `confirms_delivery` - does the transport tell you the message actually landed?
- `supports_readback` - can the reply be read back through the contract?
- `needs_human` - does a person have to be involved?
- `supplies_source_content` - can this seat read the project itself?
- `can_run_commands` - can it execute anything?
- `is_reasoning_model` - is it a reasoning model (affects prompting, not routing)?

Adding a provider is supposed to require **zero** changes to the orchestrator. If it does not, the
capability model is wrong and that is the bug to fix.

### 3. One message in flight, and no blind retry

Each seat carries at most one run. A second dispatch while one is pending is **refused**, because the only
thing that refusal prevents is a duplicate message into somebody's conversation. The delivery state machine
has a terminal `SEND_UNCERTAIN` state with no outgoing transitions: when it is genuinely unknown whether a
message landed, the automation stops and a human decides. There is no code path that re-sends automatically.

### 4. A reply that does not correlate is discarded, never guessed at

Every dispatch carries a run id and a source hash. The reply must echo both, and the comparison is exact
byte equality. No case-insensitive matching, no substring matching, no "probably the latest message", and no
proceeding when the acknowledgement is missing. An uncorrelated reply is quarantined and never reaches
review.

### 5. Evidence never invents a pass

The JSON record is the source of truth; the Markdown file and the UI card are generated views. A field that
was not recorded renders as **NOT RECORDED**, never as a tick. A reviewer that was switched off is recorded
as **DISABLED_BY_POLICY** and is explicitly not missing evidence. Static verification and runtime
verification are different words, and the second is never claimed without a runtime.

## Where things live

```
workbench/
  protocol/        envelope, correlation, policy, evidence, card, renderers, orchestrator, supervisor
  seats/           the seat object and the registry
  transports/      deepseek (HTTP), playwright-dom (browser), codex-app-server, human, openai-http
  adapters/        the ONLY module that talks to the harness
  server/          HTTP surface, job runner, store, events
  public/          the UI: plain HTML, CSS and JS, no framework
  scripts/         the autonomous loop and its tooling
  verify/          the test suites
runtime/harness/   project registry, task registry, workspaces, router, packet builder
worker/adapter/    the ChatGPT browser worker
examples/demo-project/   a deliberately tiny project with one real bug
tools/             setup check, test runner, release manifest
docs/              this and the other specifications
scripts/           the public safety scanner
```

## One task, end to end

1. The supervisor seat plans the goal into a task with success criteria.
2. The orchestrator builds a **Verified Task Envelope**: run id, permissions, source hashes, criteria.
3. A renderer turns the envelope into a packet that begins with the two ACK lines.
4. The seat's transport dispatches it and reports a delivery state.
5. The reply is read back through the transport contract.
6. The reply is correlated against the **frozen snapshot** taken at dispatch - not against the mutable
   envelope.
7. The source is re-verified (TOCTOU): if it changed since dispatch, the run stops.
8. The supervisor reviews the reply against the criteria it wrote.
9. Independence is **checked**, not assumed: a reviewer sharing the worker's provider is not independent.
10. An Evidence Record is written, its Markdown view generated, and its card rendered.

## Why the harness is bundled

The harness is the project and task layer: project registry, workspaces, tasks, worker pool, routing. It is
frozen and separately tested, and it is included in this repository so that one clone runs end to end rather
than requiring a second installation with no documentation of its own.

It is consumed as a **library through its public exports**, never shelled out to from arbitrary code, and
never edited by the workbench: `workbench/adapters/harness-adapter.js` is the single module permitted to
touch it, so the question "what can this UI actually do to my project?" has exactly one answer.

## What is deliberately absent

- **No fourth provider, and no plans for one in this release.** The capability model exists so that adding
  one is cheap; shipping one that has not been verified end to end would be the opposite of that.
- **No Codex write mode.** The reviewer is read-only by design.
- **No cloud, no accounts, no telemetry, no database.** State is JSON on disk and the server binds loopback.
- **No dependency.** Not as minimalism for its own sake: a tool that drives a logged-in browser and writes to
  your project should have as little code in it as possible that you did not read.
