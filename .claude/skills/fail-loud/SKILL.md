---
name: fail-loud
description: Use when writing error handling — catch blocks, fallbacks, defaults for failed lookups, fire-and-forget calls, external-provider failures, safety/permission checks, or anything that could report success without the underlying operation durably happening. Also use when deciding 4xx vs 5xx, retry vs dead-letter, or what a "cannot verify" outcome should do.
---

# Fail loud, fail closed

Silent failure is the defect class reviewers catch most often after tenant isolation: no-ops reported as success, errors flattened to empty results, fallbacks that quietly bypass safety checks.

## The prime directive

A caller must never observe success when the operation didn't durably happen. No toast on `emitted: false`; no 202 "submitted" when the enqueue was caught-and-logged; no webhook ack without a terminal outcome row; no "completed" ledger slot for an unimplemented handler (it suppresses the real path downstream).

## Fail-closed defaults

- Any pre-action safety lookup (suppression list, blocklist, permission, compliance state) fails CLOSED: `.catch(() => false)` on a gate converts lookup errors into bypasses. The declared default of a policy flag IS the semantics of the failure path — for authz/compliance, default to the blocking side. Scrutinise every mechanical `let x = false` near a gate.
- "Inconclusive" verification outcomes are treated as "fail" in rollback/suspension logic — a change whose safety cannot be confirmed is operationally a broken change; infrastructure outages don't grant immunity.
- When a stricter resolution path returns null meaning "deny", never fall back to the legacy permissive path on that null — gate the fallback on whether the new path was applicable at all.
- Permission-gated UI fails closed during async load: `permissions === null` renders as denied, not as visible-until-loaded.
- Ownership lookups distinguish three states — owner (owned) / null (unowned, no boundary) / undefined (not found or cross-tenant) — and the distinction survives every layer. `undefined ?? null` at any layer turns "lookup failed" into "no privacy boundary".

## Catch blocks

- No empty catches. Never `.catch(() => {})`. Every fire-and-forget promise gets `.catch()` with a logged warning naming caller and callee — even when the callee "never throws" today; one unhandled rejection can kill a long-lived worker.
- Fire-and-forget is acceptable only for non-critical observability. Producers on critical paths (user submissions, paid jobs) throw on failure and rethrow enqueue errors.
- Client API adapters must not swallow errors into empty results (`catch { return [] }`) — auth failure becomes indistinguishable from zero data and operators stop diagnosing. Minimum: log the error while returning the fail-closed shape.
- A runtime branch covering a case the system's invariants make impossible throws a typed, greppable error — returning silent false says "recoverable" when the truth is "invalid configuration that was promised impossible".
- Partially-wired features: replace the unsafe method body with a runtime throw carrying a typed reason and tracking pointer — never leave a half-implementation an accidental caller could execute.

## Error translation and status codes

- The 4xx/5xx split is a retry-semantics contract, not cosmetics. Validate typed fields (UUID, enum, int) at the route/parser surface where the structured 400 exists — pushing validation to a storage-layer cast converts caller errors into opaque 500s. Throwing-parse inside an async wrapper can bypass error-translation middleware entirely (500 + page instead of 400): use non-throwing validation and raise the shape your error-normalisation layer recognises. Check the middleware's forwarded-field whitelist before throwing errors with custom fields.
- Map every SDK/internal error — including the catch-all — to a closed contract enum at the SERVICE boundary (one canonical mapper, fail-closed on unknown); routes translate via an exhaustive switch with `default: throw`.
- Sentinel errors used as internal control flow by shared primitives are caught and translated at the immediate call site; a test asserts the sentinel never escapes into the public return shape.
- On endpoints with replace/PATCH semantics, REJECT (403) unprivileged requests containing privileged-only fields — silent stripping lets a partial update erase privileged state while returning 200. Validation schemas for such endpoints use strict/unknown-key-rejecting mode.

## Observability of failure

- Trust the structured category field the error's owner set; substring-matching on messages misclassifies on the first rewording.
- Side-effect logs describing persisted state changes emit AFTER the write succeeds; a "reset/flipped" log before a failed write lies to every downstream observer.
- Stable log codes and invariant rejections go through the structured logger with correlation fields — `console.*` writes outside the observability pipeline are never found.
- Never silently truncate inputs to embeddings/summaries/search: every cap is an exported named constant and every truncation emits a structured warning with sizes.
- Durable audit rows are written in-transaction with the state change; post-commit best-effort events are supplementary. Privileged mutations an operator could dispute get an append-only audit row.
- When an exit-code vocabulary can't carry all states, emit an always-present machine-scrapeable summary line per state.
- Paired `*_started`/`*_completed` events need a stable identity on both ends; an end with no matching start is drop-and-warn, never paired to an unrelated open. Worst case must be under-count, never mis-attribution.
