---
name: frontend-correctness
description: Use when writing or modifying React components, hooks, forms, modals/drawers, client API adapters, or polling/streaming consumers. Engineering-correctness pitfalls (state lifecycle, async races, permission gating) — distinct from design/style guidance, which lives in the frontend design-principles docs.
---

# Frontend correctness (React)

The recurring client-side bug classes from review history. All React/TypeScript.

## Component state lifecycle

- A component gating on `if (!open) return null` stays MOUNTED — useState persists across close/reopen, so stale errors and fields reappear next open. Extracted modals need a `useEffect` on `open` that resets owned state (the original host unmounted via conditional JSX; extraction created the bug). Alternatively `key={item.id}` to force remount — pick one pattern and apply it consistently.
- A drawer/modal reused across selections retains async-fetched state from the prior item until the new fetch resolves — or forever if it fails. Reset all async-derived state at the start of the effect.
- Form builders hydrating from a loaded entity must fully rebuild state on entity switch (absent items explicitly disabled) and re-serialise the complete config on save — patching over previous state leaks the prior entity's config.
- Seeding state from external identity without clobbering user edits: track last-seeded values in a ref and compare in the functional setState form (non-functional setState reads a stale closure).
- A presentational component that normalises a value for display must emit the normalised value in every `onChange({...value})` spread — otherwise it launders the raw value back to the parent on every unrelated edit.

## Async races

- When a keying prop (entity id, period) changes, reset dependent async state AND guard in-flight fetches with a request token/cancellation so a late response can't overwrite the new context. Error paths clear previous data.
- Async fetchers clear loading flags on EVERY path — an early return before the try/finally hangs the spinner forever.
- Effects with async fetches need a cancellation/staleness guard (set-state-after-unmount, stale-response races).
- Polling hooks: mutable gates (isRunning) live in a ref, not useCallback deps, so callback identity stays stable; timers in a second ref so they're cancellable on unmount.
- SSE/WebSocket `onError` handlers clear ALL connection-derived state themselves — internal callback ordering (onReconnecting first) is not a contract.
- `window.open()` must be called synchronously in the user-gesture handler — any `await` before it severs the gesture link and popup blockers silently kill it. Check the return value to surface the blocked case.
- Sibling components sharing state through a parent: derive in-flight display state from a parent-owned counter (increment before POST, decrement on the authoritative signal), never from a child's cleared local state.
- Self-contained data-fetching components fire a duplicate fetch when nested under a parent that owns the same hook — accept an optional `data` prop; the internal hook is the standalone fallback.

## Gating, permissions, errors

- Permission-gated UI fails closed during async load: `permissions === null` = denied; hold page loading until both resource and permission fetches resolve — the flicker window fires protected requests that 403.
- Client adapters never swallow errors into empty results (`catch { return [] }`) — log and return a fail-closed shape so auth failures don't masquerade as zero data.
- UI calling an adapter that returns a success flag must branch on it — a toast on `emitted: false` is a false-success defect even against a stub.
- A context/provider whose null-default is shape-identical to a failure state makes consumers render error UI where none exists — add an explicit `hasScope`-style flag and gate failure indicators on it.
- Persisted client identity (localStorage workspace/account ids) is validated against the URL and server before use — stale values silently point the UI at the wrong tenant.
- Compare against stored enum values, not derived display labels — `role === 'derived_label'` where that string is never stored is dead code that locks out the users it meant to admit.

## Data handling

- Hierarchical lists: group → filter → sort, never filter → group (filtered-out children leave parents with dead affordances; filter controls top-level visibility only).
- Percentage fields: establish `*Pct` (display as-is) vs `*Rate`/`*Fraction` (×100) naming and confirm the backend's form before writing any formatter — a generic pct() on a 0-5 score renders 400%, and applying it "consistently" hides the bug. Different scales on one page get separately-named formatters.
- Structured config through a textarea: parse on change into local draft state, emit the parsed object only on successful parse with inline errors — binding the raw string silently disables downstream checks.
- Reusable form components derive every HTML `id`, `htmlFor`, and radio `name` from a per-instance prop — hardcoded values collapse multiple instances into one browser-level group, invisible on the first instance.
- JS-side sorts that must preserve a DB ORDER BY replicate the full comparator chain with tiebreakers, ending in a stable id as the determinism anchor.
- Never merge semantically distinct states ("check failed" vs "couldn't determine") at the data layer — collapse only at the UI summary level; they carry different operator actions.
- Components that can recursively open themselves (embedded editors) take an `embedded` prop suppressing recursive-open affordances.
- Tenant-facing copy never exposes internal hierarchy/tier vocabulary — "inherited" without saying from where; provenance belongs in admin surfaces.
