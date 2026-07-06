---
name: postgres-migrations
description: Use BEFORE authoring or editing a database migration or ORM schema change — CHECK constraints, enums, foreign keys, unique or partial indexes, backfills, column renames, RLS policies, or timestamp/timezone handling. Also use when a migration fails on existing data or a unique index is rejected as non-immutable.
---

# Postgres migration and schema discipline

Rules distilled from recurring migration defects. Postgres-specific unless noted.

## SQL three-valued logic (the silent killer)

- `col = NULL` never matches; `NULL <> 'x'` evaluates UNKNOWN and silently satisfies CHECK constraints or drops rows from filters. Use `IS DISTINCT FROM` for nullable comparisons; validators must route null checks through dedicated `IS NULL` handling.
- Any predicate `event_col >= optional_nullable_col` inside NOT EXISTS / NOT IN inverts silently when the column is NULL. COALESCE optional watermarks to a safe floor and add null-case test fixtures.
- Unique indexes treat NULLs as distinct by default — handle mixed NULL semantics explicitly (COALESCE in the index expression or `NULLS NOT DISTINCT`) or duplicates slip in.

## Constraints

- Adding a CHECK constraint to an existing table requires a backfill/normalising UPDATE in the same transaction, or `NOT VALID` + later `VALIDATE` — otherwise the first pre-existing violating row aborts the migration.
- CHECK constraints must mirror the contract's enum exactly. Wider-than-spec admits undefined rows; "we filter upstream" does not survive refactors. When a TEXT column is enum-like, decide explicitly whether to add a CHECK; without one the type layer is the only enforcer.
- For JSONB columns with a fixed shape, write CHECKs as allow-lists (subtract permitted keys, require empty remainder), never deny-lists — deny-lists silently accept every key you didn't enumerate.
- CHECK constraints live outside the type system: a conditionally-NOT-NULL column is still `string | null` to TypeScript. At branches that depend on the constraint, assert and throw loudly — never coerce with `?? 'default'`. Pair multi-column CHECKs with a pure application-level transition classifier every writer consults; the CHECK alone surfaces violations as opaque 500s.
- Match FK actions to the service contract: "rows are never deleted" pairs with ON DELETE RESTRICT, not SET NULL (which silently destroys audit links).

## Indexes

- A partial unique index's WHERE clause cannot reference volatile functions (`now()`), runtime UUIDs, or other tables. When it must scope to a foreign entity, denormalise a stable slug column and treat it as immutable identity.
- `date_trunc` on `timestamptz` must cast `AT TIME ZONE 'UTC'` — in the projection, the GROUP BY, AND any index expression (without the cast it is only STABLE and the unique index is rejected as non-IMMUTABLE, sometimes only on fresh applies). Bare date_trunc follows session timezone and silently splits UTC days.
- Upserts against a partial unique index must reproduce the index's full predicate in the conflict target or the arbiter won't match. In Drizzle: `onConflictDoNothing({ target, where })` — `targetWhere` belongs to `onConflictDoUpdate` and is silently ignored; pin the generated SQL with a test.

## Structural patterns

- Postgres has no polymorphic FKs. "References table A when type=X, table B when type=Y" splits into one nullable FK per target plus a CHECK enforcing exactly-one-non-null tied to the discriminator.
- Mutually-referencing new tables need a deferred FK: order creation to resolve the cycle, or add the second constraint via later ALTER TABLE. Spec the ordering explicitly.
- Renaming an FK-referenced key value takes three statements in one transaction: INSERT new key, UPDATE referencing rows, DELETE old key.
- Flags governing fallback behaviour when a child config row is missing must live on the parent entity that always exists — a flag on the optional child is unreadable exactly when it matters.

## Cross-layer sync (the drift class)

- ORM schema and SQL migration must agree in both directions: every ORM `.references()` needs the matching SQL FK, and vice versa. Verify by running codegen and confirming zero diff — partial-index-in-migration vs full-index-in-ORM makes the next codegen emit a destructive diff.
- A NOT NULL column added to a table written by code outside your typecheck surface (separate worker process, external service) needs a grep-enumerated list of every producer, each confirmed updated — cross-process producers get no compile signal.
- Column renames: grep BOTH the ORM camelCase name AND raw snake_case literals in SQL templates, plus provisioning/seed paths. Update side-registries (RLS manifest, job maps, env manifest) in the same change.
- Value-set changes (enum member added/renamed): grep every enumeration site — SQL CHECK, ORM schema, validation schema, state-machine table, query filters, agent/config files.

## Process

- Before authoring, check the true next-free migration number on main AND all in-flight branches; on collision, renumber forward past all known claims (never backward, never reuse), in original relative order, sweeping headers, down-migrations, and doc references — verified by grepping the old number.
- The never-edit-applied-migrations rule applies only to migrations applied to some environment. Net-new migrations on an unmerged branch are edited in place.
- If migration SQL reads a session setting for conditional branching, the runner must bridge the operator's env var into that setting inside the transaction, or the branch is unreachable.
- When a migration set adds a conservative default AND a backfill on a sibling column, check whether the backfill writes values the new default forbids — if so, drop the backfill rather than shipping a permanent row-vs-policy contradiction.
