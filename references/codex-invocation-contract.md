# Codex invocation contract

> Single source of truth for how every Codex tier (`spec-reviewer`, `plan-reviewer`, `brief-reviewer`, `dual-reviewer`, `verify-phase`) shells out to the Codex CLI. Agent files **cite** this document; none embeds a divergent command line. When an agent file and this contract disagree, THIS CONTRACT WINS — fix the agent file in the same commit.

Two named modes. Review tiers use read-only; the verify phase's test-authoring step alone uses write-enabled. No tier infers write access from the read-only shape below, and no reader should treat "Codex writes the tests" as a contradiction of "Codex tiers are read-only."

## Review mode (read-only) — spec / plan / brief / dual tiers

```bash
$CODEX_BIN exec -s read-only "<prompt naming the artefact path or changed-file set + grounding instruction>"
```

- **cwd:** repo root. Never invoke from a subdirectory.
- **Artefact delivery:** the artefact path (or, for diff-scoped review, the changed-file set + base ref) is named **inside the prompt string**. Never pipe the artefact via stdin — stdin-piping starves Codex of repository context and is the exact pattern this contract replaces.
- **Grounding instruction (mandatory, explicit, in the prompt):** read the artefact, then explore the repository — does this exist already, what does it touch, are there cross-file conflicts, is this a duplication of existing logic. A prompt that only says "review this file" is under-specified; the grounding clause is what turns a text review into a repository-aware one.
- **Diff-scoped variant (`dual-reviewer`):** the prompt names the changed-file set and the base ref; Codex still explores the whole repo for context but the review itself is scoped to the branch diff.

## Write-enabled mode — verify-phase test authoring only

Used exclusively by the verify phase's step 2 (author) when it writes new test files. Two acceptable mechanisms, pinned per invoking playbook:

- **Workspace-write sandbox** — `codex exec -s workspace-write "<prompt>"` — Codex edits the working tree directly, scoped to the test-file paths the prompt names.
- **Patch-emit-and-apply** — Codex runs in read-only mode and emits a patch (diff) in its output; Claude reviews and applies it via `Edit`/`Write`. Preferred when the invoking playbook wants an explicit apply step between Codex's output and the working tree.

Write-enabled mode never governs a review tier. A review tier that needs write-enabled mode for anything is out of contract — route it back to plan-time as a gap, not a workaround.

## Binary resolution

Resolve the runnable Codex binary as the **newer of PATH vs the npm global shim**, not "whatever PATH gives first." An older PATH-resolved binary can hard-error against a newer model even though a newer binary is installed and reachable elsewhere.

```bash
CODEX_BIN=$(command -v codex 2>/dev/null || echo "${CODEX_FALLBACK_PATH:-codex}")
```

is the existing lookup used by `spec-reviewer` and `dual-reviewer`; it resolves whatever `codex` is first on PATH. Tiers built or re-mechanised against this contract additionally verify version currency: if a project's `.claude/context/agent-context.md` pins a `CODEX_FALLBACK_PATH` (or the caller otherwise knows of a second installed binary — e.g. an npm-global shim alongside a PATH install), prefer the **newer-versioned** binary of the two over blind PATH-first resolution. `codex --version` (or equivalent) is the comparison signal.

**Illustrative note (machine-specific, not a rule):** on the operator's reference machine, the PATH binary (`…/Programs/OpenAI/Codex/bin/codex`, version 0.138.0) hard-errors on the account's provisioned model; the working binary is the npm shim (`/c/Users/Michael/AppData/Roaming/npm/codex`, version 0.144.3). This is one instance of the newer-of-PATH-vs-npm-shim rule above, not a hardcoded path — other machines and other consuming repos will have different binary locations and versions.

## Fallback chain and fail-closed sandbox clause (OAI-SPEC-005, security carve-out — REQUIRED wording)

The fallback chain preserves the `-s read-only` sandbox for as long as any fallback accepts it — an older installed Codex that rejects one flag combination still gets tried with a narrower read-only-preserving command before anything weaker is attempted.

**If NO fallback accepts a read-only sandbox: STOP and record a `REVIEW_GAP`. NEVER run an unsandboxed review invocation.** This is required behaviour, not advice — no tier may fall through to a bare unsandboxed `codex exec` as a "better than nothing" last resort. A read-only review that cannot get a sandbox is a `REVIEW_GAP`, not a downgrade.

**Output capture:**
- Capture full stdout+stderr as the review output.
- Empty or clearly truncated output → retry once.
- Two consecutive failures (including two truncated/empty attempts) → stop and report to the caller. Do not attempt a third time.
- **Absence of findings after a failure is never treated as approval.** A tier that could not get a clean Codex run has no verdict to report — it must not synthesize `APPROVED` (or equivalent) from silence.

## Citing this contract

Agent files reference this document instead of restating the command line:

```markdown
Codex invocation follows [`references/codex-invocation-contract.md`](../../references/codex-invocation-contract.md) — read-only review mode, cwd = repo root, artefact by path in the prompt.
```

A literal `codex exec` command line appearing in a Codex-tier agent file outside this document is drift the tier should not carry — cite, don't embed.

---

## Project-specific notes

Project-specific operating notes for this contract (e.g. a project's `CODEX_FALLBACK_PATH` pin) live in `.claude/context/agent-context.md` under the section for the citing agent (ADR-0006), not here.
