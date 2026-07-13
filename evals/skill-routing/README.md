# Skill-routing eval cases

One JSON case file per skill, checked by `npm run eval:routing`
(`scripts/skill-routing-evals.ts`) — a deterministic lexical proxy for
Claude's skill routing built on stemmed TF-IDF + cosine ranking over the
frontmatter descriptions in `.claude/skills/*/SKILL.md`.

## Rule: every new skill ships a routing case

Adding a skill to `.claude/skills/` without a case file here emits a coverage
warning from the runner and leaves the skill's description untested against
the catalogue. Ship `evals/skill-routing/<skill-name>.json` in the same commit
as the skill.

## Case file format (pinned)

```json
{
  "skill": "<name>",
  "top_k": 3,
  "positive": ["prompt a user would actually say", "..."],
  "negative": [
    "plain prompt that must NOT rank this skill #1",
    { "prompt": "prompt owned by a sibling skill", "owner": "<other-skill>" }
  ]
}
```

- `skill` — the frontmatter `name` of the skill under test (must exist).
- `top_k` — optional, default 3. Every `positive` prompt must rank the skill
  within the top `top_k` with a nonzero score.
- `negative` — prompts that must not rank the skill #1. An entry with an
  `owner` is a pairwise routing test: the owner skill must additionally
  outrank this one for the prompt (prevents vacuous passes where the prompt
  matches nothing at all).

Malformed case files are hard errors naming the file — never silently
skipped. Collision exemptions between deliberately-sibling skills live in the
`COLLISION_EXEMPT` allowlist inside `scripts/skill-routing-evals.ts`
(validator-owned), not in case files.
