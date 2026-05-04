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
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const REFERENCES_DIR = join(PROJECT_DIR, 'references');
const WATCHER_PID_PATH = join(REFERENCES_DIR, '.watcher.pid');
const BUILD_SCRIPT_PATH = join(PROJECT_DIR, 'scripts', 'build-code-graph.ts');

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

function refreshCache() {
  if (!existsSync(BUILD_SCRIPT_PATH)) {
    return { skipped: true, reason: 'build script missing' };
  }
  const result = spawnSync('npx', ['tsx', BUILD_SCRIPT_PATH], {
    cwd: PROJECT_DIR,
    timeout: BUILD_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    // npx is a `.cmd` shim on Windows; shell=true lets the OS resolve it.
    shell: process.platform === 'win32',
  });
  return { skipped: false, result };
}

function main() {
  try {
    if (watcherAlive()) {
      // Steady state — cache is being kept live by the existing watcher.
      process.exit(0);
    }

    const refresh = refreshCache();
    if (refresh.skipped) {
      // Framework not (yet) fully imported — degrade silently.
      process.exit(0);
    }

    const { result } = refresh;
    if (result.error) {
      // spawnSync itself failed (e.g. timeout, ENOENT on npx). Don't block.
      process.stderr.write(
        `code-graph-freshness-check: spawn failed (${result.error.code || result.error.message}). ` +
        `Cache is advisory; session continues.\n`,
      );
      process.exit(0);
    }
    if (result.status !== 0) {
      process.stderr.write(
        `code-graph-freshness-check: build exited ${result.status}. ` +
        `Cache may be stale; session continues.\n`,
      );
      if (result.stderr) {
        process.stderr.write(`build stderr (last 400 chars): ${String(result.stderr).slice(-400)}\n`);
      }
      process.exit(0);
    }

    // Surface a one-line note into the SessionStart context so the agent
    // knows the cache was just refreshed (and that any prior staleness has
    // been resolved for this session).
    process.stdout.write('Code intelligence cache refreshed at session start (watcher restarted).\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `code-graph-freshness-check: unexpected error: ${err && err.message}\n`,
    );
    process.exit(0);
  }
}

main();
