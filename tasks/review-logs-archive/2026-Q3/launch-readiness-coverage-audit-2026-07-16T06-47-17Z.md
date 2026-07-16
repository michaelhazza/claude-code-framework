# Launch-readiness coverage audit — 2026-07-16

**Scope:** Does this repo's own tooling (audit docs, verification gates, CI, checklists) catch launch-operations risk — for this repo itself, and in the audit tooling it ships to consumers? 17-item checklist per the operator brief. Tooling gaps closed in this change; product-level candidates queued, not built.

**Verdict:** After fixes: **4 covered / 0 partial / 0 missing / 13 N/A** for this repo; **17/17 covered** in the shipped audit template. Before fixes: item 5 (secrets) was *missing* its enforcement layer, item 17 (named critical paths) was *partial*.

**Run mode:** Main-session targeted coverage audit (not an `audit-runner` three-pass code audit — no application code was audited; the subject was the tooling itself).

---

## Step 0 — Preflight

- **Stack:** Node 22, CommonJS + TS test files, zero runtime dependencies (devDeps: vitest, tsx, ajv, ajv-formats, @types/node). No database, no server, no job system, no deploy target.
- **Repo type:** Library/tooling — the framework **producer**. Consumers mount it as a submodule at `.claude-framework/`; there is no submodule *here* to update (verified: no `.gitmodules`). Everything in this repo is upstream-canonical, so "route improvements upstream" terminates here.
- **Repo-owned calibrated audit doc:** none exists (`docs/codebase-audit-framework.md` absent by design); `docs/codebase-audit-framework-template.md` is the shipped canonical, so template-level additions live there directly. Nothing to port.
- **Prior art:** v2.41.0 (merged 2026-07-16, PR #43) already landed a launch-readiness coverage batch sourced from a consumer repo's 17-item review (automation-v1, 2026-07-15). This audit **verifies** that batch and closes the residual producer-side gaps rather than re-deriving it.

## Step 1 — Inventory (gates verified by invocation, not existence)

| Tooling | Invoked by | Status |
|---|---|---|
| `npm run test:sync` / `test:scripts` / `test:hooks` (glob-discovered via `scripts/run-tests.js`) | `.github/workflows/ci.yml` steps | enforced |
| `npm run validate` (`scripts/validate-framework.js`: frontmatter, skill pointers, schemas, markdown links, bundle hygiene) | ci.yml | enforced |
| `npm run eval:routing` (skill-routing evals) | ci.yml | enforced |
| `scripts/check-rule-ledger.js` (rule-ledger coverage) | ci.yml | enforced |
| Manifest/settings JSON validity, version consistency, removedFiles absence, schemas-vs-CHANGELOG diff gate | ci.yml inline steps | enforced |
| `scripts/check-secrets.js` (NEW this change) | ci.yml step added in the same change | enforced |
| `scripts/gates/*.sh` (verify-loc-cap, no-raw-console, etc.) | **Consumer** CI — manifest `mode: sync` product, not producer gates | shipped artifact; non-invocation here is by design |
| `scripts/eval-prompts.ts` | Operator-invoked (needs provider API keys); its pure logic IS CI-tested via `scripts/__tests__/eval-promptsPure.test.ts` | documented exemption |
| Audit docs | `docs/codebase-audit-framework-template.md` (shipped), `docs/incident-response.md`, `.claude/agents/audit-runner.md` | current |
| Conventions | review logs `tasks/review-logs/` (in the PRODUCER repo the bundle-hygiene gate ships only README + prompt-evolution-log there, so logs live directly in `tasks/review-logs-archive/<quarter>/` per the README's archive rule), backlog `tasks/todo.md` (dated audit sections), lessons `tasks/lessons.md`; no KNOWLEDGE.md in this repo | followed by this log |

## Step 2 — 17-item gap matrix

Column A scores **this repo** (library subset — items assuming a deployed service are N/A with stated evidence). Column B scores the **shipped audit template** (`docs/codebase-audit-framework-template.md`, line refs at commit 2d8b3a8) — this repo's product, i.e. whether a consumer audit run would catch the item.

| # | Item | A: this repo | B: shipped template |
|---|---|---|---|
| 1 | Sign-in / password-reset named tests | N/A — no auth surface (zero runtime deps in `package.json`) | Covered — Module C, L237 (auth flows enumerated as named critical paths incl. reset-token single-use/expiry) |
| 2 | Payment live-mode + test/live key separation | N/A — no payment surface | Covered — Module A, L219 |
| 3 | TLS end-to-end + hardened session cookies | N/A — no served domain, no sessions | Covered — Module A, L217 (`Secure`/`HttpOnly`/`SameSite` named; header-presence explicitly insufficient) |
| 4 | Dev/staging/prod separation, dev toggles fail closed | N/A — no deploy environments; producer/consumer write separation is manifest-mode governed and e2e-tested (`tests/e2e-*.test.ts`) | Covered — Module A, L218 |
| 5 | No credentials in source / built artifacts / git history | **Was MISSING enforcement** (policy only, CONTRIBUTING; GitHub scanning fully disabled) → now Covered: CI sweep gate `scripts/check-secrets.js` + GitHub secret scanning & push protection enabled 2026-07-16 (verified via API read-back) | Covered — Module A, L210 (source + built client bundle + gitleaks-style history scan) |
| 6 | Backups with retention + dated restore drill | N/A — no production data store; all state is git-versioned and replicated (clones + GitHub remote) | Covered — Module E, L254 ("an untested backup is a hope") |
| 7 | Email verification before account activation | N/A — no accounts | Covered — Module A, L213 (absence = `high` finding, not N/A) |
| 8 | Rate limits: enumerate limiter surface, sweep public endpoints | N/A — no served endpoints | Covered — Module A, L212 (plural-limiter enumeration + per-route sweep with documented exemptions) |
| 9 | Input validation at every external boundary | Covered — boundaries are consumer-repo trees and JSON configs: manifest/settings JSON validity gate (ci.yml), ajv schema checks (`validate-framework.js`), `tests/sync-hardening.test.ts` + e2e adopt/sync/merge suites, all CI-run | Covered — Module A, L209 |
| 10 | Bot/fake-account safeguards on unauthenticated writes | N/A — no unauthenticated write surface (GitHub governs PR/issue writes) | Covered — Module A, L214 |
| 11 | N+1 / per-row query patterns | N/A — no database | Covered — Module B, L227 + `performance` skill |
| 12 | Indexes on FKs and hot predicates | N/A — no database | Covered — Module B, L227 + `postgres-migrations` skill (every FK column ships a covering index or a recorded reason) |
| 13 | No unbounded list queries | N/A — no query layer | Covered — Module B, L228 |
| 14 | Expensive work in background jobs, not handlers | N/A — no request handlers (CLI tools are synchronous by design) | Covered — Module B, L228 + `performance` skill |
| 15 | Error monitoring + off-screen human alert channel | N/A — no production runtime to monitor; CI failures reach the maintainer off-screen via GitHub notification email | Covered — Module E, L253 (in-app panel explicitly insufficient) |
| 16 | Schema changes as ordered committed migrations; gate wired into CI | Covered — consumer migrations ship as ordered `migrations/v<semver>.js` under a tested harness contract (`migrations/README.md`; `tests/migrations.test.ts`, CI-run); schemas-vs-CHANGELOG diff gate wired in ci.yml | Covered — Module E, L255 (no runtime DDL; absent CI wiring is itself a finding) |
| 17 | Critical flows declared as named critical paths | **Was PARTIAL** (requirement stated in CONTRIBUTING, no named path→suite mapping) → now Covered: named critical-paths table added to CONTRIBUTING § Test expectations; all listed suites exist and are CI-run | Covered — Module C, L236–237 |

**Also verified:** §9 gained a Pre-launch Audit mode row (L300) so launch-readiness emphasis is a first-class audit mode.

## Step 3 — Tooling gaps closed (this change)

1. **GitHub secret scanning + push protection enabled** on `michaelhazza/claude-code-framework` (public repo; was fully disabled). Verified via `security_and_analysis` API read-back. Covers full git history for provider patterns and blocks future secret pushes.
2. **`scripts/check-secrets.js`** — provider-shaped secret sweep over `git ls-files` (8 pattern families: AWS, GitHub classic + fine-grained, OpenAI/Anthropic, Stripe secret/restricted, Slack, Google, private-key blocks). Fail-closed: zero files or zero *text* files scanned is a config error (proof-of-life), an unreadable tracked file is a config error, findings print redacted previews + sha256 fingerprints only. Wired into ci.yml **in the same change**.
3. **Exact-instance allowlist** (`scripts/check-secrets-allowlist.json`, ships empty): entries are `{path, sha256, reason}`; glob paths, missing reasons, or missing fingerprints are config errors (category-level exemptions rejected structurally); an entry that suppresses nothing is stale and **fails** the gate.
4. **CONTRIBUTING tightened**: PR-etiquette secrets bullet now names both enforcement layers; Test expectations gained the named critical-paths table (item 17).

### Gate proofs (run 2026-07-16, this session)

- **Green:** `node scripts/check-secrets.js` → `OK — scanned 280 tracked files (1 binary skipped), 8 pattern families, 0 findings`, exit 0.
- **Red (dialect-varied):** three seeded tracked files — quoted AWS key in a markdown table, unquoted OpenAI project key in `.env` form, Slack token in a line comment + CRLF private-key block in `.ts` — 4 findings, exit 1.
- **Allowlist:** exact-instance entry suppressed only its own instance (3 findings remained, exit 1); stale entry on a clean tree failed (exit 1); malformed allowlist JSON exited 2.
- **Unit suite:** `scripts/__tests__/check-secrets.test.ts`, 26 tests green. Red dialects: double/single/backtick quoting, unquoted env, JSON/YAML/URL/comment/markdown contexts, CRLF. Green decoys: kebab `sk-` slugs (incl. the real `docs/decisions/README.md:55` false positive found during calibration), ellipsis/angle placeholders, pattern-source strings, short/wrong-case candidates, Stripe publishable keys. All fixtures assembled by concatenation so the suite never trips its own gate.
- **Regression suites:** `npm run validate` OK (115 managed files); `check-rule-ledger` PASS; `npm run test:scripts` all green.

**Not verified:** the new ci.yml step executing on GitHub-hosted runners (proven locally + by unit suite; the PR's CI run is the wiring proof — confirm it lands green with the "Secret sweep" step listed).

## Step 4 — Deferred

Product-level candidates and operator decisions — queued, not implemented here. See `tasks/todo.md` § *Deferred from launch-readiness coverage audit — 2026-07-16*.

## Lessons

Appended to `tasks/lessons.md` (2026-07-16 entry).
