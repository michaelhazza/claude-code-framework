/**
 * applyFindingsPure.test.ts
 *
 * Pure-function tests for the acceptance_check execution allowlist
 * (classifyAcceptanceCheckCommand) used by the applyFindings GitAdapter.
 *
 * (Vitest style, matching chatgpt-reviewPure.test.ts — NOT the node:test
 * style used by some older suites in this directory.)
 *
 * Run via: npx vitest run scripts/__tests__/applyFindingsPure.test.ts
 */

import { expect, test } from 'vitest';
import {
  ACCEPTANCE_CHECK_ALLOWED_BINARIES,
  classifyAcceptanceCheckCommand,
} from '../review-coordinator/applyFindingsPure.js';

// --- allowed commands ---

test('allows a plain npm script run', () => {
  const r = classifyAcceptanceCheckCommand('npm run lint');
  expect(r.allowed).toBe(true);
  expect(r.reason).toBeNull();
});

test('allows every allowlisted binary with plain args', () => {
  for (const bin of ACCEPTANCE_CHECK_ALLOWED_BINARIES) {
    const r = classifyAcceptanceCheckCommand(`${bin} --version`);
    expect(r.allowed, `${bin} should be allowed`).toBe(true);
  }
});

test('allows leading/trailing whitespace around an allowed command', () => {
  const r = classifyAcceptanceCheckCommand('  npx vitest run scripts/__tests__/foo.test.ts  ');
  expect(r.allowed).toBe(true);
});

test('allows a bare allowlisted binary with no args', () => {
  expect(classifyAcceptanceCheckCommand('vitest').allowed).toBe(true);
});

test('allows plain flags, paths, and equals-style args', () => {
  expect(classifyAcceptanceCheckCommand('git diff --stat HEAD~1').allowed).toBe(true);
  expect(
    classifyAcceptanceCheckCommand('node --test tests/helpers.test.ts').allowed,
  ).toBe(true);
});

// --- rejected: leading binary not allowlisted ---

test('rejects a non-allowlisted binary', () => {
  const r = classifyAcceptanceCheckCommand('curl https://example.com');
  expect(r.allowed).toBe(false);
  expect(r.reason).toContain('curl');
  expect(r.reason).toContain('not allowlisted');
});

test('rejects rm even with innocuous-looking args', () => {
  expect(classifyAcceptanceCheckCommand('rm -rf build').allowed).toBe(false);
});

test('rejects an absolute path to an allowlisted binary (bare names only)', () => {
  const r = classifyAcceptanceCheckCommand('/usr/bin/npm run lint');
  expect(r.allowed).toBe(false);
  expect(r.reason).toContain('/usr/bin/npm');
});

test('rejects a relative path to an allowlisted binary', () => {
  expect(classifyAcceptanceCheckCommand('./node_modules/.bin/vitest run').allowed).toBe(false);
});

test('binary match is case-sensitive', () => {
  expect(classifyAcceptanceCheckCommand('NPM run lint').allowed).toBe(false);
});

// --- rejected: shell metacharacters ---

test.each(['`', '$', '(', ')', ';', '&', '|', '<', '>'])(
  'rejects an otherwise-allowed command containing "%s"',
  (meta) => {
    const r = classifyAcceptanceCheckCommand(`npm run lint ${meta} whatever`);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain(meta);
    expect(r.reason).toContain('shell metacharacter');
  },
);

test('rejects command substitution via backticks', () => {
  expect(classifyAcceptanceCheckCommand('npm run `whoami`').allowed).toBe(false);
});

test('rejects variable expansion via $', () => {
  expect(classifyAcceptanceCheckCommand('npm run $EVIL').allowed).toBe(false);
});

test('rejects command chaining via ; even when both halves are allowlisted', () => {
  expect(classifyAcceptanceCheckCommand('npm run lint; npm run typecheck').allowed).toBe(false);
});

test('rejects && chaining (matches on &)', () => {
  expect(
    classifyAcceptanceCheckCommand('npm run lint && npm run typecheck').allowed,
  ).toBe(false);
});

test('rejects pipes and redirection', () => {
  expect(classifyAcceptanceCheckCommand('git log | head').allowed).toBe(false);
  expect(classifyAcceptanceCheckCommand('npm run lint > /tmp/out').allowed).toBe(false);
  expect(classifyAcceptanceCheckCommand('node script.js < input.txt').allowed).toBe(false);
});

test('rejects metacharacters hiding in later arguments', () => {
  expect(
    classifyAcceptanceCheckCommand('npx vitest run "$(cat /etc/passwd)"').allowed,
  ).toBe(false);
});

// --- rejected: control characters (newline command injection) ---

test('rejects newline command injection after an allowed command', () => {
  const r = classifyAcceptanceCheckCommand('npm run lint\nrm -rf /tmp/pwned');
  expect(r.allowed).toBe(false);
  expect(r.reason).toContain('control character');
});

test('rejects CRLF command injection after an allowed command', () => {
  expect(
    classifyAcceptanceCheckCommand('npm run lint\r\nrm -rf /tmp/pwned').allowed,
  ).toBe(false);
});

test('rejects a lone carriage return', () => {
  expect(classifyAcceptanceCheckCommand('npm run lint\rrm x').allowed).toBe(false);
});

test.each(['\t', '\x00', '\x1b', '\x7f'])(
  'rejects control character %j anywhere in the command',
  (ctrl) => {
    expect(classifyAcceptanceCheckCommand(`npm run${ctrl}lint`).allowed).toBe(false);
  },
);

test('rejects a trailing newline even with no second command', () => {
  // Trim happens for the binary check, but the raw string is what would
  // reach an executor — reject rather than special-case trailing whitespace.
  expect(classifyAcceptanceCheckCommand('npm run lint\n').allowed).toBe(false);
});

// --- rejected: quotes and backslash (meaningless without a shell) ---

test.each(["'", '"', '\\'])(
  'rejects quote/backslash %j (executor tokenises without a shell)',
  (ch) => {
    expect(classifyAcceptanceCheckCommand(`npm run lint ${ch}x${ch}`).allowed).toBe(false);
  },
);

// --- rejected: empty / degenerate input ---

test('rejects empty string', () => {
  const r = classifyAcceptanceCheckCommand('');
  expect(r.allowed).toBe(false);
  expect(r.reason).toContain('empty');
});

test('rejects whitespace-only string', () => {
  expect(classifyAcceptanceCheckCommand('   \t  ').allowed).toBe(false);
});

// --- SQL acceptance checks are not executable commands ---

test('rejects SQL acceptance checks (not shell-executable)', () => {
  const r = classifyAcceptanceCheckCommand("SELECT count(*) FROM users WHERE tenant_id = 't1'");
  expect(r.allowed).toBe(false);
});
