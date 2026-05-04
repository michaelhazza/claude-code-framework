# Review pack

For: code review, PR review, spec conformance, adversarial review.

Status: scaffold (2026-05-03). Until populated, agents using this pack should fall back to loading the full referenced files.

## Sources

Load these sections only.

- `architecture.md`:
  - `#route-conventions`
  - `#service-layer`
  - `#row-level-security-rls-three-layer-fail-closed-data-isolation`
  - `#auth-permissions`
  - `#architecture-rules`
  - `#key-files-per-domain` (index, for quick lookups)
- `DEVELOPMENT_GUIDELINES.md`:
  - § 1 Multi-tenancy and RLS
  - § 2 Service / Route / Lib tier boundaries
  - § 3 Schema layer rules
  - § 8 Development discipline
  - § 9 Multi-tenant safety checklist
- `references/test-gate-policy.md`
- `KNOWLEDGE.md` filtered to entries with category `pattern`, `gotcha`, or `correction`

## Skip

- LLM routing rules unless the diff touches LLM code
- Frontend design principles unless the diff touches UI
- Migration discipline unless the diff includes a migration
- Worked examples in any spec doc

## Why this scope

A reviewer needs the layer rules, the contracts every change must respect, and the "watch out for this" gotchas. They do NOT need the full LLM routing primitive list, the full UI design principles, or every architectural ADR.
