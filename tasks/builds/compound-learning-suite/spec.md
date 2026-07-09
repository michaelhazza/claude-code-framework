---
status: ACCEPTED
status_note: Approved for plan by external spec review — 3 rounds (10 + 5 + 4 findings, all accepted & patched). Internal review tiers (claude-spec-review / spec-reviewer / chatgpt-spec-review) deferred to the Opus session per operator model-switch directive.
date: 2026-07-09
accepted: 2026-07-09
author: Claude Fable 5 (spec-coordinator, inline)
scope_class: Major
source_branch: feat/v2.33.0-compound-learning
target_release: v2.33.0
slug: compound-learning-suite
spec_version: v0.4
---

# Spec — Compound Learning Suite (v2.33.0)

Three additive framework capabilities that make lessons and quality compound faster in consuming repos: (A) a session-start memory digest hook, (B) a local skill overlay convention, (C) a golden-set prompt eval runner. One release, one PR to `claude-code-framework`.

> **fable-mode preamble.**
> **Goal:** ship A+B+C to the framework such that a consuming repo, after `/claudeupdate`, gets (A) a fail-open SessionStart hook injecting a ≤150-line memory digest, (B) an adopt-only `.claude/context/skill-context.md` overlay + greppable skill pointers + a defined KNOWLEDGE→overlay→canonical-skill drain wired into `/cleanfiles` + two framework-doctor checks, and (C) a `/eval-prompts` command + `scripts/eval-prompts*.ts` runner + pinned cases format + one framework-doctor validity check — all with version bump, CHANGELOG, migration, and consumer migration notes.
> **Non-goals:** seeding any consumer's real data; wiring automation-v1 parallel-mode Step 7 / review-mining cases; changing canonical-skill authoring or the `mode: sync` skill contract; a scheduler for the hook or the drain; any UI.
> **Unknowns:** none load-bearing remain — the three architecture forks were resolved by operator decision (see intent.md § Grill-me Q&A); provider seam, overlay deploy mode, and drain heaviness are fixed.
> **Kill criteria:** (1) a session-start memory hook already exists — checked, none does (grounding: `.claude/hooks/` has only framework-merge-reminder + code-graph-freshness-check on SessionStart). (2) a skill overlay / `skill-context.md` convention already exists — checked, none does. (3) an eval harness already exists — checked, `cases.jsonl`/`catch rate`/`golden` match nothing but this build's own files. All three false ⇒ build proceeds.
> **Effort:** deep (Major, ships to many repos; ~10 sources read this session across hooks/skills/sync/manifest/migrations/release).

## Lifecycle Declaration

| Field | Value |
|---|---|
| Capability cluster | Framework: Hooks, Skills + context-overlay, Review pipeline / Commands (framework has no live Asset Register — only `docs/capabilities-template.md`) |
| Capability owner | TBD — framework maintainer (michaelhazza) |
| Lifecycle state on launch | Inception (new capabilities, no prior traffic) |
| Risk surface (intent schema vocabulary) | None. (No value in the intent.md Risk Surface canonical vocabulary — server/db/schema, routes, auth, RLS, webhooks, billing, messaging, agent runtime, approvals — applies; the framework repo has no such surfaces.) |
| Operational risk surface (this release) | See `## Operational risk surface` below — prompt-context injection, local repo-knowledge exposure, hook latency/noise, skill sync drift, eval-provider egress + key handling. |
| Review cadence | on-incident-only + folded into the quarterly `/cleanfiles` sweep |

## ABCd Lifecycle Estimate

| Dimension | Sizing | Notes |
|---|---|---|
| Acquire | M | Three subsystems, but each follows an existing framework pattern (hook, adopt-only template, review-script + command). Cost driver: the greenfield drain protocol (B) and eval scoring semantics (C). |
| Build | M | ~5 new source files + tests + 6 doc/registration touch-points. Cost driver: test coverage across sync/hook/migration harnesses. |
| Carry | S | Additive, fail-open, no runtime service. Cost driver: keeping doctor checks + drain protocol current as skills evolve. |
| decommission | S | Removal = drop the hook + overlay template + eval scripts from manifest (warn-only removedFiles), delete two doctor checks. No data migration; consumer files are operator-owned. |

## Operational risk surface

The intent schema's Risk Surface vocabulary (app-backend surfaces) finds nothing here, but this release does carry real operational risk. Each is named with its mitigation (external-review finding B1):

| Risk | Where | Mitigation |
|---|---|---|
| Prompt-context injection / noise | Feature A injects repo text into every session's context | Hard 150-line cap + per-source sub-budgets + oldest-first trim; the digest is bounded and advisory, never authoritative. |
| Local repo-knowledge exposure | Feature A surfaces KNOWLEDGE/lessons/current-focus content | Read-only, local-only, stdout to the operator's own session; no egress. Content is already in the operator's repo. Documented so operators who keep sensitive notes in KNOWLEDGE.md are aware it surfaces at session start. |
| Session-start latency | Feature A runs on every session in every consumer | Tail-only KNOWLEDGE read (≤32KB), elapsed-time gate between blocks (see Feature A budget), plus a real `timeout` backstop in settings.json. |
| Skill sync drift | Feature B edits 20 canonical SKILL.md files + adds a pointer contract | Executable pointer-coverage gate in `validate-framework.js` (CI-run) so a skill missing the pointer fails validation; framework-doctor advisory for consumer-side coverage. |
| Eval-provider egress + key handling | Feature C calls OpenAI with `OPENAI_API_KEY` | On-demand only (never at session start / CI unless the consumer opts in); reuses the existing `chatgpt-review*.ts` key-handling (guarded dotenv, lazy env read, never logged); provider failures throw, never silent-pass. |

## Framing assumptions

- **verified** — Hooks are ESM (`.claude/hooks/package.json` = `{"type":"module"}`), emit plain text to stdout (not JSON/additionalContext), always `process.exit(0)`, warnings to stderr, fail-open. SessionStart block at `.claude/settings.json:83-97`, no matcher, optional per-hook `timeout` (seconds).
- **verified** — Hook tests are hand-rolled Node scripts (no test framework) driven by `spawnSync(process.execPath, [HOOK], {env:{CLAUDE_PROJECT_DIR}})`; test files are NOT in the manifest.
- **verified** — KNOWLEDGE.md is append-only newest-LAST (read the tail); `tasks/lessons.md` is newest-FIRST under its `## Lessons` heading with a static format template at the file tail (read the head, skip the template). Heading formats differ per file.
- **verified** — `tasks/current-focus.md` in a real consumer is 132KB / 450 lines, dominated by a leading `<!-- mission-control ... -->` HTML comment block; the injectable content is the prose body after it.
- **verified** — `.claude/context/agent-context.md` is a `managedFiles` entry with `mode: "adopt-only"` (`manifest.json:196-201`); sync deploys it once then never clobbers (classifyFile → `skipped: adopt-only`). It is NOT in `doNotTouch`. Uniform read-instruction is the first agent body line (ADR-0006).
- **verified** — Skills are `mode: "sync"` (overwritten on update); 20 skills; frontmatter is exactly `name`+`description`; NO skill template file exists; no SKILL.md carries an addenda pointer today.
- **verified** — No `knowledge-to-framework-skills-map` flow exists; the string appears once as a hypothetical in `cleanfiles.md:30`. The drain is greenfield.
- **verified** — framework-doctor is a pure-markdown command (`.claude/commands/framework-doctor.md`), 5 numbered checks, `Zero writes`, closing `framework-doctor: N checks, M findings, 0 writes`.
- **verified** — sync.js never deletes files; files outside the manifest are never visited; `removedFiles` are warn-only; three write-defence layers (refuseIfDoNotTouch, assertWithinRoot) precede any write.
- **verified** — OpenAI calls go through `scripts/chatgpt-review-api.ts` (Responses API, AbortController timeout, 2-retry backoff); key loading pattern in `chatgpt-review.ts:74-87` — guarded `require('dotenv/config')`, then lazy `process.env.OPENAI_API_KEY` in `main()`; model via `CHATGPT_REVIEW_MODEL || DEFAULT_MODEL`. Scripts are `.ts` run via `tsx`; pure logic split into `*Pure.ts` with vitest tests in `scripts/__tests__/`.
- **verified** — Migration contract: `migrate(ctx{consumerRoot,frameworkRoot,fromVersion,toVersion})` → `{status:'applied'|'skipped'|'conflict', notes:string[]}`; helpers in `migrations/_helpers.js` (`adoptNewlyManagedFiles`, `readConsumerState`, `persistStateAtomic`); tests in `tests/migrations.test.ts`.
- **verified** — Release: `FRAMEWORK_VERSION` + `manifest.frameworkVersion` + a `## <version>` CHANGELOG heading move as one commit; CI asserts consistency. Commands are glob-covered (`.claude/commands/*.md`), so a new command needs no manifest entry.

---

# Feature A — Session-start memory digest hook

## Goal (verifiable)

A new SessionStart hook `memory-digest.js` emits a plain-text digest, ≤150 lines total, drawn from the tail of KNOWLEDGE.md, the head of `tasks/lessons.md`'s Lessons section, and the prose body of `tasks/current-focus.md`. Absent/unreadable files are skipped silently. The hook never exits non-zero, bounds its own work with an elapsed-time gate between blocks, and is backstopped by a real hook `timeout`. Test: `scripts/run-tests.js hooks` includes `memory-digest.test.js` and it passes.

## Behaviour

1. Resolve project dir from `process.env.CLAUDE_PROJECT_DIR || process.cwd()` (same as sibling hooks).
2. Build three blocks, each independently wrapped in try/catch (any failure → that block is omitted, no throw):
   - **Current focus** — read `tasks/current-focus.md` **bounded to `FOCUS_MAX_BYTES = 262_144` (256KB)** via a capped read, not an unbounded `readFileSync` (external-review finding R3: a verified real file is 132KB — not huge, but this hook is always-on, so the read is bounded like KNOWLEDGE's tail). The prose body follows the leading `<!-- mission-control ... -->` HTML comment block, so a head-bounded read captures it; strip any leading `<!-- ... -->` block(s), take the prose body, cap to `FOCUS_MAX_LINES = 40`. If the file exceeds `FOCUS_MAX_BYTES`, read only the first `FOCUS_MAX_BYTES` (prose beyond the cap is dropped — acceptable, current-focus is a periodically-rewritten pointer, not an append-only log).
   - **Recent lessons** — read `tasks/lessons.md` **bounded to `LESSONS_MAX_BYTES = 262_144` (256KB)** via a capped read (finding R7 — always-on hook, keep every read byte-bounded for consistency; lessons is small in practice but the cap removes ambiguity). Locate the `## Lessons` heading; collect entries **downward from it** (newest-first ordering) until `LESSONS_MAX_ENTRIES = 5` `### ` entries or `LESSONS_MAX_LINES = 40` lines, whichever first. Stop at the archived-lessons pointer / format-template boundary (a `### ` heading whose text is non-date-like such as `Archived`, `[Date]`, or an `## ` section change) so the trailing template is never emitted.
   - **Recent knowledge** — read KNOWLEDGE.md. Read only the **tail**: seek to the last `KNOWLEDGE_TAIL_BYTES = 32_768` bytes (or the whole file if smaller), split to lines, drop a leading partial line, then walk backward to collect the last `KNOWLEDGE_MAX_ENTRIES = 6` entries. An entry starts at a heading matching `^#{2,3}\s` (covers `## [date]`, `### [date]`, and undated `## title` + `**Date:**` forms). Sub-budget: `KNOWLEDGE_MAX_LINES = 55`.
3. Enforce the global cap: assemble blocks in order [current focus, lessons, knowledge]; if total > `TOTAL_MAX_LINES = 150`, trim from the **oldest content first** — within knowledge and lessons that means dropping the oldest (earliest) entries; the current-focus block is newest-by-nature and trimmed last, tail-first.
4. Emit one header line per present block (e.g. `— Recent lessons (tasks/lessons.md) —`) then the block. If all three blocks are empty/absent, emit nothing (silent, like framework-merge-reminder on a clean tree).
5. `process.exit(0)` always.

## Budget enforcement (external-review finding B2)

Synchronous filesystem reads cannot be interrupted mid-call, so "never blocks" is enforced at block boundaries, not inside a read:
- `SOFT_BUDGET_MS = 100`. Capture `const start = Date.now()` at entry. **Before** starting each of the three blocks, check `Date.now() - start > SOFT_BUDGET_MS`; if exceeded, stop assembling further blocks and emit what is already built. Every read is byte-bounded — KNOWLEDGE tail ≤ `KNOWLEDGE_TAIL_BYTES` (32KB), current-focus ≤ `FOCUS_MAX_BYTES` (256KB), lessons ≤ `LESSONS_MAX_BYTES` (256KB) then line-bounded (`LESSONS_MAX_LINES`) — so no single read runs long; the gate catches pathological slow filesystems by skipping the *remaining* blocks.
- **Backstop:** register the hook in settings.json WITH a `timeout` (`5` seconds) so a hung filesystem cannot stall session start beyond the harness timeout. This is defence-in-depth over the soft budget, not a substitute — the soft budget keeps the common case fast; the timeout caps the pathological case. (Corrects the prior "NO timeout override" position: the blast radius — every session in every consumer — warrants the backstop.)

## Fail-open + silence contract (external-review finding B3)

Precise contract — "skip silently" and "log to stderr" are reconciled:
- **Expected-absent inputs produce NO output at all** (no stdout, no stderr): a missing file, a missing `tasks/` dir, a missing `## Lessons` heading, an empty file. These are normal across consumers and must not add noise.
- **Unexpected errors** (a read that throws for a reason other than ENOENT, a parse failure on present content) are swallowed silently by default; they write a one-line diagnostic to stderr **only when `process.env.MEMORY_DIGEST_DEBUG === '1'`**. Never to stdout.
- Top-level try/catch wraps the whole body and exits 0 on any error. No network, no spawn, no writes. Pure read + stdout.
- Rationale: consumer KNOWLEDGE.md is 400KB+; a full read on every session start is the failure this hook avoids (tail-only). A consumer missing `tasks/` entirely must see a clean, silent session start.

## Ordering rationale (load-bearing)

KNOWLEDGE.md newest-last ⇒ **tail**. lessons.md newest-first with a decoy format-template at the file tail ⇒ **head of the Lessons section**. Reversing either ships boilerplate instead of lessons to every repo. Tests must assert both directions with fixtures that include the decoy template.

## Registration surfaces (Feature A)

- `manifest.json` — add `{"path":".claude/hooks/memory-digest.js","category":"hook","mode":"sync","substituteAt":"never"}`.
- `.claude/settings.json` — append a command entry to the SessionStart `hooks` array: `node "$CLAUDE_PROJECT_DIR"/.claude/hooks/memory-digest.js` WITH `"timeout": 5` (the backstop from the budget-enforcement section; settings-merge propagates it).
- `.claude/hooks/memory-digest.test.js` — sibling test (not manifested), spawnSync style, fixtures for: all three present, none present, KNOWLEDGE tail-only correctness, lessons head-not-template correctness, current-focus HTML-comment strip, over-budget trim (oldest-first), unreadable file fail-open, empty `## Lessons`.
- `README.md` — hooks row `9 portable hooks` → `10`, add `memory-digest` to the list.
- `SECURITY.md` — per-hook table row: SessionStart, reads KNOWLEDGE/lessons/current-focus, no egress, fail-open.
- `.claude/agents/validate-setup.md` self-check will see it registered (no doc edit needed; just must be registered).

---

# Feature B — Local skill overlay

## Goal (verifiable)

After `/claudeupdate`, a consumer has an adopt-only `.claude/context/skill-context.md` (seeded once, never clobbered). Every shipped SKILL.md carries a greppable pointer line. A written protocol governs KNOWLEDGE→overlay mirroring and overlay→canonical-skill draining, the drain is wired into `/cleanfiles`, and framework-doctor gains two overlay checks. Test: doctor checks are documented in the same shape as existing checks; grep proves the pointer line is present in all 20 SKILL.md files; the overlay template is a manifest `adopt-only` entry.

## Overlay file

- Path: `.claude/context/skill-context.md`. Manifest: `{"path":".claude/context/skill-context.md","category":"template","mode":"adopt-only","substituteAt":"never"}` (mirrors agent-context.md exactly; adopt-only means seed-once, consumer-owns-after).
- Template content: a short header explaining the convention + the write protocol pointer + one commented `## <skill-name>` example section showing the entry shape (failure mode / anti-pattern / correction, dated).
- Distinct from agent-context.md (which holds agent operating notes). Two overlays, one per subject class (agents vs skills), same ADR-0006 mechanism.

## Skill pointer line

Add one greppable line to every `.claude/skills/<name>/SKILL.md`, immediately after the frontmatter, identical wording (mirrors the ADR-0006 agent read-instruction so it is enforceable by grep):

> **Repo-specific addenda:** if `.claude/context/skill-context.md` exists and has a `## <this-skill-name>` section, read it — it carries repo-specific failure modes, anti-patterns, and corrections for this skill.

All 20 existing SKILL.md files get the line (they are `mode: sync`, so editing the canonical file is correct — it ships to consumers). CONTRIBUTING.md § *Adding a skill* gains a step requiring the pointer in new skills. (No standalone skill-template file exists to edit; the CONTRIBUTING step is the template surrogate.)

## Executable pointer-coverage gate (external-review finding B8)

Prose ("grep proves the pointer exists") is not an enforceable gate. Add a mechanical check to `scripts/validate-framework.js` (run by `npm run validate` and CI) as a new numbered check: **every `.claude/skills/*/SKILL.md` body contains the canonical pointer line.** The check greps each SKILL.md (which the validator already walks for frontmatter, Check 1) for a stable substring of the pointer line (`.claude/context/skill-context.md`); a skill missing it fails validation with exit 1. This is the real gate; the framework-doctor check below is the consumer-side advisory view (a consumer's synced skills always have the pointer, but consumer-authored local skills may not). The canonical pointer wording is pinned in `references/skill-overlay-convention.md` and the validator references that wording so the two never drift.

## Write protocol (documented)

New doc `references/skill-overlay-convention.md` (manifest `mode: sync`), the single source of truth:

1. **KNOWLEDGE.md remains the master append-only log.** Every lesson lands there first, unchanged.
2. **Same-day mirror.** When a lesson is procedural AND clearly skill-shaped (it would change how a specific skill is applied), ALSO append it that day to the matching `## <skill-name>` section of `.claude/context/skill-context.md`. The KNOWLEDGE.md entry stays canonical; the overlay entry is a scoped copy, dated, with a back-reference to the KNOWLEDGE.md date.
3. **Quarterly drain (promotion).** During the `/cleanfiles` quarterly sweep, overlay entries that generalise beyond the repo are promoted upstream into the canonical skill (a framework PR). Promoted entries are **marked, not deleted**: the overlay entry gets a `> promoted in vX.Y.Z` prefix line and stays for provenance.
4. **Mapping doc.** `/cleanfiles` consults/maintains `tasks/knowledge-to-framework-skills-map.md` (the doc `cleanfiles.md:30` already references as optional) recording overlay-entry → canonical-skill promotions.

## /cleanfiles wiring

Extend `.claude/commands/cleanfiles.md` with an overlay-drain target in its sweep table:
- Scan `.claude/context/skill-context.md` sections; for each entry not already marked `promoted in`, assess generalisability; propose promotion to the named skill (operator-confirmed, framework-PR-bound); on acceptance, add the `> promoted in vX.Y.Z` marker and a row to `tasks/knowledge-to-framework-skills-map.md`, **creating that mapping file if it does not yet exist** (finding B6 — the framework does not ship it). Non-destructive; audit-first like the rest of `/cleanfiles`.

## framework-doctor checks (Feature B)

Add to `.claude/commands/framework-doctor.md`, same shape as Checks 1-5, bumping the summary count. **These are agent-mediated checks (external-review finding B9):** like the existing doctor checks, the markdown instructs the agent to run specific read-only commands and tabulate; the doctor is not a script and does not mechanically enforce. The check text names the exact commands so the acceptance is reproducible, and the doctor's `Zero writes` rule holds. (The *mechanical* enforcement for the pointer line lives in `validate-framework.js` per the executable-gate section above; doctor is the broader consumer-side advisory view.)

**Cross-platform constraint (external-review finding R4):** the commands the check text prescribes MUST be Node-based (`node -e "…"` or a bundled read-only helper), NOT `grep`/`sed`/`awk`/`date` shell pipelines — this framework runs on Windows (win32) where those tools are not reliably present. Heading extraction, JSON/JSONL parsing, and age computation are all done in a short inline Node snippet. This mirrors the existing framework convention of Node-first tooling (`validate-framework.js`, the hooks, the migration runner are all Node).
- **Check 6 — Overlay section validity.** Instruct: extract `^## ` headings from `.claude/context/skill-context.md` **with the Node snippet** (not `grep` — finding R6/cross-platform); for each, test whether `.claude/skills/<name>/SKILL.md` exists. One row per section: section name, skill exists (bool). A section naming no existing skill is a finding. (The Node snippet lists overlay `## ` headings, lists skill dirs, and diffs them.)
- **Check 7 — Stale un-promoted overlay entries.** Instruct: for each dated entry in `.claude/context/skill-context.md` without a `> promoted in` marker, compute age from the entry date; flag entries older than one quarter. One row per stale entry: skill section, entry date, age. Awareness finding (compounding leak), not a hard failure. (Age is computed by the agent against the current date; no persisted state.)

## Registration surfaces (Feature B)

- `manifest.json` — add the `skill-context.md` adopt-only entry + the `references/skill-overlay-convention.md` sync entry.
- 20 × `SKILL.md` edits (pointer line).
- `.claude/commands/cleanfiles.md` + `.claude/commands/framework-doctor.md` edits (glob-covered, no manifest change).
- `CONTRIBUTING.md` § Adding a skill (pointer step).
- `README.md` — What-ships: note the second overlay + the convention doc.
- `docs/doc-sync.md` — register **`references/skill-overlay-convention.md` only** (external-review finding R2). The mapping doc `tasks/knowledge-to-framework-skills-map.md` is NOT registered — it is consumer-created and untracked (finding B6); its format is documented as a section *inside* `references/skill-overlay-convention.md`, not as a standalone tracked doc.

---

# Feature C — Golden-set prompt eval runner

## Goal (verifiable)

A `/eval-prompts <suite>` command runs each case in `eval/<suite>/cases.jsonl` through the prompt module named in `eval/<suite>/config.json`, scores catch rate + false-alarm rate, compares to `eval/<suite>/baseline.json`, and exits non-zero when a regression exceeds the configured threshold. Test: `scripts/__tests__/eval-promptsPure.test.ts` (vitest) covers scoring, baseline compare, threshold, and malformed-case handling, and passes under `scripts/run-tests.js scripts`.

## Suite layout (repo-owned, framework ships only the format spec)

```
eval/<suite>/
  config.json      # { promptModule, provider, model?, threshold: {catchRateDrop, falseAlarmRise}, notes? }
  cases.jsonl      # one JSON object per line: { id, input, expected, notes, source }
  baseline.json    # last-accepted { catchRate, falseAlarmRate, at, commit } — written on accept
```

- **cases format (pinned):** `{ id, input, expected, notes, source }`. `input` is fed to the target prompt; `notes`/`source` are provenance (e.g. a review-mining finding id). Format spec lives at `references/eval-suite-format.md` (manifest `mode: sync`).
- **`expected` taxonomy (pinned, v1 — external-review finding C4):** `expected` is an object `{ verdict: "issue" | "clean", label?: string }`. `verdict: "issue"` means the target prompt SHOULD flag this input (a true positive is warranted); `verdict: "clean"` means it should NOT. `label` is an optional finer-grained tag (e.g. finding category) carried for reporting, not scoring in v1. This verdict shape matches the first consumer (review-pipeline / judge prompts, whose output is inherently issue-vs-clean). Suites needing richer scoring are a post-v1 extension; the format spec documents that v1 scores on `verdict` only.
- **actual-output normalizer (pinned):** the target prompt's raw output is normalized to `{ verdict, label? }` by a per-suite normalizer named in `config.json` (`normalizer` field, an importable module). If `normalizer` is omitted, the **strict default normalizer** (external-review finding R5) requires the prompt output to be JSON containing `verdict: "issue" | "clean"`; anything else — non-JSON output, missing/invalid `verdict` — marks that case **malformed** and the run **fails** (exit non-zero) with the offending case id. There is NO fuzzy issue-detection heuristic: a keyword-guess fallback would make the golden-set numbers untrustworthy, which defeats the tool. Suites whose target prompt does not emit JSON must supply an explicit `normalizer`. The normalizer boundary is what makes catchRate/falseAlarmRate unambiguous and implementer-independent.
- `config.json` fields: `{ promptModule, provider, model?, normalizer?, threshold: { catchRateDrop, falseAlarmRise }, notes? }`. `promptModule` names an importable target prompt (a module exporting a callable taking `input`, returning model-facing output). `provider` selects the LLM seam; `model` optional. `threshold.catchRateDrop` = max tolerated catchRate decrease vs baseline; `threshold.falseAlarmRise` = max tolerated falseAlarmRate increase vs baseline.

**Metric definitions (pinned):**
- `catchRate` = (# cases with `expected.verdict === "issue"` where normalized actual `verdict === "issue"`) / (# cases with `expected.verdict === "issue"`). Higher is better.
- `falseAlarmRate` = (# cases with `expected.verdict === "clean"` where normalized actual `verdict === "issue"`) / (# cases with `expected.verdict === "clean"`). Lower is better.
- A suite with zero `issue` cases (or zero `clean` cases) reports the corresponding rate as `null` and it is excluded from threshold comparison, with a note.

## Runner (`scripts/eval-prompts.ts` + `scripts/eval-promptsPure.ts`)

- **Pure module** (`eval-promptsPure.ts`, vitest-tested): parse+validate cases, compute `catchRate` (fraction of cases whose actual matches `expected` where a catch is warranted) and `falseAlarmRate` (fraction of no-issue cases the prompt flagged), compare against baseline under thresholds → `{ pass, catchRate, falseAlarmRate, deltas, regressions[] }`. No I/O.
- **I/O module** (`eval-prompts.ts`, run via tsx): load `.env` with the guarded `require('dotenv/config')` pattern from `chatgpt-review.ts`; read `process.env.OPENAI_API_KEY` lazily; call the provider through a thin `EvalProvider` seam. v1 ships one provider (`openai`) reusing `chatgpt-review-api.ts`'s Responses-API caller (timeout + retry). `config.provider` selects the seam; unknown provider = clear error. Print catch/false-alarm vs baseline; exit 1 on threshold breach.
- **Provider seam:** minimal interface `runPrompt(messages, {model}) → Promise<string>`, where `messages` is a `ResponsesMessage[]` (`{role, content}`). The runner assembles `messages` by calling the target `promptModule(input)` (which returns the system+user content for the case) and passes them to the selected provider. OpenAI impl only at v1; a second provider slots in without touching the runner or pure module (intent.md decision 3).
- **Provider-reuse compatibility requirement (external-review finding C10):** the OpenAI impl reuses `scripts/chatgpt-review-api.ts`, whose caller already accepts a `ResponsesMessage[]` (`{role:'system'|'user'|'assistant', content:string}`) and returns extracted text (verified: `chatgpt-review-api.ts:35-43`). Therefore a **thin adapter** in `eval-prompts.ts` maps `promptModule(input)` output → `ResponsesMessage[]` → the existing caller, and maps the caller's returned text → the suite normalizer. The adapter is an explicit implementation deliverable; do not assume `promptModule` output is already in Responses-API shape. If a target prompt needs structured (JSON) output, the normalizer — not the provider caller — owns parsing it.
- **Baseline accept:** `/eval-prompts <suite> --accept` writes the current scores to `baseline.json` (the only write path; explicit operator action).
- **Missing-baseline behaviour (pinned — external-review finding C5):** a normal run against a suite with no `baseline.json` exits **non-zero** with the message `no baseline for suite <suite> — run '/eval-prompts <suite> --accept' to seed one`. It does not silently pass (that would let the first prompt change ship unmeasured). Two explicit escapes: `--accept` (seed the baseline from this run) and `--dry-run` (compute and print scores, exit 0, no comparison). framework-doctor Check 8 flags any suite that has `cases.jsonl` but no `baseline.json` as an advisory finding.

## /eval-prompts command

`.claude/commands/eval-prompts.md` (glob-covered): frontmatter `description`; body instructs running `npx tsx scripts/eval-prompts.ts <suite>` (the runner loads `.env` itself via the guarded dotenv pattern, so the command needs no shell env-loading preamble — finding R8, removes the POSIX-only `set -a; . ./.env` line that would break on Windows), interpreting pass/fail, and the `--accept` baseline flow. Documents the "prompt change lands only if its suite passes" integration contract (consumer wires it into its own review pipeline; automation-v1's parallel-mode Step 7 is a named consumer-side follow-up, out of scope here).

## framework-doctor check (Feature C)

- **Check 8 — Eval suite validity** (agent-mediated, same posture as Checks 6-7). Instruct: for each `eval/*/` dir — parse `config.json` and confirm it names a `promptModule` + a known `provider`; parse every `cases.jsonl` line and confirm the five required keys (`id, input, expected, notes, source`) with `expected` carrying a `verdict`; parse `baseline.json` if present. One row per suite: suite, config valid, cases valid, baseline present. A suite with `cases.jsonl` but no `baseline.json` is an advisory finding (per finding C5). This is the "framework-doctor manifest-validity check" the brief requires.

## Registration surfaces (Feature C)

- `manifest.json` — add `scripts/eval-prompts.ts`, `scripts/eval-promptsPure.ts` (both `category: review-script`/`script`, `mode: sync`), `references/eval-suite-format.md` (`mode: sync`).
- `.claude/commands/eval-prompts.md` (glob-covered, no manifest entry).
- `scripts/__tests__/eval-promptsPure.test.ts` (vitest; picked up by `run-tests.js scripts`).
- `README.md` — commands row `7` → `8`; scripts row note; What-ships eval-format doc.
- `docs/doc-sync.md` — register `references/eval-suite-format.md`.

---

# Execution model

- **Feature A:** synchronous hook, bounded work, no async mode (mirrors existing SessionStart hooks). Runs on every session start in every consumer.
- **Feature B:** static files + docs + markdown command edits. The drain is a manual, operator-confirmed quarterly action inside `/cleanfiles`; no runtime service.
- **Feature C:** on-demand CLI (`npx tsx`). Network only when a suite is run; keys from `.env`. Not wired into CI by the framework (consumer opts in).

# Execution-safety contracts

- **A** — idempotent (read-only, no state). Concurrency-safe (no writes). Terminal behaviour: always exit 0; partial failure degrades to fewer blocks, never a crash.
- **B** — overlay is adopt-only: first sync seeds, subsequent syncs skip (idempotent by sync.js contract). The `/cleanfiles` drain is non-destructive (marks, never deletes) and operator-gated. The migration that adopts the new managed file is idempotent (`adoptNewlyManagedFiles` → skipped on re-run).
- **C** — `--accept` is the only write path and is explicit. Runner is idempotent given fixed cases + baseline (LLM non-determinism is the inherent variance the catch/false-alarm rates and thresholds absorb; document that a suite should be sized so noise stays under the threshold). Provider failures surface loudly (reuse chatgpt-review-api retry/timeout, then throw) — no silent pass.

# Release plumbing (v2.33.0)

- Bump `.claude/FRAMEWORK_VERSION` → `2.33.0` and `manifest.frameworkVersion` → `2.33.0` in the same commit as the CHANGELOG `## 2.33.0 — <date>` heading (CI asserts all three).
- `migrations/v2.33.0.js` — adopts **the one new adopt-only managed file** (`.claude/context/skill-context.md`) into consumers that already have a matching copy, via `adoptNewlyManagedFiles`, so sync writes no spurious `.framework-new`. (The other five new managed files are `mode: sync` — sync.js handles them with its normal new-file / `.framework-new` flow; the migration does not touch them.) Idempotent; `{status,notes}`. Covered in `tests/migrations.test.ts` (fresh apply, idempotent re-run, pristine no-op).
- CHANGELOG entry references the migration and lists Added (memory-digest hook, skill-context overlay, eval runner + command), Changed (20 SKILL.md pointer lines, cleanfiles + framework-doctor commands, README/CONTRIBUTING/doc-sync).
- Consumer migration notes: what lands, what the operator must populate (`skill-context.md` sections, eval suites), and that the memory hook activates on next session start.
- Release itself is cut with `/release minor` (producer-side) after the PR merges — the PR carries the version/CHANGELOG/migration; `/release` is the tag+push step. (Sequencing note: the version bump can live in the feature PR per framework precedent; `/release`'s guard requires a clean `main`, so tagging happens post-merge.)

# File inventory lock

**New files:**
- `.claude/hooks/memory-digest.js`
- `.claude/hooks/memory-digest.test.js`
- `.claude/context/skill-context.md` (adopt-only template)
- `references/skill-overlay-convention.md`
- `references/eval-suite-format.md`
- `scripts/eval-prompts.ts`
- `scripts/eval-promptsPure.ts`
- `scripts/__tests__/eval-promptsPure.test.ts`
- `.claude/commands/eval-prompts.md`
- `migrations/v2.33.0.js`

**NOT shipped as a tracked file (external-review finding B6 — locked):** `tasks/knowledge-to-framework-skills-map.md` is **consumer-created by `/cleanfiles` on the first drain**, not shipped by the framework. Rationale: the framework ships mechanism, not data (consistent with `doNotTouch: tasks/**` and the "empty scaffolding" posture); shipping an empty tracked mapping file adds churn with no content. `/cleanfiles` creates it the first time it promotes an overlay entry. It is therefore absent from both the manifest and the file inventory; `references/skill-overlay-convention.md` documents its format and that `/cleanfiles` owns its creation.

**Edited files:**
- `manifest.json` (**+6 managedFiles entries** — `memory-digest.js`, `skill-context.md`, `skill-overlay-convention.md`, `eval-suite-format.md`, `eval-prompts.ts`, `eval-promptsPure.ts` — **plus the `frameworkVersion` value bump**. Test files and `eval-prompts.md`/command markdown are glob-covered or unmanaged and are NOT entries.)
- `.claude/settings.json` (SessionStart += memory-digest)
- `.claude/FRAMEWORK_VERSION`
- `.claude/CHANGELOG.md`
- `.claude/commands/cleanfiles.md` (drain target)
- `.claude/commands/framework-doctor.md` (Checks 6, 7, 8 + count)
- `.claude/skills/*/SKILL.md` × 20 (pointer line)
- `CONTRIBUTING.md` (Adding-a-skill pointer step)
- `README.md` (hooks 9→10, commands 7→8, What-ships rows)
- `docs/doc-sync.md` (2 new reference docs: `references/skill-overlay-convention.md` + `references/eval-suite-format.md` — NOT the mapping doc, which is consumer-created/untracked)
- `tests/migrations.test.ts` (v2.33.0 coverage)
- `scripts/validate-framework.js` (new pointer-coverage check — finding B8)

# Testing posture

- Hook: `memory-digest.test.js` (hand-rolled spawnSync, matches sibling hooks).
- Eval pure: `eval-promptsPure.test.ts` (vitest, `scripts/__tests__/`). No live-LLM test in CI — the I/O module's provider call is not unit-tested against the network; the pure scoring/threshold logic is.
- Migration: `tests/migrations.test.ts` (fresh/idempotent/pristine).
- Full `npm test` (sync + scripts + hooks) + `npm run validate` green before PR.
- Defer-until-trigger: no eval suite ships with cases (consumer-owned); the format-spec + doctor check are the framework's testable surface.

# Phase sequencing

No backward dependencies. Suggested chunk order (for the plan phase): (1) Feature A hook + test + registration; (2) Feature B overlay template + pointer sweep + convention doc; (3) Feature B /cleanfiles + doctor checks; (4) Feature C pure module + test; (5) Feature C I/O runner + command + provider seam; (6) Feature C doctor check + format spec; (7) release plumbing (version/CHANGELOG/migration/manifest/README/doc-sync) + migration test. A and C-pure are independent and parallelisable.

# Self-consistency pass

- File inventory ⟷ registration surfaces reconciled (every new file has a manifest disposition; every edited command is glob-covered).
- **Manifest count: 6 new `managedFiles` entries** (memory-digest.js, skill-context.md, skill-overlay-convention.md, eval-suite-format.md, eval-prompts.ts, eval-promptsPure.ts) **plus the `frameworkVersion` value bump**. Test files, `.claude/commands/eval-prompts.md`, and command-markdown edits are NOT entries (glob-covered or unmanaged). The inventory and this pass now agree (external-review finding B7 — the stale "+7" was corrected in place).
- `tasks/knowledge-to-framework-skills-map.md` is NOT a shipped/tracked file (finding B6) — created by `/cleanfiles` on first drain; absent from manifest and inventory. Consistent across File inventory, /cleanfiles wiring, and Deferred.
- README counts: hooks 9→10 (verified current "9 portable hooks"); commands 7→8 (verified current "7 operator commands"); skills stays 20 (no new skill, only pointer edits).
- Overlay deploy mode = adopt-only everywhere it appears (Lifecycle, Feature B, execution-safety, migration) — consistent.
- Risk surface: intent-schema field = "None." (accurate to that vocabulary); a distinct `## Operational risk surface` section carries the real risks (finding B1) — the two are not in conflict, they answer different questions.

# Deferred items

- **Seeding eval cases from automation-v1 `tasks/review-mining` (~1,900 adjudicated findings)** — consumer-side, post-release. Out of scope.
- **Wiring `/eval-prompts` into automation-v1 parallel-mode Step 7 prompt-evolution** — consumer-side, post-release.
- **Second eval provider (Anthropic, etc.)** — seam is built; impl deferred until a suite needs it.
- **Automated staleness enforcement for overlay entries** — doctor Check 7 is advisory; a hard gate is deferred.
- **Richer eval scoring beyond verdict (issue/clean)** — v1 scores on `expected.verdict` only (finding C4); multi-class / graded scoring is a post-v1 extension the format spec flags.

# Open questions

- None blocking. The three architecture forks are resolved (intent.md § Grill-me Q&A). The `knowledge-to-framework-skills-map` shipping shape is now LOCKED (consumer-created by `/cleanfiles`, not shipped — finding B6), no longer an open question.

# Revision log

- **v0.2 (2026-07-09, Fable) — external spec-review pass applied.** Ten findings accepted after review-triage adjudication (none were false-positive class): B1 operational risk surface added; B2 budget made enforceable (elapsed-gate between blocks + 5s settings.json timeout backstop); B3 silence/stderr contract made precise (`MEMORY_DIGEST_DEBUG`); B4 eval `expected` taxonomy + normalizer + metric definitions pinned; B5 missing-baseline behaviour pinned (non-zero + seed message, `--dry-run` escape); B6 mapping-doc locked consumer-created; B7 manifest count fixed in inventory (6 entries + version bump); B8 executable pointer-coverage gate added to `validate-framework.js`; B9 doctor checks marked agent-mediated with commands; C10 provider adapter made an explicit deliverable. Scope confirmed as one release (reviewer concurred).
- **v0.4 (2026-07-09, Fable) — external spec-review round 3 applied (approved for plan).** Four minor consistency/portability nits, no blockers: R6 doctor Check 6 wording changed from "grep" to "extract with the Node snippet" (the cross-platform intent was right; the word "grep" survived); R7 lessons read given `LESSONS_MAX_BYTES` (256KB) so every hook read is byte-bounded; R8 `/eval-prompts` command drops the POSIX `set -a; . ./.env` preamble (Windows-unsafe) — the runner loads `.env` itself; doc-sync's "2 new reference docs" spelled out inline (convention + eval-format, not the mapping doc). Reviewer verdict: spec approved for plan.
- **v0.3 (2026-07-09, Fable) — external spec-review round 2 applied.** Five findings, mostly ripple-corrections from the v0.2 edits (the review-triage-predicted class): R1 migration text corrected to the single adopt-only file (`skill-context.md`); the other five managed files are `mode: sync` and untouched by the migration (near-blocking — a wrong migration was the risk). R2 doc-sync registers the convention doc only; mapping-doc format documented inside it, not as a tracked doc. R3 current-focus read bounded to `FOCUS_MAX_BYTES` (256KB), removing the stale "small file" assumption. R4 framework-doctor checks constrained to Node-based cross-platform commands (Windows support). R5 eval default normalizer made strict (JSON `verdict` required, no fuzzy heuristic; malformed → run fails). Scope unchanged; reviewer moved verdict to "spec approved for plan" pending these.

# Model-switch seam

Per operator directive (2026-07-09): this spec is drafted on Fable and presented for operator feedback here. Review tiers (claude-spec-review → spec-reviewer → chatgpt-spec-review, mode `automated`), the architect plan, plan reviews, and the build run AFTER operator feedback on a fresh session (Opus), resuming from `intent.md` + `spec.md` + `progress.md`.

