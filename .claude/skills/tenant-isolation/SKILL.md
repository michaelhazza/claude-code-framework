---
name: tenant-isolation
description: Use BEFORE writing or reviewing any code that touches tenant-scoped data in a multi-tenant database — queries, routes, background jobs, queue workers, webhooks, or RLS policies. Also use when a tenant-scoped query mysteriously returns zero rows, when adding a table that holds tenant data, or when handling any identifier supplied by a client, webhook payload, or LLM tool call.
---

# Tenant isolation

The highest-frequency, highest-stakes defect class in multi-tenant codebases. Under Postgres FORCE row-level security the failure is *silent*: a query without tenant context returns zero rows and affects zero rows — no error. Jobs become permanent no-ops, UIs render empty, and "0 rows" gets treated as success.

## The one mental model

RLS context is per-TABLE and per-CONNECTION, not per-caller. "My service is already scoped" is the wrong question; ask "does THIS connection have the context THIS table's policy requires?"

## Where tenant context gets lost (check every one)

- **Background jobs, crons, boot-time scans, CLI scripts** — anything outside an authenticated request. Cross-tenant sweeps need explicit privilege elevation (admin role inside a transaction); per-tenant work needs the tenant transaction wrapper established first. A comment declaring intent does not authorize access.
- **Queue workers** — must register through the canonical wrapper that establishes tenant context, never the raw queue-library API. A worker that opts out because "the tenant id lives in the row" must re-open a tenant-scoped transaction immediately after the initial row lookup; the opt-out covers the first query only.
- **Inner/nested transactions** — an inner `db.transaction()` can check out a fresh connection WITHOUT the session variable. Same for module-level pool handles and callbacks that run after the establishing transaction committed.
- **Unauthenticated routes (webhooks, public callbacks)** — must manually establish both the DB session setting AND any async-local-storage handle downstream helpers read. Test-environment fallbacks mask the omission; only a wiring-asserting test catches it.
- **"Admin" helpers** — verify the actual privilege mechanics. A privileged pool without a role switch still hits RLS and silently returns zero rows. Names imply privileges they may not grant.

## Non-negotiable write-time rules

1. **Explicit tenant predicate on every query, even with RLS active.** RLS is the backstop, not the boundary. Any `WHERE id = ?` on a tenant table not also filtering by tenant id is a finding. An unused tenant-id parameter (`_organisationId`) on a helper IS the bug, not a style choice.
2. **RLS does not propagate through foreign keys.** A child table holding tenant data via FK only needs its own policy (EXISTS join through the parent) or its own tenant column. Check each table for its OWN policy. FK-only join/link tables get zero protection from either mechanism — route handlers must verify parent-row tenant membership explicitly.
3. **RLS protects reads, not writes.** Any write referencing rows in other tenant tables (a new FK column, a join row) needs service-layer preconditions inside the same transaction: load each referenced row under the caller's tenant scope, treat zero rows as generic not-found. A spec claiming "FK/RLS enforces same-org" on a write path is always wrong.
4. **Policies need both USING and WITH CHECK** — USING alone leaves INSERT unprotected. On tables mixing tenant and platform/global rows the two must be deliberately asymmetric: reads may include the global scope; the write predicate must NOT contain the global OR-arm. Guard `current_setting(...)` with `NULLIF(..., '')` before casting — Postgres can reorder AND clauses past an apparent short-circuit.
5. **Never trust caller-supplied scope identifiers.** Tenant/scope/owner ids in request bodies, webhook payloads (pre-signature-verification everything is attacker-controlled), job payloads, or LLM tool inputs are tampering surfaces. Derive scope from the authenticated/stored row; for queue jobs pass the entity id only and load the tenant from the row. Two-step create-then-confirm flows anchor all decisions to the stored row, not the request body.
6. **Sub-scope is not implied by tenant scope.** Routes carrying both a parent-scope id and a resource id (`/:subaccountId/agents/:agentId`) are IDOR-prone even under tenant RLS — assert the resource belongs to the named sub-scope. Service writes scoped to a sub-tenant take the sub-scope id as a REQUIRED parameter in every UPDATE/DELETE predicate. If a route is mounted under a scoped path, the principal builder MUST resolve that path param; hardcoding it to null silently widens results to the whole parent.
7. **Scope must be a query predicate, never a projection-time stamp.** Stamping the request's tenant onto rows at projection time hides cross-tenant leaks and manufactures false attribution.
8. **Return 404, not 403, when a row exists but the caller lacks access** — a 403/404 split is an existence oracle.
9. **Shared in-memory resources key on (resource × tenant).** Rate limiters, circuit breakers, and queues keyed on resource alone let one tenant exhaust or trip the breaker for all others.
10. **List endpoints must not return sensitive fields the detail endpoint gates.** Diff any new list SELECT against the detail route's redaction branches; apply redaction at both service and route layers deliberately.

## Review checklist for tenant-touching diffs

- Grep the changed set for bare/raw DB handles on tenant tables; migrate ALL hits in one commit (iterative discovery across review rounds costs far more).
- Never ship an enable-RLS migration before every raw-DB consumer of the affected tables is migrated — they fail closed on deploy. Migration + consumers are one atomic landing unit.
- Mixed scoped-vs-raw DB usage inside one file marks an unfinished migration; finish it, because new code copies whichever function it sits next to.
- When a "table lacks RLS" claim arises (yours or a reviewer's), grep the migrations directory, not just a registry file, before concluding.
