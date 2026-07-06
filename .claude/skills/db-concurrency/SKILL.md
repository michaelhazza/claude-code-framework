---
name: db-concurrency
description: Use BEFORE writing upserts, idempotency keys, state-machine transitions, queue/webhook handlers, retry logic, locks, or any code where two writers, workers, or retries can race. Also use when designing "check then act" flows, dedupe keys, or crash-recovery sweeps.
---

# Database concurrency and idempotency

Check-then-act races, wrong conflict keys, and retry re-fires are the second-largest real-defect class in review history. Postgres/TypeScript specifics labeled.

## Upserts and idempotency keys

- SELECT-then-INSERT is never concurrency-safe; use `INSERT ... ON CONFLICT`. Two racing writers both observe "no prior row".
- Never catch a unique-violation (23505) and recovery-SELECT inside the same Postgres transaction — the raised error aborts the tx and the recovery query fails. Use `ON CONFLICT DO NOTHING RETURNING id` (SQL-level no-op) then re-select the winner. Invisible in DB-mocked tests.
- A bare untargeted `onConflictDoNothing()` swallows ANY unique violation, including unrelated ones. Always name the exact conflict column set. When catching 23505 in code, key on the constraint NAME, not just the error code.
- The idempotency key captures "what makes two CALLS the same call", not "two CALLERS the same caller". If a caller can make multiple legitimate distinct calls, add a per-call discriminator (natural id or content hash). Exclude any per-attempt value (sequence, timestamp) from the conflict key — a conflict target that never collides is worse than none.
- Derive created-vs-updated from the upsert's return (`RETURNING`, `xmax = 0`), never a preflight existence SELECT. Ask the database what happened; don't ask twice.
- Webhook idempotency keys on the provider's per-delivery EVENT id (plus type), never the resource id — providers send multiple events per resource.
- Time-bucketed default idempotency keys protect double-clicks but coalesce intentional rapid triggers: document that programmatic callers must supply explicit keys. Don't "fix" with per-request UUIDs — that trades silent-drop for duplicate execution.

## State transitions

- Every state-changing UPDATE carries the full guard predicate — expected-from status, version/claim fence, tenant — and asserts affected-row count via RETURNING/rowCount. Id-only UPDATE after a read check is a TOCTOU bug. Emit the success log only in the confirmed branch; a lost race surfaces as 409/no-op, never success.
- A `version` increment in SET without `AND version = <prior>` in WHERE looks like optimistic concurrency but never closes the window.
- When a guarded UPDATE affects 0 rows, enumerate ALL legal row states in the response mapping — a two-branch "completed vs everything else" hides timing-window states.
- The terminal-state write is the LAST write in a multi-write success path; a catch block only ever writes the failure transition.
- Verify code performs only transitions the state machine declares; grep for status strings that don't exist in the machine (client filters on phantom statuses recur).
- Single-writer coordination losers return `{ success: true, suppressed: true, reason }` — "another writer beat me" is a healthy outcome; returning failure triggers retry storms and false incidents. This never applies to genuine breakage (connection lost, malformed payload, permission denied).

## Locks and critical sections

- `SELECT FOR UPDATE` only holds inside an enclosing transaction; outside one it serialises nothing.
- Never hold a row lock across an LLM call or any I/O with >~100ms tail. Classify-before-lock: read unlocked, do the slow work, then open a fresh transaction for a compare-and-set write.
- External side effects run AFTER commit, never inside the transaction callback (a later throw rolls back the DB but not the world). Conversely "commit, then throw" inside a tx callback is a trap — the helper rolls back on any throw; return a sentinel and throw after.
- Advisory locks: `hashtext(uuid)::bigint` gives 32-bit entropy (sign extension); use the two-arg int4 form from the UUID hex. Session-level locks: check the boolean unlock return (false = invariant violation), attempt unlock-all recovery, and let a release failure outrank the primary error — a stuck lock on a pooled connection blocks all future callers.
- Singleton-per-scope install flows: transaction-scoped advisory lock for the clean error path PLUS a partial unique index as the race net, mapping unique-violation to 409.
- Lazy single-acquisition over shared async state: publish the pending promise to the slot synchronously BEFORE any await; `if (slot === null) slot = await open()` has a microtask race.
- One transaction handle = one connection: never `Promise.all` concurrent queries on a single tx handle (driver interleaving, busy errors). Sequential is correct.

## Queues, retries, recovery

- Every re-enqueue/manual-retry site passes the queue's configured retry/backoff/expiry policy — relying on defaults silently downgrades reliability. Retry counters carry through BOTH returned-error and thrown-error paths.
- Classify provider failures before retrying: permanent (auth, invalid recipient) → mark failed + dead-letter + ack immediately; only transient rethrows to the retry policy. Collapsing all to one class either burns the retry budget on the unfixable or suppresses the retry machinery.
- Structurally invalid payloads from external/version-skewed producers: `safeParse` + log + ack (they never succeed on retry); reserve throwing `.parse()` for producers you control. Never migrate a defensive handler to throwing without policy approval.
- A handler re-enqueueing a deferred job for its own entity must not reuse the entity's singleton key verbatim — the active job owns it and the enqueue silently no-ops; namespace by attempt.
- Stuck-row reclaim thresholds strictly greater than the worker's expiry timeout (rule of thumb 2×); the real overlap protection is the per-row status predicate on the reclaim UPDATE.
- Pre-attempt guard hooks inside retry helpers are in-process only — cross-process dedup needs a queue singleton key, advisory lock, or unique-constraint write. Ask in review: "what if two workers race here?"
- "Row committed then enqueue fails" and "external send then crash before commit" both need an explicit answer: outbox pattern, reconciliation sweep, or a claim column with claimed-at TTL (claim via conditional UPDATE → do work → stamp done-at; sweep retries unstamped terminal rows).
- Rate limiters counting rows in a sliding window: if the in-flight row is inserted before the check, exclude it from the count — otherwise the effective limit is N-1.

## Time

- Values feeding dedupe keys, cursors, or predicates compared against DB columns come from DB time (`transaction_timestamp()`) in the same transaction — never `Date.now()`, and never an app-clock fallback when the DB query fails (fail closed; skip the tick). Elapsed-time for timeouts/billing computes both endpoints in SQL.
- In per-row → batched-INSERT refactors, never collapse per-row timestamps into one batch-build-time `new Date()` — ordering and sequencing consumers observably diverge. Drive post-batch reconciliation from the source-ordered input array, and wrap the bulk INSERT in its own try/catch so in-memory-resolved entries survive a write failure ("if the bulk INSERT throws, what survives?").
