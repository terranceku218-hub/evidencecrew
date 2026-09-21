# Security Policy

EvidenceCrew 0.3.1 (release candidate)

This document describes the security model of EvidenceCrew and how to report a
vulnerability. It is written for users, operators and contributors. It states the
guarantees the project intends to hold; it is not a claim that the software is free
of defects.

## Table of Contents

- [Reporting a Vulnerability](#reporting-a-vulnerability)
- [Responsible Disclosure](#responsible-disclosure)
- [Scope](#scope)
- [Security Model](#security-model)
- [Credentials Stay Local](#credentials-stay-local)
- [Browser Session Risk](#browser-session-risk)
- [Localhost Binding](#localhost-binding)
- [Credential Logging](#credential-logging)
- [Project Write Permissions](#project-write-permissions)
- [Codex Is Optional](#codex-is-optional)
- [Approvals and Stop Conditions](#approvals-and-stop-conditions)
- [Evidence and Honest Reporting](#evidence-and-honest-reporting)
- [Supported Versions](#supported-versions)
- [Hardening Checklist](#hardening-checklist)

## Reporting a Vulnerability

Report vulnerabilities privately rather than in a public issue. A public issue
discloses the problem before a fix exists and puts every user at risk.

**Use the repository's private reporting channel:** GitHub's **Security** tab ->
**Report a vulnerability**, which opens a private security advisory visible only to
the maintainer. This is the intended route and it is the one to try first.

**If that channel is not available to you** - private vulnerability reporting has to
be switched on in the repository settings, and it may not be enabled yet - then open a
public issue that says only that you have a security report and would like a private
channel. Do not describe the vulnerability, and do not include reproduction steps,
credentials or logs in that issue. A maintainer will open a private channel and reply
there.

There is deliberately no email address printed here. A contact address in a document
goes stale the moment a maintainer changes, and an address that bounces is worse than
no address at all, because the reporter believes they have disclosed something.

A useful report includes:

- Reproduction steps, in enough detail that a maintainer can repeat them.
- The affected version, exactly as the workbench header shows it (for example `0.1.0`).
- What an attacker gains, and what preconditions they need.
- Whether the issue is reachable in a default, local-only configuration.

Do not include real credentials, tokens, cookies, session data or personal data in a
report. Use placeholder values.

## Responsible Disclosure

The project follows a simple responsible disclosure process:

1. Report privately. Do not open a public issue, and do not publish details before a
   fix or a documented decision exists.
2. Include reproduction steps and the affected version, as described above.
3. Expect an acknowledgement of the report.
4. Expect either a fix or a documented decision explaining why the reported behaviour
   will not be changed. A documented decision is a real outcome: some behaviours are
   deliberate properties of the design, and the reply will say so.
5. Keep the report free of real credentials and personal data.
6. Coordinate the public write-up with the maintainer so that users have a fix
   available before the details are public.

## Scope

In scope:

- The shipped source code and the local server it starts.
- The credential handling paths.
- The transport layer and its delivery state machine.
- The Evidence Record and any other recorded artifact that could leak data or
  misreport what happened.
- The local web UI and the local API.

Out of scope:

- The third-party services the workbench talks to. Report those to the respective
  provider.
- The user's own browser, browser extensions, or browser profile.
- A machine that is already compromised, where an attacker can read local files
  directly. Local credentials sit on disk, as they must for a local tool.
- Deliberate misconfiguration that exposes the local server to a network, which is
  described below as a vulnerability rather than a supported configuration.

## Security Model

EvidenceCrew is a local control plane for verifiable multi-agent work. It runs on
the user's own machine as a single Node.js process serving a local web UI, and all
state is JSON on disk.

The trust boundary follows from that shape:

- The machine and its user account are trusted.
- The network is not trusted, and the workbench does not depend on it except for the
  provider calls the user configured.
- Two provider-backed agents take part in a run: a supervisor agent (DeepSeek, over
  its HTTP API) that decomposes a submitted Goal into a Task with explicit success
  criteria, and a worker agent (ChatGPT, driven through a real logged-in browser
  session) that performs the work and reports back. The supervisor reviews the result
  and answers PASS, RETRY or BLOCKED.
- Every run produces an Evidence Record that states what actually happened.

Security work in this project is therefore mostly about three things: keeping
credentials local, never fabricating a confirmation that did not happen, and never
touching anything outside the scope the user approved.

## Credentials Stay Local

- The DeepSeek key is read from a local credentials file. That file is never
  committed and never logged.
- The workbench never stores ChatGPT credentials, cookies or session tokens. The
  browser session belongs to the user and lives in the browser profile.

There is no workbench-side session store to steal, because there is no workbench-side
session store. If you believe you have found a path that persists a provider
credential, cookie or session token into the repository, a log, an Evidence Record or
a packet, that is a security issue and should be reported privately.

## Browser Session Risk

The worker drives a real, already-logged-in browser session through DOM automation.
That design choice has consequences the user should understand:

- The user must log in themselves.
- The user must complete any CAPTCHA or two-factor challenge themselves.
- The software never automates or bypasses a login, a CAPTCHA or a 2FA prompt.
- The software never copies or reads the user's everyday browser profile.

The user's authentication state stays in the user's browser, under the user's
control. A challenge that appears is a signal to the human, not an obstacle for the
automation to defeat; there is no code path in this project that attempts to defeat
one.

## Localhost Binding

- The web UI and API bind to 127.0.0.1 only.
- It is a single-user local tool and must never be exposed to a network or the
  internet.
- There is no authentication because there is no remote access. Binding to a public
  interface would be a vulnerability, not a configuration choice.

Do not put the local server behind a reverse proxy, do not bind it to a public
interface, and do not port-forward it. A change that makes remote access possible is
treated as a security defect, not as a feature request.

## Credential Logging

- No code path may write a token, cookie or credential value into a log, a
  transcript, an Evidence Record or a packet.
- The repository ships a safety scanner that reports the LOCATION and CLASS of
  anything that looks like a secret and deliberately never prints the matched value,
  because printing it copies the secret somewhere new.

That last point is a design rule, not a limitation to work around. Do not "improve"
the scanner by adding the matched value to its output, and do not paste a suspected
secret into an issue, a pull request, a commit message or a chat transcript. Report
the location and the class only.

## Project Write Permissions

- Every dispatched task carries an explicit write scope and a deny list.
- A task with an empty write scope cannot modify the project even if the worker tries.

Write scope is enforced at dispatch, not requested politely from the agent. If you
find a path where a worker can write outside its declared scope, or where the deny
list is not consulted, treat it as a security issue.

## Codex Is Optional

- Codex is an independent reviewer that is OFF by default, and the system runs fully
  without it.
- When it is off, results are reviewed by the supervisor and recorded as such.

No security guarantee of this project depends on Codex being enabled. A run without it
is a normal, supported run with a different, and honestly recorded, review path.

## Approvals and Stop Conditions

The system has deliberate stop conditions, including needing a human decision before
a write that falls outside the approved scope. It is designed to stop rather than to
guess.

The same principle governs message delivery. There is no blind retry anywhere. The
delivery state machine is IDLE -> SUBMITTING -> SEND_PENDING -> USER_TURN_CONFIRMED ->
ASSISTANT_PENDING -> COMPLETE, and SEND_UNCERTAIN is a terminal state with no outgoing
transitions. A message that may or may not have been sent stops the automation and
requires a human decision; it is never re-sent automatically. One message is in flight
per seat.

If a report describes a path that silently retries a send, that resolves an uncertain
delivery by guessing, or that continues past a stop condition, the report is valid and
welcome even if the outcome looks benign in a specific run.

## Evidence and Honest Reporting

Security reporting and evidence reporting share one rule: state what was actually
observed.

- The JSON record is the source of truth. The Markdown view and the UI card are
  generated views.
- A field that was never recorded renders as NOT RECORDED (a dash), never as a pass.
- An independent reviewer that is switched off is recorded as DISABLED_BY_POLICY (not
  applicable), which is explicitly not the same as missing evidence.
- The system distinguishes STATIC verification from RUNTIME verification and never
  claims runtime verification it did not perform.

A security report that is honest about what was and was not demonstrated is far more
useful than a confident one. If you are unsure whether something is exploitable, say
so and describe what you observed.

## Supported Versions

Security fixes are applied to the current release line. Version 0.3.1 is a release
candidate, so its behaviour may still change before a stable release.

When reporting, always state the affected version, because a defect fixed in a later
version is not the same report as a defect that is still present.

## Hardening Checklist

For users running the workbench locally:

- Keep the local credentials file out of version control, and confirm it is not
  committed.
- Log in to the worker's browser session yourself, and complete any CAPTCHA or 2FA
  challenge yourself.
- Keep the local server bound to 127.0.0.1. Do not expose it to a network.
- Give each task the narrowest write scope that lets it succeed, and set the deny list.
- Leave the independent reviewer off unless you have a reason to enable it. The system
  runs fully without it, and the review path is recorded either way.
- Read the Evidence Record, including the NOT RECORDED and DISABLED_BY_POLICY fields,
  before treating a run as verified.
- Treat an uncertainty stop as a prompt for a human decision, not as an error to
  silence.
