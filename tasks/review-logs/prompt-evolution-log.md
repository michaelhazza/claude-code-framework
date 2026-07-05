# Prompt evolution log

Append-only record of every learning edit applied to the OpenAI review prompts
in `scripts/chatgpt-reviewPure.ts` during parallel-mode sessions (see
`docs/review-pipeline/parallel-mode.md` § Apply protocol). Newest entry last.
Never edit or delete existing entries.

## Entry template

```markdown
### [YYYY-MM-DD] <mode: pr|spec|plan> — <one-line summary of the edit>

- **Channel:** 1 (ChatGPT-only finding) | 2 (severity calibration) | 3 (anti-hunt)
- **Source finding:** <title or fingerprint of the finding that motivated the edit>
- **Diagnosis:** <one sentence — what the prompt was blind to>
- **Edit location:** scripts/chatgpt-reviewPure.ts:<line> (<prompt constant name>)
- **Before:** `<exact text removed, or "n/a — pure addition">`
- **After:** `<exact text added>`
- **Operator decision:** apply | apply all
- **Test outcome:** vitest chatgpt-reviewPure suite — pass | reverted (failure: <ref>)
- **Session log:** tasks/review-logs/<session log filename>
```

## Phase-3 flip tracking

The flip-to-automated decision (parallel-mode.md § Phase 3) reads this file:
zero new entries across N consecutive parallel rounds (alongside zero
ChatGPT-only findings) is the signal that the API prompts have caught up with
ChatGPT-web. Record round outcomes here even when no proposal fired:

```markdown
### [YYYY-MM-DD] <mode> — no proposals this round
- **Round:** <N> of session <session log filename>
- **Signal:** zero ChatGPT-only findings; severity calibration aligned
```

---

<!-- entries below -->
