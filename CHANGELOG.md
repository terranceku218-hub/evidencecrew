# Changelog

Notable changes to EvidenceCrew. This project uses [Semantic Versioning](https://semver.org/); before `1.0.0`
the minor version may carry breaking changes, and Early Access means the interfaces may still move.

## v0.1.0 — Early Access

First public release. Everything below ships and is exercised by the test suite in this repository
(`npm test` needs no API key, no browser and no network).

**Added**

- **Agent Seats** — a role with a provider, a transport, a conversation, permissions and a health state, so
  provider and transport are independent choices rather than the same decision twice.
- **Verified Task Protocol** — every dispatch carries a `run_id` and a source hash; a reply that does not
  echo them is quarantined rather than guessed at, and a send that may or may not have landed stops in the
  terminal `SEND_UNCERTAIN` state instead of being retried.
- **DeepSeek Supervisor** — decomposes a goal into tasks with explicit acceptance criteria, reviews results,
  and answers `PASS` or `RETRY`.
- **ChatGPT Worker** — does the work through a real, logged-in browser session, for people whose subscription
  does not come with an API key.
- **Optional Codex Reviewer** — an independent second opinion, `OFF` by default; no goal is ever blocked by
  its absence, and a disabled reviewer is recorded as a policy choice rather than as missing evidence.
- **Guided Goals** — nine templates, each of which sets the policy for that kind of work and offers an
  editable starting goal.
- **Beginner Mode** — one screen, four plain-language choices and a preview of what the run will do, with the
  technical surface one switch away rather than in the way.
- **Execution Intensity** — Quick / Balanced / Strict, controlling how many agent calls, retries, reviews and
  subagents a run may spend, and how much validation it may run. It can only tighten a budget, never raise one.
- **Evidence Cards** — a receipt per task: what correlated, what changed, what was validated, and what was
  never recorded at all. `NOT RECORDED` is never rendered as a pass.
- **Compact Context** — long-term state is assembled from the goal, task, decision and evidence records rather
  than by re-sending a conversation transcript, so cost does not grow with history.
- **Four interface languages** — 简体中文 (default), 繁體中文, English, 日本語.

**Known limitations**

See the [Known limitations](README.md#known-limitations) section of the README for the full, current list.
The short version: Windows-first, the browser worker is slow and depends on a login you perform yourself and
on a web page that can change, Codex is optional, the OpenAI-compatible transport is experimental, there is
no runtime verification of your code, intensity controls a call budget rather than a measured token count, and
two live-page probes in the browser worker's own verification script do not currently pass.

**Security**

No credentials are stored, logged or transmitted beyond the provider they belong to, and no browser profile of
yours is ever read. See [SECURITY.md](SECURITY.md) before reporting anything, and report privately.

**Licence**

[Apache-2.0](LICENSE).
