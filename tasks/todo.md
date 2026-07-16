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

- [ ] [origin:launch-readiness-audit:2026-07-16] [status:open] Run a targeted Pre-launch Audit (template §9 mode) in consumer repos against the v2.41.0-extended checklist
  - Why: this audit verified the TOOLING covers all 17 launch-readiness items; the consumer repos' PRODUCT gaps (email verification, off-screen alerting, backup drills, sign-in backoff, …) are candidates, not audited findings, until an audit-runner pass converts them into tracked, prioritised findings.
  - Approach: in each consumer repo (starting with automation-v1), invoke `audit-runner` in Targeted mode scoped to the Pre-launch row of `docs/codebase-audit-framework.md` §9; route findings through its normal three-pass flow.
- [ ] [origin:launch-readiness-audit:2026-07-16] [status:open] DECISION: enable Dependabot security updates + vulnerability alerts on this repo
  - Why: currently disabled (verified via API 2026-07-16). Blast radius is low (five devDependencies, zero runtime deps) but the framework ships scripts into other repos, so a compromised devDep is a supply-chain vector. Not flipped during the audit because it changes PR workflow (automated PRs) — operator call.
  - Approach: `gh api -X PATCH repos/michaelhazza/claude-code-framework -f security_and_analysis[dependabot_security_updates][status]=enabled` (plus vulnerability alerts in repo settings).
- [ ] [origin:launch-readiness-audit:2026-07-16] [status:open] DECISION: enable secret-scanning non-provider patterns + validity checks
  - Why: provider-pattern scanning + push protection are now on; the generic-pattern tier catches more but false-positives more (this repo is kebab-case-heavy). Validity checks phone matched tokens to providers.
  - Approach: same `security_and_analysis` PATCH, two more fields; revisit after a month of provider-tier signal.
- [ ] [origin:launch-readiness-audit:2026-07-16] [status:open] Candidate: ship a portable secret-sweep gate in `scripts/gates/` for consumers
  - Why: template Module A (L210) tells consumers to run a gitleaks-style scan; a portable `verify-no-secrets` gate in the shipped gates library would standardise it like the other verify-gates. Product decision — new shipped surface, needs manifest entry + release.
  - Approach: generalise `scripts/check-secrets.js` behind the gates-library env-knob convention; keep the exact-instance allowlist contract.
