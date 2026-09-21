# Agent Harness

A multi-project agent harness: **DeepSeek Harness as Supervisor** + **ChatGPT Web as Expert Worker**.

Built to serve **many projects**, not one. The tooling and the projects are deliberately separate.

**V2** adds the Workspace layer and the Task Registry:

```
Harness -> Project -> Workspace -> Task -> Agent / Worker
```

---

## Layout

```
<repo>\
├── agent-harness\                 <- THIS harness (global tooling)
│   ├── cli.js                     <- entry point
│   ├── config.json                <- global config (paths, safety, limits)
│   ├── acceptance.js              <- V1 acceptance suite (59 checks)
│   ├── v2e2e.js                   <- V2 workspace/task suite (60 checks)
│   ├── yamltest.js                <- YAML regression suite (33 checks)
│   ├── bin\harness.ps1            <- convenience shim
│   ├── lib\
│   │   ├── paths.js               <- config + atomic IO + logging
│   │   ├── mini-yaml.js           <- zero-dependency YAML subset
│   │   ├── registry.js            <- project registry + root safety
│   │   ├── project.js             <- project loading + isolation guards
│   │   ├── workspaces.js          <- V2: workspace registry + path boundary
│   │   ├── tasks.js               <- V2: task registry + lifecycle + deps
│   │   ├── workers.js             <- Worker Pool (project+workspace-bound conversations)
│   │   ├── router.js              <- 4-stage task routing
│   │   ├── packet.js              <- Worker packet construction (V1 + V2 hierarchical)
│   │   └── driver.js              <- the only caller of the protected worker
│   ├── registry\
│   │   ├── projects.json          <- which projects exist
│   │   └── workers.json           <- which conversations serve which project+workspace
│   ├── templates\                 <- coding / writing / research / general
│   └── docs\HARNESS_PROTOCOL.md   <- authoritative global rules
│
└── chatgpt-worker\                <- PROTECTED. Verified browser Worker. Do not edit.
```

A project can live anywhere. It is never stored inside the harness.

---

## The four concepts

| Concept | Scope | Holds |
| --- | --- | --- |
| **Project** | Long-lived boundary — a game, a novel, a product | Overall goal, global decisions, cross-workspace dependencies, project-level status and tasks |
| **Workspace** | A logical work domain inside a project | Domain goal, paths, permissions, its own state and tasks, its own Worker conversation |
| **Task** | One finite, verifiable piece of work | Belongs to exactly one Project **and** one Workspace |
| **Agent / Worker** | The executor | Serves a specific Workspace/Task for a time. Owns nothing. |

The project layer records only a **summary table** of its workspaces. The detail lives in each
workspace's own `WORKSPACE_STATE.md` — never duplicated upward.

---

## Per-project layout

```
<project root>\
└── .ai\
    ├── PROJECT_STATE.md      project goal, status, WORKSPACE SUMMARY, cross-workspace risks
    ├── PROJECT_TASKS.md      generated view of all tasks
    ├── DECISIONS.md          global design decisions
    ├── PROJECT.yaml          machine-readable project config
    ├── workspaces.json       workspace registry (machine truth)
    ├── tasks.json            task registry (machine truth)
    └── workspaces\
        └── <workspace_id>\
            ├── WORKSPACE.yaml
            ├── WORKSPACE_STATE.md
            └── TASKS.md      generated view
```

Markdown is for humans. `workspaces.json` and `tasks.json` are the machine truth, and the
Markdown views are generated from them.

---

## Quick start

```powershell
$cli = "<repo>/runtime/harness\cli.js"

node $cli register "D:\Work\MyVN" --name SchoolMysteryVN --type general --id visual-novel --scaffold
node $cli workspace add visual-novel story --name "Main Story" --type writing --path story `
       --role writing --keyword 剧情 --keyword 章节 --keyword 动机
node $cli workspace add visual-novel game-code --name "Game Code" --type coding --path src/combat `
       --role coding --keyword 战斗 --keyword HUD

node $cli task add visual-novel --workspace story --title "Rewrite chapter 3 motive" `
       --criteria "motive is foreshadowed" --priority high
node $cli task ready VN-STORY-001
node $cli task start VN-STORY-001
```

Add `--json` to any command for machine-readable output.

---

## Commands

### Projects
| Command | Purpose |
| --- | --- |
| `projects` | list registered projects |
| `register <path> [--name N] [--type T] [--id I] [--scaffold] [--approve-root]` | register a project |
| `remove <project_id>` | remove a **registration only** — never deletes files; archives its workers |
| `open <project_id>` | load config, state files, git state, worker |
| `status [project_id]` | compact health for one or all projects |

### Workspaces
| Command | Purpose |
| --- | --- |
| `workspace list <project_id>` | list workspaces (materialises the implicit `default`) |
| `workspace add <project_id> <ws_id> [--name N] [--type T] [--path P]... [--keyword K]... [--role R]` | add a workspace |
| `workspace status <project_id> <ws_id>` | detail: permissions, paths, worker, task counts |
| `workspace open <project_id> <ws_id>` | same, and records `last_used` |
| `workspace remove <project_id> <ws_id> [--archive] [--force]` | unregister, or archive (preferred) |

### Tasks
| Command | Purpose |
| --- | --- |
| `task list <project_id> [--workspace W] [--status S] [--open]` | list tasks |
| `task add <project_id> --workspace W --title "..." [--criteria C]... [--priority P] [--depends D]... [--cross-read W]...` | create a task |
| `task show <task_id>` | full task detail |
| `task start` / `ready` / `review` / `block` / `unblock` / `retry` / `done` / `cancel` `<task_id>` | lifecycle transitions |
| `task sync <project_id>` | regenerate Markdown views |
| `task <project_id> "<free text>"` | V1 behaviour — route a task |

### Workers / packets
| Command | Purpose |
| --- | --- |
| `worker list [project_id] [--workspace W]` | list workers |
| `worker new <project_id> [--role R] [--workspace W]` | create a project+workspace-bound worker |
| `worker open-conversation <worker_id>` | create a new ChatGPT conversation |
| `worker focus <worker_id>` | point the browser at the worker's conversation |
| `worker archive` / `rotate` / `rounds` | lifecycle, rotation, counter reconciliation |
| `packet init <project_id>` | Worker initialization packet |
| `packet task <project_id> <spec.json>` | V1 flat packet |
| `packet wstask <project_id> <task_id> [spec.json]` | **V2 hierarchical packet** |
| `health` / `verify` | Worker health; protected verification suite |

---

## Project types

| Type | Allows | Denies by default |
| --- | --- | --- |
| `coding` | file_read, file_write, shell, git, test | — |
| `writing` | file_read, file_write | shell, git, test |
| `research` | file_read, web | file_write, shell, git, test |
| `general` | file_read | file_write, shell, git, test, web |

Workspace types: `coding` `writing` `research` `art` `audio` `testing` `production` `general`.
A workspace may override the project's permissions; the widening is explicit in its config.

Task status: `TODO` `READY` `IN_PROGRESS` `REVIEW` `BLOCKED` `DONE` `CANCELLED`.
The pseudo-workspace `project` holds project-level tasks (releases, cross-workspace integration).

---

## Isolation model

- The **browser session and ChatGPT login are global** — one profile, one login, shared.
- The **conversation is per project AND per workspace**. Story context must never reach the
  worker fixing a null reference. Binding a conversation to a second project or workspace is
  refused.
- Packets carry **one workspace's** state plus only the decisions and files that task needs.
  They never carry every workspace, every decision and every task.
- Cross-workspace **reads** require a declaration (`cross_workspace_reads`) on the task.
  Cross-workspace **writes** require declaration *and* supervisor review.
- Reading outside a project root is refused unless explicitly approved.

---

## Task lifecycle

```
TODO -> READY -> IN_PROGRESS -> REVIEW -> DONE
                  |                |
                  v                v
               BLOCKED          RETRY (max 3) -> IN_PROGRESS
```

- `READY` requires `success_criteria` and all dependencies `DONE`.
- `DONE` requires `success_criteria` **and** a verification note. A worker returning text is
  not evidence of completion.
- The retry cap (3) is structural: exceeding it forces `BLOCKED` rather than looping.

Dependencies support exactly three checks — existence, completion, and cycle detection.
A cycle is reported as BLOCKED with the offending chain. There is deliberately no DAG engine.

---

## Testing

```powershell
node <repo>/runtime/harness\acceptance.js   # V1: 59 checks
node <repo>/runtime/harness\v2e2e.js        # V2: 60 checks
node <repo>/runtime/harness\yamltest.js     # 33 checks
node <repo>/runtime/harness\cli.js verify   # protected worker: 10 gates
```

Both suites redirect the registry to a temporary directory, so running them cannot touch real
projects or the production registry.

---

## Rules

See `docs/HARNESS_PROTOCOL.md`. The short version:

- Simple work: the Supervisor does it. Complex work: delegate with a full packet.
- Review verdicts are PASS / RETRY / BLOCKED. `MAX_RETRY_PER_TASK = 3`, structurally enforced.
- Files change only after a PASS.
- Rotate workers at `MAX_WORKER_ROUNDS = 8`, with a real handoff packet.
- Login and captcha are human-only.
- Never point a project at a drive root, the user home, or the Desktop/Documents root.

---

## Zero dependencies

Everything here uses only Node built-ins. The harness runs offline from a shell with nothing
installed, which is the same property that keeps the protected worker dependable.

