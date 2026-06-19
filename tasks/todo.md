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
