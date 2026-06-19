# Implementation Plan: Render-Grounded Mockups + Behaviour Capture

**Source spec:** `tasks/builds/grounded-mockups-render-and-behaviour/spec.md` (DRAFT, §9 decisions binding)
**Target repo:** `.claude-framework` (build EVERYTHING here, Pure-split; live capture verified in `automation-v1` post-sync)
**Classification:** Significant — 4 framework agents (mockup-designer, mockup-reviewer, spec-coordinator, mockup-coordinator), new artifact contract, new Playwright script, doc-sync, ADR
**Target version:** 2.24.0 (minor bump; if a parallel build merges first, take the next free version and re-stack the CHANGELOG entry)

> **Executor note (binding, verbatim):** Test gates and whole-repo verification scripts (`npm run test:gates`, `npm run test:qa`, `npm run test:unit`, `npm test`, `scripts/verify-*.sh`, `scripts/gates/*.sh`, `scripts/run-all-*.sh`) are CI-only. They do NOT run during local execution of this plan, in any chunk, in any form. Targeted execution of unit tests authored within this plan is allowed; running the broader suite is not.

> **Toolchain note (binding, the spine of this whole plan):** The `.claude-framework` repo has NO toolchain — root `package.json` is `{"type":"commonjs"}`, no `node_modules`, no `tsconfig`, no vitest/tsc/eslint. Lint, typecheck, Vitest, and Playwright CANNOT run inside `.claude-framework`. Anything needing a toolchain is verified by copying/syncing the touched files into `automation-v1` (full toolchain: vitest, `tsc`, `eslint .`, Playwright `^1.59.1`, UI server, storageState auth) and running there. Grep- and version-diff acceptance (A4/A5/A6/A7) run directly in the framework.

## Contents

1. Model-collapse check
2. Architecture Notes
3. Stepwise Implementation Plan (dependency graph + build order + builder allocation)
4. Per-Chunk Detail (Chunks 2, 1, 3, 4, 5, 6)
5. Consuming-repo / post-sync action
6. Acceptance criteria mapping + REVIEW_GAP
7. Risks & mitigations
8. Self-consistency pass
9. G2 end-of-construction

---

## 1. Model-collapse check

The motivating "AI Website Cloner" pattern is literally a pipeline (drive browser → read DOM → extract tokens → emit manifest), so the three pre-plan questions must be asked honestly.

1. **Does this decompose into ingest → extract → transform → render?** Pillar A does: navigate (ingest) → read computed CSS + DOM (extract) → de-duplicate into token sheet + pruned outline (transform) → write manifest (render). Pillar B does not — it is an authored Markdown checklist, no pipeline.
2. **Is each step something a frontier multimodal model could do in one call?** Partially. A model given a full-page screenshot could plausibly emit "the colours/fonts/tab labels are X" in one structured-output call, collapsing extract+transform.
3. **Can the whole pipeline collapse into one model call with a structured-output schema?**

**Decision: reject the collapse.** Rationale: the capture's value is precisely that it is **observed, not inferred** — the spec's entire thesis (§1, G2) is that the designer and reviewer must check against *real computed CSS and the real DOM*, not against any model's reading of a picture. A model reading a screenshot is exactly the "approximation of an approximation" this feature exists to eliminate; it would reintroduce the guess and would not be deterministic enough for A1/A3 (the reviewer must grep the captured tab labels and trust they are the page's actual `textContent`, not a vision model's transcription). Determinism, auditability, and the no-guess principle all point to mechanical Playwright extraction. The capture stays a deterministic script; the *design judgement* downstream stays with the (model-driven) designer. No collapse.

---

## 2. Architecture Notes

**Decision 1 — Pure-split for everything testable; impure orchestrator ships untested.** Token-sheet de-duplication and DOM-outline pruning are pure functions of an input → `scripts/mockup/capture-surfacePure.ts` with Vitest tests. The manifest validator is pure → `scripts/mockup/capture-manifestPure.ts`. The Playwright-driving orchestration (server boot, navigation, `page.evaluate`, screenshot, file writes) goes in the impure `scripts/mockup/capture-surface.ts`, shipped but NOT unit-tested (mirrors `chatgpt-review.ts` impure + `chatgpt-reviewPure.ts` pure + `__tests__/chatgpt-reviewPure.test.ts`). *Rejected:* one monolithic script — untestable, breaks the convention.

**Decision 2 — Pure tests use Vitest, not `node:test`.** Binding constraint 3 and project MEMORY require Vitest (`import { describe, it, expect } from 'vitest'`; `npx vitest run`); `scripts/verify-test-quality.sh` rejects `node:test`/`node:assert`/handwritten harnesses. NOTE: the older `scripts/__tests__/cross-repo-scoutPure.test.ts` still uses `node:test` — do NOT copy that file's harness style; copy `chatgpt-reviewPure.test.ts`'s Vitest style instead. State this to the builder so it does not pattern-match on the wrong neighbour.

**Decision 3 — Reuse the existing UI-test-server/auth mechanism; do not rebuild login.** Spec §4.2 explicitly waives the fourth-occurrence rule here — deliberate reuse of one existing mechanism. The impure script imports the consuming repo's UI-test-server bootstrap and reuses its storageState auth files at a *conventional* path. Per ADR-0006 the script references conventional consuming-repo paths (NOT automation-v1 specifics): bootstrap `scripts/start-ui-test-server.ts`, storageState `.test-runs/playwright/auth/{role}.json`, baseURL `http://127.0.0.1:5000`, Playwright `^1.59.1`. The script depends on the convention, not on automation-v1.

**Decision 4 — `capture-surface.ts` is a runtime-imports-consumer-paths managed file.** Like the review scripts, it ships into consuming repos and at runtime imports the consuming repo's UI-test server/auth. The framework cannot exercise it; automation-v1 verifies the live path (A1/A2) after sync. That is the Pure-split's point: pure extractors proven via automation-v1 vitest, impure orchestrator proven by the live capture in automation-v1.

**Decision 5 — manifest.json (sync contract) entries mandatory for every new shipped file.** Every new script, test, and the behaviour-manifest template needs a `managedFiles` entry or it will not propagate. Mirror existing `helper-script`/`helper-script-test` rows for scripts/tests; mirror a `template` row for the behaviour-manifest template.

**Decision 6 — ADR-0007 is a synced managed file.** ADRs 0001/0002/0005/0006 are in `manifest.json`; 0003/0004 are not. This methodology choice is durable, fleet-relevant, and cited by the agent prose, so it should travel. Add a `docs/decisions/0007-*.md` `managedFiles` entry alongside the others. *Rejected:* leaving it unmanaged (like 0003/0004) — the agents cite the principle, so consuming repos need the ADR.

**Pattern posture:** mostly direct code, one deliberate reuse (UI-server/auth), one established split (Pure/impure). No new abstractions invented. Three-similar-lines rule respected; the only "extract a helper" move (thin server/auth context helper) is the §4.2-authorised reuse, not speculative DRY.

---

## 3. Stepwise Implementation Plan

Six chunks, following spec §7. Dependency graph (spec §7 note):

```
Chunk 2 (manifest contract + validator)  ─┐
Chunk 1 (capture script + extractors)    ─┤ 1 & 2 independent of 3/4/5
                                          │
Chunk 3 (mockup-designer edits) ──────────┤ 3,4,5 mutually independent
Chunk 4 (mockup-reviewer edits) ──────────┤  once Chunk 2's contract exists
Chunk 5 (spec-coordinator + template) ────┘
                                          │
Chunk 6 (docs + version + ADR + manifest) ── depends on ALL
```

**Build order presented to operator: 2 → 1 → 3 → 4 → 5 → 6.** Chunk 2 first because its `captureStatus` enum + fallback-reason vocabulary + manifest shape are the contract Chunk 1's extractors emit and Chunks 3/4 reference in prose. (1 and 2 are formally independent, but doing 2 first means Chunk 1 imports a settled type.)

**Builder (Sonnet) vs careful agent-prose editing:**
- **Chunks 1 & 2** — TypeScript + Vitest tests. Suitable for the `builder` Sonnet sub-agent (deterministic, test-backed).
- **Chunks 3, 4, 5** — surgical prose edits to framework-canonical agent files. Need careful, style-matched editing (anchor preservation, ADR-0006 project-agnostic wording, no LOCAL-OVERRIDE reintroduction). Prefer main-session (Opus) editing or a closely-reviewed builder pass; small diffs but prose precision matters more than token volume.
- **Chunk 6** — docs + version + ADR + manifest. Mixed: ADR + doc subsections are prose (Opus-careful); version bump + manifest entries are mechanical (builder-safe).

---

## 4. Per-Chunk Detail

### Chunk 2 — Capture manifest contract + validator

**Scope:** Define the capture-manifest shape, `captureStatus` enum, fallback-reason vocabulary, and a pure validator. Does NOT touch Playwright or agent files.

**Files created:**
- `scripts/mockup/capture-manifestPure.ts` — exported `CaptureStatus`, `FallbackReason` types, `CaptureManifest`/`CaptureScreenEntry` interfaces, `validateCaptureManifest(input: unknown): { valid: true } | { valid: false; errors: string[] }`.
- `scripts/__tests__/capture-manifestPure.test.ts` — Vitest (`import { describe, it, expect } from 'vitest'`).

**Module shape:**
- *Public interface:* `validateCaptureManifest()` + exported types. All callers (impure script, reviewer's mental model) touch only these.
- *Hidden:* per-field validators, enum membership checks, error-message assembly, ISO-8601 `capturedAt` parsing.

**Contracts:**

`captureStatus` enum (§4.3, §4.6) — exactly: `captured | fallback_source_read | failed`. Semantics (review #3):
- `captured` — a real render was observed; all per-viewport screenshots, a non-empty token sheet, and a non-empty DOM outline are present.
- `fallback_source_read` — an *anticipated* capture failure (server down, route unreachable, no seed data, new surface). Carries a `fallbackReason`; the designer degrades to source-read grounding (§4.6, never a hard gate). **This is the status ordinary capture failures emit.**
- `failed` — an *unrecoverable/internal* error (the capture script itself threw before it could classify a fallback). Requires a `failureReason` (free text); never carries a `captured` claim, screenshots, token sheet, or DOM outline. The designer treats `failed` exactly like a fallback (degrade to source-read, logged). The orchestrator should prefer emitting `fallback_source_read` for any failure it can attribute; `failed` is the last-resort bucket. The validator accepts it but enforces "no captured-shape fields, `failureReason` present."

`fallbackReason` vocabulary (§4.6), required when `captureStatus = fallback_source_read`: `server_unavailable | route_unreachable_as_{role} | data_absent | n/a_new_surface`. `route_unreachable_as_{role}` is a template — the validator accepts the `route_unreachable_as_` prefix + a non-empty role token. `data_absent` still allows a screenshot to exist (captured empty state).

Per-screen entry (§4.3) — **a discriminated union on `captureStatus` (review #2-followup), NOT one interface with everything optional.** This makes the validator's "captured carries all / failed carries none" rules a compile-time guarantee and stops the builder fighting the validator with all-optional fields:

```ts
interface BaseScreenEntry { screenId: string; route: string; role: string; capturedAt: string /* UTC ISO 8601 */; viewports: number[] /* default 375/768/1280 */ }
interface CapturedScreenEntry extends BaseScreenEntry {
  captureStatus: 'captured';
  screenshotPaths: Record<number, string>;  // one key per entry in viewports — REQUIRED
  tokenSheet: TokenSheet;                    // non-empty — REQUIRED
  domOutline: DomOutline;                    // structured, ≥1 non-empty array — REQUIRED
}
interface FallbackSourceReadScreenEntry extends BaseScreenEntry {
  captureStatus: 'fallback_source_read';
  fallbackReason: FallbackReason;            // REQUIRED
  screenshotPaths?: Record<number, string>;  // optional — present only for data_absent (empty-state capture)
}
interface FailedScreenEntry extends BaseScreenEntry {
  captureStatus: 'failed';
  failureReason: string;                     // REQUIRED, non-empty — no captured-shape fields
}
type CaptureScreenEntry = CapturedScreenEntry | FallbackSourceReadScreenEntry | FailedScreenEntry;
```

Top-level: `{ slug, generatedAt, screens: CaptureScreenEntry[] }`. `validateCaptureManifest` narrows on `captureStatus` and applies the per-variant rules below; a `FailedScreenEntry` carrying any captured-shape field (screenshots/token sheet/DOM outline) is rejected at runtime even though the union forbids it at compile time (defends against untyped JSON input).

**`domOutline` shape (review #2 — load-bearing, the reviewer greps it for real vocabulary):** a structured object, not an opaque hash. Shape per §4.2: `{ navItems: string[], tabLabels: string[], headings: string[], tableColumnHeaders: string[], primaryButtons: string[], statusPills: string[] }`. Each array holds the page's real `textContent` so Axis 1(b) can match the mockup's inherited vocabulary against observed reality. A `captured` entry must have a `domOutline` with at least one non-empty array.

**Validator rules (the gate the reviewer trusts):**
- reject unknown `captureStatus`;
- reject `fallback_source_read` without a valid `fallbackReason`;
- reject `failed` without a non-empty `failureReason`, or `failed` carrying any captured-shape field (screenshots/token sheet/DOM outline) — review #3;
- **reject `captured` unless every viewport in `viewports` has a screenshot path** (a one-viewport screenshot set on a 375/768/1280 entry fails — review #1), AND the token sheet is non-empty, AND `domOutline` has ≥1 non-empty array (review #2);
- reject malformed `capturedAt`; reject empty `screenId`/`route`/`role`; reject empty `viewports`.

**Error handling:** validator never throws on bad input — returns `{ valid: false, errors }`. Returns invalid (never crashes) even on `null`/wrong-type input, so a capture round can log and degrade rather than die.

**Test considerations (A3):** valid manifest passes; unknown status rejected; `fallback_source_read` missing reason rejected; **`captured` entry with `viewports: [375,768,1280]` but a missing 768 screenshot path rejected (review #1);** `captured` with empty token sheet rejected; **`captured` with an empty `domOutline` (all arrays empty) rejected, and a `domOutline` containing real tab labels/column headers accepted (review #2);** **`failed` without `failureReason` rejected, `failed` carrying a screenshot rejected (review #3);** malformed `capturedAt` rejected; `route_unreachable_as_org-admin` accepted, bare `route_unreachable_as_` rejected.

**Dependencies:** none.

**Verification:** copy both files into the matching paths in `automation-v1`, then run **`npx vitest run scripts/__tests__/capture-manifestPure.test.ts`** there. Scoped lint in automation-v1: `npx eslint scripts/mockup/capture-manifestPure.ts scripts/__tests__/capture-manifestPure.test.ts`. (Cannot run in `.claude-framework` — no toolchain.)

---

### Chunk 1 — Capture script + pure extractors + shared server/auth helper

**Scope:** Playwright-driven `capture-surface.ts` (impure, shipped, untested) + pure token-sheet/DOM-outline extractors (tested). Reuses the consuming repo's UI-test server + storageState auth. Captures existing surfaces ONLY; never the prototype. Does NOT define the manifest contract (Chunk 2) or edit agents.

**Files created:**
- `scripts/mockup/capture-surfacePure.ts` — pure: `extractTokenSheet(computedStyleRecords): TokenSheet` (de-duplicate colours / font families+sizes+weights / spacing / radii / shadows into ONE page-wide sheet per §9-decision-1, NOT per-element); `pruneDomOutline(rawNodes): DomOutline` (keep landmark + heading + interactive-control level — returns the **structured** `DomOutline` from Chunk 2: `{ navItems, tabLabels, headings, tableColumnHeaders, primaryButtons, statusPills }`, each an array of real `textContent` strings, NOT a digest — review #2; §4.2).
- `scripts/mockup/capture-surface.ts` — impure orchestrator: parse input `{ screenId, route, viewport|viewports, role }[]` (viewports default to 375/768/1280); boot/attach UI test server; per role load storageState; navigate; wait network-idle + settle; **per viewport** full-page PNG (downscale very tall pages per §9-decision-3) → `prototypes/{slug}/_captures/{screenId}-{viewport}.png`, writing one `screenshotPaths` entry per viewport so the §4.2 three-viewport contract is satisfied for a `captured` entry (review #1); `page.evaluate` to collect computed styles + raw DOM → pure extractors; assemble entries; call `validateCaptureManifest` (Chunk 2); write `prototypes/{slug}/_captures/manifest.json`. On anticipated failure: write `fallback_source_read` + `fallbackReason` and NO partial/corrupt screenshot (A2); on an unrecoverable internal error: write `failed` + `failureReason`, no captured-shape fields (review #3).
- `scripts/__tests__/capture-surfacePure.test.ts` — Vitest, tests the two pure extractors.

**Reuse helper (§4.2-authorised):** if the consuming UI-test harness exposes a reusable authenticated-context factory, import it; else extract a thin shared helper that boots the server (`scripts/start-ui-test-server.ts` convention; `UI_TEST_MODE`/`UI_SCENARIO_MODE`) and loads `.test-runs/playwright/auth/{role}.json`. Reference via conventional consuming-repo paths only (ADR-0006).

**Module shape:**
- *Public interface (impure):* a single `captureSurfaces(inputs, opts): Promise<CaptureManifest>` (or CLI `argv` wrapper). Small.
- *Public interface (pure):* `extractTokenSheet`, `pruneDomOutline`.
- *Hidden:* server boot/attach lifecycle, storageState resolution, per-viewport loop, `page.evaluate` payload shape, screenshot downscaling, network-idle/settle timing, fallback-status mapping, partial-write avoidance (write temp, rename on success).

**Contracts:** consumes Chunk 2's types + `validateCaptureManifest`; emits a manifest that validates. Input tuple `{ screenId, route, viewport|viewports, role }`; role ∈ `{ org-admin, system-admin }` for v1 but `role` is a free parameter (§9-decision-2) so adding personas needs no code change.

**Error handling (graceful degradation, §4.6 — never a gate):**
- Server cannot boot → `fallback_source_read` / `server_unavailable`, exit clean, no partial PNG.
- Route unreachable as role → `fallback_source_read` / `route_unreachable_as_{role}`.
- Seed data absent → capture empty state, flag `data_absent` (screenshot still written).
- New surface, no page to extend → `n/a_new_surface`.
A failed capture NEVER blocks the round; it downgrades grounding to source-read, logged. (G4.)

**Test considerations (pure only):** token de-dup collapses duplicate colours/fonts to one sheet; DOM-outline pruning keeps tab labels + column headers + status pills, drops span/leaf noise; empty input → empty-but-valid structures. Impure orchestration is NOT unit-tested in the framework — exercised by the live A1/A2 run in automation-v1.

**Dependencies:** Chunk 2.

**Verification:**
- *Pure extractors:* copy `capture-surfacePure.ts` + its test into automation-v1, run **`npx vitest run scripts/__tests__/capture-surfacePure.test.ts`**; scoped lint on the touched files.
- *Impure orchestrator (A1/A2 — live):* CANNOT run in the framework. After sync into automation-v1: start `npm run dev:server:ui`, run the script against a known `org-admin` route → assert screenshots at 375/768/1280 + non-empty token sheet + DOM outline naming real tab labels + manifest entry `captureStatus: captured` (A1); then with the UI server down, re-run → assert `fallback_source_read`/`server_unavailable` and no partial PNG (A2). **automation-v1-post-sync only — see REVIEW_GAP.**
- typecheck/build run once at G2 in automation-v1, not per-chunk.

---

### Chunk 3 — `mockup-designer` Step 0a upgrade + new Step 3c

**Scope:** Edit `.claude/agents/mockup-designer.md` (framework-canonical). Add the render-capture sub-step into Step 0a, extend the grounding list, add Step 3c (behaviour manifest), extend the round-summary template. Project-agnostic prose only (ADR-0006). Does NOT edit other agents or docs.

**File edited:** `.claude-framework/.claude/agents/mockup-designer.md`

**Edits (surgical, anchor-preserving):**
1. **Step 0a (§4.4):** after the existing "Read those files in full" step, insert the render-capture sub-step ordered BEFORE drafting: run `scripts/mockup/capture-surface.ts` for the identified surfaces (route + role + viewports 375/768/1280); on success Read screenshots + token sheet and ground the draft in captured tokens + DOM outline; on failure fall back to source-read grounding and record the downgrade + reason. Reference the conventional script path, not automation-v1 specifics.
2. **Grounding-list extension (§4.4.4):** the per-screen grounding list (Step 4 round summary) now cites, per screen, BOTH the source file AND `captureStatus` + capture paths. "Grounded" = "grounded against the capture, or explicitly fell back with reason."
3. **New Step 3c (§5.4):** after layout drafting, author/update `tasks/builds/{slug}/behaviour-manifest.md` completing the §5.2 checklist per screen; `n/a` rows need a one-line reason; round summary references the manifest and lists `n/a` rows.
4. **Step 1 TodoWrite skeleton + Step 4 round-summary template:** add the capture status/paths fields and the behaviour-manifest reference so templates stay in sync with the new steps.

**Module shape:** agent prose, not code. *Public surface:* the named anchors A4 greps (`capture` sub-step in Step 0a; the fallback path; `Step 3c`; behaviour-manifest reference). *Hidden:* none executable.

**Contracts:** must name `capture-surface.ts`, the fallback path, and Step 3c / behaviour-manifest so A4 greps succeed. Keep the five hard rules, operator-vocabulary rule, and mobile-shape mandate unchanged (render-grounding feeds them better inputs, does not relax them — §4.4).

**Error handling:** n/a (prose). The described behaviour must specify the fallback (never silent) per §4.6.

**Test considerations:** A4 grep — Step 0a names the capture sub-step AND the fallback path; Step 3c names the behaviour manifest. Reviewer confirms ADR-0006 compliance (no automation-v1 names, no LOCAL-OVERRIDE block reintroduced, project-context read-instruction intact).

**Dependencies:** Chunk 2 (contract referenced in prose). Independent of 1/4/5.

**Verification:** grep directly in the framework — `grep -n "capture-surface" .claude/agents/mockup-designer.md`, `grep -n "Step 3c" .claude/agents/mockup-designer.md`, `grep -n "fall back\|fallback" .claude/agents/mockup-designer.md`. No toolchain.

---

### Chunk 4 — `mockup-reviewer` Axis 1 capture checks + new Axis 4

**Scope:** Edit `.claude/agents/mockup-reviewer.md`. Add capture-aware checks to Axis 1, add Axis 4 (behaviour completeness), update context-loading list and the blocking/should-fix tier lists. Project-agnostic prose. Does NOT edit other agents.

**File edited:** `.claude-framework/.claude/agents/mockup-reviewer.md`

**Edits:**
1. **Context Loading:** add "read the capture manifest at `prototypes/{slug}/_captures/manifest.json`" and "read `tasks/builds/{slug}/behaviour-manifest.md`".
2. **Axis 1 (§4.5):** add four capture-aware checks — (a) capture-present-or-downgrade-justified: a `captured` claim with no artifact at the cited path is 🔴; (b) mockup vocabulary (tab labels, status-pill text, column headers) must match the *captured DOM outline*, not just source — drift the brief didn't request is 🟡, escalating to 🔴 if it implies a phantom surface; (c) token fidelity (advisory): gross departure from the captured token sheet without justification is 🟡; (d) fallback explicit: `fallback_source_read` acceptable ONLY with a recorded reason; silently skipped capture on a renderable surface is 🔴.
3. **Axis 4 — Behaviour completeness (§5.4):** new orthogonal axis. Verify `behaviour-manifest.md` exists, has a row-per-screen, no unanswered §5.2 checklist items. Missing manifest 🔴; unanswered required row 🔴; `n/a` without reason 🟡. Reviewer judges *specified*, not *good* (taste is operator's).
4. **Update the axes preamble** ("three orthogonal axes" → four) and the 🔴/🟡 tier lists to include the new findings. Update the verdict logic so all FOUR axes must be CLEAN.

**Module shape:** prose. *Public surface:* anchors A4 greps (`Axis 1` references capture manifest; `Axis 4` references behaviour checklist). *Hidden:* none.

**Contracts:** Axis 1 references the capture manifest; Axis 4 references the §5.2 behaviour checklist. Severity mapping per §4.5/§5.4 above.

**Test considerations:** A4 grep — Axis 1 references the capture manifest; Axis 4 references the behaviour checklist. Confirm the "three axes → four axes" update is consistent everywhere it appears (preamble + verdict logic). ADR-0006 compliance.

**Dependencies:** Chunk 2. Independent of 1/3/5.

**Verification:** grep in the framework — `grep -n "Axis 4" .claude/agents/mockup-reviewer.md`, `grep -n "capture manifest\|_captures" .claude/agents/mockup-reviewer.md`, `grep -n "behaviour" .claude/agents/mockup-reviewer.md`. No toolchain.

---

### Chunk 5 — `spec-coordinator` Step 6 behaviour pull-through + behaviour-manifest template

**Scope:** Edit `.claude/agents/spec-coordinator.md` Step 6 to pull the behaviour manifest into the authored spec under an `## Interaction behaviour` section; add the behaviour-manifest template file; add the new artifacts to the coordinator artifact/persistence lists (review #5). Does NOT edit the scope-excluded agents (feature-coordinator, architect, builder, plan-reviewers, build-scheduler).

**Files:**
- *Edited:* `.claude-framework/.claude/agents/spec-coordinator.md` (Step 6, near the existing "If the brief was UI-touching and mockups were produced..." line at ~472; and Step 5/Step 9 handoff artifact references).
- *Edited (review #5):* `.claude-framework/.claude/agents/mockup-coordinator.md` — Step 8 completion sequence + the per-round/final completion block (lines ~41, ~117) so the coordinator's artifact list explicitly preserves/references the capture manifest (`prototypes/{slug}/_captures/manifest.json`) and the behaviour manifest (`tasks/builds/{slug}/behaviour-manifest.md`) alongside `mockup-log.md` and `mockup-review-log-*` (§6 says the coordinator persists them alongside the existing logs). Project-agnostic prose, ADR-0006.
- *Created:* `.claude-framework/docs/behaviour-manifest-template.md` — Markdown checklist with the fixed, grep-able §5.2 row set per §9-decision-4. Co-located with other `docs/*-template`/reference files.

**Edit to spec-coordinator Step 6:** add a clause — when a UI-touching spec is authored and a `behaviour-manifest.md` exists for the slug, pull its content into the spec under an `## Interaction behaviour` section so the contract survives into Phase 2 (plan + builder). Reference path `tasks/builds/{slug}/behaviour-manifest.md`. Also: spec-coordinator Step 5/Step 9 record the capture manifest + behaviour manifest paths alongside the existing `mockups:` handoff field so they are not dropped between phases (review #5).

**Behaviour-manifest template contents (A6 — must contain every §5.2 row):** fixed Markdown checklist, one block per screen, rows:
- **Reveal model** — scroll-driven vs click-driven vs always-visible per section; progressive-disclosure vs first-paint.
- **Interactive states** — per control: default, hover, focus, pressed/active, disabled, loading (hover states declare their tap equivalent).
- **Async states** — per data region: loading (skeleton/spinner/nothing), empty, error, populated.
- **Transitions and motion** — animations/transitions/scroll behaviour the design depends on (name intended behaviour, library only as reference).
- **Primary-action feedback** — what the operator sees after the one primary action (inline state preferred, toast, navigation, modal).
- **Input behaviour** — validation timing (on-blur vs on-submit), coupled-field enable/disable, mobile keyboard-open handling.
Each row supports `n/a` + one-line reason. Use `{{PROJECT_NAME}}` placeholders if any project name would otherwise appear.

**Module shape:** prose + a static template. *Public surface:* the `## Interaction behaviour` anchor (A5 grep) in spec-coordinator; the six checklist row labels (A6 grep) in the template. *Hidden:* none.

**Contracts:** spec-coordinator Step 6 references pulling the behaviour manifest into `## Interaction behaviour`. Template contains all six §5.2 rows verbatim-enough that A6 greps each.

**Test considerations:** A5 grep (`## Interaction behaviour` in spec-coordinator Step 6); A6 grep (each of the six §5.2 rows in the template). The cross-link must point at the manifest path Chunk 3 writes.

**Dependencies:** Chunk 2 (conceptual contract). Independent of 1/3/4.

**Verification:** grep in the framework — `grep -n "Interaction behaviour" .claude/agents/spec-coordinator.md`; grep each row label in `docs/behaviour-manifest-template.md`; `grep -n "_captures\|behaviour-manifest" .claude/agents/mockup-coordinator.md` (review #5 — confirm the coordinator's artifact list references both new artifacts). No toolchain. Record in `progress.md` that the existing mockup loop does not discard `prototypes/{slug}/_captures/manifest.json` or `tasks/builds/{slug}/behaviour-manifest.md`.

---

### Chunk 6 — Docs + cross-links + ADR + version bump + manifest entries

**Scope:** All doc-sync surface, the ADR, the version bump, and the `manifest.json` `managedFiles` entries for every new shipped file. Depends on all prior chunks (documents and registers them).

**Files edited:**
- `docs/frontend-design-principles.md` — add two human-readable subsections (full sentences, `{{PROJECT_NAME}}`/`{{COMPANY_NAME}}` placeholders, KEEP the existing `LOCAL-OVERRIDE` block — docs retain it, only agents deprecated it):
  - **"Ground in the real render"** — observe-don't-guess; designer works from a real capture (screenshot + token sheet + DOM outline), not source inference; fallback is explicit.
  - **"Interaction behaviour"** — point at the behaviour-manifest checklist; do not duplicate the rows, cross-reference them.
- `docs/mobile-capability-principles.md` — add cross-links from the hover-only rule (§ Hover does not equal tap) and the keyboard rule (§ Keyboard handling) to the behaviour checklist's Interactive-states / Input-behaviour rows. Cross-link, DO NOT duplicate (§6). KEEP the `LOCAL-OVERRIDE` block.
- `.claude/CHANGELOG.md` — add a `## 2.24.0 — {date}` entry: **Added** (capture script + pure extractors + manifest validator + behaviour-manifest template + ADR-0007); **Changed** (mockup-designer Step 0a/3c, mockup-reviewer Axis 1/4, spec-coordinator Step 6, mockup-coordinator artifact persistence, frontend/mobile docs). Operator note: if a parallel build merged first, bump to the next free version and re-stack.
- `.claude/FRAMEWORK_VERSION` — `2.24.0`.
- `manifest.json` — bump `frameworkVersion` to `2.24.0` (also closes the existing 2.23.0/2.20.0 drift) AND add the `managedFiles` entries below.
- `docs/doc-sync.md` — only if a new doc-sync trigger is introduced; else record "no new trigger" verdict. (`adopt-only` template; edit ships once.)
- **`docs/capabilities.md` doc-sync verdict (review #4 — §6/§10 require the verdict be recorded even when n/a).** This is a consuming-repo product registry (not present/managed in the framework). Record the explicit verdict in `progress.md` under a `## Doc-sync verdicts` heading: `docs/capabilities.md: n/a — internal tooling only, no product capability change`. If the framework repo carries its own `docs/capabilities.md`, record the same verdict there per its doc-sync convention.

**Files created:**
- `docs/decisions/0007-ground-mockups-in-real-render.md` — ADR per §10: "Mockups ground in real rendered output, not source inference." Context (no-UAT conditions, drift risk), Decision (render-grounded default-on when renderable, always degradable, never a hard gate), Consequences, Alternatives (source-read only — rejected; model-reads-screenshot — rejected per the model-collapse check), When to revisit. Use `docs/decisions/_template.md` shape (match 0006's style).

**`manifest.json` `managedFiles` entries to ADD (mirror existing rows):**
```
{ "path": "scripts/mockup/capture-surface.ts",              "category": "helper-script",      "mode": "sync",       "substituteAt": "never" }
{ "path": "scripts/mockup/capture-surfacePure.ts",          "category": "helper-script",      "mode": "sync",       "substituteAt": "never" }
{ "path": "scripts/mockup/capture-manifestPure.ts",         "category": "helper-script",      "mode": "sync",       "substituteAt": "never" }
{ "path": "scripts/__tests__/capture-surfacePure.test.ts",  "category": "helper-script-test", "mode": "sync",       "substituteAt": "never" }
{ "path": "scripts/__tests__/capture-manifestPure.test.ts", "category": "helper-script-test", "mode": "sync",       "substituteAt": "never" }
{ "path": "docs/behaviour-manifest-template.md",            "category": "template",           "mode": "adopt-only", "substituteAt": "adoption" }
{ "path": "docs/decisions/0007-*.md",                       "category": "adr",                "mode": "sync",       "substituteAt": "never" }
```
Rationale: scripts/tests mirror the existing `helper-script`/`helper-script-test` rows (cross-repo-scout, experiment-runner, audit-context-packs). The behaviour-manifest template is `adopt-only` + `substituteAt: adoption` (repo-populated scaffolding, like `docs/spec-context.md`/`docs/frontend-design-examples.md`). ADR-0007 `sync`/`never` mirrors 0001/0002/0005/0006.

**Module shape:** docs + config. *Public surface:* the A7 grep anchors (new subsections in both docs; CHANGELOG entry; version bump) + the manifest entries that make sync work. *Hidden:* none.

**Error handling:** n/a.

**Test considerations (A7):** both docs carry the new subsections/cross-links; CHANGELOG records 2.24.0; `FRAMEWORK_VERSION` = 2.24.0; `manifest.json frameworkVersion` = 2.24.0 and contains all seven new entries. Confirm both docs RETAIN their `LOCAL-OVERRIDE` blocks. Confirm placeholders used, not hardcoded names.

**Dependencies:** ALL of Chunks 1–5.

**Verification:** grep + manual diff in the framework — `grep -n "Ground in the real render" docs/frontend-design-principles.md`, `grep -n "Interaction behaviour" docs/frontend-design-principles.md`, `grep -n "behaviour" docs/mobile-capability-principles.md`, `grep -n "2.24.0" .claude/CHANGELOG.md .claude/FRAMEWORK_VERSION manifest.json`, `grep -n "capture-surface\|behaviour-manifest-template\|0007" manifest.json`. No toolchain.

---

## 5. Consuming-repo / post-sync action (NOT a framework chunk deliverable)

Binding constraint 7: `architecture.md` is in `manifest.json doNotTouch`; the framework repo's copy is not synced. The spec §10 "architecture.md frontend-conventions note" is a **consuming-repo doc-sync item**, executed in automation-v1 AFTER sync — NOT a deliverable of any framework chunk. Flagged so the operator schedules it as a post-sync follow-up in automation-v1 (add a short "Frontend conventions: mockups ground in real render; see frontend-design-principles.md" note to automation-v1's `architecture.md`).

---

## 6. Acceptance criteria → chunk → where verified

| Criterion | Chunk | Where verified |
|---|---|---|
| **A1** capture → screenshots 375/768/1280 + token sheet + DOM outline + `captureStatus: captured` | 1 | **automation-v1 post-sync only** (live UI server). Framework cannot run. → REVIEW_GAP |
| **A2** server-down → clean `fallback_source_read`/`server_unavailable`, no partial PNG | 1 | **automation-v1 post-sync only** (live, server deliberately down). → REVIEW_GAP |
| **A3** manifest validates; malformed rejected | 2 | automation-v1 vitest: `npx vitest run scripts/__tests__/capture-manifestPure.test.ts` (copy/sync first) |
| **A4** designer Step 0a/3c + reviewer Axis 1/4 anchors | 3, 4 | Framework grep (no toolchain) |
| **A5** spec-coordinator Step 6 `## Interaction behaviour` | 5 | Framework grep |
| **A6** behaviour-manifest template contains every §5.2 row | 5 | Framework grep (each row) |
| **A7** docs subsections/cross-links + CHANGELOG + version bump | 6 | Framework grep + version diff |
| **A8** lint + typecheck pass on new script + touched TS | 1, 2 | automation-v1 G2 (once, integrated): `npm run lint`, `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck` |

**REVIEW_GAP (record in `tasks/builds/grounded-mockups-render-and-behaviour/progress.md`):**
```
REVIEW_GAP: live-capture-verification (A1/A2) | task-class: Significant | reason: framework repo has no toolchain/UI server; live Playwright capture cannot run in .claude-framework | operator-override: no | remediation: verify A1/A2 in automation-v1 after sync — start npm run dev:server:ui, run capture-surface.ts against a known org-admin route (A1), then re-run with server down (A2)
```

**GRADED review posture:** No schema/migration/RLS/tenant-data surface (spec §10) → `adversarial-reviewer` not triggered; record the GRADED skip in `progress.md`. `dual-reviewer` applies (Significant) unless Codex unavailable → then a `REVIEW_GAP` for it. `chatgpt-pr-review` is enforced at Phase 3 by finalisation-coordinator.

---

## 7. Risks & mitigations

1. **Toolchain split is the load-bearing assumption.** Every TS/test/live check runs in automation-v1, not the framework. *Mitigation:* per-chunk verification explicitly names "copy/sync into automation-v1, run there"; A1/A2 carry a REVIEW_GAP so the cross-repo step is not silently skipped.
2. **Wrong test-harness pattern-match.** The older `cross-repo-scoutPure.test.ts` uses `node:test`; copying it would fail `verify-test-quality.sh`. *Mitigation:* Decision 2 pins Vitest and names `chatgpt-reviewPure.test.ts` as the correct neighbour.
3. **manifest.json entries forgotten → feature never syncs (silent failure).** *Mitigation:* Chunk 6 lists all seven entries explicitly; A7 greps `manifest.json` for them.
4. **ADR-0006 violation in agent edits.** Hardcoding automation-v1 paths/names in Chunks 3/4/5 would corrupt framework-canonical files. *Mitigation:* each agent chunk states "conventional consuming-repo path only, no automation-v1 specifics, no LOCAL-OVERRIDE reintroduction"; reviewer checks it.
5. **Version drift / parallel-build race.** Two open builds may both claim 2.24.0. *Mitigation:* operator note in Chunk 6 — take the next free version and re-stack the CHANGELOG entry if a parallel build merged first.
6. **Partial-write corruption on capture failure (A2) — "exists" is not "correct".** A crashed Playwright run could leave a half-written PNG and a `captured` claim that lies. *Mitigation:* impure script writes screenshots to temp + renames on success; on failure writes only the `fallback_source_read` status, no PNG. Axis 1 check (a) treats a `captured` claim with no/partial artifact at the cited path as 🔴 — closing the "exists ≠ correct" state-lie gap.
7. **`data_absent` ambiguity.** §4.6 says capture the empty state AND flag `data_absent`, but `data_absent` is a fallback-reason. *Mitigation:* Chunk 2 validator allows a screenshot to exist with `data_absent`; the designer still grounds layout from the empty state (Chunk 3 prose).

---

## 8. Self-consistency pass

- **Goals vs implementation:** G1 (real render) → Chunk 1; G2 (verifiable by reviewer) → Chunk 4 Axis 1; G3 (behaviour first-class) → Chunks 3/5 + template; G4 (graceful degrade) → Chunk 1 fallback + Chunk 2 enum; G5 (operator simplicity intact) → no operator-facing change, agent-internal only. All five mapped.
- **Pillar independence (§3):** Pillar A = Chunks 1/2 + Chunk 4 Axis 1 + Chunk 3 Step 0a; Pillar B = Chunk 3 Step 3c + Chunk 4 Axis 4 + Chunk 5. Either can ship alone; both share Chunk 6 doc-sync. Consistent with §3.
- **Single source of truth:** behaviour-manifest.md is authoritative (§5.3); the spec's `## Interaction behaviour` is the pull-through (Chunk 5); prototype demonstration is optional (§9-decision-5). No competing source. Capture manifest is the single Axis-1 contract.
- **Decisions §9 respected:** page-wide token sheet (1) → Chunk 1 `extractTokenSheet`; org-admin+system-admin parameterised (2) → Chunk 1 `role` param; captures committed (3) → output under `prototypes/{slug}/_captures/`; Markdown checklist (4) → Chunk 5 template; manifest required / demo optional (5) → Chunks 3/4; default-on-degradable-never-gate (6) → Chunk 1 + spec prose. None reopened.
- **Test-gate policy:** no forbidden gate commands anywhere; per-chunk verification is scoped lint + targeted vitest only; typecheck/build deferred to G2.

---

## 9. G2 (end-of-construction, coordinator-owned, run in automation-v1 once)

After all chunks built and synced into automation-v1: `npm run lint`, `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck`, and `npm run build:server`/`npm run build:client` as relevant against integrated branch state. Not per-chunk.

---

## 10. Plan review — iteration 1 (applied)

External plan review (CHANGES_REQUESTED). All five findings were technical contract-fidelity issues against the spec; applied directly (none were product-surface decisions).

1. **#1 (High) — three-viewport `captured` contract.** Validator now requires a screenshot path for *every* viewport in the entry's `viewports` array (a single screenshot on a 375/768/1280 entry fails); added the "missing 768" rejection test. (Chunk 2 + Chunk 1.)
2. **#2 (High) — DOM outline is structured, not a digest.** Replaced `domOutlineDigest` with a structured `domOutline` (`navItems/tabLabels/headings/tableColumnHeaders/primaryButtons/statusPills`, each real `textContent`); `captured` requires a non-empty outline; `pruneDomOutline` emits it; added accept/reject tests. This is what Axis 1(b) greps. (Chunk 2 + Chunk 1.)
3. **#3 (Medium) — `failed` semantics defined.** `fallback_source_read` is the status for ordinary/anticipated failures (with reason); `failed` is the unrecoverable internal bucket requiring a `failureReason` and carrying no captured-shape fields; designer degrades on both. Never a hard gate (§4.6 preserved). (Chunk 2 + Chunk 1.)
4. **#4 (Medium) — `docs/capabilities.md` doc-sync verdict recorded.** Chunk 6 now records the explicit `n/a — internal tooling only` verdict in `progress.md § Doc-sync verdicts` (file is a consuming-repo registry). 
5. **#5 (Low) — coordinator artifact persistence.** Chunk 5 now edits `mockup-coordinator.md` (and spec-coordinator Step 5/9 handoff) so the capture manifest + behaviour manifest are preserved/referenced alongside the existing mockup logs (§6); verification greps for it.

### Iteration 2 (APPROVED with two low cleanups — applied)

- **Cleanup 1 — agent count.** Header classification corrected to "4 framework agents" (adds mockup-coordinator); Chunk 6 CHANGELOG "Changed" list now includes mockup-coordinator artifact persistence.
- **Cleanup 2 — discriminated union.** `CaptureScreenEntry` specified as `CapturedScreenEntry | FallbackSourceReadScreenEntry | FailedScreenEntry` (above), so the captured-carries-all / failed-carries-none contract is compile-time enforced, not all-optional fields.

**Plan status: APPROVED. Build authorised to run autonomously through to a PR into claude-framework (no merge).**
