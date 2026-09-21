# HARNESS PROTOCOL - Global Rules

> This file defines how the Agent Harness operates. It is **global**: the same rules apply
> to every project. Per-project facts live in that project's `.ai/` directory, never here.
>
> This document is the AUTHORITATIVE copy. A project may carry a copy at
> `.ai/HARNESS_PROTOCOL.md` for local reference, but if the two ever disagree, this one wins.

---

## 0. Architecture

```
User task
   |
   v
DeepSeek Supervisor  --- reads the target project's .ai/ state
   |                   --- reads the project's REAL files
   |                   --- routes the task (router.js)
   |
   +-- simple / planning / state work --> Supervisor handles it directly
   |
   +-- complex work --> Task packet --> ChatGPT Web Worker (project-bound conversation)
   |                                        |
   |                                        v
   |                                  DeepSeek Review: PASS / RETRY / BLOCKED
   |                                        |
   |                                        +-- RETRY   -> correction packet, SAME conversation
   |                                        +-- BLOCKED -> stop, report to user
   |                                        +-- PASS    -> only now may files change
   |
   v
Verify (re-read, git diff, tests) -> update .ai/PROJECT_STATE.md and .ai/TASKS.md
```

### The three layers

| Layer | Location | Scope |
| --- | --- | --- |
| **Harness tooling** | `<repo>/runtime/harness\` | Global. Registry, router, CLI, templates, protocol. |
| **Worker (browser + ChatGPT login)** | `<repo>/worker\` | Global. One browser, one profile, one login. **Protected - never edit casually.** |
| **Project** | Any directory the user chooses | Per project. Own `.ai/` state, own conversation. |

**A project never lives inside the harness.** The harness never assumes where projects are.

---

## 1. Roles

- **DeepSeek = Supervisor / Planner / Reviewer.** Owns the task end to end. Final decision.
- **ChatGPT Web Worker = Expert.** Analysis, debugging, architecture, cross-file reasoning,
  review, side-effect analysis, change design. **Not the final decision maker.**

Simple work (reading files, searching, locating things, state bookkeeping) — Supervisor does it.
Complex work — delegate with a full task packet.

---

## 2. Project isolation (the core invariant)

1. **One conversation belongs to exactly one project AND one workspace.** The browser and the
   ChatGPT login are global; the *conversation* is what carries context, so it is the unit of
   isolation. Binding an active conversation to a different project or workspace is refused.
   Story context must never reach the worker fixing a null reference.
2. **Project A's state files must never enter project B's packet.** Packets are assembled from
   a single project's `.ai/` directory. Reading outside a project root is refused by
   `project.containCheck()` unless the user explicitly approves it.
3. **Every log line carries `project_id`.**
4. Switching projects means using that project's own worker, or creating one.

---

## 2b. The Workspace layer (V2)

```
Harness -> Project -> Workspace -> Task -> Agent / Worker
```

### The four concepts

| Concept | Holds | Does NOT hold |
| --- | --- | --- |
| **Project** | Overall goal, global decisions, cross-workspace dependencies, project status, project-level tasks, a **summary table** of workspaces | The detail of any single workspace |
| **Workspace** | Domain goal, declared paths, permissions, its own state and tasks, its own Worker conversation | Other workspaces' state |
| **Task** | Belongs to exactly one project + one workspace | — |
| **Agent / Worker** | Executes a task for a time | Owns nothing |

**A workspace is not a directory.** `paths` is a list of project-relative locations it may
touch; it may be empty (whole project root), one directory, or several. The abstraction is the
*context boundary*, not the folder.

### Workspace registry

Per project, at `.ai/workspaces.json` — a machine registry, never a global one, because a
workspace always belongs to a project. Its state lives in
`.ai/workspaces/<workspace_id>/` (`WORKSPACE.yaml`, `WORKSPACE_STATE.md`, `TASKS.md`).

### Path boundary

- Reads and writes default to the workspace's declared paths.
- A **cross-workspace read** requires `cross_workspace_reads: [ws_id]` on the task.
- A **cross-workspace write** requires declaration *and* supervisor review with a recorded reason.
- An empty `paths` list means the whole project root. That is the correct semantic for a legacy
  project whose work was never partitioned — not an oversight.

### Project state stays a summary

`PROJECT_STATE.md` holds only a `## Workspaces` table (workspace, status, current task,
blockers). The detail lives in each `WORKSPACE_STATE.md`. Duplicating workspace detail upward
is forbidden — it is how a project state file turns back into a transcript.

---

## 2c. Task Registry (V2)

`TASKS.md` is for humans; `.ai/tasks.json` is the machine truth. The Markdown views
(`PROJECT_TASKS.md`, `workspaces/<id>/TASKS.md`) are **generated** from it.

Every task has a stable id: `<PROJECT_PREFIX>-<WORKSPACE>-<NNN>`, e.g. `VN-STORY-001`.
Position or title is never an identifier.

### Lifecycle

```
TODO -> READY -> IN_PROGRESS -> REVIEW -> DONE
                  |                |
                  v                v
               BLOCKED          RETRY (max 3) -> IN_PROGRESS
```

- `READY` requires `success_criteria` **and** every dependency `DONE`.
- `DONE` requires `success_criteria` **and** a verification note. **A worker returning text is
  not evidence of completion.**
- RETRY is not a status: a failed review moves `REVIEW -> IN_PROGRESS` and increments
  `retry_count`. A status called RETRY would let a task sit there forever.
- Exceeding `MAX_RETRY` (3) forces `BLOCKED`. The cap is structural.

### Dependencies

Exactly three checks: **existence**, **completion**, **cycle detection**. A cycle is reported
as BLOCKED with the offending chain. There is deliberately no DAG engine — the failure it
would guard against (a task starting before its prerequisite) is fully covered.

### The `project` pseudo-workspace

`workspace_id: project` holds project-level work — releases, cross-workspace integration,
milestones, project review — so no fake domain has to be invented for it.

---

## 2d. Router (V2)

Four stages: **Project -> Workspace -> Task type -> Delegate**.

If the workspace cannot be determined reliably, the router returns `WORKSPACE_REQUIRED` (or
`WORKSPACE_AMBIGUOUS`). **It does not guess.** A wrong workspace means the worker gets the wrong
context and may touch the wrong files, which is worse than pausing to ask.

Project-specific vocabulary belongs in the workspace definition (`keywords` in
`WORKSPACE.yaml`), not in the router. The router must never learn one project's domain language.

---

## 2e. Worker rotation (V2)

Rotation stays **within its workspace**: a replacement for the story worker is another story
worker. The handoff packet carries the project minimum, the workspace state, the current task,
the relevant decisions, and the real files that task needs — and **never** every workspace's
state. That is what actually reduces context.

---

## 3. Project state files

A project's state lives in `<root>/.ai/` (configurable per project):

| File | Required | Purpose |
| --- | --- | --- |
| `PROJECT_STATE.md` | yes | Goal, current state, **WORKSPACE SUMMARY**, cross-workspace risks, milestones, blockers |
| `PROJECT_TASKS.md` | generated | Human view of all tasks |
| `TASKS.md` | V1 only | Legacy project-level task list; V2 projects use the task registry |
| `DECISIONS.md` | yes | Long-lived design decisions and rejected options |
| `PROJECT.yaml` | yes | Machine-readable project config (type, worker, git, permissions) |
| `workspaces.json` | generated | Workspace registry (machine truth) |
| `tasks.json` | generated | Task registry (machine truth) |
| `workspaces/<id>/…` | per workspace | `WORKSPACE.yaml`, `WORKSPACE_STATE.md`, `TASKS.md` |
| `KNOWN_ISSUES.md` | optional | Standing problems worth remembering |
| `HANDOFF.md` | optional | Handoff notes for a replacement worker |
| `HARNESS_PROTOCOL.md` | optional | Local copy of these global rules |

**Never overwrite an existing state file.** Scaffolding creates only what is missing — an
existing `PROJECT_STATE.md` *is* the project's memory.

### Fact precedence

```
Real files on disk  >  tasks.json current task state  >  PROJECT_STATE.md  >  DECISIONS.md
```

When a state file disagrees with the tree, **the tree wins**. Record the disagreement and
correct the state file. Never silently trust the document.

### What does NOT belong in state files

Chat logs, full agent replies, full review transcripts, step-by-step narration. State files
record **final effective facts** only. If a project's state file starts reading like a
transcript, it has stopped being memory.

---

## 4. Project types and permissions

Set in `PROJECT.yaml`; a project may override any field.

| Type | Allows | Denies by default |
| --- | --- | --- |
| `coding` | file_read, file_write, shell, git, test | — |
| `writing` | file_read, file_write | shell, git, test |
| `research` | file_read, web | file_write, shell, git, test |
| `general` | file_read | file_write, shell, git, test, web |

`general` is deliberately read-only until a project opts in.

---

## 5. Task packet (delegation contract)

Every delegation must carry:

```
[ROLE] [TASK] [PROJECT CONTEXT] [PROJECT STATE] [FILES]
[KNOWN FACTS] [DO NOT BREAK] [SUCCESS CRITERIA] [REQUEST]
[OUTPUT FORMAT] [WORKING RULES] [IMPORTANT]
```

A packet missing `task`, `request`, or `successCriteria` is **refused** by the builder.
Delegating "look at this bug" is a defective delegation.

### Working rules (present in every packet, unconditionally)

1. Do not assume code you have not seen.
2. The real, latest files are authoritative.
3. State a conflict between `PROJECT_STATE` and the code; do not silently pick a side.
4. Do not widen the task.
5. State potential side effects.
6. Do not modify functionality unrelated to the task.
7. Say what is missing when information is insufficient; do not invent.
8. Output must be reviewable by the Supervisor.

---

## 6. Review protocol

Verdicts are exactly three:

- **PASS** — meets the success criteria; work may proceed.
- **RETRY** — a concrete defect. Must state (1) which requirement was unmet, (2) what to
  correct, (3) the success criterion. An unspecified RETRY is **rejected**, because it burns
  a round with no target.
- **BLOCKED** — missing information, files, permission, or environment.

### Retry cap

```
MAX_RETRY_PER_TASK = 3
```

The cap is **structural**: an always-RETRY reviewer still terminates. After the final
permitted attempt the result is forced to BLOCKED. No unbounded loops.

---

## 7. Write and verify protocol

Files change only **after** an accepted plan:

```
read real files -> analyze -> (delegate) -> Review PASS -> edit -> verify -> record state
```

After any edit:

1. Re-read what was written.
2. `git diff` — check for unexpected files, whole-file rewrites, encoding changes, mass
   reformatting, and edits unrelated to the task.
3. Run the project's tests if any exist.
4. Run a build/compile check if the project has one.
5. On failure: collect the error, hand it back for analysis, fix, re-verify.

**"The file was written" is not completion.** An anomalous diff is an immediate BLOCKED — do
not widen the change.

### Git discipline

- Before editing: `git status`; record pre-existing uncommitted changes so they are never
  mistaken for AI edits.
- Never run `git reset --hard`, `git clean -fd`, or a force push unless the user asks.
- Do not `git init` a directory that is not clearly a project root.

---

## 8. Encoding safety (a rule born from a real incident)

On Windows, PowerShell's `Get-Content` defaults to the system ANSI code page. A scripted

```
Get-Content  ->  string replace  ->  Set-Content
```

round-trip on UTF-8 source **destroys non-ASCII characters, irreversibly.** This has already
happened once in this project and required rebuilding multiple files.

Therefore:

- Never use that pattern for bulk source edits.
- Prefer a dedicated file-editing tool, explicit UTF-8 encoding, and small patches.
- Harness tool source is **ASCII-only** so such a round-trip is a no-op.
- After editing, check `git diff` for whole-file changes, mojibake, BOM changes, or
  line-ending flips. **Stop immediately** if any appear.

---

## 9. Worker rotation

```
MAX_WORKER_ROUNDS = 8
```

The threshold is a **signal, not an order.** Rotate on any of: rounds at threshold, noticeably
slower replies, truncated or anomalous output, context-related page messages, or one worker
carrying too many unrelated tasks.

**Round counting caveat:** the counter only advances when the harness itself sends. Rounds
typed by hand, or that occurred before a browser restart, are invisible to it. Reconcile with
`worker rounds <worker_id> <n>` after checking the real conversation.

On rotation: archive the old worker (never delete), create a new one, and send a **handoff
packet built from the state files** — never "continue the previous work", and never a replay
of the old transcript (that would recreate the context growth rotation exists to prevent).

---

## 10. Task routing (advisory)

Task types: `coding`, `writing`, `research`, `project-management`, `review`, `general`.

| Type | Default |
| --- | --- |
| coding | delegate |
| review | always delegate (an author's review is not an independent review) |
| writing | delegate |
| research | delegate only if web capability is available |
| project-management | supervisor only |
| general | supervisor decides after reading the real files |

**Routing is advisory.** The Supervisor may override it. The router classifies *type*, never
*difficulty* — a keyword scan cannot know that a one-line change touches a load-bearing
invariant.

---

## 11. Global safety rules (permanent)

1. A project root may **not** be `C:\`, the user home, the Desktop root, or the Documents
   root. Explicit approval is required to override, and the override is recorded.
2. Validate the project boundary before any `git init`.
3. File deletion is high-risk: confirm before acting.
4. `MAX_RETRY_PER_TASK = 3`.
5. Rotate workers at the threshold, with a proper handoff.
6. **Never read another Chrome profile.** Only the dedicated worker profile.
7. **Login and captcha are human-only.** The harness never enters credentials, never solves
   or bypasses a challenge, and never touches account security settings.
8. One project may not operate on another project's directory without explicit approval.
9. Removing a project **registration** never deletes project files.

---

## 12. Recovery

If the Worker browser window was closed, it is recovered with the **existing** persistent
profile — no new profile, no re-login unless the session actually expired:

```
node <repo>/runtime/harness\cli.js health
```

- `READY` — continue.
- `LOGIN_REQUIRED` — stop; ask the user to sign in. Do not attempt credentials.
- `ERROR` — stop; report the full error. Do not rebuild anything.

Then re-verify:

```
node <repo>/runtime/harness\cli.js verify
```

---

## 13. Session start protocol

1. `cli.js status` — see every registered project and its health.
2. `cli.js open <project_id>` — load config, state files, git state, worker binding.
3. Read any warnings the open reported (missing state, no worker, dirty tree).
4. Check the real files that matter for the task.
5. `cli.js task <project_id> "<task>"` — get the routing decision.
6. State a short plan (goal, files, delegate?, success criteria) and execute.

Do not re-analyze an entire project on every session. The state files exist so you do not
have to.
