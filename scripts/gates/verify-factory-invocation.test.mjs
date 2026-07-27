/**
 * verify-factory-invocation.test.mjs
 *
 * Vitest self-test for scripts/gates/verify-factory-invocation.mjs. Spawns
 * the real gate as a child process against isolated temp-dir copies of the
 * two committed fixtures (clean-source.ts, uninvoked-factory.ts).
 *
 * GATE_SOURCE_DIR and GATE_SCAN_DIR both point at the SAME temp dir per case
 * — each fixture is self-contained (defines AND either invokes or
 * bare-references its own factory). Isolation matters: both fixtures live
 * side by side in the committed fixtures/ dir, and the gate's derivation
 * step reads every .ts file in GATE_SOURCE_DIR, so pointing the gate at the
 * shared fixtures/ dir directly would always see uninvoked-factory.ts's
 * violation regardless of which case is under test — hence the per-case
 * copy into an isolated temp dir.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, 'verify-factory-invocation.mjs');
const FIXTURES_DIR = path.join(HERE, 'fixtures', 'verify-factory-invocation');
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** Copies one committed fixture into an isolated temp dir; returns the dir. */
function isolatedFixtureDir(name) {
  const dir = path.join(os.tmpdir(), `factory-invocation-${crypto.randomUUID()}`);
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
      GATE_SOURCE_DIR: dir,
      GATE_SCAN_DIR: dir,
      ...env,
    },
  });
  return { status: res.status ?? -1, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('verify-factory-invocation gate', () => {
  it('clean fixture: factory correctly invoked — exit 0', () => {
    const dir = isolatedFixtureDir('clean-source.ts');
    try {
      const r = runGate(dir);
      expect(r.status, r.stdout + r.stderr).toBe(0);
    } finally {
      rmrf(dir);
    }
  });

  it('violation fixture: bare factory reference — exit 2 (warning-first default)', () => {
    const dir = isolatedFixtureDir('uninvoked-factory.ts');
    try {
      const r = runGate(dir);
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toContain('uninvoked-factory');
    } finally {
      rmrf(dir);
    }
  });

  it('violation fixture with VERIFY_FACTORY_INVOCATION_EXIT=1 — exit 1 (blocking)', () => {
    const dir = isolatedFixtureDir('uninvoked-factory.ts');
    try {
      const r = runGate(dir, { VERIFY_FACTORY_INVOCATION_EXIT: '1' });
      expect(r.status, r.stdout + r.stderr).toBe(1);
    } finally {
      rmrf(dir);
    }
  });

  it('missing GATE_SOURCE_DIR — exit 1 (fail-closed misconfiguration)', () => {
    const missing = path.join(os.tmpdir(), `factory-invocation-missing-${crypto.randomUUID()}`);
    const r = runGate(missing);
    expect(r.status, r.stdout + r.stderr).toBe(1);
  });
});
