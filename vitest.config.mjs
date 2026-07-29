import { defineConfig } from 'vitest/config';

/**
 * Framework test config.
 *
 * WHY testTimeout IS RAISED FROM THE 5s DEFAULT
 * Most suites here test shell scripts, PowerShell scripts and CLI entry points
 * by SPAWNING them as child processes. On Windows each spawn costs a few hundred
 * milliseconds, and a single case may spawn several (the script under test, plus
 * stubbed binaries it shells out to). Under full-suite parallel load that
 * routinely crossed Vitest's 5s default, producing failures that had nothing to
 * do with the code under test: one observed run failed 11 cases across 7 files
 * while the very next run passed 602/602.
 *
 * A flaky suite is worse than a slow one. Every gate reading downstream of
 * `npm test` — G1, G2, the release checks — becomes untrustworthy if a green
 * depends on machine load, and the standard response to a flaky red is to re-run
 * until it passes, which is exactly how a real failure gets waved through.
 *
 * This raises the ceiling only; it does not weaken a single assertion. A test
 * that genuinely hangs still fails, 30s later.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // WHY WORKER COUNT IS CAPPED
    // A MODEST cap, and the secondary half of a two-part fix. Read the numbers
    // below before changing it in either direction.
    //
    // The symptom: roughly half of all full runs exited NON-ZERO while the
    // summary line read `Tests 691 passed (691)`. The cause was not a test. It
    // was Vitest's worker-to-main reporting RPC missing its birpc deadline
    // (60s, not exposed as a config option), which Vitest raises as an
    // UNHANDLED error:
    //   Error: [vitest-worker]: Timeout calling "onTaskUpdate"
    // A green suite that exits 1 is the worst available signal: `npm test` says
    // FAILED, every gate downstream says FAILED, and the only explanation names
    // an internal RPC call rather than any test.
    //
    // The PRIMARY fix was not this setting. It was making the slowest file stop
    // being slow: scripts/runner/install-runner.test.mjs spawned a fresh
    // PowerShell per case and took 79.6s, four times the next-slowest file and
    // long enough to hold a worker past the deadline on its own. Batching those
    // spawns into one process took it to 3.6s, and with the load gone the two
    // files that had failed only under parallel load (resolve-codex-bin,
    // check-shipped-source) stopped failing too: they were never broken, they
    // were losing a CPU race. See psBatch() in that file.
    //
    // Measured, because the intuition here is wrong in both directions:
    //   default (~16 workers), 79.6s file : ~50% of runs exit 1
    //   maxWorkers 6,          79.6s file : 2 of 3 runs exit 1
    //   maxWorkers 3,          79.6s file : 2 of 2 runs exit 1, MORE timeouts
    //   maxWorkers 8,           3.6s file : 3 of 3 green, 0 timeouts, 39-46s
    // Cutting workers made it WORSE, because it lengthens the chain of files a
    // single worker runs back-to-back. Do not "fix" a recurrence by lowering
    // this number; find the slow file instead. `npx vitest run --reporter=verbose`
    // prints per-file times, and anything approaching 60s is the real bug.
    maxWorkers: 8,
    minWorkers: 1,
  },
});
