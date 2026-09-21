# SCREENSHOTS

Four images, and what each one actually shows. They are the files in `docs/screenshots/` and they are what
the README displays.

- [What each shot is](#what-each-shot-is)
- [How they were captured](#how-they-were-captured)
- [Disclosures](#disclosures)
- [Sanitising rules](#sanitising-rules)

## What each shot is

| File | Shows | Why it is the shot |
|---|---|---|
| `05-ui-main-en.png` | The whole interface in English: the goal area with a real goal typed in, the task queue, and the Agent Team | The README is English-first, so this is the first image |
| `05-ui-main-zh.png` | The same interface in **简体中文**, the default language | Shows the Chinese-first experience: 你希望 AI 团队做什么？, 智能体席位（Agent Seat）, 证据 |
| `06-agent-team-en.png` / `06-agent-team-zh.png` | The Agent Team panel in both languages: each seat's role, what it does, provider, transport, delivery state, round budget and write scope. Codex reads **Not enabled** / **未启用** rather than an error | The panel a first-time user looks at first, in both languages, with the optional reviewer shown honestly as off |
| `07-codex-toggle-en.png` / `07-codex-toggle-zh.png` | The header: the language picker and **Use Codex Reviewer** / **使用 Codex 审查者** with its OFF/AUTO positions | The switch and its localisation in one frame |
| `01-goal-team.png` | The Goal panel and the Seats panel | Kept from the first capture; superseded by `05` for the README |
| `02-task-running.png` | The Seats panel with per-seat round budgets and write scope | See disclosure 2 below |
| `03-evidence-verified.png` | One Evidence Record: **VERIFIED**, every mark, and the collapsed technical drawer | The most important image in the repository |
| `04-codex-toggle.png` | The header with the reviewer switch, together with the card's `DISABLED_BY_POLICY` line | Shows the switch and its consequence together |

## How they were captured

From a **fresh checkout of the public tree**, running as its own instance on `127.0.0.1:3199`, with the
bundled demo project registered. Nothing was drawn or mocked up: the panels are the real UI rendering real
state, and the Evidence Record in shot 3 is a real record produced by the real pipeline.

The capture sequence is scripted so it is reproducible rather than a matter of what happened to be on
screen:

```
node capture.js      # loads, selects the demo project, types the goal, opens a record, captures four shots
node scan-shots.js   # reads the text of each captured region and fails on any private marker
```

`scan-shots.js` exists because a screenshot is not reviewable by reading it in a diff. It reads the
`innerText` of the same DOM regions that were captured and scans for the markers that must never be
published: a drive-letter path, the maintainer's username, a conversation URL, the private project and
workspace identifiers, a credential filename, and anything shaped like a real API key.

**Current result: 4 regions, 0 with private markers.** The PNGs were also checked for embedded `tEXt`,
`iTXt` and `zTXt` chunks: none, so no metadata carries a path either.

## Disclosures

Two things about these images that a reader deserves to know, because neither is visible by looking:

1. **Shot 2 shows seat state, not a live in-flight turn.** A genuinely in-flight browser turn needs a
   logged-in ChatGPT session, which the capturing machine does not have pointed at this checkout. Rather
   than stage a fake progress bar, the shot shows what is real: each seat's provider, transport, delivery
   state, round budget and write scope. The in-flight behaviour is documented in
   [`AUTONOMOUS_LOOP.md`](AUTONOMOUS_LOOP.md) instead of being faked in a picture.

2. **The Timeline panel is hidden in shots 1 and 4.** That panel renders this machine's event log, and the
   log includes the absolute path a project was registered from, which on the capturing machine contains a
   username. It is pinned to the bottom of the viewport, so it cannot be cropped out; it was hidden for the
   capture. No product content was removed, and nothing else was altered. Closing that hole properly means
   sanitising event payloads in the UI, which is a product change rather than a packaging one and is listed
   as follow-up work rather than quietly patched for a screenshot.

3. **The record in shot 3 came from a replay-mode run.** The autonomous loop can run with a saved worker
   result instead of a live dispatch, which is what makes it testable without spending a subscription turn.
   That run's Evidence Record says so in its own notes: `worker_mode=REPLAY (a saved worker result was
   replayed; no live worker turn occurred)`. The record is real, the review is real, and the receipt states
   which mode produced it - which is the point of having receipts.

## Sanitising rules

Before any image is committed:

- [ ] run `node scan-shots.js` and get zero regions with private markers
- [ ] no real filesystem path
- [ ] no username, account name, avatar or email
- [ ] no conversation URL
- [ ] no token, key or credential fragment, including in a terminal behind the window
- [ ] no private project or workspace identifier
- [ ] no notification popup, and no other tab visible in a tab strip
- [ ] run the repository scan once more after adding images: `npm run scan`
