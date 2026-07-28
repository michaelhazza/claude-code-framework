#!/usr/bin/env node
// board-sync.mjs — upserts one draft-item card per build onto a single
// account-level GitHub Projects v2 board, sourced from every
// tasks/builds/*/status.json (contract: schemas/build-status.schema.json).
// Companion to generate-current-focus.mjs (C8) — same status.json source,
// different sink (a board, not a markdown block). The board is a VIEW, not
// a gate (spec §7.4/§8.4): its failure modes are recorded and non-blocking.
//
// ---------------------------------------------------------------------------
// §5.3 OPEN ITEM CLOSED HERE — the `gh project` command surface, pinned
// against `gh 2.87.3` by running `--help` on every relevant subcommand
// (read-only; no board was created or edited while writing this chunk).
// Confirmed subcommands + flags:
//
//   gh project create --owner <login> --title <title> --format json
//     -> one-time board creation. Returns { number, id, ... }.
//   gh project field-list <number> --owner <login> --format json
//     -> { fields: [{ id, name, type, options?: [{id,name}], ... }] }
//        (options present only on SINGLE_SELECT fields). Read once per run
//        to resolve field ids for item-edit mutations.
//   gh project field-create <number> --owner <login> --name <name>
//     --data-type {TEXT|SINGLE_SELECT|DATE|NUMBER}
//     [--single-select-options "a,b,c"] --format json
//     -> one-time custom-field creation (--init only).
//     IMPORTANT: there is NO `field-edit` subcommand in this gh version
//     (confirmed against the full `gh project --help` command list:
//     close/copy/create/delete/edit/field-create/field-delete/field-list/
//     item-add/item-archive/item-create/item-delete/item-edit/item-list/
//     link/list/mark-template/unlink/view). A field's options can only be
//     set at creation time. `gh project create` auto-provisions a default
//     single-select "Status" field per GitHub's standard project template —
//     this cannot be verified or renamed via the CLI without creating a live
//     board (out of scope here — no mutating command was run). --init
//     therefore REUSES a pre-existing "Status" field if field-list already
//     reports one, and prints an operator instruction to confirm its
//     options match the enum via the web UI; otherwise it creates one fresh
//     with the correct options. WATCH-OUT FOR C21/C22: verify this against
//     a real board on the first --init run and correct this comment +
//     runInit() if the default field's name/type differs from what's
//     assumed here.
//   gh project item-create <number> --owner <login> --title <t> --body <b>
//     --format json -> creates ONE draft-issue card, returns { id, ... }.
//   gh project item-edit --id <item-id> [--title <t>] [--body <b>]
//     [--project-id <id> --field-id <id>
//       (--text <v> | --number <n> | --date <YYYY-MM-DD>
//        | --single-select-option-id <id> | --clear)]
//     --format json
//     -> per --help: "only a single field value can be updated per
//     invocation" for project-item field edits, so upserting a card's
//     custom fields costs one item-edit call per field. Draft-issue
//     title/body edits use --id alone (no --project-id/--field-id needed).
//   gh project item-list <number> --owner <login> --format json [-L <n>]
//     -> list existing cards to resolve the {Build Repo, Slug} upsert key.
//   gh project item-archive <number> --id <item-id> --owner <login>
//     --format json [--undo] -> archive (or unarchive) one item. NOTE:
//     unlike item-edit, item-archive DOES take the project <number> as a
//     positional (per its USAGE line), matching item-create/item-list.
//   gh project view <number> --owner <login> --format json
//     -> { id, number, title, ... }. Used to resolve the project's internal
//     node id (required by item-edit --project-id), separate from the
//     user-facing project --number.
//
// DELTA FROM THE PLAN'S ASSUMPTION: none at the subcommand-name level —
// every subcommand the plan named (item-create, item-edit, field-list)
// exists exactly as named, with the flags above. The delta is the missing
// `field-edit` subcommand, which the plan did not anticipate and which
// changes how --init must treat a pre-existing default "Status" field (see
// above).
//
// UNVERIFIED ASSUMPTION (no live board exists to inspect without a
// mutating call, which this chunk does not make): the exact JSON shape
// `item-list`/`item-create` return for a card's custom-field values. This
// script assumes each item object may expose field values either as flat
// top-level keys matching the field's display name, or nested under a
// `fieldValues` map, and hedges for both in normaliseItem() below. Because
// `updated_at` is explicitly a card-BODY value per the contract (not a
// field — see below), the stale/duplicate logic never depends on this
// assumption: it reads updated_at back out of the body text instead, via a
// stable hidden marker this script itself writes. If the field-value shape
// turns out to differ, only normaliseItem() needs correcting.
// ---------------------------------------------------------------------------
//
// Board contract (spec §7.4/§8.4):
//   - Identity = {repository, slug}, held in two custom TEXT fields `Build Repo`
//     + `Slug`. The repo value is canonicalised to lowercase before any key
//     comparison (OAI-SPEC-002 — GitHub owner/repo is case-insensitive, so
//     `Owner/Repo` vs `owner/repo` must not create a duplicate card).
//   - Item type: draft issues only. No per-build GitHub issue is created.
//   - Column mapping: the board's Kanban column comes from the `Status`
//     SINGLE_SELECT field (one option per status enum value). `phase` is a
//     plain field, never a column. `branch`/`pr`/`blockers`/`updated_at` go
//     in the card BODY (not fields) — this script embeds `updated_at` in a
//     hidden HTML-comment marker inside the body so it stays machine
//     -readable for the stale/duplicate checks below without becoming a
//     seventh custom field.
//   - Stale-update protection: skip a write when the existing card's
//     updated_at is strictly newer than the incoming record's.
//   - Duplicate recovery: two cards matching one {Build Repo, Slug} key -> keep
//     the newest (by updated_at), archive the rest, warn. Equal updated_at
//     -> lowest card id wins (OAI-SPEC-002 deterministic tie-break;
//     GitHub Projects v2 item ids are opaque node-id strings, so "lowest"
//     is plain code-point string comparison — deterministic regardless of
//     API return order).
//   - Archive: MERGED/ABANDONED records auto-archive their card after
//     ARCHIVE_AFTER_DAYS (default 14, substitutable via the
//     BOARD_SYNC_ARCHIVE_AFTER_DAYS env var).
//
// Error handling — deliberately asymmetric; this asymmetry IS the contract:
//   - `gh` failure, network error, or missing `projects_board` config in
//     `.claude/project-registries.json` -> RECORDED (console.warn) and
//     NON-BLOCKING. This script always exits 0 on the sync path, no matter
//     what `gh` does. DO NOT "harden" this into a hard failure later — the
//     board is a view, not a gate (spec §7.4), and this is the one place in
//     the pipeline where a failure is intentionally swallowed-with-a-record.
//   - EXCEPTION: slug !== directory name -> REFUSE the upsert for that one
//     record (fails closed even though the rest of this script is fail-
//     open) — a wrong slug would otherwise upsert under the WRONG board
//     identity and silently corrupt another build's card. Uses the exact
//     same wording contract as generate-current-focus.mjs (C8):
//     `slug <slug> does not match directory <dir>`.
//   --init is the one exception to "always exit 0": it is an operator-run,
//   interactive bootstrap command, so a hard failure there (bad --owner,
//   missing --title, gh error) surfaces as a non-zero exit — the operator
//   is actively watching the terminal, unlike the unattended sync path.
//
// Structure for testability: all decision logic lives in exported PURE
// functions (no fs, no gh, no Date.now()) — canonicaliseRepo, buildCardKey,
// validateSlugMatchesDir, extractUpdatedAtFromBody, buildCardBody,
// mapRecordToCard, chooseSurvivor, shouldSkipStale, shouldArchive,
// parseOwnerRepoFromGitUrl. All `gh` invocation is isolated below in the
// thin I/O layer (ghJson + its callers). Tests exercise only the pure
// functions and never shell out to `gh`.
//
// Usage:
//   node scripts/status/board-sync.mjs [--root <dir>] [--repo <owner/name>]
//   node scripts/status/board-sync.mjs --init --owner <login> --title <title>
//
//   --root   Repo root to scan tasks/builds/* from (default: process.cwd()).
//            Makes the sync path testable against temp-dir fixtures.
//   --repo   owner/name identity for this repo's cards (default: parsed
//            from `git remote get-url origin` run in --root).
//   --init   One-time board + field creation (operator-run once per
//            account; NOT invoked by any coordinator playbook). Prints the
//            resulting project number for the operator to record in
//            `.claude/project-registries.json` under
//            `projects_board: { owner, number }`.
//
// stdlib-only at runtime (gh is an external binary, not an npm dependency),
// matching generate-current-focus.mjs's convention.
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ARCHIVE_AFTER_DAYS = Number(process.env.BOARD_SYNC_ARCHIVE_AFTER_DAYS ?? 14);
const ARCHIVE_AFTER_MS = ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000;

const UPDATED_AT_MARKER = /<!-- board-sync:v1 updated_at=(\S+) -->/;

const BOARD_FIELDS_TO_CREATE = [
  { name: 'Build Repo', dataType: 'TEXT' },  // NOT 'Repo' — reserved in Projects v2 (createProjectV2Field rejects it)
  { name: 'Slug', dataType: 'TEXT' },
  { name: 'Phase', dataType: 'TEXT' },
  {
    name: 'Status',
    dataType: 'SINGLE_SELECT',
    options: ['PLANNING', 'BUILDING', 'REVIEWING', 'MERGE_READY', 'MERGED', 'ABANDONED'],
  },
];

// ---------------------------------------------------------------------------
// Pure functions (exported for tests — no fs, no gh, no wall-clock reads).
// ---------------------------------------------------------------------------

/** Lowercase a repo identity for case-insensitive key comparison
 *  (OAI-SPEC-002). Non-strings pass through unchanged. */
export function canonicaliseRepo(repo) {
  return typeof repo === 'string' ? repo.toLowerCase() : repo;
}

/** Composite upsert key = canonicalised {repository, slug}. */
export function buildCardKey(repo, slug) {
  return `${canonicaliseRepo(repo)}::${slug}`;
}

/** OAI-SPEC-003, board half. Returns null when slug matches the directory,
 *  else the exact wording C8's generator asserts for the same invariant. */
export function validateSlugMatchesDir(slug, dirName) {
  if (slug === dirName) return null;
  return `slug ${slug} does not match directory ${dirName}`;
}

/** Reads the hidden updated_at marker this script writes into every card
 *  body, so the stale/duplicate checks stay machine-readable without a
 *  seventh custom field. Returns null when absent or unparseable. */
export function extractUpdatedAtFromBody(body) {
  if (typeof body !== 'string') return null;
  const match = body.match(UPDATED_AT_MARKER);
  return match ? match[1] : null;
}

/** Card body: hidden updated_at marker, then the human-readable
 *  branch/PR/blockers/updated_at/summary fields the contract assigns to
 *  the body rather than to custom fields. */
export function buildCardBody(record) {
  const lines = [];
  lines.push(`<!-- board-sync:v1 updated_at=${record.updated_at} -->`);
  lines.push(`**Branch:** ${record.branch}`);
  lines.push(`**PR:** ${record.pr === null || record.pr === undefined ? 'none' : `#${record.pr}`}`);
  lines.push(`**Blockers:** ${record.blockers.length}`);
  for (const blocker of record.blockers) {
    lines.push(`- [${blocker.cleared_at ? 'cleared' : 'open'}] ${blocker.text}`);
  }
  lines.push(`**Updated:** ${record.updated_at}`);
  lines.push('');
  lines.push(record.summary);
  return lines.join('\n');
}

/** Maps one BUILD_STATUS record (§8.1) to a board card: {repository, slug}
 *  -> key/fields (§8.4), status -> Status field/column, phase -> Phase
 *  field, branch/PR/blockers/updated_at -> body. */
export function mapRecordToCard(record, repository) {
  const repo = canonicaliseRepo(repository);
  return {
    key: buildCardKey(repo, record.slug),
    title: `${record.slug}: ${record.title}`,
    body: buildCardBody(record),
    fields: {
      'Build Repo': repo,
      Slug: record.slug,
      Status: record.status,
      Phase: record.phase,
    },
  };
}

/** Duplicate recovery: newest updated_at survives; on an exact tie, the
 *  lowest card id survives (deterministic — OAI-SPEC-002). `cards` are
 *  normalised existing-card shapes: { id, updated_at, ... }. */
export function chooseSurvivor(cards) {
  if (!cards || cards.length === 0) return { survivor: null, toArchive: [] };
  const sorted = [...cards].sort((a, b) => {
    const at = a.updated_at ?? '';
    const bt = b.updated_at ?? '';
    if (at !== bt) return at < bt ? 1 : -1; // desc: newest first, missing sorts last
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  return { survivor: sorted[0], toArchive: sorted.slice(1) };
}

/** Stale-update protection: skip the write when the surviving card's
 *  updated_at is strictly newer than the incoming record's. A card with no
 *  readable updated_at (null) is never treated as newer. */
export function shouldSkipStale(card, record) {
  if (!card || card.updated_at == null) return false;
  return card.updated_at > record.updated_at;
}

/** Auto-archive: MERGED/ABANDONED records archive their card once
 *  ARCHIVE_AFTER_DAYS has elapsed since updated_at. `now` is always
 *  injected — never reads the real clock, so this stays deterministic. */
export function shouldArchive(record, now) {
  if (record.status !== 'MERGED' && record.status !== 'ABANDONED') return false;
  const ageMs = now.getTime() - new Date(record.updated_at).getTime();
  return ageMs >= ARCHIVE_AFTER_MS;
}

/** Parses `owner/name` out of an `origin` remote URL (https or ssh form).
 *  Returns null when the URL isn't a recognisable github.com remote. */
export function parseOwnerRepoFromGitUrl(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/github\.com[/:]([^/]+)\/(.+?)(\.git)?\/?$/);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

// ---------------------------------------------------------------------------
// Thin I/O layer — every `gh` invocation and every fs read lives below this
// line. Nothing here is exercised by the unit tests.
// ---------------------------------------------------------------------------

function extractFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return null;
  return argv[idx + 1];
}

async function loadBoardConfig(root) {
  const configPath = path.join(root, '.claude', 'project-registries.json');
  if (!existsSync(configPath)) return null;
  let data;
  try {
    data = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    return null;
  }
  const board = data.projects_board;
  if (!board || !board.owner || !board.number) return null;
  return board;
}

function detectRepoFromGitRemote(root) {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim();
    return parseOwnerRepoFromGitUrl(url);
  } catch {
    return null;
  }
}

async function collectStatusRecords(root) {
  const buildsDir = path.join(root, 'tasks', 'builds');
  const records = [];
  const refused = [];

  let entries;
  try {
    entries = await readdir(buildsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { records, refused };
    throw err;
  }

  const dirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();

  for (const dirName of dirNames) {
    const statusPath = path.join(buildsDir, dirName, 'status.json');
    if (!existsSync(statusPath)) continue; // pre-migration build dir — not yet part of this contract

    let raw;
    try {
      raw = await readFile(statusPath, 'utf8');
    } catch (err) {
      refused.push({ dir: dirName, error: `cannot read status.json: ${err.message}` });
      continue;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      refused.push({ dir: dirName, error: `invalid JSON: ${err.message}` });
      continue;
    }

    const slugError = validateSlugMatchesDir(data.slug, dirName);
    if (slugError) {
      refused.push({ dir: dirName, error: slugError });
      continue;
    }

    records.push(data);
  }

  return { records, refused };
}

function ghJson(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8' });
  return JSON.parse(out);
}

function fetchFieldIds(owner, number) {
  const data = ghJson(['project', 'field-list', String(number), '--owner', owner, '--format', 'json']);
  const fields = {};
  for (const field of data.fields ?? []) {
    fields[field.name] = { id: field.id, options: field.options ?? [] };
  }
  return fields;
}

function fetchProjectId(owner, number) {
  const data = ghJson(['project', 'view', String(number), '--owner', owner, '--format', 'json']);
  return data.id;
}

// ASSUMPTION (see header): unverified without a live board. Hedges for both
// a flat field-name-keyed shape and a nested fieldValues map.
function normaliseItem(item) {
  const body = item.body ?? item.content?.body ?? '';
  return {
    id: item.id,
    repo: canonicaliseRepo(item.Repo ?? item.fieldValues?.Repo ?? null),
    slug: item.Slug ?? item.fieldValues?.Slug ?? null,
    updated_at: extractUpdatedAtFromBody(body),
    body,
  };
}

function fetchExistingItems(owner, number) {
  const data = ghJson(['project', 'item-list', String(number), '--owner', owner, '--format', 'json', '-L', '200']);
  return (data.items ?? []).map(normaliseItem);
}

function setFieldValues(boardCtx, fields, itemId, values) {
  for (const [name, value] of Object.entries(values)) {
    const field = fields[name];
    if (!field) {
      console.warn(`[board-sync] field "${name}" not found on board — run --init or check board setup`);
      continue;
    }
    const args = [
      'project', 'item-edit', '--id', itemId,
      '--project-id', boardCtx.projectId, '--field-id', field.id, '--format', 'json',
    ];
    if (field.options.length > 0) {
      const option = field.options.find((o) => o.name === value);
      if (!option) {
        console.warn(`[board-sync] field "${name}" has no option "${value}" — skipping`);
        continue;
      }
      args.push('--single-select-option-id', option.id);
    } else {
      args.push('--text', String(value));
    }
    execFileSync('gh', args, { encoding: 'utf8' });
  }
}

function createCard(boardCtx, fields, card) {
  const created = ghJson([
    'project', 'item-create', String(boardCtx.number), '--owner', boardCtx.owner,
    '--title', card.title, '--body', card.body, '--format', 'json',
  ]);
  setFieldValues(boardCtx, fields, created.id, card.fields);
}

function updateCard(boardCtx, fields, itemId, card) {
  execFileSync('gh', ['project', 'item-edit', '--id', itemId, '--title', card.title, '--format', 'json'], { encoding: 'utf8' });
  execFileSync('gh', ['project', 'item-edit', '--id', itemId, '--body', card.body, '--format', 'json'], { encoding: 'utf8' });
  setFieldValues(boardCtx, fields, itemId, card.fields);
}

function archiveItem(owner, number, itemId) {
  execFileSync('gh', ['project', 'item-archive', String(number), '--id', itemId, '--owner', owner, '--format', 'json'], {
    encoding: 'utf8',
  });
}

async function runInit(owner, title) {
  console.log(`[board-sync] --init: creating project "${title}" for ${owner}...`);
  const project = ghJson(['project', 'create', '--owner', owner, '--title', title, '--format', 'json']);
  console.log(`[board-sync] --init: created project number ${project.number} (id ${project.id}).`);

  const existingFields = fetchFieldIds(owner, project.number);
  for (const fieldSpec of BOARD_FIELDS_TO_CREATE) {
    if (existingFields[fieldSpec.name]) {
      console.log(
        `[board-sync] --init: field "${fieldSpec.name}" already exists — reusing. If this is the ` +
          'default "Status" field, confirm its options match PLANNING/BUILDING/REVIEWING/MERGE_READY/' +
          'MERGED/ABANDONED via the web UI (no field-edit subcommand exists to do this from the CLI).'
      );
      continue;
    }
    const args = [
      'project', 'field-create', String(project.number), '--owner', owner,
      '--name', fieldSpec.name, '--data-type', fieldSpec.dataType, '--format', 'json',
    ];
    if (fieldSpec.options) args.push('--single-select-options', fieldSpec.options.join(','));
    ghJson(args);
    console.log(`[board-sync] --init: created field "${fieldSpec.name}".`);
  }

  console.log(
    '[board-sync] --init complete. Record this in .claude/project-registries.json:\n' +
      `  "projects_board": { "owner": "${owner}", "number": ${project.number} }`
  );
}

async function syncBoard(root, repository, boardConfig) {
  const { records, refused } = await collectStatusRecords(root);
  for (const r of refused) {
    console.warn(`[board-sync] REFUSED ${r.dir}: ${r.error}`);
  }
  if (records.length === 0) {
    console.log('[board-sync] no builds to sync.');
    return;
  }

  let fields;
  let projectId;
  let existingItems;
  try {
    fields = fetchFieldIds(boardConfig.owner, boardConfig.number);
    projectId = fetchProjectId(boardConfig.owner, boardConfig.number);
    existingItems = fetchExistingItems(boardConfig.owner, boardConfig.number);
  } catch (err) {
    console.warn(`[board-sync] gh failure reading board state — recorded, non-blocking: ${err.message}`);
    return;
  }

  const boardCtx = { owner: boardConfig.owner, number: boardConfig.number, projectId };

  const byKey = new Map();
  for (const item of existingItems) {
    if (!item.repo || !item.slug) continue; // not one of ours
    const key = buildCardKey(item.repo, item.slug);
    const bucket = byKey.get(key) ?? [];
    bucket.push(item);
    byKey.set(key, bucket);
  }

  const now = new Date();

  for (const record of records) {
    try {
      const card = mapRecordToCard(record, repository);
      const bucket = byKey.get(card.key) ?? [];
      const { survivor, toArchive } = chooseSurvivor(bucket);

      for (const dup of toArchive) {
        console.warn(`[board-sync] duplicate card for ${card.key} — archiving ${dup.id}, keeping ${survivor.id}`);
        archiveItem(boardCtx.owner, boardCtx.number, dup.id);
      }

      if (!survivor) {
        createCard(boardCtx, fields, card);
      } else if (shouldSkipStale(survivor, record)) {
        console.warn(`[board-sync] skip ${card.key} — existing card is newer than the incoming record`);
      } else {
        updateCard(boardCtx, fields, survivor.id, card);
      }

      if (shouldArchive(record, now)) {
        const targetId = survivor ? survivor.id : null;
        if (targetId) archiveItem(boardCtx.owner, boardCtx.number, targetId);
      }
    } catch (err) {
      console.warn(`[board-sync] gh failure syncing ${record.slug} — recorded, non-blocking: ${err.message}`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const root = path.resolve(extractFlagValue(argv, '--root') ?? process.cwd());
  const repoFlag = extractFlagValue(argv, '--repo');
  const isInit = argv.includes('--init');

  if (isInit) {
    const owner = extractFlagValue(argv, '--owner');
    const title = extractFlagValue(argv, '--title');
    if (!owner || !title) {
      console.error('[board-sync] --init requires --owner <login> --title <title>');
      process.exitCode = 1;
      return;
    }
    await runInit(owner, title);
    return;
  }

  const boardConfig = await loadBoardConfig(root);
  if (!boardConfig) {
    console.warn(
      '[board-sync] projects_board not configured in .claude/project-registries.json — skipping sync (board is a view, not a gate)'
    );
    return;
  }

  const repository = repoFlag ?? detectRepoFromGitRemote(root);
  if (!repository) {
    console.warn('[board-sync] could not determine repository identity (no --repo and no git remote) — skipping sync');
    return;
  }

  await syncBoard(root, repository, boardConfig);
}

// Entry-point guard: this module is imported directly by board-sync.test.mjs
// to reach the pure functions above, so main() must NOT run as a side effect
// of import — only when this file is executed as a script. Without this
// guard, importing the module in a test process would unconditionally shell
// out toward `gh` the moment `projects_board` is ever configured.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.warn(`[board-sync] unexpected error — recorded, non-blocking: ${err.message}`);
  });
}
