# demo-project

A deliberately tiny stand-in for a real codebase.

`demo-project` is the thing the agents work ON during an EvidenceCrew demo. Agent
Workbench is a local control plane for verifiable multi-agent work: a human types a
Goal, a supervisor AI turns it into a Task with success criteria, a worker AI does the
work, the supervisor reviews it and answers PASS or RETRY, and every run ends in a
signed Evidence Record.

So this repository has to be small enough for a 30-second demo and real enough that a
genuine RETRY makes sense. It ships with exactly one real bug, on purpose.

## What is in here

- `src/hud-pulse.js` - a damage-flash helper for a health bar. Plain functions only:
  no classes, no timers, no DOM, no dependencies. `beginPulse` starts a flash,
  `advancePulse` moves it forward by a number of seconds, and `pulseStyle` returns
  `{ scale, color }` for the current phase.
- `src/hud-pulse.fixed.js` - the corrected helper.
- `test/pulse.test.js` - the checks that run against `src/hud-pulse.js`.
- `test/pulse.fixed.test.js` - the same checks against the fixed helper.
- `package.json` - scripts only, zero dependencies.

Both test runners are plain Node.js. There is no test framework, no install step and
nothing to configure. Node 18 or newer is enough.

## Running the tests

```
node test/pulse.test.js
node test/pulse.fixed.test.js
```

The first command is expected to FAIL while the bug is unfixed and to exit non-zero.
The second command is expected to PASS and to exit zero. Each check prints as
`PASS name` or `FAIL name :: detail`, followed by a summary line such as
`demo-project: 6 passed, 2 failed`.

## The bug

The colour that a pulse restores when it finishes is captured from the bar's current
colour every time `beginPulse` is called, so a second pulse that starts while the first
one is still flashing captures a mid-flash tint as its new baseline and the bar
permanently drifts to the wrong colour after a few rapid hits. The baseline is the
bar's resting colour, so it may only be captured while no pulse is running.

## Demo goal

Type this into EvidenceCrew as the Goal:

> Inspect src/hud-pulse.js in this repository and report what you find about how the pulse colour is handled, without changing any files yet; a damage flash must always return the health bar to the true baseline colour rather than to a mid-flash tint, even when a second hit overlaps a pulse that is still running, and the baseline must therefore only be captured while no pulse is active. Then fix that behaviour in src/hud-pulse.js in the smallest way that keeps the existing public API unchanged, and prove the fix by running the test suite with `node test/pulse.test.js` and pasting the summary line from the run into your report.

The supervisor reads the inspection report, marks the pass that ignores the overlapping
case as RETRY, and only accepts the run whose tests end green.
