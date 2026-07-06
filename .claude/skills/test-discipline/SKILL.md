---
name: test-discipline
description: Use when writing or modifying tests, mocks, fixtures, or acceptance criteria; when a test passes suspiciously easily; after reordering calls in code under test; or when deciding what KIND of test a requirement needs (pure unit vs DB-integration vs gate).
---

# Test discipline

Rules for tests that actually prove something, distilled from post-mortems of tests that passed while the feature was broken.

## Tests that prove nothing (audit for these)

- Assertions only inside a loop or `if` over possibly-empty data pass vacuously. Every test has at least one assertion that runs unconditionally.
- A green test on a pure helper the production path never calls is a dead test — for "invariant holds at read time" requirements, conformance means every production read site routes through the canonical filter.
- Tests that mock the consequence rather than the implementation survive contract changes they should catch: assert the path taken (which dependencies were called, in what order), not just one side effect on a pre-mocked surface.
- Positional mocks (`mockResolvedValueOnce` at index N) silently break when a refactor reorders calls — failure-path tests go false-green because the injected rejection hits a different call. After any reorder, grep tests for positional mocks and re-wire.
- A test file outside the runner's include globs provides zero coverage regardless of content; check globs before treating a test-shaped file as active (or deleting it as unused).
- Judge/rubric thresholds: prompt scale, threshold constant, and clamp must agree on the same 0-N scale, with the scale in the constant's name — a mismatch makes the gate trivially pass while looking consistent.

## Match the test to the failure mode

- Pure-function/service-mocked tests can never catch: DB CHECK-constraint violations, RLS/session-variable behaviour, ON-CONFLICT arbiter matching, or transaction-abort semantics. When a write path touches a table whose migrations define cross-column constraints, grep the migrations first and pin a real-DB integration test.
- Separate pure computation from I/O: the pure function takes a fully-enumerated input struct (caller-supplied timestamps, no clock/DB) and returns deterministic output; a thin coordinator does the reads/writes. This is what makes logic testable without a DB — and identifies exactly what ISN'T covered.
- When a refactor moves observable side effects into storage-layer arithmetic (e.g. behaviour driven by absence from an `ON CONFLICT ... RETURNING` set), pure tests can no longer prove equivalence — the conflict arbiter is the real unique index; use a fixture-DB test.
- External-provider payload shapes need a captured real-delivery fixture committed to the repo and a test reading the pinned path from it — documentation-faith fails silently (`undefined` passes idempotency checks against itself).
- Extending a widely-used shared helper: strictly additive (new options optional, defaults reproduce current behaviour), pinned by a frozen snapshot of the pre-change implementation as a fixture asserting observable equivalence — deliberate divergence then surfaces in review as a fixture edit.
- Not every path needs the same coverage shape: structural invariants suit cheap static gates, propagation logic suits unit tests, security context suits integration tests. Choose by failure mode, not habit.

## Fixtures and determinism

- Interleaved/out-of-order fixtures catch ordering bugs that in-order fixtures never fire (audit SQL time-window joins, reconciliation order). Fixtures always write in-order by default — that's the blind spot.
- Cross-source parity (a catalogue vs the schema consumers actually see): a ~20-line test iterating one side asserting membership in the other, both directions, is the cheapest drift gate there is.
- Discriminated-union validators: every variant branch calls a variant-specific validator (envelope-only validation silently accepts malformed variants), and unknown discriminant values are rejected explicitly — TS unions protect in-process callers only.
- Regression tests for retired/disabled behaviour: pin the retirement with a test asserting the typed "retired" failure, so accidental re-enablement fails loudly.
- CLI-entry guards on modules exporting both testable functions and a top-level entrypoint (Node ESM: compare `import.meta.url` to `process.argv[1]`) — otherwise importing from a test executes main() with side effects.
- Idempotency-sensitive closures (`release()`, `close()`) get a call-twice test.

## Acceptance criteria (spec-side)

- Write goals as verifiable assertions before starting: "add validation" becomes "these invalid inputs return 400". Prefer assertions checkable by deterministic tooling over human judgment.
- Numeric performance targets separate a wide runaway ceiling from the tight binding gate, and binding budgets derive from measured runs, never projections.
- Every "budget may be exceeded when Y" carve-out pairs with a required evidence artifact — an exception invocable without evidence is budget creep.
