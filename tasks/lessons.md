# Lessons

After-action notes from completed work. Lighter-weight than KNOWLEDGE.md (which is canonical patterns and gotchas) — this is "what we learned during THIS task that might inform future tasks."

## When to write

- After completing a non-trivial task.
- After resolving a hotfix.
- After a review pass that surfaced a class of issue you hadn't seen before.

## Item shape

```markdown
## <YYYY-MM-DD> — <task title>

**Context:** what we were doing.
**Surprise:** what didn't go as expected.
**Takeaway:** what we'd do differently next time. If durable, promote to `KNOWLEDGE.md` or write an ADR.
```

---

## Entries

[Append as you go.]

## 2026-07-16 — Launch-readiness coverage audit (tooling axis)

**Context:** 17-item launch-readiness coverage audit of this repo's own quality/ops tooling, one day after v2.41.0 ported the same checklist into the shipped audit template from a consumer review.
**Surprise:** The shipped template covered 17/17, but the producer repo itself had zero secret-scanning enforcement — policy stated in CONTRIBUTING, GitHub secret scanning fully disabled on a public repo, no CI sweep. The repo that ships the "extend the sweep to git history" rule wasn't running any sweep on itself. Also: a naive `sk-` token pattern false-positived on `risk-class-…` kebab slugs on the very first calibration run — provider-shaped patterns need lookbehind + require-a-digit guards in kebab-case-heavy repos.
**Takeaway:** When auditing a tooling *producer*, score two axes (the repo itself AND the shipped product) — "the template covers it" says nothing about the producer's own posture. And classify before declaring wiring gaps: `scripts/gates/*.sh` look like uninvoked gates but are manifest-synced consumer product; `eval-prompts.ts` looks unwired but is an API-key-bound operator tool whose pure core is CI-tested.
