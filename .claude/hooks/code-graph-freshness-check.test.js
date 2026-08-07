#!/usr/bin/env node
/**
 * Test suite for code-graph-freshness-check.js — SessionStart cache guard.
 *
 * Verifies the hook's branch behaviour with the spawned generator stubbed
 * out: a fake `npx` shim is placed first on PATH (the hook resolves npx via
 * spawnSync), logging every invocation to a file instead of running tsx.
 *
 * Branches covered:
 *   - generator absent           → exits 0 silently, never spawns
 *   - generator present          → spawns the build, reports "refreshed"
 *   - watcher alive (live pid)   → skips the build entirely
 *   - watcher pid dead/garbage   → falls through to the build
 *   - build exits non-zero       → still exits 0 (fail-open), warns on stderr
 *
 * NOTE (scope): this file only TESTS the hook; the generator it spawns
 * (scripts/build-code-graph.ts) ships separately.
 *
 * Style mirrors config-protection.test.js: end-to-end child process runs.
 *
 * Run: node .claude/hooks/code-graph-freshness-check.test.js
 * Exit 0 on all pass, 1 on any fail.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'code-graph-freshness-check.js');

// ── Fake npx shim ──────────────────────────────────────────────────────────
// The hook calls spawnSync('npx', ['tsx', <script>], ...). Putting a stub
// first on PATH intercepts that call; the stub appends its args to STUB_LOG
// and exits with STUB_EXIT (default 0).

const STUB_BIN = mkdtempSync(join(tmpdir(), 'cgfc-stub-bin-'));

// POSIX shim
writeFileSync(
  join(STUB_BIN, 'npx'),
  '#!/bin/sh\necho "$@" >> "$STUB_LOG"\nexit ${STUB_EXIT:-0}\n',
);
chmodSync(join(STUB_BIN, 'npx'), 0o755);

// Windows shim (spawnSync uses shell:true on win32, resolving npx.cmd)
writeFileSync(
  join(STUB_BIN, 'npx.cmd'),
  '@echo off\r\necho %* >> "%STUB_LOG%"\r\nif defined STUB_EXIT ( exit /b %STUB_EXIT% ) else ( exit /b 0 )\r\n',
);

let caseNo = 0;

/** Create a fresh fake project dir; returns { proj, log, run(extraEnv) }. */
function makeProject({ withGenerator = false, watcherPid = null } = {}) {
  const proj = mkdtempSync(join(tmpdir(), 'cgfc-proj-'));
  const log = join(proj, `stub-${++caseNo}.log`);
  if (withGenerator) {
    mkdirSync(join(proj, 'scripts'), { recursive: true });
    writeFileSync(join(proj, 'scripts', 'build-code-graph.ts'), '// stub generator\n');
  }
  if (watcherPid !== null) {
    mkdirSync(join(proj, 'references'), { recursive: true });
    writeFileSync(join(proj, 'references', '.watcher.pid'), String(watcherPid));
  }
  const run = (extraEnv = {}) =>
    spawnSync(process.execPath, [HOOK], {
      input: '',
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: proj,
        PATH: STUB_BIN + delimiter + process.env.PATH,
        Path: STUB_BIN + delimiter + (process.env.Path || process.env.PATH),
        STUB_LOG: log,
        ...extraEnv,
      },
    });
  return { proj, log, run };
}

function stubCalls(log) {
  if (!existsSync(log)) return '';
  return readFileSync(log, 'utf8');
}

let pass = 0;
const fails = [];

function check(label, actual, expected, extra) {
  if (actual === expected) {
    pass++;
  } else {
    fails.push({ label, expected, actual, reason: extra || '' });
  }
}

// ── 1. Generator absent → silent no-op, no spawn ───────────────────────────
{
  const { proj, log, run } = makeProject({ withGenerator: false });
  const r = run();
  check('generator absent: exit 0', r.status, 0, r.stderr);
  check('generator absent: no "refreshed" line', /refreshed/.test(r.stdout || ''), false, r.stdout);
  check('generator absent: npx never spawned', stubCalls(log).trim(), '');
  rmSync(proj, { recursive: true, force: true });
}

// ── 2. Generator present, no watcher → spawns detached rebuild, claims lock ─
// The rebuild is now detached (non-blocking), so the STUB_LOG write races the
// parent exit; assert the synchronously-written lock + the background message.
{
  const { proj, run } = makeProject({ withGenerator: true });
  const r = run();
  const lock = join(proj, '.claude', 'session-state', '.code-graph-rebuild.lock');
  check('generator present: exit 0', r.status, 0, r.stderr);
  check('generator present: stdout reports background rebuild', /rebuilding in the background/.test(r.stdout || ''), true, `stdout=${r.stdout} stderr=${r.stderr}`);
  check('generator present: rebuild lock claimed', existsSync(lock), true, r.stdout);
  check('generator present: no "refreshed" claim (no longer synchronous)', /refreshed/.test(r.stdout || ''), false, r.stdout);
  rmSync(proj, { recursive: true, force: true });
}

// ── 3. Watcher alive → fast path, build NOT spawned ────────────────────────
{
  // This test process's own pid is guaranteed alive.
  const { proj, log, run } = makeProject({ withGenerator: true, watcherPid: process.pid });
  const r = run();
  check('watcher alive: exit 0', r.status, 0, r.stderr);
  check('watcher alive: build NOT spawned', /build-code-graph\.ts/.test(stubCalls(log)), false, stubCalls(log));
  check('watcher alive: no "refreshed" line', /refreshed/.test(r.stdout || ''), false, r.stdout);
  rmSync(proj, { recursive: true, force: true });
}

// ── 4. Watcher pid dead or garbage → falls through to detached rebuild ──────
{
  // A pid far beyond any plausible live process.
  const { proj, run } = makeProject({ withGenerator: true, watcherPid: 999999999 });
  const r = run();
  const lock = join(proj, '.claude', 'session-state', '.code-graph-rebuild.lock');
  check('dead watcher pid: exit 0', r.status, 0, r.stderr);
  check('dead watcher pid: rebuild lock claimed', existsSync(lock), true, r.stdout);
  rmSync(proj, { recursive: true, force: true });
}
{
  const { proj, run } = makeProject({ withGenerator: true, watcherPid: 'not-a-pid' });
  const r = run();
  const lock = join(proj, '.claude', 'session-state', '.code-graph-rebuild.lock');
  check('garbage watcher pid: exit 0', r.status, 0, r.stderr);
  check('garbage watcher pid: rebuild lock claimed', existsSync(lock), true, r.stdout);
  rmSync(proj, { recursive: true, force: true });
}

// ── 5. Detached rebuild is non-blocking: a failing build never surfaces at ──
// session start (the whole point — the hook does not wait for the child).
{
  const { proj, run } = makeProject({ withGenerator: true });
  const r = run({ STUB_EXIT: '3' }); // only the detached child sees this; hook does not observe it
  check('detached rebuild: hook exits 0 regardless of build outcome', r.status, 0, r.stderr);
  check('detached rebuild: no synchronous "build exited" block', /build exited/.test(r.stderr || ''), false, r.stderr);
  check('detached rebuild: no "refreshed" claim', /refreshed/.test(r.stdout || ''), false, r.stdout);
  rmSync(proj, { recursive: true, force: true });
}

// ── 6. Rebuild lock already held (fresh) → reports in-progress, no takeover ─
{
  const { proj, run } = makeProject({ withGenerator: true });
  const ss = join(proj, '.claude', 'session-state');
  mkdirSync(ss, { recursive: true });
  writeFileSync(join(ss, '.code-graph-rebuild.lock'), String(Date.now())); // fresh lock held by "another session"
  const r = run();
  check('busy lock: exit 0', r.status, 0, r.stderr);
  check('busy lock: reports rebuild already running', /already running/.test(r.stdout || ''), true, r.stdout);
  rmSync(proj, { recursive: true, force: true });
}

// ── 7. Stale lock (>10 min) → taken over, rebuild proceeds ──────────────────
{
  const { proj, run } = makeProject({ withGenerator: true });
  const ss = join(proj, '.claude', 'session-state');
  mkdirSync(ss, { recursive: true });
  writeFileSync(join(ss, '.code-graph-rebuild.lock'), String(Date.now() - 11 * 60_000)); // stale
  const r = run();
  check('stale lock: exit 0', r.status, 0, r.stderr);
  check('stale lock: taken over, background rebuild proceeds', /rebuilding in the background/.test(r.stdout || ''), true, r.stdout);
  rmSync(proj, { recursive: true, force: true });
}

// ── 8. Hook run leaves git status --porcelain clean (session-state ignored) ─
{
  const { proj, run } = makeProject({ withGenerator: true });
  const gitq = (args) => spawnSync('git', args, { cwd: proj, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  const init = gitq(['init', '-q']);
  if (init.status === 0) {
    // First line is what the v2.65.0 migration ensures; second ignores this
    // test's own npx-stub log scaffold so only the hook's writes are measured.
    writeFileSync(join(proj, '.gitignore'), '.claude/session-state/\nstub-*.log\n');
    gitq(['add', '-A']);
    gitq(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
    const before = (gitq(['status', '--porcelain']).stdout || '').trim();
    run(); // writes the rebuild lock into the ignored session-state dir
    const after = (gitq(['status', '--porcelain']).stdout || '').trim();
    check('git-clean: status unchanged after hook run', after, before, `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  } else {
    // git unavailable in this environment — skip without failing the suite.
    check('git-clean: skipped (git unavailable)', true, true);
  }
  rmSync(proj, { recursive: true, force: true });
}

// ── 9. H1: spawn('npx') ENOENT (npx not on PATH) → async 'error' is handled,
// hook still exits 0 (no unhandled-error crash). Runs with PATH pointing at an
// empty bin dir so npx cannot resolve; dead watcher forces the rebuild branch.
{
  const emptyBin = mkdtempSync(join(tmpdir(), 'cgfc-empty-bin-'));
  const { proj, run } = makeProject({ withGenerator: true });
  const lock = join(proj, '.claude', 'session-state', '.code-graph-rebuild.lock');
  const r = run({ PATH: emptyBin, Path: emptyBin });
  check('H1 spawn-ENOENT: hook exits 0 (async spawn error handled)', r.status, 0, r.stderr);
  check('H1 spawn-ENOENT: no unhandled-error crash on stderr', /Uncaught|unhandled 'error'|ERR_UNHANDLED/.test(r.stderr || ''), false, r.stderr);
  // M3: the async error handler emits a visible fail-open warning (the caller
  // already said "rebuilding in the background") and releases the lock so a
  // later session can retry.
  check('M3 spawn-ENOENT: fail-open warning emitted', /background rebuild failed to start/.test(r.stderr || ''), true, r.stderr);
  check('M3 spawn-ENOENT: rebuild lock cleared after failure', existsSync(lock), false, `lock still present: ${lock}`);
  rmSync(proj, { recursive: true, force: true });
  rmSync(emptyBin, { recursive: true, force: true });
}

// ── 10. H2: after a stale-lock takeover, the takeover re-creates the lock with
// an EXCLUSIVE (wx) write, so an immediately-following contender sees a held
// lock and reports busy — it does NOT also take over. (True simultaneous racing
// is not deterministically unit-testable in a subprocess harness; this asserts
// the exclusive-arbiter mechanism the fix relies on.)
{
  const { proj, run } = makeProject({ withGenerator: true });
  const ss = join(proj, '.claude', 'session-state');
  mkdirSync(ss, { recursive: true });
  writeFileSync(join(ss, '.code-graph-rebuild.lock'), String(Date.now() - 11 * 60_000)); // stale
  const r1 = run();
  check('H2 takeover: first run takes over the stale lock', /rebuilding in the background/.test(r1.stdout || ''), true, r1.stdout);
  const r2 = run(); // lock is now fresh (held by the takeover) → busy, not a 2nd takeover
  check('H2 takeover: immediate second contender is busy (exclusive lock held)', /already running/.test(r2.stdout || ''), true, r2.stdout);
  rmSync(proj, { recursive: true, force: true });
}

// ── 11. M2: the audit stamp is a membership fingerprint, not a max-mtime, so a
// context-pack DELETION re-triggers the audit (max-mtime would drop below the
// stamp and wrongly skip). Watcher-alive branch → only the audit runs.
{
  const { proj, run, log } = makeProject({ watcherPid: process.pid });
  mkdirSync(join(proj, 'scripts'), { recursive: true });
  writeFileSync(join(proj, 'scripts', 'audit-context-packs.ts'), '// stub audit\n');
  writeFileSync(join(proj, 'architecture.md'), '# arch\n');
  mkdirSync(join(proj, 'docs', 'context-packs'), { recursive: true });
  writeFileSync(join(proj, 'docs', 'context-packs', 'a.md'), 'a');
  writeFileSync(join(proj, 'docs', 'context-packs', 'b.md'), 'b');
  const auditRuns = () => (stubCalls(log).match(/audit-context-packs/g) || []).length;
  run();
  const n1 = auditRuns();
  run(); // inputs unchanged → skipped
  const n2 = auditRuns();
  rmSync(join(proj, 'docs', 'context-packs', 'b.md')); // membership changes
  run(); // fingerprint differs → audit re-runs
  const n3 = auditRuns();
  check('M2: audit runs on first session', n1 >= 1, true, `n1=${n1}`);
  check('M2: audit skipped when inputs unchanged', n2, n1, `n1=${n1} n2=${n2}`);
  check('M2: audit RE-RUNS after a context-pack deletion', n3 > n2, true, `n2=${n2} n3=${n3}`);
  rmSync(proj, { recursive: true, force: true });
}

// ── Cleanup + report ───────────────────────────────────────────────────────

rmSync(STUB_BIN, { recursive: true, force: true });

const totalCases = pass + fails.length;
console.log(`Cases: ${totalCases}, passed: ${pass}, failed: ${fails.length}`);
if (fails.length) {
  for (const f of fails) {
    console.log(
      `FAIL actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)} | ${f.label} | ${f.reason}`,
    );
  }
  process.exit(1);
}
process.exit(0);
