---
name: llm-integration
description: Use when building features that CALL an LLM — prompt assembly, model-output handling, LLM-driven tools/agents, scoring or judge harnesses, embeddings, or any pipeline where model output feeds subsequent logic. Engineering rules for treating the model as an unreliable, injectable, non-deterministic dependency.
---

# LLM integration engineering

The model is an external dependency that lies, reorders, truncates, and can be hijacked by its own inputs. Build accordingly.

## Trust and verification

- Never trust the model's self-report of a measurable transformation (shortened, deduplicated, translated, "I fixed it"). Compute the objective measure on the artifact itself and gate on that; the self-report is triage input only. A "success" failing the measure is a protocol violation routed to a typed failure.
- When validating that a model echoed a structured object unchanged, canonicalise both sides first (recursively sort object keys; arrays keep order) — models routinely reorder JSON keys, and naive stringify-comparison rejects every semantically-identical response.
- Model output claiming to be structured is authoritative only in schema-validated form: validate on receipt, quarantine non-conforming output rather than applying it, and never parse decisions out of prose.
- In scoring/judge harnesses, parser failure is a distinct outcome (`parse_error`), never a neutral passable score — conflating "our parser broke" with "genuine regression" hides integration bugs behind green checks. Prompt scale, threshold constant, and clamp must agree on the same 0-N scale, named in the constant.
- Never resolve credentials or user identity from LLM tool input — resolve the owning user from the authenticated resource record. An agent must not act for a user it isn't bound to, regardless of what the model puts in a field.

## Prompt assembly

- Untrusted content (user text, documents, tool results, diffs, prior model output) goes in the user channel wrapped in an explicit trust boundary with a treat-as-data directive — never substituted into the system prompt. Diffs and documents frequently contain instruction-shaped text.
- If middleware truncates messages downstream, the trust wrapper must survive truncation: escape `<`/`>` in the body so a sliced wrapper cannot be broken out of; a code fence opened at the top loses its closing delimiter to the slice.
- Never silently truncate inputs to embeddings, summaries, rankers, or prompts: every cap is an exported named constant and every truncation emits a structured warning with sizes — silent truncation is a quality regression invisible in metrics.
- Text a user or a prior model produced, interpolated into a subsequent prompt, is an injection surface (second-order). The security boundary is the locked tool surface plus approval gates, not prompt wording.

## Operational shape

- Never hold a DB row lock or open transaction across an LLM call (or any I/O with >100ms tail): classify-before-lock — read and validate unlocked, call the model, then open a fresh transaction for a compare-and-set write.
- Classify provider failures before retrying: auth/quota/content-policy rejections are permanent (dead-letter immediately); timeouts/5xx are transient (rethrow to the retry policy). Collapsing the classes either burns retry budgets on the unfixable or delays operator action by the whole budget.
- LLM calls are expensive fan-out points: every new dispatch path joins the existing per-run/per-tenant budget counters and rate limits — new paths repeatedly bypass established ceilings.
- Tunable parameters (thresholds, decay, prompts under test) evolve via append-only versioned config with an active pointer, never in-place edits, so every run records which version produced its results.
- Deterministic evaluation needs cached/pinned fixtures; a harness scoring live model output cannot distinguish model drift from regression.
- Two-phase interactions with different user-channel trust semantics need separate system prompts — one prompt serving both phases inherits the weaker phase's assumptions.

## LLM-as-reviewer

For adjudicating findings from LLM reviewers (false-positive taxonomy, round management, convergence), use the `review-triage` skill. The one rule that belongs here: stateless reviewers have no memory — re-inject prior decisions and the current artifact every round, or the loop relitigates forever.
