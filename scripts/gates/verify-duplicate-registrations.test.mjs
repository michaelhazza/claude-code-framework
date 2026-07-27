/**
 * verify-duplicate-registrations.test.mjs
 *
 * Vitest self-test for scripts/gates/verify-duplicate-registrations.mjs.
 * Spawns the real gate as a child process against isolated temp-dir copies
 * of the two committed fixtures (clean-registrations.ts,
 * double-registration.ts).
 *
 * GATE_SCAN_DIR points at a per-case isolated temp dir containing ONLY that
 * fixture — both fixtures live side by side in the committed fixtures/ dir,
 * and the gate scans every .ts file under GATE_SCAN_DIR, so pointing the
 * gate at the shared fixtures/ dir directly would always see
 * double-registration.ts's violation regardless of which case is under test
 * — hence the per-case copy into an isolated temp dir.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, 'verify-duplicate-registrations.mjs');
const FIXTURES_DIR = path.join(HERE, 'fixtures', 'verify-duplicate-registrations');
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** Copies one committed fixture into an isolated temp dir; returns the dir. */
function isolatedFixtureDir(name) {
  const dir = path.join(os.tmpdir(), `duplicate-registrations-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, name), path.join(dir, name));
  return dir;
}

function runGate(dir, env = {}) {
  const res = spawnSync(process.execPath, [GATE], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      GATE_SCAN_DIR: dir,
      ...env,
    },
  });
  return { status: res.status ?? -1, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('verify-duplicate-registrations gate', () => {
  it('clean fixture: distinct keys — exit 0', () => {
    const dir = isolatedFixtureDir('clean-registrations.ts');
    try {
      const r = runGate(dir);
      expect(r.status, r.stdout + r.stderr).toBe(0);
    } finally {
      rmrf(dir);
    }
  });

  it('violation fixture: same-key double registration — exit 2 (warning-first default)', () => {
    const dir = isolatedFixtureDir('double-registration.ts');
    try {
      const r = runGate(dir);
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toContain('duplicate-registration');
    } finally {
      rmrf(dir);
    }
  });

  it('violation fixture with VERIFY_DUPLICATE_REGISTRATIONS_EXIT=1 — exit 1 (blocking)', () => {
    const dir = isolatedFixtureDir('double-registration.ts');
    try {
      const r = runGate(dir, { VERIFY_DUPLICATE_REGISTRATIONS_EXIT: '1' });
      expect(r.status, r.stdout + r.stderr).toBe(1);
    } finally {
      rmrf(dir);
    }
  });

  it('missing GATE_SCAN_DIR — exit 1 (fail-closed misconfiguration)', () => {
    const missing = path.join(os.tmpdir(), `duplicate-registrations-missing-${crypto.randomUUID()}`);
    const r = runGate(missing);
    expect(r.status, r.stdout + r.stderr).toBe(1);
  });
});
