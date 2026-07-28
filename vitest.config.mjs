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
  },
});
