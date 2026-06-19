# Spec: Render-Grounded Mockups + Behaviour Capture

**Status:** DRAFT (iteration 1 decisions applied; see §9)
**Date:** 2026-06-18
**Target:** Claude framework (canonical agent files + supporting scripts), authored from `automation-v1`
**Classification:** Significant (multiple framework agents, new artifact contract, new capture script, doc-sync)
**Build branch (intended):** dedicated branch, separate from the parallel-worktree feature

## Table of contents

1. Problem and motivation
2. Goals and non-goals
3. Two pillars at a glance
4. Pillar A — Render-grounded mockups
5. Pillar B — Behaviour capture
6. Integration boundaries
7. Chunk plan
8. Acceptance criteria
9. Open questions (for iteration)
10. Framework, versioning, and doc-sync impact

---

## 1. Problem and motivation

The product is currently being developed primarily off mockups. No validation testing, usability testing, or UAT has run against any of those mockups yet. That means the mockup is doing load-bearing work as the de-facto spec for what gets built, and any inaccuracy in a mockup propagates straight into shipped code as drift.

Two specific weaknesses in the current mockup pipeline amplify that risk:

- **Grounding is inferred, not observed.** `mockup-designer` Step 0a ("codebase grounding pass") grounds a new mockup by *reading the source `.tsx` files* of the pages it extends and inferring their rendered shape. Reading source is better than nothing, but the designer never sees the actual rendered page: real spacing, real fonts, real colours, real component composition at runtime, real current-state copy. The mockup is an approximation of an approximation. `mockup-reviewer` then verifies grounding by re-reading the same source files, so a wrong inference by the designer can be confirmed as "grounded" by the reviewer.

- **Behaviour is unspecified.** The pipeline pins *layout* (where things sit, the five hard rules, mobile shape) but says almost nothing about *interaction behaviour*: scroll-driven vs click-driven reveals, hover/press states, transitions, loading/empty/error states, optimistic updates, scroll libraries. When behaviour is not written down, the builder guesses it, and "looks right but feels wrong" is exactly the class of rework that surfaces late.

The AI Website Cloner pattern that motivated this spec attacks both: it drives a real browser, reads the live DOM and computed CSS off every element (it observes, it does not guess), and it explicitly captures behaviour (scroll vs click, hover, smooth-scroll). We adopt the *principle*, not the tool: reduce guessing on both axes.

**Enabling fact.** This repo already ships Playwright (`@playwright/test`) plus a dedicated UI test server (`npm run dev:server:ui`, `scripts/start-ui-test-server.ts`) and mobile-viewport projects. Render-grounding reuses that existing harness; it does not introduce new browser-automation infrastructure.

## 2. Goals and non-goals

### Goals

- **G1.** Ground every "extends an existing page" mockup in the *real rendered current state* of that page, not just its source. The designer works from an actual screenshot + a structured capture of the live page, and the Before view in any Before/After pairing is a real capture, not a hand-drawn approximation.
- **G2.** Make grounding *verifiable by the reviewer against observed reality* — `mockup-reviewer` checks the mockup against the capture artifact, not only against re-read source.
- **G3.** Capture interaction *behaviour* as a first-class part of the mockup deliverable: a behaviour manifest per screen that pins the interaction contract the builder must honour.
- **G4.** Degrade gracefully. When the running app cannot render the target surface (no dev server, auth-gated route, missing seed data), the pipeline falls back to today's source-read grounding with an explicit, logged downgrade, never a silent one.
- **G5.** Keep the operator-facing simplicity bar intact. None of this adds operator-facing complexity to mockups; it changes how the designer and reviewer *work*, not what the operator sees.

### Non-goals

- **NG1.** Not cloning external websites. The capture target is *our own running app's existing surfaces*, to ground extensions of them. No external-URL ingestion.
- **NG2.** Not auto-generating the mockup from the capture. The capture grounds the designer; the designer still designs. We are not building a screenshot-to-React generator.
- **NG3.** Not replacing the Playwright UI test suite or its config. We reuse its server bootstrap and browser context; we do not fold mockup capture into the CI UI gate.
- **NG4.** Not pixel-perfect cloning of our own pages. The goal is faithful grounding (real tokens, real structure, real copy), not byte-identical reproduction.
- **NG5.** Not a behaviour *implementation* spec. The behaviour manifest is a contract the builder reads; this spec does not prescribe the runtime animation stack.

## 3. Two pillars at a glance

| | Pillar A — Render-grounded mockups | Pillar B — Behaviour capture |
|---|---|---|
| **Principle** | Observe, don't guess (the *what*) | Pin behaviour, not just looks (the *how*) |
| **New artifact** | Capture manifest per extended screen (`prototypes/{slug}/_captures/`) | Behaviour manifest per screen (`tasks/builds/{slug}/behaviour-manifest.md`) |
| **New script** | `scripts/mockup/capture-surface.ts` (Playwright-driven) | none — manifest is authored, with a checklist gate |
| **mockup-designer change** | Step 0a captures real render before drafting | New Step 3c authors the behaviour manifest |
| **mockup-reviewer change** | New Axis-1 check: mockup matches capture | New Axis-4: behaviour manifest completeness |
| **Degradation** | Falls back to source-read grounding, logged | Manifest required regardless; capture optional |

The two pillars are independent and can ship in either order or separately. They share the mockup pipeline and are specced together because they touch the same three agents (`mockup-designer`, `mockup-reviewer`, `spec-coordinator`) and the same doc-sync surface, so one build round is cheaper than two.

## 4. Pillar A — Render-grounded mockups

### 4.1 Current vs target

- **Current (source-read grounding).** `mockup-designer` Step 0a: enumerate `client/src/pages/`, identify the page being extended, Read the `.tsx`, infer layout/vocabulary, draft HTML. `mockup-reviewer` Axis 1: re-Read the same `.tsx` to confirm the file exists and "looks like an extension."
- **Target (render-grounded).** Step 0a additionally captures the *live rendered* current state of each surface being extended into a capture manifest. The designer drafts from the real screenshot + extracted design tokens + DOM outline. The reviewer verifies the mockup against the capture, closing the "designer and reviewer both read the same wrong inference" loop.

Source-read grounding is retained as the fallback (§4.6), not removed. Render-grounding is the new default *when the surface is renderable*.

### 4.2 Capture mechanism — `scripts/mockup/capture-surface.ts`

A new Playwright-driven script that reuses the existing UI-test server bootstrap (`scripts/start-ui-test-server.ts`) and authenticated browser context (the UI suite already logs in as `org-admin`, `system-admin`, etc.). Input: a list of `{ screenId, route, viewport, role }`. For each entry it:

1. Boots (or attaches to) the UI test server, navigates to `route` as `role`, waits for network-idle + a settle delay.
2. Captures, per screen and per viewport (375 / 768 / 1280, mirroring the mobile-shape mandate):
   - **Screenshot** (full-page PNG) → `prototypes/{slug}/_captures/{screenId}-{viewport}.png`.
   - **Computed design tokens** — the de-duplicated set of computed CSS values actually in use on the page: colours (background/text/border), font families + sizes + weights, spacing scale (margins/paddings/gaps), border-radii, shadows. Emitted as a small JSON token sheet, NOT a full per-element CSS dump.
   - **DOM outline** — a pruned structural tree (landmark + heading + interactive-control level, not every span): nav items present, tab labels, section headings, table column headers, primary buttons, status-pill text. This is the "real vocabulary" source the designer must inherit.
3. Writes a per-screen capture manifest entry (§4.3).

Scope guard: the script captures *existing* surfaces only (grounding inputs). It never captures the prototype itself. Output lives under `prototypes/{slug}/_captures/` and is committed with the mockup so the reviewer and future rounds can diff against it.

Reuse over rebuild: the script must import the existing UI-test server/auth setup rather than re-implement login. If the UI-test harness exposes a reusable context factory, use it; if not, the first chunk extracts a thin shared helper (the fourth-occurrence rule does not apply — this is deliberate reuse of one existing mechanism).

### 4.3 Capture manifest artifact

Per build, `prototypes/{slug}/_captures/manifest.json` records, for each captured screen: `screenId`, `route`, `role`, `capturedAt` (UTC ISO 8601), the viewport list, screenshot paths, the token sheet, the structured DOM outline (real nav / tabs / headings / column headers / primary buttons / status pills, not a digest), and a `captureStatus` of `captured | fallback_source_read | failed`. The manifest is the contract `mockup-reviewer` reads in Axis 1.

### 4.4 `mockup-designer` changes (Step 0a upgrade)

Step 0a gains a render-capture sub-step, ordered *before* drafting:

1. Identify the existing surfaces being extended (unchanged — still enumerate `client/src/pages/`).
2. **NEW:** run `capture-surface.ts` for those surfaces (route + role + viewports). If capture succeeds, Read the screenshots and token sheet; ground the draft in the captured tokens (real colours/spacing/fonts) and the captured DOM outline (real tab labels, status-pill text, column headers).
3. If capture fails or the surface is non-renderable, fall back to source-read grounding (§4.6) and record the downgrade.
4. The round summary's per-screen grounding list (already mandatory) extends to cite, per screen, both the source file *and* the capture status + capture paths. "Grounded" now means "grounded against the capture (or explicitly fell back, with reason)."

The designer still applies the five hard rules, the operator-vocabulary rule, and the mobile-shape mandate unchanged. Render-grounding feeds those rules better inputs; it does not relax them.

### 4.5 `mockup-reviewer` changes (Axis 1)

Axis 1 (Grounding) gains capture-aware checks:

- **Capture present or downgrade justified.** If the round summary claims `captured`, the capture manifest and screenshots must exist at the cited paths. A `captured` claim with no artifact is 🔴.
- **Mockup matches capture, not just source.** The mockup's inherited vocabulary (tab labels, status-pill text, column headers) must match the *captured DOM outline*, not only the source file. Divergence the brief did not request is 🟡 (vocabulary drift), escalating to 🔴 if it implies a phantom surface.
- **Token fidelity (advisory).** Gross departures from the captured token sheet (a different colour system, a font the page doesn't use) without brief justification are 🟡.
- **Fallback is explicit.** A `fallback_source_read` status is acceptable *only* with a recorded reason (§4.6). A round that silently skipped capture on a renderable surface is 🔴 (process violation, mirrors today's "claimed grounded without enumeration" rule).

### 4.6 Failure modes and graceful degradation

Capture can legitimately fail. Each falls back to source-read grounding with a logged reason in the capture manifest and the round summary:

- **App not running / cannot boot UI server** → `fallback_source_read`, reason `server_unavailable`.
- **Auth-gated or role-gated route the harness can't reach** → `fallback_source_read`, reason `route_unreachable_as_{role}`.
- **Surface requires seed data not present** (empty state only) → capture the empty state, flag `data_absent`; designer still grounds layout from it.
- **Brand-new surface with no existing page to extend** → no capture target by definition; record `n/a_new_surface`. This is the existing "new dedicated page requires justification" path, unchanged.

The hard rule: capture is *best-effort grounding input*, never a *gate*. A failed capture never blocks the mockup round; it only downgrades grounding to today's behaviour, explicitly.

## 5. Pillar B — Behaviour capture

### 5.1 The behaviour manifest

A new authored artifact, `tasks/builds/{slug}/behaviour-manifest.md`, that pins the interaction contract for every screen in the mockup. It is the missing half of the spec: layout says where things sit; the behaviour manifest says how they behave. The builder reads it as a contract; `mockup-reviewer` gates its completeness.

### 5.2 What gets captured (the behaviour checklist)

Per screen, the manifest answers each of these (or marks `n/a` with a reason). The checklist is the gate; an unanswered row is an incomplete manifest.

- **Reveal model** — scroll-driven vs click-driven vs always-visible for each major section. Which content is progressive-disclosure (tab, drawer, expand-on-click) vs on first paint.
- **Interactive states** — for every interactive control: default, hover, focus, pressed/active, disabled, loading. (Hover states must declare their *tap equivalent*, reusing the existing mobile hover-only rule.)
- **Async states** — for every data region: loading (skeleton vs spinner vs nothing), empty, error, and populated. The "happy path only" mockup is the failure this row prevents, and it pairs with the existing Axis-1.5 capability-failure-state rule.
- **Transitions and motion** — any animation, transition, or scroll behaviour the design depends on: smooth-scroll, sticky headers on scroll, sheet/drawer slide-in, optimistic update then reconcile. Name the *intended behaviour*, not a library, though a library may be named as a reference (e.g. "smooth-scroll, Lenis-style").
- **Primary-action feedback** — what the operator sees after the one primary action fires: inline state change (preferred, per the inline-state hard rule), toast, navigation, modal.
- **Input behaviour** — validation timing (on-blur vs on-submit), coupled-field enable/disable (reuses the existing coupled-field-invariant rule), keyboard-open handling on mobile forms.

### 5.3 Where behaviour lives

Two surfaces, one source of truth:

- **Authoritative:** `tasks/builds/{slug}/behaviour-manifest.md` (the checklist above, per screen). This is what flows into the spec and downstream to the builder.
- **Optional demonstration:** the prototype HTML may demonstrate behaviour inline (hover styles, a click-to-expand, a skeleton-then-content toggle) where cheap. Demonstration is encouraged but not required; the manifest is the contract. Where the prototype demonstrates a behaviour, annotate the element so the reviewer can map demonstration to manifest row.

### 5.4 Agent changes for Pillar B

- **`mockup-designer`** gains Step 3c (Behaviour manifest): after drafting layout, author/update `behaviour-manifest.md` for each screen this round, completing the §5.2 checklist. Marked `n/a` rows require a one-line reason. The round summary references the manifest and lists any `n/a` rows.
- **`mockup-reviewer`** gains Axis 4 (Behaviour completeness): verify the manifest exists, has a row-per-screen, and has no unanswered checklist items. A missing manifest is 🔴; an unanswered required row is 🔴; an `n/a` without reason is 🟡. The reviewer does not judge whether the behaviour is *good* (that is operator/taste, not mechanical) — only whether it is *specified*.
- **`spec-coordinator`** (Step 6 spec authoring): when a UI-touching spec is authored, the behaviour manifest is pulled into the spec under an `## Interaction behaviour` section so the contract survives into Phase 2 (the plan and the builder), not just the mockup round. This is the load-bearing link that stops behaviour from being lost between mockup and build.

## 6. Integration boundaries

- **`mockup-coordinator` / `spec-coordinator` Step 5 (mockup loop).** The loop structure is unchanged: designer → reviewer → operator. Capture runs inside the designer's Step 0a; the manifest authoring inside Step 3c. No new loop stage. The coordinator persists the capture manifest and behaviour manifest alongside the existing `mockup-log.md` and `mockup-review-log-*`.
- **`docs/frontend-design-principles.md`** gains a short "Ground in the real render" subsection and an "Interaction behaviour" subsection pointing at the manifest checklist. (Human-readable; full sentences.)
- **`docs/mobile-capability-principles.md`** — the hover-only and keyboard-open rules are now *also* referenced from the behaviour checklist; cross-link, do not duplicate.
- **Playwright config / UI test server.** Read-only reuse. The capture script imports the server bootstrap and auth context; it must not modify Playwright projects or the CI UI gate.
- **CI.** No new CI gate. Capture is a local authoring aid. `lint` and `typecheck` cover the new TypeScript script. The capture script is never run in CI.
- **`docs/capabilities.md`.** No product capability change (this is internal tooling), so likely `n/a` at doc-sync, but the doc-sync gate must record the verdict explicitly.

## 7. Chunk plan

Architecture-level; the implementation plan (function signatures, exact file contracts) is produced by `architect` in Phase 2.

- **Chunk 1 — Capture script + shared server/auth helper.** `scripts/mockup/capture-surface.ts` plus the thin reusable UI-test-server/auth context helper it depends on. Token-sheet + DOM-outline extraction. Output to `prototypes/{slug}/_captures/`. Pure-function token/outline extractors get targeted unit tests.
- **Chunk 2 — Capture manifest contract.** The `manifest.json` shape, the `captureStatus` enum, the fallback-reason vocabulary, and a validator (so the reviewer can trust the artifact).
- **Chunk 3 — `mockup-designer` Step 0a upgrade + Step 3c.** Edit the framework-canonical agent file: render-capture sub-step, grounding-list extension, behaviour-manifest authoring, round-summary additions.
- **Chunk 4 — `mockup-reviewer` Axis 1 capture checks + Axis 4 behaviour completeness.** Edit the framework-canonical agent file.
- **Chunk 5 — `spec-coordinator` Step 6 behaviour pull-through + behaviour-manifest template.** Wire the manifest into the authored spec's `## Interaction behaviour` section; add the template.
- **Chunk 6 — Docs + doc-sync.** `frontend-design-principles.md`, `mobile-capability-principles.md` cross-links, `architecture.md` frontend-conventions note, `.claude/CHANGELOG.md`, framework version bump, `docs/doc-sync.md` if a new trigger is introduced.

Chunk dependency note (feeds the parallel-worktree feature, if landed first): Chunks 1 and 2 are independent of 3/4/5 (script + contract vs agent-file edits). Chunks 3, 4, 5 each edit a different agent file and are mutually independent once the contract (Chunk 2) exists. Chunk 6 depends on all.

## 8. Acceptance criteria

Verifiable assertions (the spec's success conditions, written as checks):

- **A1.** Running `capture-surface.ts` against a known existing route (e.g. an `org-admin` page) produces a screenshot at 375/768/1280, a non-empty token sheet, a DOM outline naming the page's real tab labels, and a `manifest.json` entry with `captureStatus: captured`. (Deterministic: artifacts exist, JSON validates.)
- **A2.** With the UI server deliberately down, the same invocation exits cleanly with `captureStatus: fallback_source_read`, reason `server_unavailable`, and writes no partial/corrupt screenshot. (Deterministic: status + absence of partial artifact.)
- **A3.** The capture manifest validates against its contract validator (Chunk 2). An intentionally malformed manifest is rejected. (Targeted unit test.)
- **A4.** `mockup-designer.md` Step 0a names the capture sub-step and the fallback path; Step 3c names the behaviour manifest. `mockup-reviewer.md` Axis 1 references the capture manifest and Axis 4 references the behaviour checklist. (Deterministic: grep the agent files for the required anchors.)
- **A5.** `spec-coordinator.md` Step 6 references pulling the behaviour manifest into an `## Interaction behaviour` spec section. (Deterministic: grep.)
- **A6.** A behaviour-manifest template exists and contains every §5.2 checklist row. (Deterministic: grep for each row.)
- **A7.** Doc-sync: `frontend-design-principles.md` and `mobile-capability-principles.md` carry the new subsections/cross-links; `.claude/CHANGELOG.md` records the feature; framework version bumped. (Deterministic: grep + version diff.)
- **A8.** `lint` and `typecheck` pass on the new script and any touched TypeScript.

## 9. Decisions (iteration 1, operator-confirmed)

All iteration-1 open questions resolved per recommendation. These are now binding for the plan.

1. **Token capture depth: page-wide de-duplicated token sheet.** v1 extracts one de-duplicated set of tokens per page (colours, fonts, spacing, radii, shadows), not per-element CSS. Richer per-region or per-element extraction is a deferred increment if grounding fidelity proves insufficient.
2. **Role coverage: `org-admin` + `system-admin` for v1, parameterised.** The script captures as these two roles initially, but `role` is a parameter so subaccount/operator personas can be added without a code change when a brief needs them.
3. **Captures are committed** under `prototypes/{slug}/_captures/`, co-located with the mockup, so the reviewer and future rounds can diff against them. PNGs are small; add a sanity note in Chunk 1 to keep full-page captures reasonably sized (downscale very tall pages if needed).
4. **Behaviour manifest format: Markdown checklist** with a fixed, grep-able row set. Human-skimmable for the operator; the reviewer greps the fixed rows for completeness. No YAML/JSON.
5. **Behaviour demonstration: manifest required, prototype demonstration encouraged not required.** The manifest is the contract; demonstrating a behaviour inline in the prototype is welcome where cheap but never gating.
6. **Render-grounding is default-on when renderable, always degradable, never a hard gate.** No "must capture or block" mode. A failed capture only downgrades to source-read grounding, explicitly logged (§4.6).

## 10. Framework, versioning, and doc-sync impact

- **Framework-canonical files edited:** `.claude/agents/mockup-designer.md`, `.claude/agents/mockup-reviewer.md`, `.claude/agents/spec-coordinator.md`. These sync from the `claude-code-framework` submodule; the change is authored here and lands in the framework per the submodule's upgrade/sync protocol (`.claude/CHANGELOG.md`, `FRAMEWORK_VERSION`).
- **New files:** `scripts/mockup/capture-surface.ts`, the capture-manifest validator, the behaviour-manifest template.
- **Docs:** `frontend-design-principles.md`, `mobile-capability-principles.md`, `architecture.md` (frontend conventions), `.claude/CHANGELOG.md`, `docs/doc-sync.md` (if a new trigger), `docs/capabilities.md` (likely `n/a`, record verdict).
- **ADR:** worth a short ADR — "Mockups ground in real rendered output, not source inference" — because it is a durable methodology choice with rationale (drift reduction under no-UAT conditions).
- **No schema, no migration, no RLS surface.** Not a tenant-data change; `adversarial-reviewer` likely not triggered (record the GRADED skip).
