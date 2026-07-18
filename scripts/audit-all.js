#!/usr/bin/env node
'use strict';
/**
 * audit-all.js — umbrella runner for the framework's deterministic gates.
 *
 * Runs every gate to completion (no fail-fast: an audit's value is the full
 * picture, so a failing gate never hides the ones after it), prints each
 * gate's own output under a section header, then a pass/fail table. Exit 1
 * if any gate failed.
 *
 * `validate` (validate-framework.js) is included because it now carries the
 * agent-frontmatter / hook-wiring / ADR-index checks; the consumer-state
 * audit runs only when this checkout is mounted as `<consumer>/.claude-framework`
 * (standalone framework CI has no consumer to audit — that is a skip, and it
 * is reported as one, never silently).
 */

const { spawnSync } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

const GATES = [
  { id: 'validate', script: 'scripts/validate-framework.js' },
  { id: 'profiles', script: 'scripts/check-profiles.js' },
  { id: 'migrations', script: 'scripts/check-migrations.js' },
  { id: 'shipped-source', script: 'scripts/check-shipped-source.js' },
  {
    id: 'consumer-state',
    script: 'scripts/audit-consumer-state.js',
    skipUnless: () =>
      path.basename(REPO_ROOT) === '.claude-framework'
      && existsSync(path.join(REPO_ROOT, '..', '.claude', '.framework-state.json')),
    skipReason: 'not mounted as <consumer>/.claude-framework — no consumer state to audit',
  },
];

function main() {
  const results = [];
  for (const gate of GATES) {
    console.log(`\n=== ${gate.id} (${gate.script}) ===`);
    if (gate.skipUnless && !gate.skipUnless()) {
      console.log(`SKIPPED: ${gate.skipReason}`);
      results.push({ id: gate.id, status: 'skip' });
      continue;
    }
    const scriptPath = path.join(REPO_ROOT, gate.script);
    if (!existsSync(scriptPath)) {
      console.log(`MISSING: ${gate.script} — update GATES in scripts/audit-all.js`);
      results.push({ id: gate.id, status: 'fail' });
      continue;
    }
    const run = spawnSync(process.execPath, [scriptPath], { stdio: 'inherit', cwd: REPO_ROOT });
    results.push({ id: gate.id, status: run.status === 0 ? 'pass' : 'fail' });
  }

  const failed = results.filter((result) => result.status === 'fail');
  console.log('\n=== audit:all summary ===');
  for (const result of results) {
    console.log(`  ${result.status.toUpperCase().padEnd(4)} ${result.id}`);
  }
  console.log(`  ${failed.length > 0 ? 'FAIL' : 'PASS'}: ${failed.length} of ${results.length} gate(s) failing.`);
  if (failed.length > 0) process.exit(1);
}

main();
