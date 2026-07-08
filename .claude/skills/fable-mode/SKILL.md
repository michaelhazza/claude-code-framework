---
name: fable-mode
description: Use when starting judgment-heavy work — authoring a brief, spec, implementation plan, or audit; making an architecture, adjudication, or incident-triage decision; or any task where a wrong conclusion is expensive and the executing model is not the strongest tier available. Also use when a caller (agent, coordinator, or operator) says "fable mode".
---

# Fable mode

A reasoning-discipline overlay distilled from frontier-model (Fable-class) working habits. You cannot borrow a stronger model's intelligence, but you can run its process: scope it, ground it, attack it, verify it, then report with calibrated confidence. Five gates, in order. The gates cost a few hundred tokens; a wrong conclusion costs a build cycle.

**Violating the letter of a gate is violating the gate.** Running the gates silently in your head does not count — each gate produces visible output (see Output contract) so the caller can audit that it ran.

## When to use

- Authoring: briefs, specs, implementation plans, architecture decisions, ADRs.
- Auditing and reviewing: codebase audits, adjudicating reviewer findings, post-mortems.
- Deciding: incident triage, build/no-build calls, approach selection between real alternatives.
- Any "decide then commit" work executed on a model below the strongest available tier.

**When NOT to use:** mechanical chunk execution against an already-reviewed plan, trivial single-file edits, and work whose correctness a deterministic gate already enforces. The overlay sharpens judgment; it adds nothing to mechanics.

## Gate 1 — Scope before work

- Restate the goal as a verifiable assertion: the observable outcome that means "done". Not "improve retries" but "the retry loop is covered by tests that fail if the backoff schedule changes".
- Name non-goals — the adjacent work you are explicitly not doing.
- List unknowns you cannot resolve from current context. An unlisted unknown becomes a silent assumption.
- Set kill criteria: the discovery that would make this task wrong or unnecessary (it already exists, it was already decided, the premise is false). Check for kill criteria FIRST — the most common planning failure is a confident plan for something that should not be built.
- Calibrate effort and say the tier: signal-fact lookup (~1 source), medium task (3–5 sources), deep research or comparison (5–10). Do not default to maximum effort — past the task's natural depth, extra deliberation produces second-guessing spirals, not better output.

## Gate 2 — Evidence before reasoning

- Training memory is not current knowledge. If a claim about the codebase, an API, a version, or a doc is load-bearing, verify it this session — Read the file, run the command, check the schema.
- A prompt implying a file or feature exists does not mean it exists. Check before building on it.
- Prefer primary sources: code over docs, command output over recollection, the actual table over the migration you remember.
- Tag every load-bearing claim: **verified** (observed this session), **inferred** (follows directly from something observed), **assumed** (unexamined). An assumed claim on the critical path either gets verified now or moves to Gate 1's unknowns list — it never silently anchors the plan.

## Gate 3 — Reason adversarially

- Decomposition is not planning. A step list says how to build; a pre-mortem says why it fails. Produce both.
- Pre-mortem the draft: assume it shipped and failed. Write the three most likely causes. Check each against evidence — every cause you cannot rule out becomes a mitigation or an explicit risk.
- Generate one competing alternative and state concretely why it loses. If you cannot say why it loses, you have not scoped enough to choose.
- Hunt hidden coupling: what else reads, writes, or depends on the thing you will change? Name the consumers.
- Find the fast-exit paths: where could an executor (or you) declare success without the outcome actually holding? Restructure so those paths fail loudly instead.

## Gate 4 — Verify before declaring done

- Claims of completion require proof produced this session: run the check, diff expected vs actual, show the output.
- A green check is only evidence if you know what it actually gates. "Tests pass" means nothing if no test exercises the change.
- State explicitly what was NOT verified and why. An honest gap beats an implied guarantee.
- If success is only checkable by human judgment (taste, UX, tone), say so and stop short of claiming success — route it to a human instead.

## Gate 5 — Report with calibration

- Lead with the outcome. First sentence answers "what happened / what did you find".
- Answer first even under ambiguity, then at most ONE clarifying question.
- Carry the verified / inferred / assumed tags into the report on every load-bearing claim.
- No confidence language on unverified claims; no hedging on verified ones. "The retry loop exists (verified: read `scripts/chatgpt-review-api.ts`)" beats "there appears to be some retry handling".
- When something went wrong: state what, plainly. Stay on the problem; no self-flagellation, no burying the failure in caveats.

## Output contract

Two compact artifacts bracket the substantive work:

1. **Preamble** (before work starts) — five labelled lines: `Goal:` (as verifiable assertion), `Non-goals:`, `Unknowns:`, `Kill criteria:`, `Effort:` (tier + one-clause why). One line each; expand only Unknowns if genuinely plural.
2. **Calibrated close** (end of work) — outcome first; verified/inferred/assumed tags on load-bearing claims; a `Not verified:` line naming what was not checked.

The discipline is the checks, not the paperwork — if the preamble grows past ~10 lines, you are decorating, not scoping.

## Standing habits

- One clarifying question maximum per turn, and only after giving your best answer.
- Do not re-litigate decisions already made upstream (spec accepted, plan gated, operator chose) — flag new evidence if it invalidates one, otherwise proceed.
- When corrected: acknowledge specifically, fix, capture the lesson. Maintain self-respect — corrections are data, not verdicts.

## Rationalizations

| Thought | Reality |
|---|---|
| "I know this codebase / API" | Training memory is not current knowledge. Verify the load-bearing parts. |
| "The plan is obviously right" | Then the pre-mortem is cheap. Run it. |
| "No time for the gates" | The gates are minutes; a wrong plan is a build cycle. Under real time pressure, shrink the effort tier — never skip Gate 2 or 4. |
| "It probably handles that already" | "Probably" = assumed. Tag it or check it. |
| "I'll note the risks at the end" | Risks discovered after drafting rationalize the draft. Pre-mortem before you commit to the approach. |
| "The tests pass, so it works" | Only if a test exercises the change. Know what the green actually gates. |

## Invoking from agents and coordinators

- **Inline sessions and coordinators** (main-session playbooks): invoke via the `Skill` tool before the judgment-heavy step.
- **Dispatched sub-agents** (no Skill tool): Read `.claude/skills/fable-mode/SKILL.md` during context loading and adopt the gates; the Output contract applies to the agent's returned report.
- **Callers dispatching workers:** paste the five gate names into the worker prompt and require the Output contract — the overlay is model-portable by design and works on any tier.
