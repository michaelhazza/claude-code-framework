# Spec Conformance Log

**Spec:** `tasks/builds/grounded-mockups-render-and-behaviour/spec.md`
**Spec commit at check:** `e7a1776`
**Branch:** `claude/build-grounded-mockups`
**Base:** `a0303b2a45d4a829ae2066f402e2311441bccc89`
**Repo:** `.claude-framework` (claude-code-framework, mounted as a submodule of automation-v1; verified IN the submodule, not the parent)
**Scope:** all-of-spec (single completed implementation; caller-confirmed). A1/A2 live capture is a documented REVIEW_GAP, excluded from conformance per caller instruction.
**Changed-code set:** 17 files (spec.md, plan.md, progress.md excluded)
**Run at:** 2026-06-19T03:26:53Z
**Commit at finish:** `9856b81`

---

## Summary

- Requirements extracted:     34
- PASS:                       32
- MECHANICAL_GAP → fixed:     0
- DIRECTIONAL_GAP → deferred: 0
- AMBIGUOUS → deferred:       0
- OUT_OF_SCOPE → skipped:     2 (A1, A2 — live-capture, documented REVIEW_GAP; not a conformance gap per caller + plan §6)

**Verdict:** CONFORMANT — no gaps. Proceed to `pr-reviewer`. No mechanical fixes applied, so no expanded-set re-review needed.

---

## Requirements extracted (full checklist)

### Capture manifest contract (§4.3, §4.6, plan Chunk 2) — `scripts/mockup/capture-manifestPure.ts`

| REQ | Requirement | Verdict | Evidence |
|---|---|---|---|
| 1 | `CaptureStatus` enum exactly `captured \| fallback_source_read \| failed` | PASS | line 20 + `CAPTURE_STATUSES` line 109 |
| 2 | `FallbackReason` vocab incl. `route_unreachable_as_{role}` template | PASS | lines 27-31; `isValidFallbackReason` 147-154 (prefix + non-empty role token) |
| 3 | Per-screen entry is a discriminated union on `captureStatus`, not all-optional | PASS | `CaptureScreenEntry` lines 93-96; three variant interfaces 72-91 |
| 4 | `captured` requires a screenshot per listed viewport | PASS | `screenshotPathsForViewports` 227-240; case `captured` 266-270 |
| 5 | `captured` requires non-empty token sheet | PASS | `tokenSheetIssues` 161-179 (≥1 non-empty array) |
| 6 | `captured` requires non-empty structured `domOutline` (6 named arrays) | PASS | `DomOutline` 53-60; `domOutlineIssues` 182-200 |
| 7 | `fallback_source_read` requires valid `fallbackReason` | PASS | case 272-278 |
| 8 | `failed` requires `failureReason` and carries no captured-shape fields | PASS | case 279-288; `hasCapturedShapeFields` 243-249 |
| 9 | Validator never throws on bad input (returns structured result) | PASS | `validateCaptureManifest` 297-313, `isRecord` guard 300 |
| 10 | Top-level `{ slug, generatedAt, screens }` shape | PASS | `CaptureManifest` 98-103 |

### Capture script + pure extractors (§4.2, §9 decisions 1-3, plan Chunk 1)

| REQ | Requirement | Verdict | Evidence |
|---|---|---|---|
| 11 | `extractTokenSheet` produces ONE page-wide de-duplicated token sheet (not per-element) | PASS | `capture-surfacePure.ts` 92-120; `dedupeOrdered` 73-84 |
| 12 | `pruneDomOutline` emits structured outline (nav/tab/heading/columnHeader/primaryButton/statusPill) of real textContent | PASS | `capture-surfacePure.ts` 128-152 |
| 13 | `capture-surface.ts` per-viewport screenshots 375/768/1280, one path per viewport | PASS | `DEFAULT_VIEWPORTS` 70; per-viewport loop 189-210 |
| 14 | Output under `prototypes/{slug}/_captures/` | PASS | `capture-surface.ts` 236, 200 |
| 15 | Atomic screenshot write (no partial PNG on failure — A2) | PASS | `screenshotAtomic` 89-105 (tmp + rename, rm on error) |
| 16 | Graceful degradation: server down → `fallback_source_read`/`server_unavailable`, no PNG | PASS | `captureSurfaces` 242-249 |
| 17 | Route unreachable as role → `fallback_source_read`/`route_unreachable_as_{role}` | PASS | `captureOneScreen` 178-181, 194-197 |
| 18 | Unrecoverable per-screen error → `failed`+`failureReason`, no captured-shape fields | PASS | 257-260; `failedEntry` 159-169 |
| 19 | Reuses conventional consuming-repo UI-server/auth paths (ADR-0006, no project names) | PASS | header 14-28; `DEFAULT_AUTH_DIR` 72, `DEFAULT_BASE_URL` 71 |
| 20 | `role` is a free parameter (§9 decision 2) | PASS | `CaptureInput.role` 51; `storageStatePath` per-role 177 |
| 21 | Captures existing surfaces only, never the prototype | PASS | scope-guard header 9-10; input is `{screenId,route,role}` only |
| 22 | Pure extractors Vitest-tested (not node:test) | PASS | both `__tests__` files import from `'vitest'` |

### `mockup-designer` edits (§4.4, §5.4, plan Chunk 3, A4)

| REQ | Requirement | Verdict | Evidence |
|---|---|---|---|
| 23 | Step 0a render-capture sub-step (item 2a), ordered before drafting | PASS | `mockup-designer.md` line 33 |
| 24 | Step 0a names the fallback path with reasons | PASS | line 33 (server_unavailable / route_unreachable / data_absent / n/a_new_surface) |
| 25 | Grounding-list extension cites source file + capture status + paths | PASS | line 34; round-summary template 190-194 |
| 26 | New Step 3c authors behaviour manifest, §5.2 checklist | PASS | lines 165-180 |
| 27 | TodoWrite skeleton + round-summary updated for capture status + manifest | PASS | Step 1 lines 45-52; Step 4 209-216 |

### `mockup-reviewer` edits (§4.5, §5.4, plan Chunk 4, A4)

| REQ | Requirement | Verdict | Evidence |
|---|---|---|---|
| 28 | Axis 1 four capture-aware checks (present/match/token-fidelity/fallback-explicit) | PASS | `mockup-reviewer.md` 48-53 |
| 29 | Context Loading reads capture manifest + behaviour manifest | PASS | items 9-10, lines 30-31 |
| 30 | New Axis 4 behaviour completeness (specified, not taste) | PASS | lines 122-131 |
| 31 | Preamble "four axes" + tier lists + verdict logic consistent | PASS | line 35; 🔴 list 156-159; 🟡 list 173-175 |

### `spec-coordinator` + `mockup-coordinator` + template (§5.4, §6, plan Chunk 5, A5/A6)

| REQ | Requirement | Verdict | Evidence |
|---|---|---|---|
| 32 | spec-coordinator Step 6 pulls manifest into `## Interaction behaviour` (A5) | PASS | `spec-coordinator.md` line 474; handoff fields 601-602 |
| 33 | mockup-coordinator persists capture + behaviour manifests alongside logs | PASS | `mockup-coordinator.md` lines 92, 130-131; spec-coordinator 399 |
| 34 | Behaviour template contains all six §5.2 rows (A6) | PASS | `behaviour-manifest-template.md` 16-32 (6/6 rows present) |

### Docs + version + ADR + manifest (§10, plan Chunk 6, A7)

| REQ | Requirement | Verdict | Evidence |
|---|---|---|---|
| 35 | frontend-design-principles: "Ground in the real render" + "Interaction behaviour" subsections | PASS | lines 159-171; LOCAL-OVERRIDE retained 153-157; `{{PROJECT_NAME}}` used |
| 36 | mobile-capability-principles cross-links behaviour checklist (no dup) | PASS | lines 146, 161; LOCAL-OVERRIDE retained 253-257 |
| 37 | ADR-0007 written, template shape | PASS | `docs/decisions/0007-ground-mockups-in-real-render.md` (Context/Decision/Consequences/Alternatives/Revisit) |
| 38 | FRAMEWORK_VERSION = 2.24.0; manifest frameworkVersion = 2.24.0 (closes drift) | PASS | `cat -A` = `2.24.0`; manifest.json line 2 |
| 39 | CHANGELOG 2.24.0 entry (Added + Changed) | PASS | `.claude/CHANGELOG.md` line 35 block |
| 40 | manifest 7 new managedFiles entries (5 scripts/tests + template + ADR-0007) | PASS | manifest.json diff — all 7 present, categories/modes match existing rows |
| 41 | doc-sync trigger row for the new contract | PASS | `docs/doc-sync.md` new row (mobile + behaviour-template trigger) |

### Live capture (A1/A2) — OUT_OF_SCOPE

| REQ | Requirement | Verdict | Evidence |
|---|---|---|---|
| A1 | Live capture against real route → `captured` + artifacts | OUT_OF_SCOPE | REVIEW_GAP in progress.md; framework has no browser; verified post-sync in automation-v1 |
| A2 | Server-down → clean `fallback_source_read`, no partial PNG | OUT_OF_SCOPE | same REVIEW_GAP; code path verified statically (REQ 15-16) |

---

## Mechanical fixes applied

None. Every extracted requirement passed on first verification.

---

## Directional / ambiguous gaps (routed to tasks/todo.md)

None.

---

## Files modified by this run

None (read-only verification; this log is the only artifact written).

---

## Next step

CONFORMANT — no gaps. Proceed to `pr-reviewer`. No mechanical fixes were applied, so the changed-code set is unchanged and no expanded-set re-review is required. The A1/A2 live-capture REVIEW_GAP remains the only open verification item; it is correctly deferred to post-sync execution in automation-v1 (not a framework-repo conformance gap).
