# RELEASE CHECKLIST

Run this before tagging. Every line is a check somebody can perform, not an intention.

- [Secrets and private data](#secrets-and-private-data)
- [Clean install](#clean-install)
- [Quickstart](#quickstart)
- [Demo](#demo)
- [Screenshots](#screenshots)
- [Documentation currency](#documentation-currency)
- [Tests](#tests)
- [Packaging integrity](#packaging-integrity)
- [Repository and release](#repository-and-release)
- [Known blockers](#known-blockers)

## Secrets and private data

- [ ] `npm run scan` reports **0 CRITICAL and 0 HIGH** findings
- [ ] `PUBLIC_EXCLUDE.md` matches reality: every excluded category is still excluded
- [ ] no `.credentials.yaml`, `auth.json`, `profile/`, `temp/`, `logs/`, `state/`, `evidence/` in the tree
- [ ] no real conversation URL anywhere (`grep` for `chatgpt.com/c/` and confirm every hit is the synthetic
      all-zeros placeholder or an obviously fake fixture)
- [ ] no personal absolute path anywhere (`grep` for the drive-letter user pattern)
- [ ] `tools/RELEASE_MANIFEST.json` was regenerated for this exact tree
- [ ] git history contains no secret either - check the log, not just the working tree. A secret that was
      committed and deleted is still in the object database and in every fork

## Clean install

- [ ] clone into a **new, empty directory**, not over an existing checkout
- [ ] `npm install` completes with nothing to install
- [ ] `npm run setup` reports no FAIL items on a machine with the required pieces present
- [ ] the setup check reports a missing credential as MISSING with a fix, not as a crash
- [ ] starting with `PORT=<free port> npm start` works, so a port clash is not a blocker
- [ ] the server binds **127.0.0.1 only** - verify the listening address, not just that it responds

## Quickstart

- [ ] `docs/QUICKSTART.md` steps were executed in order, on a clean clone, and each one worked
- [ ] the measured setup effort is stated honestly in the README table
- [ ] the troubleshooting table covers what actually went wrong during the rehearsal
- [ ] the documented environment variables all exist in the code (no invented variable names)

## Demo

- [ ] the demo goal completes and produces an Evidence Record
- [ ] `examples/demo-project`: the shipped test suite **fails** (`6 passed, 2 failed`) and the fixed
      reference **passes** (`8 passed, 0 failed`)
- [ ] the demo needs no Codex: `codex_review_mode = OFF` throughout
- [ ] `docs/DEMO.md` storyboard was followed, including the RETRY beat
- [ ] the recording shows no personal path, token, conversation URL or account name

## Screenshots

- [ ] Goal plus Team
- [ ] a Task in progress, including the honest `SEND_PENDING` state
- [ ] an Evidence Card
- [ ] the Codex toggle showing OFF, and ON if a second clip exists
- [ ] every screenshot sanitised: no real paths, no conversation URLs, no usernames, no tokens
- [ ] the primary image is **not** a chat transcript

## Documentation currency

- [ ] `README.md` claims match the code. Re-read the support table against the transports that exist
- [ ] any provider not verified end to end is still marked EXPERIMENTAL / DECLARED
- [ ] `docs/VERIFIED_TASK_PROTOCOL.md` field names match the envelope builder
- [ ] `docs/AGENT_SEAT.md` capability names match the declared transports
- [ ] `docs/EVIDENCE.md` marks match the card's symbol table
- [ ] `docs/AUTONOMOUS_LOOP.md` limits match the policy defaults
- [ ] `SECURITY.md` and `CONTRIBUTING.md` still describe the code as it is
- [ ] no document promises a fixed latency for the browser transport

## Tests

- [ ] `npm test` passes on a clean clone: no key, no browser, no network
- [ ] the maintainer tier runner passes: DAILY, then the affected suites, and **CORE_CHANGE once**
- [ ] the **RELEASE tier is run exactly once** for the tagged commit, and its result is recorded
- [ ] the frozen harness still reports no drift against its baseline
- [ ] the protected worker adapter still reports no drift against its recorded baseline

## Packaging integrity

- [ ] `node verify-tree.js <tree>` reports: syntax ok, every module loads, **and no module loaded from
      outside the tree**
- [ ] the tree starts and answers on an ephemeral port
- [ ] no stray file in the repository root (no scratch scripts, no logs, no editor droppings)
- [ ] the packager was run with COPY semantics and the private instance still works afterwards
- [ ] generated files are present and portable: `workbench/config.json`, `workbench/config.js`,
      `runtime/harness/config.json`, `worker/adapter/config.json`

## Repository and release

- [ ] repository name confirmed by the maintainer
- [ ] visibility confirmed (public or private first) by the maintainer
- [ ] licence chosen and recorded, with the `LICENSE` file added and `package.json` updated
- [ ] copyright holder line written
- [ ] version in `package.json` matches the tag
- [ ] tag created and pushed **after** the checklist passes, not before
- [ ] first release notes state what is verified and, explicitly, what is not
- [ ] `PUBLIC_EXCLUDE.md`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/RELEASE_CHECKLIST.md` present
- [ ] `NOTICE`, `CHANGELOG.md` present
- [ ] first branch is `main`, with no additional branch model at v0.1.0

## GitHub settings to enable after the repository exists

None of these can be configured before the repository is created, and none of them should be **claimed** as
done until someone has actually opened the settings page and confirmed it. Both of the ones marked below
change what this repository's own documentation promises, so enable them before announcing the release:

- [ ] **Private vulnerability reporting** — **required, not optional.** `SECURITY.md` tells reporters to use
      GitHub's *Security -> Report a vulnerability* channel. Until this is switched on, that instruction is
      not a working route, and the document's documented fallback (a content-free public issue asking for a
      private channel) is what a reporter is left with. Enable it, then open the Security tab yourself and
      confirm the button appears.
- [ ] **Secret scanning** and **push protection** — the second is what actually stops a credential reaching
      the repository rather than reporting it afterwards.
- [ ] **Dependabot alerts** and **Dependabot security updates** — this project has no dependencies, so
      nothing is expected here. That is the reason to enable them anyway: silence then means "nothing to
      report" rather than "nobody is watching".
- [ ] **Code scanning** — optional. There is no build step and no third-party linter, so the default CodeQL
      setup has little to work on; decide deliberately rather than by default.
- [ ] branch protection on `main` — consider only once there is more than one contributor.

## Post-push acceptance, which cannot be done before the push

These are the only checks that prove the published artifact works, and they are deliberately left unticked
here because they are **NOT RUN** until the repository exists:

- [ ] `git clone` the repository into a fresh empty directory and run `npm install`, `npm run setup`,
      `npm test`, `npm start` there. Confirm HTTP 200, the EvidenceCrew title, the Chinese interface by
      default, the nine goal templates, the execution-intensity control, Codex `OFF` and Beginner mode.
- [ ] Download the **Source code (zip)** from the release page, extract to a fresh directory, and run the same
      four commands. This is the check that proves the tree does not depend on `.git`.
- [ ] Re-run `node tools/run-tests.js` inside the clone and confirm the same pass counts as the staging tree.
- [ ] Confirm `tools/TREE_MANIFEST.json` in the clone matches: `node tools/check-tree-manifest.js`.
- [ ] Stop the server and remove the clone, or keep it as a release artifact.

If either fresh-clone or ZIP acceptance fails, **do not create the release**.

## Known blockers

These are the open items on the release candidate as it stands. They are listed here so that publishing
with them still open is a decision rather than an oversight.

- [x] **Licence chosen.** Apache-2.0. `LICENSE` is present, `package.json` declares it, and the README states
      it. The appendix boilerplate is unchanged: no copyright holder line has been filled in, because that
      is a claim only the maintainer can make.
- [x] **Screenshots taken.** The four in `docs/screenshots/`, verified clean by `scan-shots.js` and
      disclosed in `docs/SCREENSHOTS.md`.
- [x] **Pre-existing worker-runner defect fixed in the private instance too**, so the two implementations no
      longer diverge on that bug.
- [ ] **Demo GIF not recorded.** `docs/DEMO.md` has the storyboard and `npm run demo` walks the beats
      locally; the recording is still to be made.
- [ ] **The OpenAI-compatible provider is EXPERIMENTAL.** It is conformance-tested against a loopback stub
      and has not been verified against a live third-party endpoint. The README says so.
- [ ] **Repository metadata not yet set:** the GitHub slug (`evidencecrew`), visibility (public) and the
      first release are decisions the maintainer has made but not yet applied. `package.json` deliberately
      carries no `repository` field rather than a guessed URL.
- [ ] **The browser worker is Windows-first**, as the support table states. macOS and Linux get the
      supervisor, reviewer and human seats only.
- [ ] **Event payload sanitisation is follow-up work.** The UI Timeline renders the absolute path a project
      was registered from, which is why it is hidden in two of the screenshots. Closing that properly is a
      product change, not a packaging one.
