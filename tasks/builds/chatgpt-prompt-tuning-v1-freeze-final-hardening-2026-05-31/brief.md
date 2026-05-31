# Brief — ChatGPT spec-review prompt tuning (v1-freeze-final-hardening session)

**Author:** Phase 1 spec-coordinator session, v1-freeze-final-hardening build (PR #450)
**Date:** 2026-05-31
**Status:** Revision 1 — initial draft, 6 proposed SPEC-V2 Hunt Targets sourced from the 3-round `chatgpt-spec-review` session on the v1-freeze-final-hardening spec.
**Target file:** `scripts/chatgpt-reviewPure.ts` — `SYSTEM_PROMPT_SPEC_V2` only
**Branches affected:** new branch `chatgpt-prompt-tuning-v1-freeze-final-hardening-2026-05-31` against `main` (Trivial-class, no runtime behaviour change)
**Estimated diff size:** ~60 lines additive

---

## Table of contents

1. Executive summary
2. Context
3. Source incidents (v1-freeze-final-hardening spec review)
   - 3.1 Per-round divergence map
   - 3.2 ChatGPT-only findings that OpenAI missed
   - 3.3 OpenAI-only findings that pinned new patterns
   - 3.4 What OpenAI got right and the prompt already covers
   - 3.5 What was correctly deferred to architect-time
4. Proposed additions to `SYSTEM_PROMPT_SPEC_V2`
   - 4.1 SPEC-NEW-4 — Producer/consumer fencing-column pairs
   - 4.2 SPEC-NEW-5 — Dedupe-key canonicalisation for user-supplied strings
   - 4.3 SPEC-NEW-6 — Content-boundary ACs must enumerate non-visible carriers
   - 4.4 SPEC-NEW-7 — Hostname allowlists must specify IP-literal handling
   - 4.5 SPEC-NEW-8 — Denormalised tenant columns need integrity triggers, not just RLS
   - 4.6 SPEC-NEW-9 — Deploy-boundary cutover for new idempotency arbiters
5. Existing prompts (for reviewer context)
6. Rollout
   - 6.1 Apply path
   - 6.2 Compatibility
   - 6.3 Risk
   - 6.4 Reviewer plan
7. Appendix — source incident log references
8. Decision log

---

## 1. Executive summary

The v1-freeze-final-hardening spec review (3 rounds, parallel mode, 24 findings, verdict APPROVED, session log `tasks/review-logs/chatgpt-spec-review-v1-freeze-final-hardening-2026-05-31T01-34-41Z.md` in the consuming repo) produced a clean overlap-vs-divergence map between the OpenAI API tier and ChatGPT-web. Four findings ChatGPT-web caught were missed by OpenAI across all three rounds; two findings OpenAI surfaced repeatedly are not yet pinned as explicit hunt targets even though OpenAI did the work; together they map cleanly onto 6 new patterns.

This brief proposes adding **6 new Hunt-Target patterns** to `SYSTEM_PROMPT_SPEC_V2`. The change is additive only — no Hunt Target is removed or weakened. Each pattern is tied to specific findings from the v1-freeze-final-hardening session, with finding IDs traceable to the session log.

This brief is scoped to `SYSTEM_PROMPT_SPEC_V2` only because the source session was a spec review. Plan and PR prompts are out of scope for this revision.

---

## 2. Context

`chatgpt-spec-review` runs in three modes — manual, automated, parallel. Parallel mode dispatches the OpenAI automated half (using `SYSTEM_PROMPT_SPEC_V2` from `scripts/chatgpt-reviewPure.ts`) alongside the operator's manual ChatGPT-web round and renders a side-by-side compare panel. The compare panel is the canonical learning surface: every ChatGPT-only finding is a candidate prompt-improvement, and every OpenAI-only finding the operator validates as real evidence the prompt is working.

The 2026-05-29 notifications-system brief (Revision 3, APPROVED) is the prior art for this pattern. That brief sourced 13 patterns across all three tiers (SPEC, PLAN, PR) from the notifications-system build's full pipeline run. This brief sources 6 SPEC-only patterns from a single spec review.

---

## 3. Source incidents (v1-freeze-final-hardening spec review)

### 3.1 Per-round divergence map

The session ran 3 rounds. Total findings: 24. Verdict progression: NEEDS_DISCUSSION → CHANGES_REQUESTED → APPROVED.

| Round | OpenAI findings | CW findings | Overlap | OAI-only | CW-only |
|---|---|---|---|---|---|
| 1 | 5 | 8 + 1 polish | 4 (F2, F3, F5, F6) | 1 (F10) | 4 (F1, F4, F7, F8, F9) |
| 2 | 6 | 6 | 4 (F11, F12, F13, F14) | 3 (F17, F18, F19) | 2 (F15, F16) |
| 3 | 5 | 0 substantive (3 architect notes) | 1 (F24, both confirm defer) | 4 (F20, F21, F22, F23) | 3 (F25, F26, F27 — architect notes only) |

### 3.2 ChatGPT-only findings that OpenAI missed (prompt-improvement candidates)

These are the findings ChatGPT-web caught that the OpenAI prompt did NOT catch in the same round. Each maps onto a proposed Hunt Target in §4.

| Finding | Round | Severity | Pattern | Maps to |
|---|---|---|---|---|
| F1 — NDL-002 retry_generation fencing contract | 1 | high | Producer-side fencing column added, consumer-side fencing check not specified | SPEC-NEW-4 |
| F4 — NDL-003 email canonicalisation for dedupe keys | 1 | medium | Dedupe key built from user-supplied string, no canonicaliser named | SPEC-NEW-5 |
| F7 — STEEL-ADV-6 broaden hidden-token AC | 1 | low | Content-boundary AC enumerated only one carrier | SPEC-NEW-6 |
| F15 — STEEL-PR-12 add IP-literal rejection | 2 | low | Hostname allowlist defined, IP-literal handling not specified | SPEC-NEW-7 |

### 3.3 OpenAI-only findings that pinned new patterns the prompt should make explicit

These are findings OpenAI surfaced (one round late or twice in a row) that pin a pattern not yet listed as a Hunt Target. Adding the Hunt Target would catch the same class of finding earlier and more reliably on future spec reviews.

| Finding | Round | Severity | Pattern | Maps to |
|---|---|---|---|---|
| F20 — cross-org integrity trigger on `iee_run_artifacts` | 3 | high | Denormalised tenant column + parent FK + RLS — but no parent-tenant equality trigger | SPEC-NEW-8 |
| F21 — cutover scope + pre-deploy queue-drain | 3 | high | New idempotency arbiter introduced; in-flight events crossing deploy boundary not addressed | SPEC-NEW-9 |

### 3.4 What OpenAI got right and the prompt already covers (kept as evidence the prompt is working)

These findings demonstrate the existing v2 Hunt Targets are doing real work and should be kept unchanged:

- **F10 (Round 1).** Goals vs mechanisms contradiction — §1 goal 4 ("never re-renders or re-delivers") vs §8 edge note ("accept the narrow re-render window"). Caught by the existing "Goals vs mechanisms" Hunt Target. This was the most consequential finding of the entire session; the existing prompt did the heavy lifting.
- **F17 (Round 2).** §2 scope-table "Migration? No" contradicted §12 "one additive migration". Caught by existing "Migration discipline" + "Stale phase/chunk-number references" Hunt Targets.
- **F18 (Round 2).** §9 `innerText` alone does not satisfy AC-6.4. Caught by existing "Testability" Hunt Target.
- **F22 (Round 3).** Claim-row-before-upload pattern needed a winner-commit-time conditional UPDATE fence. Caught by existing "Atomicity claims that don't account for the external-side-effect window" + "Concurrency" Hunt Targets. (Note: F22 also overlaps SPEC-NEW-4 below — claim_token is a fencing column too. The Hunt Target additions in §4 strengthen this from "the OpenAI side eventually finds it" to "the prompt pins the pattern explicitly".)
- **F23 (Round 3).** §8 decision line "no new table" residual contradiction. Caught by the existing second-order integrity pass and "Stale phase/chunk-number references" pattern.
- **F19/F24.** NDL-001 canonical caller-subaccount accessor still unpinned. OpenAI correctly raised this twice; both times correctly classified as deferred to plan gate. The existing prompt is not at fault; this is a deliberate cross-tier deferral.

### 3.5 What was correctly deferred to architect-time and should NOT be added to the prompt

ChatGPT-web Round 3 also surfaced three "Implementer notes for the architect" (F25, F26, F27). All three were explicitly tagged as NOT spec blockers — they belong to plan-stage refinement. None should be folded into the spec prompt:

- F25 — stale-claim sweep SQL form preference (DELETE+predicate vs claim_token match).
- F26 — IPv4-mapped IPv6 regression test for the host-pinning matrix.
- F27 — opacity:0 / clipped / shadow-DOM text scope note for AC-6.4.

These are correctly architect-tier work, not spec-tier. The corresponding spec-tier patterns (host pinning IP-literal handling and content-boundary carrier enumeration) ARE in scope for this brief — see SPEC-NEW-6 and SPEC-NEW-7 below — but the architect-time refinements layer on top of those, not into them.

---

## 4. Proposed additions to `SYSTEM_PROMPT_SPEC_V2`

Six new Hunt-Target bullets, appended to the existing Hunt-Targets list in `scripts/chatgpt-reviewPure.ts:660–790`. Numbering continues from SPEC-NEW-3 (the last one from the 2026-05-29 brief).

### 4.1 SPEC-NEW-4 — Producer/consumer fencing-column pairs

**Source:** F1 (Round 1, NDL-002 retry_generation fencing contract). Also strengthens F22 detection (Round 3, claim-row late-winner fence).

```
- Producer/consumer fencing-column pairs. When the spec adds or touches a
  fencing/generation/version/claim-token column on a write path (e.g.
  retry_generation, version, epoch, claim_token, sequence), the consumer-side
  reader/dispatcher/worker must declare the matching equality check and zero-
  row-abort behaviour. A producer-side bump with no consumer-side equality
  predicate is a silent double-dispatch hazard — the producer's intent (stale
  reader skips) is not enforced anywhere. Flag any new fencing column whose
  matching consumer-side WHERE clause + zero-row-affected behaviour
  (no-op / abort / fail-closed) is not specified. The fix sketch should name
  both the producer's bump site AND the consumer's predicate site.
```

**Why this Hunt Target is needed:** F1 surfaced this for `retry_generation` — the spec added a producer-side bump to the reclaim path but the consumer-side dispatcher's matching check was absent. F22 surfaced the same shape one round later for `claim_token` — the spec added the claim_token but the winner-commit-time conditional UPDATE was absent. Two distinct findings, same pattern. The existing "Idempotency and retries" and "Concurrency" Hunt Targets cover this in spirit but do not call it out as a producer/consumer-pair invariant.

### 4.2 SPEC-NEW-5 — Dedupe-key canonicalisation for user-supplied strings

**Source:** F4 (Round 1, NDL-003 email canonicalisation for dedupe keys).

```
- Dedupe-key canonicalisation for user-supplied strings. When the spec
  specifies an idempotency key, suppression-lookup key, or uniqueness key that
  includes a user-supplied identifier (email address, URL, slug, name,
  domain, identifier, free-text label), flag any case where the spec does
  not name (a) the canonicalisation function applied at both write-time and
  lookup-time (lowercasing, trimming, IDNA / punycode normalisation, Unicode
  NFC, percent-decoding for URLs, etc.), AND (b) the rule that display values
  may preserve original casing only when the canonical form is used for all
  comparisons. Literal-string keys without canonicalisation rules create
  duplicate-delivery / duplicate-row / suppression-bypass hazards on
  case / whitespace / Unicode variants. The fix sketch should name the
  existing canonicaliser if one exists in PROJECT_CONTEXT, or require a new
  one be named.
```

**Why this Hunt Target is needed:** F4 was missed by OpenAI across all 3 rounds. The existing "Idempotency and retries" Hunt Target says "every write path defines duplicate handling and replay semantics" but does not call out the specific class of bug where the key itself is mis-canonical. This is a recurring class — any spec that introduces an idempotency key built from arbitrary user input is exposed.

### 4.3 SPEC-NEW-6 — Content-boundary ACs must enumerate non-visible carriers

**Source:** F7 (Round 1, broaden hidden-token AC) and F18 (Round 2, `innerText` alone insufficient).

```
- Content-boundary ACs must enumerate non-visible carriers. When the spec
  asserts a boundary like "X contains only visible text" / "X never leaks
  secrets / hidden tokens / raw HTML" / "X is bounded to user-visible content",
  the acceptance test must enumerate all the non-visible carriers explicitly,
  not rely on a single implementation hint (e.g. "use innerText"). The full
  carrier set for a DOM-shaped boundary includes:
    - <script>, <style>, <meta>, <link>, <template>, comment nodes
    - aria-* and data-* attribute values
    - aria-hidden="true" subtrees, hidden CSS (display:none, visibility:hidden)
    - off-viewport absolutely / fixedly positioned elements
    - hidden form inputs (type="hidden")
  Flag any content-boundary AC whose assertion text names only one carrier
  (or only the helper, with no carriers enumerated). The fix sketch should
  expand the AC to enumerate the carrier set the implementation must scrub.
  If the helper itself is the boundary, require a separate AC that names the
  helper's contract explicitly so a future shape change cannot silently
  regress the boundary.
```

**Why this Hunt Target is needed:** F7 (Round 1) and F18 (Round 2) are the same pattern at different specificity. The existing "Testability" Hunt Target says "acceptance criteria map to deterministic checks" but does not call out the specific class of bug where the AC silently relies on a single carrier-name (innerText, document.body.textContent) when the boundary contract is broader. This pattern recurs across any spec touching XSS, secret-leakage, log-redaction, telemetry-sanitisation, or DOM-to-text serialisation.

### 4.4 SPEC-NEW-7 — Hostname allowlists must specify IP-literal handling

**Source:** F15 (Round 2, STEEL-PR-12 IP-literal rejection).

```
- Hostname allowlists must specify IP-literal handling. When the spec defines
  hostname pinning, suffix allowlisting, or any URL-host validation, flag any
  case where IP literals (IPv4 numeric / octal / hex forms; bracketed IPv6
  including mapped / zero-compressed / embedded-IPv4 forms) are not
  explicitly classified as either rejected or allowed. A hostname-only
  allowlist that does not address IP literals is a common bypass vector —
  e.g. an attacker substituting the underlying IP for the allowlisted
  hostname. Require the spec to either (a) state that IP literals are
  rejected for managed URLs with an explicit failure mode, or (b) state that
  IP literals are explicitly allowed (typically via a self-host override or
  internal-loopback exception). The acceptance matrix must include at least
  one IP-literal negative case (or positive case when allowed) per IP family.
```

**Why this Hunt Target is needed:** F15 was missed by OpenAI in Round 2. The existing "Security-mechanism claims contradicted by their own section" Hunt Target catches blanket-vs-bypass contradictions but does not catch missing-coverage gaps. IP-literal handling is a well-known host-pinning bypass class that recurs whenever a spec introduces URL allowlisting, webhook ingress validation, redirect-target validation, or trusted-origin matching.

### 4.5 SPEC-NEW-8 — Denormalised tenant columns need integrity triggers, not just RLS

**Source:** F20 (Round 3, cross-org integrity trigger on `iee_run_artifacts`).

```
- Denormalised tenant columns need integrity triggers, not just RLS. When
  the spec introduces a new table that carries a denormalised tenant column
  (organisation_id, org_id, tenant_id, subaccount_id, account_id, etc.)
  alongside a parent foreign key to another table with its own tenant
  column, RLS protects the value-as-stored but not its consistency with
  the parent. A row whose denormalised tenant column does not match its
  parent's tenant column is invisible to RLS (both columns are checked
  against the same tx context) but corrupts every parent-join and every
  tenant-scoped audit. Flag any new table whose denormalised tenant column
  is not backed by an explicit BEFORE INSERT OR UPDATE row-level integrity
  trigger comparing the column against the parent's tenant column, with a
  negative-path test (insert with mismatched tenant id → DB rejects) and a
  post-test SQL audit. The fix sketch should name both the trigger
  contract and the AC enumerating the rejection path.
```

**Why this Hunt Target is needed:** F20 was a high-severity OpenAI finding in Round 3. The existing "Tenant isolation and RLS" Hunt Target says "new tenant tables need tenant/org columns, RLS policies, registry entries" but does not address the parent-consistency gap. RLS is a value-as-stored protection; the trigger is a value-accuracy protection. Both are needed when the table denormalises tenant context for query-performance reasons.

### 4.6 SPEC-NEW-9 — Deploy-boundary cutover for new idempotency arbiters

**Source:** F21 (Round 3, cutover scope + pre-deploy queue-drain).

```
- Deploy-boundary cutover for new idempotency arbiters. When the spec
  introduces a new table, column, or state that becomes the idempotency
  arbiter for a flow that has in-flight events at deploy time (queued jobs,
  retries scheduled by the outgoing implementation, persistent webhooks
  retrying from external providers), flag any case where the spec does not
  specify the cutover discipline. Acceptable cutover options are: (a) a
  backfill from the existing state into the new arbiter, with a fixed
  pre-deploy SQL migration; (b) a pre-deploy queue-drain checklist step
  with a verification query; (c) explicit scope of the new guarantee to
  post-deploy events only, with a customer-visible note about
  pre-deploy-event behaviour. The fix sketch should name which option
  applies + its operator-facing artefact (migration body, checklist step in
  the operator runbook, customer-visible note in the guarantee section).
  Without an explicit cutover discipline, the new idempotency guarantee is
  silently false for events spanning the deploy boundary.
```

**Why this Hunt Target is needed:** F21 was a high-severity OpenAI finding in Round 3 and is structurally invisible to spec-internal consistency checks — the contradiction is between the spec's customer-facing guarantee and the operational reality of in-flight events at deploy time. The existing "Phase sequencing" Hunt Target covers chunk-ordering within the build but does not cover the deploy-boundary cutover when the new state replaces the old one. This is a recurring class for any spec introducing a new idempotency mechanism, especially when v0 → v1 replaces an at-most-once or at-least-once posture with an exactly-once promise.

---

## 5. Existing prompts (for reviewer context)

The full text of `SYSTEM_PROMPT_SPEC_V2` lives at `scripts/chatgpt-reviewPure.ts:634–855` on `main` (post-2026-05-29 brief landing). The new Hunt Targets in §4 append to the existing bulleted list of Hunt Targets (current last bullet: "Chunk-discipline file-count check on the spec's own chunk plan" at `scripts/chatgpt-reviewPure.ts:783–790`).

The existing prompt's Process section (Pass 1 Inventory → Pass 7 Acceptance-check verifiability) and Second-order integrity pass are unchanged. The Output section (schema versioning, recommendation enum, OUTPUT_ENVELOPE_CONTRACT) is unchanged.

The 6 new Hunt Targets follow the same shape as the existing bullets: one descriptive sentence naming the pattern, one or more sentences describing the detection logic, one sentence on the failure mode the pattern catches, and (where applicable) a fix-sketch guidance line.

---

## 6. Rollout

### 6.1 Apply path

1. Land this brief on the framework `main` branch via PR.
2. Edit `scripts/chatgpt-reviewPure.ts` to append the 6 new Hunt-Target bullets to `SYSTEM_PROMPT_SPEC_V2`'s Hunt Targets list. Insert in numerical SPEC-NEW order (4 → 5 → 6 → 7 → 8 → 9), appended at the end of the existing Hunt-Target list.
3. Update `scripts/__tests__/chatgpt-reviewPure.test.ts` if it asserts on the Hunt-Target list shape (likely a count check or contains check). Otherwise no test change required — the prompt is a string export, not a runtime contract.
4. Bump `prompt_version` in the spec-mode handler from `openai-spec-review.v2` to `openai-spec-review.v3` if the codebase tracks prompt versions in the output envelope. (Check `getSystemPromptForMode` at `scripts/chatgpt-reviewPure.ts:1409` — the version tag is set there or in the result-envelope builder.)
5. Add a CHANGELOG entry to `.claude/CHANGELOG.md` noting the v3 prompt-revision and citing this brief.
6. Update `docs/review-pipeline/parallel-mode.md` if it documents the SPEC prompt's Hunt-Target list explicitly (likely a count or a hash). Otherwise no doc change required.
7. Run a smoke check on the spec used as the source for this brief (`tasks/builds/v1-freeze-final-hardening/spec.md` in the consuming repo) to confirm the new Hunt Targets would surface the corresponding findings on a re-run. This is a sanity check, not a regression test — the v1-freeze spec is already APPROVED, so the new Hunt Targets should find the patterns they were designed to catch but should NOT regress the existing-APPROVED verdict.

### 6.2 Compatibility

The 6 new Hunt Targets are additive and reference only standard spec concepts (write paths, dedupe keys, content boundaries, hostname allowlists, denormalised tenant columns, idempotency arbiters). No project-specific terms are introduced; no PROJECT_CONTEXT injection changes are required. The 2026-05-29 brief's §6.2 "Parallel PROJECT_CONTEXT update" is unaffected.

### 6.3 Risk

Risk class: **Trivial**. The change is additive to a system prompt; no runtime code paths change; no schema changes; no PR-pipeline behaviour changes. The worst case is the new Hunt Targets surface false positives on future spec reviews. False positives are caught by the existing coordinator-side schema validation and the operator's per-finding triage; they do not auto-apply. The mitigation if false positives prove noisy is to tighten the Hunt Target wording in a follow-up Trivial PR.

### 6.4 Reviewer plan

1. Claude spec-review (advisory, lifetime cap 3) — sanity-check the brief's mapping of findings to patterns.
2. ChatGPT-spec-review (automated mode) — adversarial review of the brief itself, validating that each new Hunt Target's failure-mode description is concrete and that the fix-sketch guidance is actionable.
3. Operator gate — surface the brief's verdict + the new Hunt Targets for operator approval before landing.
4. Land via Trivial PR against `main` of the framework submodule (`michaelhazza/claude-code-framework`). PR title: `feat(chatgpt-spec-prompt): add 6 hunt targets from v1-freeze-final-hardening parallel-mode learning`.

---

## 7. Appendix — source incident log references

- Consuming repo: `automation-v1-fourth`
- Session log: `tasks/review-logs/chatgpt-spec-review-v1-freeze-final-hardening-2026-05-31T01-34-41Z.md` (in the consuming repo)
- Spec under review: `tasks/builds/v1-freeze-final-hardening/spec.md` (in the consuming repo)
- PR: `michaelhazza/automation-v1#450`
- Final verdict: APPROVED, 24 findings, 21 applied, 0 rejected, 3 deferred.
- Per-round OpenAI raw outputs: `tasks/review-logs/.parallel-mode/openai-round1.json` / `openai-round2.json` / `openai-round3.json` (in the consuming repo)
- ChatGPT-web raw outputs: captured in-session in the session log Round 1 / Round 2 / Round 3 sections.

---

## 8. Decision log

- **Decision 1:** scope this brief to `SYSTEM_PROMPT_SPEC_V2` only. The source session was a spec review; the PLAN and PR tiers were not exercised. A separate brief should source future plan-prompt or PR-prompt improvements from the corresponding tier's session logs.
- **Decision 2:** do NOT fold architect-tier implementer notes (F25, F26, F27) into the spec prompt. Those are correctly plan-stage refinements; folding them into the spec prompt would create false positives on specs that defer those details to plan time by design.
- **Decision 3:** the 6 new Hunt Targets are written to be portable across consuming repos. No repo-specific file paths or registry names are referenced. The 2026-05-29 brief's PROJECT_CONTEXT parameterisation pattern is not needed for these 6 because the patterns reference standard spec concepts, not project-specific manifests.
- **Decision 4:** keep the existing Hunt Targets unchanged. F10, F17, F18, F22, F23 are evidence the existing prompt is doing real work — strengthening those Hunt Targets is out of scope for this revision.

