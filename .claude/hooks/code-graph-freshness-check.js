#!/usr/bin/env node
/**
 * SessionStart hook: code-graph-freshness-check
 *
 * Keeps the code intelligence cache (Phase 0) fresh across Claude Code
 * sessions where the dev server is not running.
 *
 * The cache's primary lifecycle is:
 *   `npm run dev` → predev → tsx scripts/build-code-graph.ts → detached
 *   chokidar watcher persists across the dev session.
 *
 * If the user does Claude-Code-only work without `npm run dev`, the
 * watcher is never (re)started after the previous dev session ends.
 * The cache then silently drifts as files are edited and agents read
 * stale data — exactly the failure mode the Phase 0 plan calls out as
 * "the most concerning failure mode."
 *
 * Mechanism:
 *   1. If references/.watcher.pid points at a live process, the watcher
 *      is keeping the cache fresh on every save. Exit fast (no-op).
 *   2. Otherwise spawn `tsx scripts/build-code-graph.ts` synchronously.
 *      This:
 *        - SHA256-walks source against the existing cache, re-extracting
 *          only changed files (sub-second on warm cache, a few seconds
 *          cold per the Phase 0 spec)
 *        - rewrites shards atomically for any drift
 *        - prunes deleted files
 *        - spawns a fresh detached watcher (singleton lock-protected;
 *          coexists safely with any concurrent session start)
 *
 *   Subsequent session starts find a live watcher and take the fast
 *   path — there is no per-session cost in the steady state.
 *
 * Exit policy:
 *   - Always exit 0. The cache is an advisory hint layer; a hook bug
 *     or build failure must never block session start.
 *   - On successful refresh, write a one-line confirmation to stdout
 *     so the SessionStart context records that the cache was touched.
 *   - On failure, log to stderr and exit 0.
 *
 * Portability note (framework export):
 *   - If scripts/build-code-graph.ts is missing, exit 0 silently. This
 *     lets the hook ship inside .claude/ without hard-requiring the
 *     code-graph generator to also be imported into the target repo
 *     yet (e.g. mid-incremental-import).
 *
 * audit-context-packs check:
 *   - After the freshness check, run audit-context-packs (if present).
 *   - Runs fail-open: a non-zero exit logs a warning to stderr but
 *     does NOT block session start.
 *   - If the script is missing (pre-v2.13.0 consumer), silently skip.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const REFERENCES_DIR = join(PROJECT_DIR, 'references');
const WATCHER_PID_PATH = join(REFERENCES_DIR, '.watcher.pid');
const BUILD_SCRIPT_PATH = join(PROJECT_DIR, 'scripts', 'build-code-graph.ts');

// Mutable runtime state (stamps, locks) MUST live under the gitignored
// .claude/session-state/ — never references/ (committed tree). A migration
// (v2.65.0) appends this path to the consumer .gitignore when absent.
const SESSION_STATE_DIR = join(PROJECT_DIR, '.claude', 'session-state');
const AUDIT_STAMP_PATH = join(SESSION_STATE_DIR, '.audit-context-packs.stamp');
const REBUILD_LOCK_PATH = join(SESSION_STATE_DIR, '.code-graph-rebuild.lock');
const REBUILD_LOCK_STALE_MS = 10 * 60_000; // a crashed rebuild cannot wedge the cold path past this

// Paths for audit-context-packs: prefer consumer-local, fall back to framework submodule.
const AUDIT_SCRIPT_LOCAL = join(PROJECT_DIR, 'scripts', 'audit-context-packs.ts');
const AUDIT_SCRIPT_FRAMEWORK = join(PROJECT_DIR, '.claude-framework', 'scripts', 'audit-context-packs.ts');

// Generous upper bound. Spec says cold build completes in <30s; warm cache is
// sub-second. 60s leaves headroom for the rare cold start on a slow machine
// without ever hanging a session indefinitely.
const BUILD_TIMEOUT_MS = 60_000;

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive.
    // ESRCH (and anything else) means dead or unreachable.
    return Boolean(err && err.code === 'EPERM');
  }
}

function watcherAlive() {
  if (!existsSync(WATCHER_PID_PATH)) return false;
  try {
    const raw = readFileSync(WATCHER_PID_PATH, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    return isPidAlive(pid);
  } catch {
    return false;
  }
}

/**
 * runSessionStartChecks() — orchestrates freshness + audit checks.
 *
 * Preserves all original branch behaviours, now as return-paths rather than
 * early exits. The single terminal exit lives in main() below.
 *
 * Branch dispositions (original → post-refactor):
 *   watcher-alive         : was early exit immediately → now returns early,
 *                           audit check still runs.
 *   build-script-missing  : was silent early exit → records
 *                           freshness:'skipped', continues to audit.
 *   spawn-failed          : was stderr + early exit → same stderr message,
 *                           records freshness:'failed', continues to audit.
 *   refresh-failed        : was stderr (2 lines) + early exit → same two
 *                           stderr messages, records freshness:'failed'.
 *   refresh-succeeded     : was stdout + early exit → same stdout line,
 *                           records freshness:'refreshed', continues.
 *   catch-handler         : outer try/catch in main() still terminates as
 *                           a fallback safety net (branch 6 unchanged).
 */
/**
 * Run the audit-context-packs check. Fail-open: surfaces failures as stderr
 * warnings, never blocks session start. Returns the disposition so callers can
 * log it.
 *
 * Extracted so it can be called from BOTH branches of runSessionStartChecks
 * (watcher-alive and watcher-dead) — the docstring on runSessionStartChecks
 * promises the audit runs in both paths.
 */
function runAuditContextPacks() {
  // Prefer consumer-local script; fall back to framework submodule copy.
  const auditScriptPath = existsSync(AUDIT_SCRIPT_LOCAL)
    ? AUDIT_SCRIPT_LOCAL
    : existsSync(AUDIT_SCRIPT_FRAMEWORK)
      ? AUDIT_SCRIPT_FRAMEWORK
      : null;

  if (auditScriptPath === null) {
    // Script missing (pre-v2.13.0 consumer) — silent skip.
    return { audit: 'skipped', reason: 'script_missing' };
  }

  const auditResult = spawnSync('npx', ['tsx', auditScriptPath], {
    cwd: PROJECT_DIR,
    timeout: BUILD_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  if (auditResult.error) {
    // Spawn itself failed (timeout, ENOENT on npx, etc.). Surface fail-open.
    process.stderr.write(
      `audit-context-packs: spawn failed (${auditResult.error.code || auditResult.error.message}). ` +
      `Session continues.\n`,
    );
    return { audit: 'failed', reason: 'spawn' };
  }

  if (auditResult.status !== 0) {
    // The audit detected broken anchors OR the script itself errored. Surface
    // BOTH stdout (broken-anchor lines) AND stderr (script errors such as
    // "architecture.md not found"). Earlier this only surfaced stdout, so
    // stderr-only failures were swallowed.
    const stdout = auditResult.stdout ? String(auditResult.stdout) : '';
    const stderr = auditResult.stderr ? String(auditResult.stderr) : '';
    if (stdout || stderr) {
      process.stderr.write(
        `audit-context-packs: broken anchors detected (fix before finalisation):\n${stdout}${stderr}`,
      );
    } else {
      // Non-zero exit with no output — surface the bare status so the failure is visible.
      process.stderr.write(
        `audit-context-packs: exited ${auditResult.status} with no output. Session continues.\n`,
      );
    }
    return { audit: 'failed', reason: 'status_nonzero' };
  }

  return { audit: 'ok' };
}

/** Best-effort mkdir for the runtime state dir. Never throws. */
function ensureSessionStateDir() {
  try { mkdirSync(SESSION_STATE_DIR, { recursive: true }); } catch { /* fail-open */ }
}

/**
 * Newest mtime (ms) across the audit-context-packs inputs (architecture.md and
 * every docs/context-packs/*). 0 when none exist — an absent input never
 * triggers a run. Used to skip the ~sub-second audit spawn in steady state.
 */
function auditInputsFingerprint() {
  // A MEMBERSHIP fingerprint, not a max mtime. Max-mtime silently misses a
  // deletion: if the newest context-pack is removed, the remaining max drops
  // BELOW the stamp and the audit is wrongly skipped even though the pack set
  // (which the audit validates) just changed. The fingerprint pins each input's
  // name AND mtime, so any add / delete / edit changes it.
  const parts = [];
  try {
    const arch = join(PROJECT_DIR, 'architecture.md');
    if (existsSync(arch)) parts.push(`architecture.md:${statSync(arch).mtimeMs}`);
  } catch { /* ignore */ }
  try {
    const packDir = join(PROJECT_DIR, 'docs', 'context-packs');
    if (existsSync(packDir)) {
      for (const name of readdirSync(packDir).sort()) {
        try { parts.push(`${name}:${statSync(join(packDir, name)).mtimeMs}`); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return parts.join('|');
}

/**
 * mtime-gated audit: skip the spawn when neither architecture.md nor any
 * context-pack changed since the last successful run (steady-state fast path).
 * Only a SUCCESSFUL audit stamps, so a failing state (broken anchors) keeps
 * re-surfacing every session until fixed. Stamp write is best-effort and lands
 * in the gitignored session-state dir, so it never dirties git status.
 */
function maybeRunAudit() {
  const cur = auditInputsFingerprint();
  let stamp = '';
  try { stamp = readFileSync(AUDIT_STAMP_PATH, 'utf8').trim(); } catch { /* no stamp yet */ }
  if (cur !== '' && cur === stamp) return { audit: 'skipped', reason: 'inputs_unchanged' };
  const res = runAuditContextPacks();
  if (res.audit === 'ok' && cur !== '') {
    ensureSessionStateDir();
    try { writeFileSync(AUDIT_STAMP_PATH, cur); } catch { /* fail-open */ }
  }
  return res;
}

/**
 * Atomically claim the rebuild lock so two sessions starting together cannot
 * both launch a CPU-heavy detached rebuild. Returns 'claimed' | 'takeover' |
 * 'busy'. 'wx' makes the create fail if the lock exists; a lock older than
 * REBUILD_LOCK_STALE_MS is taken over so a crashed rebuild cannot wedge the path.
 */
function tryClaimRebuildLock() {
  ensureSessionStateDir();
  try {
    writeFileSync(REBUILD_LOCK_PATH, String(Date.now()), { flag: 'wx' });
    return 'claimed';
  } catch {
    let ts = 0;
    try { ts = Number.parseInt(readFileSync(REBUILD_LOCK_PATH, 'utf8').trim(), 10) || 0; } catch { /* unreadable */ }
    if (Date.now() - ts >= REBUILD_LOCK_STALE_MS) {
      // ATOMIC takeover: a plain overwrite here would let two sessions that both
      // read the same stale timestamp both "take over" and both launch a rebuild.
      // Instead, remove the stale lock and re-create it with 'wx' (exclusive):
      // the exclusive create is the atomic arbiter — even if several sessions
      // rm concurrently, only ONE wx create succeeds and returns 'takeover';
      // the rest get EEXIST and return 'busy'.
      try { rmSync(REBUILD_LOCK_PATH, { force: true }); } catch { /* fall through */ }
      try {
        writeFileSync(REBUILD_LOCK_PATH, String(Date.now()), { flag: 'wx' });
        return 'takeover';
      } catch { /* another session won the exclusive re-create */ }
    }
    return 'busy';
  }
}

/** Best-effort lock removal (called once a live watcher proves the rebuild finished). */
function clearRebuildLock() {
  try { rmSync(REBUILD_LOCK_PATH, { force: true }); } catch { /* fail-open */ }
}

/**
 * Spawn the code-graph rebuild DETACHED and return immediately, so session start
 * is never blocked for the cold rebuild (previously up to BUILD_TIMEOUT_MS). The
 * detached child rebuilds the cache and re-establishes the watcher; the lock it
 * ran under is cleared by a later watcher-alive session or by stale-takeover.
 */
function spawnDetachedRebuild() {
  if (!existsSync(BUILD_SCRIPT_PATH)) return { skipped: true, reason: 'build script missing' };
  try {
    const child = spawn('npx', ['tsx', BUILD_SCRIPT_PATH], {
      cwd: PROJECT_DIR,
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    // spawn() reports failures like ENOENT (npx not on PATH) ASYNCHRONOUSLY via
    // an 'error' event, NOT by throwing into the try/catch above. Without this
    // listener that error is unhandled and can crash the session-start hook —
    // the opposite of the fail-open contract. Register it BEFORE unref() so the
    // handler survives, clear the lock we hold so a real rebuild can be retried,
    // and swallow the error (fail-open). The synchronous catch below still
    // covers the rare throw-on-spawn path.
    child.on('error', () => {
      clearRebuildLock();
    });
    child.unref();
    return { skipped: false };
  } catch (err) {
    clearRebuildLock();
    return { skipped: false, error: err };
  }
}

function runSessionStartChecks() {
  // branch: watcher-alive — watcher is live; cache is current.
  if (watcherAlive()) {
    // A live watcher proves any prior detached rebuild finished — clear its lock.
    clearRebuildLock();
    // Cache is being kept live — no refresh needed, but the audit-context-packs
    // check MUST still run (mtime-gated): stale anchors can drift in the
    // watcher-alive steady state too (a heading rename invalidates context-pack
    // links regardless of whether the code-intelligence cache is fresh).
    maybeRunAudit();
    return { freshness: 'watcher_alive' };
  }

  // branch: watcher-dead — rebuild is needed. Do NOT block session start on it:
  // claim the lock and spawn the rebuild detached, exiting immediately.
  let freshnessResult;
  const claim = tryClaimRebuildLock();
  if (claim === 'busy') {
    process.stdout.write('Code intelligence cache rebuild already running in another session; session continues.\n');
    freshnessResult = { freshness: 'rebuild_in_progress' };
  } else {
    const spawned = spawnDetachedRebuild();
    if (spawned.skipped) {
      // branch: build-script-missing — framework not (yet) fully imported; degrade silently.
      clearRebuildLock();
      freshnessResult = { freshness: 'skipped', reason: 'build script missing' };
    } else if (spawned.error) {
      // branch: spawn-failed — spawn itself threw (e.g. ENOENT on npx).
      clearRebuildLock();
      process.stderr.write(
        `code-graph-freshness-check: detached rebuild spawn failed (${spawned.error.code || spawned.error.message}). ` +
        `Cache is advisory; session continues.\n`,
      );
      freshnessResult = { freshness: 'failed', reason: 'spawn' };
    } else {
      process.stdout.write('Code intelligence cache rebuilding in the background (watcher was down); session continues.\n');
      freshnessResult = { freshness: 'rebuild_spawned' };
    }
  }

  maybeRunAudit();
  return freshnessResult;
}

function main() {
  try {
    runSessionStartChecks();
    // branch: catch-handler — outer safety net; single terminal exit below.
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `code-graph-freshness-check: unexpected error: ${err && err.message}\n`,
    );
    process.exit(0);
  }
}

main();
