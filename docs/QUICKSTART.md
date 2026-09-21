# QUICKSTART

Five minutes, honestly measured. Nothing here is aspirational: every step below was executed against the
release candidate on Windows with Node 24, and the timings are what it actually took.

- [What you need](#what-you-need)
- [The five minutes](#the-five-minutes)
- [Configuring the two required pieces](#configuring-the-two-required-pieces)
- [Running the demo goal](#running-the-demo-goal)
- [What you will see](#what-you-will-see)
- [Troubleshooting](#troubleshooting)
- [Environment variables](#environment-variables)

## What you need

| Requirement | Why | Notes |
|---|---|---|
| Node.js 18 or later | the whole stack is Node built-ins only | `npm run setup` reports your version |
| git | to clone | - |
| A DeepSeek API key | the supervisor seat | any account with API access |
| A ChatGPT account | the worker seat | your own logged-in browser session |
| Chrome or Chromium | the browser transport | the profile directory starts **empty** |

**Not required: Codex, Docker, a database, a cloud account, or any npm dependency.** `npm install` is a
no-op and there is no lockfile to audit, because there are no dependencies.

## The five minutes

### 1. Clone (10 seconds)

```bash
git clone <this-repo> evidencecrew
cd evidencecrew
```

### 2. Do not install anything (0 seconds)

```bash
npm install        # completes immediately: zero dependencies
```

You can skip this. It is listed because every reader tries it, and because "nothing happened" is the
correct outcome.

### 3. Check the machine (2 seconds)

```bash
npm run setup
```

You get one line per requirement, each with the exact command that fixes it. Example:

```
[ok]   Node.js version                    v24.12.0 on win32
[ok]   npm dependencies                   none: Node built-ins only, so there is nothing to install
[ok]   repository layout                  8 expected components present
[FAIL] DeepSeek supervisor credential     no credential file at <home>/.dsh/.credentials.yaml
[?]    ChatGPT browser worker             not probed: this check does not open a browser
[opt]  Codex independent reviewer         OFF by default; the workbench runs fully without it
[ok]   Workspace directory                <repo>/.state is writable
```

The setup check **never asks for a credential and never writes one**. It reports whether each piece is
present, and it never prints a credential value.

### 4. Give it the DeepSeek key (1 minute)

Either of these, your choice:

```bash
# option A: a local file, git-ignored, never logged
mkdir -p ~/.dsh
printf 'DEEPSEEK_API_KEY: <your key>\n' >> ~/.dsh/.credentials.yaml
```

```bash
# option B: an environment variable, convenient for CI
export DEEPSEEK_API_KEY=<your key>          # PowerShell: $env:DEEPSEEK_API_KEY='<your key>'
```

### 5. Start it (5 seconds)

```bash
npm start
# -> EvidenceCrew listening on http://127.0.0.1:3099
```

Open <http://127.0.0.1:3099>. It binds to loopback only, on purpose, and there is no authentication because
there is no remote access.

### 6. Log in to ChatGPT yourself (1-2 minutes, once)

The first time the worker seat is used, a browser window opens with an empty profile. **You** log in to
chatgpt.com in that window, and you complete any CAPTCHA or two-factor challenge yourself. The workbench
never automates a login, never solves a CAPTCHA, and never copies or reads your everyday Chrome profile.

The session persists in the worker's own profile directory, so this is a one-time step.

### 7. Run a goal (2-5 minutes, mostly waiting on the browser)

Paste this into the workbench, with the demo project selected:

> Inspect `src/hud-pulse.js` in the demo project and report how the pulse colour is handled, without
> changing any files yet. A damage flash must always return the health bar to the true baseline colour
> rather than to a mid-flash tint, even when a second hit overlaps a pulse that is still running, so the
> baseline may only be captured while no pulse is active. Then fix it in the smallest way that keeps the
> public API unchanged, and prove the fix with `node test/pulse.test.js`, pasting the summary line.

Total: **about five minutes**, of which four are the browser worker thinking and rendering. That is the
honest cost of driving a subscription instead of an API key.

## Configuring the two required pieces

**DeepSeek supervisor.** `workbench/transports/transport.deepseek.js`. Base URL defaults to
`https://api.deepseek.com` and can be overridden with `DEEPSEEK_BASE_URL`. The model defaults to
`deepseek-flash`.

**ChatGPT worker.** `workbench/transports/transport.playwright-dom.js` over the worker adapter. The
adapter's own configuration is `worker/adapter/config.json`, and its `profileDir` starts empty. Set
`AWB_WORKER_PROFILE_DIR` to use a different profile location.

**Codex reviewer.** Optional. `codex_review_mode` is `OFF` by default and the workbench runs fully without
it. Switch it on with the toggle in the workbench header, or set `AWB_CODEX_MODE=OFF|AUTO|REQUIRED`.

## Running the demo goal

Nothing about the demo needs an API key, a browser or a network:

```bash
cd examples/demo-project
node test/pulse.test.js         # 6 passed, 2 failed - the demo ships a real bug on purpose
node test/pulse.fixed.test.js   # 8 passed, 0 failed - the corrected reference
```

That failing pair is what makes the demo honest: it gives the worker something real to find and it lets the
supervisor legitimately answer `RETRY` before `PASS`. The recording storyboard is in
[`DEMO.md`](DEMO.md).

## What you will see

1. **A Goal** you typed.
2. **A Team**: the seats, their providers, their transports, and a health state per seat. Codex shows as
   OFF by default.
3. **A Task** with the success criteria the supervisor wrote and the exact envelope that was dispatched.
4. **A review verdict**: `PASS` or `RETRY`, with the criterion that was not satisfied named.
5. **An Evidence Record**: the receipt, with `NOT RECORDED` where something was never recorded and the
   not-applicable mark where something does not apply to that run.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `EADDRINUSE` on start | port 3099 is taken | `PORT=3199 npm start` |
| Setup check: no credential file | expected on a fresh machine | step 4 above |
| Worker reports `LOGIN_REQUIRED` | the browser profile is new | log in yourself in the window that opened |
| Worker reports `CAPTCHA` | the provider asked for a human | solve it yourself; nothing here will try to |
| A send sits in `SEND_PENDING` for minutes | normal for the browser transport | wait. Never re-dispatch: the anti-duplicate guard refuses it, on purpose |
| Goal stops with `NO_PROGRESS` | two consecutive iterations produced no completed task | read the review's concerns; usually the worker's reply did not address a criterion |
| Goal stops with `BUDGET_EXHAUSTED` | a configured limit was reached | raise the limit deliberately, or split the goal |
| Evidence says `RUNTIME VERIFIED = NO` | there is no runtime for your project here | run your own tests; the record is telling you the truth |

## Environment variables

Every path in the configuration can be overridden, which is what makes the same tree usable from a
different checkout location or a CI runner.

| Variable | Overrides |
|---|---|
| `PORT` | the HTTP port (default 3099) |
| `DEEPSEEK_API_KEY` | the DeepSeek credential, taking precedence over the credentials file |
| `DEEPSEEK_BASE_URL` | the DeepSeek API base URL |
| `AWB_CODEX_MODE` | `OFF` / `AUTO` / `REQUIRED` for the optional reviewer |
| `AWB_PROJECT_ROOT` | the project the autonomous loop works on (defaults to the demo project) |
| `AWB_WORKBENCH_ROOT`, `AWB_PUBLIC_DIR`, `AWB_LOGS_DIR`, `AWB_STATE_FILE` | workbench paths |
| `AWB_HARNESS_ROOT`, `AWB_HARNESS_CLI`, `AWB_HARNESS_REGISTRY`, `AWB_HARNESS_LOGS`, `AWB_HARNESS_TEMPLATES` | bundled harness paths |
| `AWB_WORKER_DIR`, `AWB_WORKER_CLI`, `AWB_WORKER_ADAPTER_DIR` | worker adapter paths |
| `AWB_WORKER_PROFILE_DIR`, `AWB_WORKER_STATE_DIR`, `AWB_WORKER_LOGS_DIR`, `AWB_WORKER_LEDGER` | browser worker paths |

Never commit any of these with real values. See [`../PUBLIC_EXCLUDE.md`](../PUBLIC_EXCLUDE.md).
