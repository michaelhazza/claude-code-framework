# ChatGPT PR Review Session — claude-build-grounded-mockups — 2026-06-19T03-37-37Z

## Session Info
- Branch: claude/build-grounded-mockups
- PR: #27 — https://github.com/michaelhazza/claude-code-framework/pull/27
- Repo: michaelhazza/claude-code-framework (submodule at .claude-framework)
- Mode: automated
- Autonomy: unattended (sub-agent dispatch, no interactive operator)
- HUMAN_IN_LOOP: no (forced by unattended)
- Started: 2026-06-19T03:37:37Z

---

## Round 1 — 2026-06-19T03:39Z

Model: gpt-5.5 (served gpt-5.5-2026-04-23, match). Verdict: CHANGES_REQUESTED. 3 findings.
Diff: code-only, 17 files, 88KB (excluded tasks/review-logs, tasks/builds, KNOWLEDGE.md).
Top themes: error_handling, spec_delta.

Every concrete finding verified against the live `capture-surface.ts` / `docs/decisions/README.md` before triage (diff-misread guard) — all three confirmed valid.

### Recommendations and Decisions
| Finding | Triage | Recommendation | Final Decision | Severity | Rationale |
|---------|--------|----------------|----------------|----------|-----------|
| OAI-PR-001 Capture can hard-fail before writing the downgrade manifest | technical | implement | auto (implement) | medium | `chromium.launch()` was outside the try, so a missing-browser-binary repo rejected the whole round — contradicts §4.6 "capture is never a gate". ChatGPT tagged user_visible; overridden to technical: internal authoring tool, no customer surface (risk_domain:none confirmed by operator). |
| OAI-PR-002 Manifest persists absolute screenshot paths vs documented repo-relative contract | technical | implement | auto (implement) | medium | Default `outDir` rooted at projectRoot → absolute paths in the committed manifest; leaks local username/workspace layout. Docs/tests/changelog all say repo-relative. |
| OAI-PR-003 ADR-0007 not in decisions/README index | technical | implement | auto (implement) | low | doc-sync.md L26 requires updating `decisions/README.md` when a new ADR lands; 0007 was absent. |

All three triaged technical (internal framework tooling, risk_domain:none). None are user-facing product decisions, so none gated on operator approval. None hit an escalation carveout (all medium/low, scope local, confident fixes, no [missing-doc], no defer).

### Implemented (auto-applied technical)
- [auto] OAI-PR-001: `scripts/mockup/capture-surface.ts` — wrapped `chromium.launch()` in try/catch; on launch failure every screen degrades to a per-screen `failed` entry (reason `browser_unavailable: <msg>`) and the manifest is still written. Mirrors the existing `server_unavailable` degradation path.
- [auto] OAI-PR-002: `scripts/mockup/capture-surface.ts` — added pure `toRepoRelative()` helper; `screenshotPaths` now stores repo-relative POSIX paths (PNG still written to its absolute filesystem location). `projectRoot` threaded through `captureOneScreen`.
- [auto] OAI-PR-003: `docs/decisions/README.md` — added the ADR-0007 index row and advanced the "start local ADRs at NNNN" marker to 0008.

### Test acceptance — deferred to the existing A1/A2 REVIEW_GAP
OAI-PR-001 and OAI-PR-002 acceptance checks ask for a mocked-Playwright orchestrator test (`scripts/__tests__/capture-surface.test.ts`). Deferred, NOT added: the framework repo has no toolchain (no playwright/vitest install) and the parent automation-v1 repo does not carry these scripts, so such a test could never execute in either CI — it would be dead. The orchestrator's degradation paths are already covered by the build's intentional A1/A2 live-capture REVIEW_GAP (run in the consuming repo with a real browser). These two new behaviours (browser_unavailable → all `failed`; repo-relative manifest paths) extend what that live A1/A2 run must assert. Routed to tasks/todo.md.

### Verification
- Standalone `tsc --noEmit --strict` on the three capture scripts (via parent automation-v1 tsc + playwright types): EXIT 0.
- Pure modules (`capture-surfacePure.ts`, `capture-manifestPure.ts`) unchanged → existing 25 Vitest tests unaffected.
- Framework repo has no lint/typecheck/test toolchain by design (task constraint) — not run there.

---
