# Framework migrations

Per-version migration scripts that run automatically during `/claudeupdate` on consuming repos. The pattern is modelled on Rails / Drizzle / Flyway database migrations: every framework version that needs operator-visible cleanup or per-repo file changes ships a script here; `scripts/run-migrations.js` discovers them and runs in order.

## Convention

- One file per framework version: `v<MAJOR>.<MINOR>.<PATCH>.js`
- Each file exports a single async function `migrate(ctx)` where `ctx` is `{ consumerRoot: string, frameworkRoot: string, fromVersion: string, toVersion: string }`
- The function is called from the consuming repo's root (`process.cwd() === ctx.consumerRoot`)
- Migrations MUST be **idempotent** — safe to re-run. Always check whether the change is already applied before applying it.
- Migrations MUST be **non-destructive on conflict** — if a file the migration would modify has been customised locally, leave it alone and report; do not auto-overwrite.
- Migrations SHOULD return a structured result: `{ status: 'applied' | 'skipped' | 'conflict', notes: string[] }`. The runner aggregates these for the per-repo report.

## Execution model

`scripts/run-migrations.js` is called with `(consumerRoot, fromVersion, toVersion)`:

1. Reads the consuming repo's `.claude/.framework-state.json` to get `appliedMigrations: string[]` (list of versions already applied)
2. Discovers all `migrations/v*.js` files in the framework canonical
3. Sorts by semver
4. Filters to `version > fromVersion && version <= toVersion && !appliedMigrations.includes(version)`
5. Runs each in order, capturing the result
6. Appends successful version IDs to `appliedMigrations[]` and writes back
7. Returns a per-version report

If any migration throws, the runner stops and propagates the error. The state file is updated only for migrations that completed successfully before the failure.

## State tracking

The `appliedMigrations: string[]` field in `.framework-state.json` is the source of truth for what's been applied. It's authoritative — the runner never assumes a migration has been applied based on file presence or content. This means:

- A consuming repo that adopts framework v2.9.0 fresh (no prior `.framework-state.json`) gets all migrations from v2.0.0 onward, in order
- A consuming repo that's at v2.8.0 and bumps to v2.9.0 gets only the v2.9.0 migration
- A consuming repo that was at v2.7.x, then v2.8.0 was adopted manually (per the v2.8.0 CHANGELOG migration notes), the operator can pre-populate `appliedMigrations: ["2.8.0"]` to mark it done; the runner will skip v2.8.0 next bump

## Authoring a new migration

1. Look at the most recent migration file as a template
2. Name it `v<version>.js` matching `.claude/FRAMEWORK_VERSION` at the time of authoring
3. Make it idempotent (use `existsSync`, content hashing, or marker files)
4. Test by running `node scripts/run-migrations.js <consumer-root> <previous-version> <this-version>` against a smoke target
5. Update `CHANGELOG.md` to reference the migration: `Migration: <script-name> — <what-it-does-and-why>`
6. Ensure the file is in `manifest.json` `managedFiles` (the `migrations/*.js` glob covers it automatically)

## Why migrations, not just sync.js

`sync.js` deploys files declaratively from `managedFiles`. It can't:

- Delete files that the framework used to manage but no longer does (sync.js leaves them — they're now "customised")
- Copy templates to non-template destinations (e.g. copy `.claude/project-registries.json.template` → `.claude/project-registries.json` on first adoption)
- Rename or move files within the consuming repo
- Run arbitrary one-time setup commands

Migrations cover this gap. They're operator-visible (reported per-repo by `/claudeupdate`), versioned (no surprise re-runs), and idempotent (safe under repeated execution).
