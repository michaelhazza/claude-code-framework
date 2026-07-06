---
name: wire-it-through
description: Use whenever adding a new capability (table, service, route, job, event, component, field, enum value) to verify it is wired end-to-end before calling it done, and when adding fields that cross serialization or client-server boundaries. The single most common build failure across all review history is a component that exists, compiles, and is tested — but is never called.
---

# Wire it through

"Shipped but unwired" is the #1 conformance gap across hundreds of builds: the migration lands, the service exists, tests pass — and the hot path never touches any of it. Existence is not integration.

## The done-check

For every new artifact, name and verify its CONSUMING call site on the production execution path:

- **Table** → at least one production read AND write (every column read somewhere must be written somewhere; a `started_at` no path writes makes the recovery sweep blind).
- **Service method** → the route/job actually calls it (routes writing the table directly while the service sits unused is the classic shape).
- **Route** → mounted in the app registry; client actually calls it; navigation points at routes that exist.
- **Job/worker/handler** → a producer enqueues it AND the startup wiring registers it. `register()`/`schedule()` exports are inert until the boot loop calls them. Registration of domain primitives at boot is unconditional (not nested in an env conditional one consumer needs), and registration-validation failures log-then-RETHROW — a half-booted process that 500s on every dispatch is worse than a clean crash.
- **Event** → emitted name matches consumed name byte-for-byte; at least one producer exists for every consumer (a UI subscribing to an event nothing emits renders permanently empty).
- **React component** → imported and rendered from its entry point in the SAME commit as the definition. "Component done" means visible, not compiled.
- **Pure helper** → the production path calls it; a green test on an unwired helper is a dead test. A pure helper called as a bare statement with its return value discarded is a no-op bug.
- **Callback/seam on a shared wrapper** → fulfils an "everywhere" requirement only when every in-scope caller wires it; grep all call sites, each passes it or carries a marked exemption.

Before classifying an uncalled handler as dead code: if the services it imports are live, it is almost certainly a missing WIRE, not a DELETE.

## Fields crossing boundaries

- Trace a new field end-to-end in ONE pass: request schema → handler destructuring → service input type → persistence write. A field missing from the service type means the handler silently derives or drops it and TypeScript can't tell you.
- When fields are added to a type that crosses a serialization boundary (JSON envelope, queue payload, RPC), update the envelope constructor in the same commit — each layer's isolated check passes while the end-to-end path is dead at the boundary. Layer-by-layer review structurally cannot catch this; only cross-file grep does.
- Never accept-then-silently-drop a request field; never let the UI mark editable what the service rejects.
- `JSON.stringify` drops `undefined` fields — a struct stripped for storage cannot be reconstructed downstream; rebuild from local state at the consumption point.

## Client ↔ server contract

Build client hooks against the server route's actual validation schema, not from memory:

- Strict schemas reject extra fields (one injected extra field 400s every request); field names must match exactly; response wrappers (`{ thing: row }`) must be unwrapped.
- Compile-green is not contract conformance when shapes are stringly/JSON typed — several "Save" buttons shipped as silent no-ops. Exercise the full request path once, or share types both sides import.
- Enum values shipped by the server must all be mapped by the client (and vice versa); a client branch on a status the DB enum doesn't contain is dead code that will lock someone out.

## Value sets and renames

- A value set (status enum, kind, reason code) is typically enumerated in 4+ places: SQL CHECK, ORM schema, validation schema, state-machine table, query filters — plus prompts, agent configs, and docs. When adding or renaming a member, grep every enumeration INCLUDING non-code files; fixing only schema/types leaves stale copies silently enforcing old behaviour.
- Renaming any string identifier (queue topic, event name, cache-key prefix, log code) is a repo-wide refactor: grep the old name before editing, enumerate every hit (emit sites, derived keys, tests, comments), and require a zero-match post-rename grep.
- After any file move/rename, grep scripts/, docs/, CI configs for the old path in the same commit — gate scripts referencing dead paths fail silently for weeks. Path-matching regexes in gates/guards break when files move into subdirectories.

## Paired surfaces

- When one path writes a value a second path must handle later (token expiry ↔ refresh-on-expiry; provider added ↔ every switch dispatching on provider), extend both in the same change — the failure arrives one token-lifetime later.
- Two adjacent sites recording the same logical value (telemetry attr + audit row) share the identical conditional expression — never hardcode one side on a happy-path assumption.
- Two UI surfaces over the same timeline data share the same send path and projection renderer, or messages exist in storage but never appear.
- When adding an emission/log/audit call to a multi-return function, grep for ALL return statements and catch branches and decide per-path — the natural "wire the obvious return" misses exactly the failure paths that matter. A diff adding an emission to one return of a multi-return function is a review smell.
