# Todo

Active backlog. Items captured here are queued for work; resolved items move to `tasks/todo-archive/<quarter>.md` once a section is fully `[x]`.

## How items land here

- `triage-agent` captures ideas + bugs surfaced during dev sessions.
- Review agents (`pr-reviewer`, `spec-conformance`, `chatgpt-pr-review`, `chatgpt-spec-review`) route deferred / directional findings here.
- Audit runs (`audit-runner`) write deferred items here under a `## Deferred from <scope> audit — <YYYY-MM-DD>` section.

## Item shape

```markdown
- [ ] [origin:<source>:<YYYY-MM-DD>] [status:open|deferred|resolved] Short title
  - Why: one or two sentences.
  - Approach: one or two sentences.
  - Risk: one sentence (optional).
```

`origin` lets you grep the source of every backlog item. Examples: `origin:pr-1234-r2-f3`, `origin:setup-audit:2026-05-03`.

---

## Sections

[Add sections as items accrue. Keep section headings stable so grep-by-origin works across the file.]

## PR Review deferred items

### PR #27 — claude-build-grounded-mockups (2026-06-19)

- [ ] Assert capture-surface degradation in the A1/A2 live-capture run: `browser_unavailable` launch failure produces all-`failed` manifest entries (OAI-PR-001) and manifest `screenshotPaths` are repo-relative POSIX, never absolute (OAI-PR-002). Code fixes landed in this PR; the assertions extend the existing intentional A1/A2 REVIEW_GAP (no browser in the framework repo). [auto]

## Deferred from launch-readiness coverage audit — 2026-07-16

- [x] [origin:launch-readiness-audit:2026-07-16] [status:resolved] Run a targeted Pre-launch Audit (template §9 mode) in consumer repos against the v2.41.0-extended checklist
  - Why: this audit verified the TOOLING covers all 17 launch-readiness items; the consumer repos' PRODUCT gaps (email verification, off-screen alerting, backup drills, sign-in backoff, …) are candidates, not audited findings, until an audit-runner pass converts them into tracked, prioritised findings.
  - Resolved 2026-07-16: findings-only Pre-launch Audit of automation-v1 completed via audit-runner in an isolated worktree (live checkouts untouched; worktree removed after push). Verdicts: 6 covered / 7 partial / 3 missing (missing = auth-flow test coverage, backup/restore drill, email verification — all already tracked in their `origin:audit:ace:2026-07-16` batch; 6 net-new PL-1…PL-6 findings filed, e.g. Stripe key read raw from process.env bypassing env.ts, payment flow absent from critical-paths-manifest). Artifacts on automation-v1 branch `audit/pre-launch-readiness-2026-07-16` (commit 372fd3b41, pushed, no PR): review log `tasks/review-logs/audit-runner-log-pre-launch-readiness-2026-07-16T09-46-16Z.md`, prioritised `tasks/todo.md` entries (origin:pre-launch-audit:2026-07-16), 2 KNOWLEDGE.md patterns. Remaining follow-through happens in automation-v1's own sessions (merge the audit branch, work the findings).
- [x] [origin:launch-readiness-audit:2026-07-16] [status:resolved] DECISION: enable Dependabot security updates + vulnerability alerts on this repo
  - Why: currently disabled (verified via API 2026-07-16). Blast radius is low (five devDependencies, zero runtime deps) but the framework ships scripts into other repos, so a compromised devDep is a supply-chain vector. Not flipped during the audit because it changes PR workflow (automated PRs) — operator call.
  - Resolved 2026-07-16: operator approved ("start building the deferred items"); vulnerability alerts + automated security fixes enabled via `gh api` PUT, verified by read-back (`dependabot_security_updates: enabled`).
- [ ] [origin:launch-readiness-audit:2026-07-16] [status:open] DECISION: enable secret-scanning non-provider patterns + validity checks
  - Why: provider-pattern scanning + push protection are now on; the generic-pattern tier catches more but false-positives more (this repo is kebab-case-heavy). Validity checks phone matched tokens to providers.
  - Approach: same `security_and_analysis` PATCH, two more fields; revisit after a month of provider-tier signal.
- [x] [origin:launch-readiness-audit:2026-07-16] [status:resolved] Candidate: ship a portable secret-sweep gate in `scripts/gates/` for consumers
  - Why: template Module A (L210) tells consumers to run a gitleaks-style scan; a portable `verify-no-secrets` gate in the shipped gates library would standardise it like the other verify-gates. Product decision — new shipped surface, needs manifest entry + release.
  - Resolved 2026-07-16: operator approved; shipped as v2.42.0 (PR #45, tag pushed, consumer notification dispatched). `scripts/gates/verify-no-secrets.sh` wraps the now-managed `scripts/check-secrets.js` (single scanner source, 26-test suite ships too); wrapper proven green + red at all three failure classes before release.
