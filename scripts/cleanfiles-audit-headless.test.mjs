#!/usr/bin/env node
/**
 * Test for cleanfiles-audit-headless.mjs — the /cleanfiles audit scheduler wrapper.
 *
 * Verifies the orchestration the wrapper exists to supply, WITHOUT invoking the
 * real (nesting-guarded, costly) `claude` binary: a node stub stands in via
 * CLEANFILES_AUDIT_CMD.
 *
 *   1. cwd pinning        — the child runs with cwd = CLEANFILES_AUDIT_REPO.
 *   2. external dated log — output lands in CLEANFILES_AUDIT_LOGDIR/audit-*.log,
 *                           OUTSIDE the repo.
 *   3. exit-code prop     — the wrapper exits with the child's exit code.
 *   4. repository purity  — nothing is written inside the repo directory.
 *
 * Run: node scripts/cleanfiles-audit-headless.test.mjs
 * Exit 0 on all pass, 1 on any fail.
 */

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRAPPER = join(dirname(fileURLToPath(import.meta.url)), 'cleanfiles-audit-headless.mjs');

const root = mkdtempSync(join(tmpdir(), 'cleanfiles-wrapper-'));
const repoDir = join(root, 'repo');
mkdirSync(repoDir, { recursive: true });
const logDir = join(root, 'external-logs'); // deliberately NOT under repoDir
writeFileSync(join(repoDir, 'seed.txt'), 'unchanged');

// Stub "claude": prints its cwd + argv and exits with code 3. Invoked as
// `node <stub>` via the CLEANFILES_AUDIT_CMD override.
const stub = join(root, 'fake-claude.mjs');
writeFileSync(
  stub,
  [
    "process.stdout.write('FAKE_CLAUDE cwd=' + process.cwd() + ' argv=' + JSON.stringify(process.argv.slice(2)) + '\\n');",
    'process.exit(3);',
  ].join('\n'),
);

const repoBefore = readdirSync(repoDir).sort().join(',');

const result = spawnSync(process.execPath, [WRAPPER], {
  encoding: 'utf8',
  env: {
    ...process.env,
    CLEANFILES_AUDIT_REPO: repoDir,
    CLEANFILES_AUDIT_LOGDIR: logDir,
    CLEANFILES_AUDIT_CMD: JSON.stringify([process.execPath, stub]),
  },
});

const repoAfter = readdirSync(repoDir).sort().join(',');
const logs = existsSync(logDir) ? readdirSync(logDir).filter((f) => /^audit-\d{4}-\d{2}-\d{2}\.log$/.test(f)) : [];
const logText = logs.length ? readFileSync(join(logDir, logs[0]), 'utf8') : '';

let pass = 0;
const fails = [];
function check(label, cond) {
  if (cond) pass++;
  else fails.push(label);
}

check('exit-code propagation: wrapper exits with child code 3', result.status === 3);
check('external dated log created (audit-YYYY-MM-DD.log) in the log dir', logs.length === 1);
check('log dir is OUTSIDE the repo (no audit log inside repo)', !existsSync(join(repoDir, logs[0] || 'audit-x.log')));
check('cwd pinning: child ran with cwd = repo dir', logText.includes(`FAKE_CLAUDE cwd=${repoDir}`));
check('repository purity: repo dir contents unchanged', repoBefore === repoAfter && repoBefore === 'seed.txt');
check('repository purity: seed file body unchanged', readFileSync(join(repoDir, 'seed.txt'), 'utf8') === 'unchanged');

rmSync(root, { recursive: true, force: true });

console.log(`Cases: ${pass + fails.length}, passed: ${pass}, failed: ${fails.length}`);
if (fails.length) {
  for (const f of fails) console.log(`FAIL | ${f}`);
  console.log(`(wrapper exit was ${result.status}; log dir had: ${logs.join(', ') || 'none'})`);
  process.exit(1);
}
process.exit(0);
