# LICENSE OPTIONS - a report, not a decision

> **DECISION TAKEN: Apache-2.0.** It was chosen because this project drives commercial model providers and
> will attract contributors from companies, where "is there a patent grant?" is a standard question that
> MIT leaves unanswered. The full text is in [`../LICENSE`](../LICENSE), `package.json` declares
> `"license": "Apache-2.0"`, and the README states it. No copyright holder line has been filled in: that is
> a claim only the maintainer can make.
>
> This document is kept as the reasoning behind the choice rather than as an open question.

**No licence has been chosen.** This document lays out the choice and its consequences. Until a decision is
recorded and a `LICENSE` file is added, the repository is all-rights-reserved by default, which means nobody
may legally reuse it - the opposite of the intent of publishing it. Choosing is therefore a release blocker,
not a nicety.

- [What is actually in this repository](#what-is-actually-in-this-repository)
- [Third-party content review](#third-party-content-review)
- [MIT](#mit)
- [Apache-2.0](#apache-20)
- [Comparison](#comparison)
- [Recommendation](#recommendation)
- [What still needs a decision](#what-still-needs-a-decision)

## What is actually in this repository

| Component | Origin | Licence question |
|---|---|---|
| `workbench/` - protocol, seats, transports, server, UI | original work | none |
| `runtime/harness/` - project registry, task registry, workspaces, router, YAML parser | original work | none |
| `worker/adapter/` - ChatGPT browser worker | original work | none |
| `examples/demo-project/` | original work, written for this release | none |
| `tools/`, `scripts/` | original work | none |
| `public/favicon.svg` | original work | none |

**There are no third-party dependencies**, at runtime or in development. No vendored code, no copied
snippets of unclear provenance, and no lockfile, because `dependencies` and `devDependencies` are both
empty by design. This removes the most common licensing problem in a project like this before it starts.

## Third-party content review

The honest version, including what is NOT covered:

| Question | Finding |
|---|---|
| Copied third-party source? | **No.** All code in the tree was written for this project. |
| Bundled third-party assets? | **No.** No fonts, no images from elsewhere, no icon sets, no sample data. |
| GPL or copyleft code? | **No.** Nothing copyleft is present, so no copyleft obligation attaches. |
| Redistributable data files? | **No data files ship.** The evidence records, logs and browser profile are excluded. |
| Does the code drive someone else's service? | **Yes, and this matters.** See below. |
| OpenAI / Playwright / other SDK licensing? | **No SDK is bundled.** The browser transport drives Chrome through the DevTools protocol and a small automation layer; it does not vendor a client library. |

### The part a licence does not cover

Driving ChatGPT through a browser session, and Codex through its app-server protocol, means the software
interacts with services governed by **their own terms of service**, not by this repository's licence. A
permissive licence on this code grants rights to *this code*; it grants nothing with respect to those
services. Whatever licence is chosen, the README should continue to state plainly that:

- you use **your own** accounts and your own sessions;
- automating a web UI may be restricted by the provider's terms, and that is the user's call to make;
- the project does not bypass authentication, CAPTCHAs or two-factor challenges, and it must not be changed
  to do so (this is stated in `SECURITY.md` and enforced by the design).

If a maintainer wants to be explicit about that boundary, a short "Acceptable use" section in the README is
the right place, and it is more honest than trying to encode it in a licence.

## MIT

Short, permissive, universally understood.

**Advantages**

- The default choice for a developer tool. A reader does not have to think about it.
- Maximum adoption: usable in closed-source products, in internal corporate tools, and by people who will
  never read a licence.
- Compatible with essentially everything, including being vendored into other permissively licensed work.
- One paragraph. Nobody has ever needed a lawyer to read it.

**Disadvantages**

- **No patent grant.** A contributor who holds a patent covering their contribution has not licensed it to
  you. For a tool that is essentially orchestration and protocol glue, this is a small risk; for anything
  with novel algorithms it would matter more.
- **No trademark clause.** It does not stop someone from using the project's name in a confusing way.
- **No explicit statement about contributions or notices.** It is silent on more than Apache is.

## Apache-2.0

Permissive like MIT, plus explicit patent and attribution machinery.

**Advantages**

- **An explicit patent grant** from every contributor, and a patent-retaliation clause: if you sue over
  patents, you lose your licence. This is the main reason a company will prefer it.
- **Explicit trademark language** (it grants no trademark rights), which is useful if the project name
  matters.
- **Explicit contribution terms**: contributions are under the same licence unless stated otherwise.
- The standard choice for infrastructure projects inside companies, which can matter for adoption in a
  corporate environment where a legal review is triggered by the words "patent grant" being absent.

**Disadvantages**

- Considerably longer, and it requires shipping the licence text and a `NOTICE` file if one exists, plus
  stating changes to modified files.
- Some readers see "Apache" and assume a heavier compliance burden than they want for a small tool.
- Slightly more friction when vendoring the code into a project that is itself MIT.

## Comparison

| | MIT | Apache-2.0 |
|---|---|---|
| Permissive (closed-source use allowed) | yes | yes |
| Patent grant | no | **yes, explicit** |
| Patent retaliation | no | **yes** |
| Trademark clause | no | **yes (explicitly grants none)** |
| Attribution in binary distribution | no | yes (`NOTICE`) |
| Length / reading effort | one paragraph | several pages |
| Typical adoption friction | lowest | low, slightly higher in small projects |
| Common in | libraries, small tools, application frameworks | infrastructure, corporate-backed projects |

Both are compatible with each other and with the permissive licences you would expect in this space.

## Recommendation

**Apache-2.0, with MIT as a defensible second choice.**

The reasoning:

1. This project's value is in its **protocol and its orchestration design**, not in a novel algorithm. What
   it will attract is contributors from companies, and companies have a standard question about patent
   grants. Answering that question in advance removes a real adoption blocker at zero cost to the intended
   users, none of whom are restricted by either licence.
2. The project deliberately interacts with **commercial services** and drives a logged-in browser. Its
   public documentation will spend effort on what it will not automate. A licence with an explicit
   trademark clause and explicit contribution terms is a better fit for a project that has to be careful
   about how its name and its guarantees travel.
3. Choose **MIT** instead if the goal is maximum casual adoption with minimum ceremony - for example if the
   audience is individual developers rather than teams, and speed of adoption matters more than corporate
   legal comfort.

Either way, the licence decision should come with:

- a `LICENSE` file containing the full chosen text,
- a `NOTICE` file if Apache-2.0 is chosen and any notice is required,
- a line in `README.md` replacing the current "not yet chosen" paragraph,
- a `license` field in `package.json` (currently `SEE LICENSE IN docs/LICENSE_OPTIONS.md`),
- a sentence in `CONTRIBUTING.md` stating that contributions are accepted under the same licence.

## What still needs a decision

These are the maintainer's calls, and none of them should be made silently:

1. **Which licence** - MIT or Apache-2.0.
2. **Copyright holder line** - an individual's name, a project name, or an organisation. This is published
   text and is not a technical decision.
3. **Whether to add an Acceptable Use section** to the README covering the provider-terms boundary
   described above.
4. **Whether a CLA or DCO is wanted** for contributions. The recommendation is a DCO (`git commit -s`),
   which is lighter and sufficient for a project of this size.
