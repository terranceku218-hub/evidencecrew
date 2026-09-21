# DEMO - the 30-second storyboard

The demo has one job: show that this is **not** another chat window, and that a result arrives with a
receipt. It must never depend on Codex quota, and it must not need more than one browser worker turn on
screen.

- [What the demo must show](#what-the-demo-must-show)
- [Storyboard](#storyboard)
- [Pre-recording checklist](#pre-recording-checklist)
- [The optional second clip](#the-optional-second-clip)
- [Why the retry is the important beat](#why-the-retry-is-the-important-beat)

## What the demo must show

In order of importance, on screen:

1. a **Goal** a human typed,
2. the **Team** (seats, providers, transports, and Codex shown as OFF),
3. a **Task** with the success criteria the supervisor wrote,
4. a **RETRY** - the moment that proves something is actually reviewing,
5. the **Evidence Record** with the marks that distinguish recorded, not recorded and not applicable.

The first frame must NOT be a chat transcript. If the recording opens on a conversation, the viewer
concludes this is a chat wrapper and stops watching.

## Storyboard

| Time | On screen | What to do | Why this beat exists |
|---|---|---|---|
| 0-5 s | the Goal box | type the demo goal, press the submit key | it starts with a human decision, not with a model |
| 5-10 s | the Team panel, then a new Task | let the supervisor plan | shows a role being filled, and Codex visibly OFF |
| 10-18 s | the Task in flight, `SEND_PENDING` | keep the camera on the state machine | shows an honest waiting state instead of a fake progress bar |
| 18-23 s | the review verdict: **RETRY** | pause on the named criterion | the reviewer disagreed, and said why |
| 23-27 s | the revised Task, then **PASS** | let the retry complete | one loop, closed properly |
| 27-30 s | the Evidence Record | hold on the card | the receipt, then the line below |

Final frame, as text over the card:

```
Don't trust Done. Verify it.
```

Recording notes:

- Use the **demo project**, never a real project. It is small, it is public, and its bug is real.
- Keep the browser worker's latency OUT of the main clip if it is embarrassing: cut between "dispatched" and
  "reply read", and say in the caption that the cut is a wait, not an edit. Do not fake a fast reply.
- Show `codex_review_mode = OFF` at least once, so nobody thinks the demo needs a third subscription.
- Do not show any real path, token, conversation URL or account name.

## Pre-recording checklist

- [ ] window is the right size and the zoom level is readable at 720p
- [ ] no personal paths visible (browser bookmarks bar, window title, file picker)
- [ ] Codex toggle is OFF, and the Team panel says so
- [ ] the demo project is the selected project
- [ ] `examples/demo-project/test/pulse.test.js` currently FAILS (`6 passed, 2 failed`) so the bug is real
- [ ] the browser worker is already logged in, so no login wall appears on camera
- [ ] notifications silenced; no other tabs with private content
- [ ] the Evidence Record you will show is from this run, not a stale one

## The optional second clip

Only if you have Codex available. Keep it separate, keep it short, and label it:

> Optional: an independent reviewer. DeepSeek plans, ChatGPT works, and Codex - a different provider -
> reviews the result with independence satisfied. Off by default; the loop you just saw never needed it.

This clip shows the same loop with `codex_review_mode = AUTO`, and the Evidence Record then reads
`review_level = INDEPENDENT_PROVIDER_REVIEW` instead of `SUPERVISOR_REVIEW`. That difference is the whole
point of the clip: it is the same product with one more seat filled.

## Why the retry is the important beat

Any tool can show a green checkmark. A green checkmark is unfalsifiable: the viewer has no way to tell a
real review from a decorative one.

The `RETRY` is different. It shows the supervisor reading a result, naming the criterion that was not
satisfied, and sending it back with that criticism attached - and the second attempt passing because the
work actually improved. That sequence is the product's core claim in five seconds of video, and it is why
the demo project ships with a bug that a careless first attempt will miss.
