# PUBLIC EXCLUDE - what must never enter this repository

This file is the audit record for the public release. It lists what was found in the private working
instance, what was excluded, and how the exclusion is enforced. It is a document about the boundary, so it
names categories and locations - never a credential value. Nothing here contains a secret, and nothing here
should be edited to contain one.

The scan that produced it is in this repository and you can run it yourself:

```
npm run scan          # or: node scripts/public-safety-scan.js .
```

It reports the location and class of anything that looks like a secret and **deliberately never prints the
matched value**. A scanner that prints the secret it found has copied the secret somewhere new: your
terminal scrollback, your CI log, your screenshot.

---

## 1. How this release was built

The private instance is a live working environment with real credentials, a real browser session and a real
private project in it. It was **not** turned into a repository. Instead:

```
private instance  --(copy, never move)-->  staging tree  -->  publish
```

The copy is performed by a packaging script that lives OUTSIDE the published tree, asserts its destination,
denies by default, and writes `tools/RELEASE_MANIFEST.json` recording every shipped file with its origin and
every rewrite applied to it. Nothing in the private instance is written to.

---

## 2. Findings and disposition

> A note on the paths below: they name directories in the maintainer private working instance, which
> keeps its original names. The published product is called EvidenceCrew, and its repository is
> evidencecrew; the private tree was never renamed, so an audit that renamed these paths would not
> describe the machine it is auditing.


Severity is about consequence if published, not about how interesting the value is.

| # | Location | Type | Risk | Disposition |
|---|---|---|---|---|
| 1 | `chatgpt-worker/profile/` (1201 files) | Chrome profile: cookies, login data, session state | CRITICAL - a copied browser profile is an authenticated session | **must-exclude**, whole directory, never copied |
| 2 | `chatgpt-worker/.playwright-cli/` (74 files) | Browser automation session cache | HIGH - session artefacts and page state | **must-exclude** |
| 3 | `agent-workbench/temp/codex-home/` | A copied Codex home directory | CRITICAL - may contain `auth.json` and OAuth tokens | **must-exclude**, never content-scanned, never copied |
| 4 | `agent-workspaces/codex-lab/home/auth.json` | OAuth token store | CRITICAL - account access | **must-exclude** |
| 5 | `~/.dsh/.credentials.yaml` | `DEEPSEEK_API_KEY` | CRITICAL | **must-exclude**; the setup check reports presence only, never the value |
| 6 | `agent-workbench/temp/SEND-*.log`, `*.out.json` | Packet transcripts with private conversation URLs | HIGH - links to private conversations plus prompt content | **must-exclude**, whole `temp/` |
| 7 | `agent-harness/logs/`, `agent-harness/registry/workers.json` | Packet transcripts, reply archives, conversation URLs, worker ledger | HIGH | **must-exclude** |
| 8 | `agent-workbench/evidence/` (92 records) | Real run output: absolute project paths, prompts, model replies, diffs | HIGH | **must-exclude**; `.gitignore` covers `evidence/` |
| 9 | `agent-workspaces/game/` (+ the private project) | Private project content and git history | HIGH | **must-exclude**; replaced in the release by `examples/demo-project` |
| 10 | `agent-harness/acceptance.js`, `v2e2e.js`, `hotfix-201.test.js` | Real conversation URLs in test fixtures | MEDIUM - a private conversation link | **rewritten** to a synthetic id (`.../c/00000000-0000-0000-0000-000000000000`) |
| 11 | ~90 source and doc files | Absolute personal paths (`C:\Users\<user>\...`) | MEDIUM - leaks a username and machine layout, and breaks on any other machine | **rewritten** to expressions derived from the file location, or to `%USERPROFILE%` / `<repo>` in prose |
| 12 | `agent-workbench/{seats,server,scripts}/**` | Private project and workspace identifiers, private source filenames | MEDIUM - confusing and a small privacy leak | **rewritten** to neutral identifiers |
| 13 | `agent-workbench/{instance state}`, `logs/`, `state/`, `*.jsonl` | This machine's operational state | MEDIUM | **must-exclude**; created on first run, git-ignored |
| 14 | `chatgpt-worker/logs/phase2-login-required.png` | Screenshot of a login wall | MEDIUM | **must-exclude** |

**Result of the scan over the published tree: 0 CRITICAL, 0 HIGH, 0 MEDIUM.**
Two LOW findings remain and are intentional: a `user@example.com` string in a YAML test fixture, and
`public/favicon.svg` (a non-text asset).

---

## 3. The rules this repository enforces

These are the rules a contributor must not break. They are stated here, in `.gitignore`, in `SECURITY.md`
and in the safety scanner, because a rule that exists in only one place is a rule that will be broken in the
other two.

1. **No credential is ever committed.** Not in a file, not in a comment, not in a test fixture, not in a
   screenshot, not in a commit message.
2. **No browser profile, cookie database or session token is ever committed.** The ChatGPT login is the
   user's, and the profile directory is created empty on first run.
3. **No private project content is ever committed.** If you want to demonstrate work on a real codebase,
   describe it and keep the code out.
4. **No real conversation URL is ever committed.** It is a capability: anyone with the link and access to
   that account can read the conversation.
5. **No personal absolute path is ever committed.** Use a path derived from the file location, an
   environment variable, or a documented placeholder.
6. **Evidence Records are output, not source.** They are generated by running the tool against your own
   projects, and they contain your paths and prompts. They are git-ignored on purpose.

## 4. If you are contributing from your own working instance

You will have all of the above on your machine. Before you open a pull request:

```
npm run scan
```

If it reports a CRITICAL or HIGH finding, do not "fix" it by deleting the line and committing anyway -
check whether the whole file should be in the repository at all. Most of the time it should not.

## 5. Pre-publication checklist

- [ ] `npm run scan` reports no CRITICAL or HIGH findings
- [ ] `git status` shows no unexpected new files
- [ ] no `.credentials.yaml`, `auth.json`, `profile/`, `temp/`, `logs/`, `evidence/` in the tree
- [ ] screenshots are sanitised: no tokens, no real paths, no real conversation URLs, no usernames
- [ ] `tools/RELEASE_MANIFEST.json` matches the tree you are about to publish
- [ ] the private instance still works and was not modified (the packager copies; it never moves)
