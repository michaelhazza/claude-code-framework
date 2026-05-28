# context/ — PROJECT_CONTEXT injection

This directory ships the framework-default `PROJECT_CONTEXT` content used by every reviewer in the
review cascade (spec §3a, §3b, §4, D6). The coordinator injects these defaults — or a per-app
override — into every reviewer call.

---

## What is PROJECT_CONTEXT?

`PROJECT_CONTEXT` is a prose block (not a JSON object) that adapts the framework-neutral reviewer
prompts to a specific app's stage and architecture. Every Claude and OpenAI reviewer reads it as
standing context before evaluating any artifact.

The coordinator builds `PROJECT_CONTEXT` by reading the sections below and injecting them as a
single prose block. The consuming repo may supply its own text for any section; the framework
defaults in `context/framing-defaults.md` are used for sections the consuming repo does not
override.

---

## Recommended sections (§3a injection schema)

Each section is a markdown heading the reviewer prompts reference by name. Provide each section as
prose under the heading — no structured JSON.

| Heading | Content | Required for? |
|---|---|---|
| `## Stage` | `pre-production`, `early-production`, or `production` | All review types (hard) |
| `## Framing assumptions` | The five-point block from `context/framing-defaults.md` by default; per-app overrides allowed | All review types (hard) |
| `## Principles` | Excerpt from the consuming repo's `CLAUDE.md` — the rules that govern review judgment | All review types (soft) |
| `## Architecture` | Excerpt from `architecture.md` — domain model, key primitives, tenant-key column name | Spec / plan / PR touching tenant data (hard — see §3b) |
| `## Guidelines` | Excerpt from the development-guidelines doc — RLS rules, idempotency posture, error format, test-gate policy | Spec / plan / PR touching tenant data (hard — see §3b) |
| `## Doc-sync rules` | Excerpt from `docs/doc-sync.md` or equivalent — which reference docs need updates when | Spec / plan (soft — reviewer continues with advisory findings) |
| `## Known operator decisions` | Append-only list of explicit operator decisions the reviewer must not re-litigate | All review types (soft — logged as `operator_decisions_section: empty` when absent) |

---

## §3b PROJECT_CONTEXT completeness rule (fail-closed)

`PROJECT_CONTEXT` is the only mechanism that adapts framework-neutral prompts to a specific app's
stage and architecture. A missing or incomplete `PROJECT_CONTEXT` silently gives the reviewer false
confidence — it would approve a spec it did not have the context to judge.

**Fail-closed rule:** the coordinator validates `PROJECT_CONTEXT` before invoking any reviewer. If
required sections are missing for the artifact's review type, the coordinator does NOT call the
reviewer; it surfaces `NEEDS_DISCUSSION` directly to the operator with the missing-section list.

| Review type | Required sections | Behaviour if missing |
|---|---|---|
| Any | `Stage` | Hard `NEEDS_DISCUSSION` — no reviewer invoked. The coordinator does not assume "pre-production" silently; the consuming repo must declare. |
| Any | `Framing assumptions` | Hard `NEEDS_DISCUSSION`. Use the framework default block (`context/framing-defaults.md`) if the consuming repo does not override. |
| Spec / plan / PR touching tenant data, RLS, idempotency, or workers | `Architecture` AND `Guidelines` | Hard `NEEDS_DISCUSSION`. The reviewer cannot judge tenant-isolation posture without the project's tenant-key naming and RLS conventions. |
| Spec / plan | `Doc-sync rules` | Soft — logged as a warning, reviewer continues. Doc-sync findings will be advisory. |
| Any | `Known operator decisions` | Soft — allowed empty, but explicitly logged as `operator_decisions_section: empty` so §16 measurement can detect if false positives correlate with missing operator-decision context. |

---

## Detection rule for "touching tenant data"

The coordinator runs a lightweight scan of the artifact for any of: the project's declared
tenant-key column name (from `PROJECT_CONTEXT.Architecture`), or the literal strings `RLS`,
`policy`, `tenant`, `org`, `subaccount`, `account_scoped`. If any match, the artifact counts as
touching tenant data and the `Architecture` + `Guidelines` hard requirement applies.

This complements D6 (framing assumptions injected) — D6 says the assumptions live in injected
context; §3b says the coordinator refuses to invoke a reviewer when the injected context is
incomplete.

---

## Soft warnings

### Doc-sync rules

If `## Doc-sync rules` is absent from `PROJECT_CONTEXT`, the coordinator logs a warning and
continues. Doc-sync findings from the reviewer will be advisory (`triage_hint: user-facing`), not
blocking. Provide the section to let the reviewer make normative doc-sync calls.

### Known operator decisions

If `## Known operator decisions` is absent or empty, the coordinator logs
`operator_decisions_section: empty` and continues. Reviewers may then flag decisions the operator
has already accepted — producing false positives. Populate this section with an append-only list of
explicit operator decisions to suppress re-litigation noise.

---

## Canonical paths

During Phase 2 (host repo, before Chunk 13 mirror):
- `context/framing-defaults.md` — framework default framing block
- `context/README.md` — this file

Post-Chunk-13 (framework consumers via submodule):
- `.claude-framework/context/framing-defaults.md`
- `.claude-framework/context/README.md`

Non-submodule consumers: deferred per spec §14 Q5. Not yet designed; document the need in your
consuming repo's issue tracker if you require a non-submodule path.
