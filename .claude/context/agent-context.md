# Agent context — project-specific operating notes for the agent fleet

This file is the **only** place to add project-specific behaviour for a framework agent. It is the fleet-wide analogue of `CLAUDE.md`: every framework agent under `.claude/agents/` reads this file at the start of every run and treats the `##` section matching its own name as **binding project context**.

**Contract (ADR-0006):**

- Agent `.md` files are framework-canonical and are **never edited per-repo** — no inline `LOCAL-OVERRIDE` blocks, no out-of-marker drift. Project notes go here instead.
- Add a `## <agent-name>` section **only** for an agent you actually need to customise. Agents with no project notes need no section.
- The heading MUST exactly match the agent's name (the `name:` field in `.claude/agents/<agent-name>.md`).
- Keep sections tight. If one section grows long (a CI command table, a large allowlist), move the detail to a `references/<topic>.md` file and leave a 2-line pointer here.
- This file is `adopt-only`: the framework deploys it once, then never overwrites it. It is yours to maintain.

Distinct from the reviewer `PROJECT_CONTEXT` system (`context/` at the framework root, injected into reviewers) — that adapts review prompts; this carries agent operating notes. They cross-reference but do not merge.

---

## Worked example (delete or replace)

The format is a level-2 heading per agent, then prose / bullets / tables as needed:

> ## finalisation-coordinator
>
> **G5 CI-parity gate.** This repo's CI jobs, gate shards, and escape-hatch paths are in [`references/g5-ci-parity-commands.md`](../../references/g5-ci-parity-commands.md). Run that command set locally before applying the `ready-to-merge` label.

---

<!--
Valid agent names (must match a file in .claude/agents/). Add a `## <name>` section only when you customise that agent:

adversarial-reviewer · architect · audit-runner · bug-fixer · builder ·
chatgpt-plan-review · chatgpt-pr-review · chatgpt-spec-review · claude-plan-review ·
claude-spec-review · codebase-explainer · context-pack-loader · cross-repo-scout ·
dual-reviewer · experiment-runner · feature-coordinator · finalisation-coordinator ·
hotfix · incident-commander · mockup-coordinator · mockup-designer · mockup-reviewer ·
pr-reviewer · reality-checker · spec-conformance · spec-coordinator · spec-reviewer ·
triage-agent · validate-setup
-->
