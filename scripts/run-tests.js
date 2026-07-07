#!/usr/bin/env node
'use strict';
/**
 * run-tests.js — glob-driven test discovery and dispatch.
 *
 * Single source of truth for which test files exist and which runner each
 * one uses. CI (`.github/workflows/ci.yml`) and local runs both go through
 * the package.json scripts, which call this file — there are no hand-kept
 * test lists anywhere else.
 *
 * Discovery: walks the repo (skipping .git, node_modules, .claude-framework)
 * and collects every file that either
 *   - matches *.test.{ts,js,mts,cts,mjs,cjs}, or
 *   - lives inside a __tests__/ directory.
 *
 * Classification (mutually exclusive, checked in order):
 *   1. imports 'vitest'        → vitest suite   (npx vitest run <files>)
 *   2. imports 'node:test'     → node:test suite (npx tsx --test <files>)
 *   3. plain .js/.cjs/.mjs     → standalone node assertion script (node <file>)
 *   4. anything else           → ERROR (unclassifiable — fail loudly, never skip)
 *
 * Every discovered test file lands in exactly one group; an unclassifiable
 * file fails the run. Adding a test file anywhere in the tree makes it run
 * automatically — no list to update.
 *
 * Usage: node scripts/run-tests.js [all|sync|scripts|hooks]
 *   all     — every discovered test file (default)
 *   sync    — files under tests/           (sync-engine suites)
 *   scripts — files under scripts/         (helper/review-script suites)
 *   hooks   — files under .claude/hooks/   (hook sanity suites)
 */

const { readdirSync, readFileSync, statSync } = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude-framework']);
const TEST_FILE_RE = /\.test\.(ts|mts|cts|js|mjs|cjs)$/;

function discover(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      discover(full, out);
    } else if (entry.isFile()) {
      const inTestsDir = path
        .relative(REPO_ROOT, full)
        .split(path.sep)
        .includes('__tests__');
      if (TEST_FILE_RE.test(entry.name) || inTestsDir) out.push(full);
    }
  }
  return out;
}

function classify(file) {
  const src = readFileSync(file, 'utf8');
  if (/from\s+['"]vitest['"]/.test(src) || /require\(\s*['"]vitest['"]\s*\)/.test(src)) {
    return 'vitest';
  }
  if (/from\s+['"]node:test['"]/.test(src) || /require\(\s*['"]node:test['"]\s*\)/.test(src)) {
    return 'node-test';
  }
  if (/\.(js|mjs|cjs)$/.test(file)) return 'plain-node';
  return null; // unclassifiable — a .ts test with no known runner import
}

function rel(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join('/');
}

function inGroup(file, group) {
  const r = rel(file);
  switch (group) {
    case 'sync':
      return r.startsWith('tests/');
    case 'scripts':
      return r.startsWith('scripts/');
    case 'hooks':
      return r.startsWith('.claude/hooks/');
    case 'all':
      return true;
    default:
      return false;
  }
}

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    // npx is a .cmd shim on Windows; shell lets the OS resolve it. Direct
    // executables (node) must NOT go through the shell — their absolute
    // path may contain spaces and shell mode does no quoting.
    shell: cmd === 'npx' && process.platform === 'win32',
  });
  if (result.error) {
    console.error(`spawn failed: ${result.error.message}`);
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

function main() {
  const group = process.argv[2] || 'all';
  if (!['all', 'sync', 'scripts', 'hooks'].includes(group)) {
    console.error(`run-tests: unknown group "${group}" (use all|sync|scripts|hooks)`);
    process.exit(1);
  }

  const discovered = discover(REPO_ROOT, []).sort();
  const groups = { vitest: [], 'node-test': [], 'plain-node': [] };
  const unclassified = [];

  for (const file of discovered) {
    if (!inGroup(file, group)) continue;
    const kind = classify(file);
    if (kind === null) unclassified.push(rel(file));
    else groups[kind].push(rel(file));
  }

  if (unclassified.length > 0) {
    console.error(
      'run-tests: unclassifiable test file(s) — no vitest/node:test import and not runnable as plain node:',
    );
    for (const f of unclassified) console.error(`  - ${f}`);
    process.exit(1);
  }

  const total =
    groups.vitest.length + groups['node-test'].length + groups['plain-node'].length;
  if (total === 0) {
    console.error(`run-tests: no test files discovered for group "${group}"`);
    process.exit(1);
  }

  console.log(
    `run-tests: group=${group} — ${total} file(s): ` +
      `${groups.vitest.length} vitest, ${groups['node-test'].length} node:test, ` +
      `${groups['plain-node'].length} plain node`,
  );

  let failed = 0;

  if (groups.vitest.length > 0) {
    failed |= run('npx', ['vitest', 'run', ...groups.vitest]) !== 0 ? 1 : 0;
  }
  if (groups['node-test'].length > 0) {
    failed |= run('npx', ['tsx', '--test', ...groups['node-test']]) !== 0 ? 1 : 0;
  }
  for (const file of groups['plain-node']) {
    failed |= run(process.execPath, [file]) !== 0 ? 1 : 0;
  }

  if (failed) {
    console.error('\nrun-tests: FAILED');
    process.exit(1);
  }
  console.log('\nrun-tests: all suites green');
}

main();
