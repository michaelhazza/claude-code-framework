#!/usr/bin/env node
/**
 * cleanfiles-audit-headless.mjs — thin scheduler wrapper for `/cleanfiles audit`.
 *
 * See `.claude/commands/cleanfiles.md` § "Wire the clock". The native headless
 * invocation is `claude -p "/cleanfiles audit"`. Windows Task Scheduler's
 * "Start a program" action cannot express, in the task definition alone:
 *   (1) stdout/stderr redirection to a DATED file,
 *   (2) a per-run timeout on the child process,
 *   (3) reliable exit-code propagation through a shell one-liner.
 * This wrapper supplies exactly that orchestration around the native invocation.
 *
 * REPOSITORY PURITY: the wrapper writes ONLY to the external log directory
 * (default `%LOCALAPPDATA%\ClaudeCodeFramework\cleanfiles-audit\`), never inside
 * the audited repository. `/cleanfiles audit` is itself read-only (cleanfiles.md
 * § "Audit-mode purity"), so a scheduled run leaves the repo tree and HEAD
 * unchanged.
 *
 * Configuration (all optional, via environment):
 *   CLEANFILES_AUDIT_REPO        repo root to audit (cwd pin); default process.cwd()
 *   CLEANFILES_AUDIT_LOGDIR      external log directory; default under LOCALAPPDATA
 *   CLEANFILES_AUDIT_TIMEOUT_MS  per-run timeout in ms; default 900000 (15 min)
 *   CLEANFILES_AUDIT_CMD         JSON array overriding the whole command (testing)
 *   CLAUDE_BIN                   claude executable name/path; default "claude"
 *
 * Exit codes: the child's exit code is propagated verbatim; 124 on timeout-kill;
 * 127 on spawn failure.
 *
 * Invocation (documented in the "Wire the clock" section):
 *   node scripts/cleanfiles-audit-headless.mjs
 * (invocability via `node`, not a POSIX executable bit — the target is Windows.)
 *
 * Tests: scripts/cleanfiles-audit-headless.test.mjs
 */

import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';

const REPO = process.env.CLEANFILES_AUDIT_REPO || process.cwd();
const LOCALAPPDATA =
  process.env.LOCALAPPDATA ||
  join(process.env.USERPROFILE || process.env.HOME || '.', 'AppData', 'Local');
const LOG_DIR =
  process.env.CLEANFILES_AUDIT_LOGDIR ||
  join(LOCALAPPDATA, 'ClaudeCodeFramework', 'cleanfiles-audit');
const TIMEOUT_MS = Number(process.env.CLEANFILES_AUDIT_TIMEOUT_MS || 15 * 60 * 1000);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// The command the wrapper runs. Overridable as a JSON array for testing so the
// orchestration can be verified without invoking the real (and nesting-guarded)
// `claude` binary. `bypassPermissions` lets the read-only audit run unattended
// without a permission prompt; audit-mode purity keeps it write-free regardless.
const COMMAND = process.env.CLEANFILES_AUDIT_CMD
  ? JSON.parse(process.env.CLEANFILES_AUDIT_CMD)
  : [
      CLAUDE_BIN,
      '-p',
      '/cleanfiles audit',
      '--output-format',
      'text',
      '--permission-mode',
      'bypassPermissions',
      '--no-session-persistence',
    ];

/** YYYY-MM-DD for the dated log filename. */
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `audit-${isoDate(new Date())}.log`);
  const log = createWriteStream(logPath, { flags: 'a' });
  const started = new Date().toISOString();
  log.write(`\n===== cleanfiles-audit-headless @ ${started} (repo: ${REPO}) =====\n`);
  log.write(`[wrapper] command: ${JSON.stringify(COMMAND)}\n`);

  const child = spawn(COMMAND[0], COMMAND.slice(1), {
    cwd: REPO, // (1) cwd pinning
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    log.write(`\n[wrapper] TIMEOUT after ${TIMEOUT_MS}ms — killing child\n`); // (2) per-run timeout
    child.kill();
  }, TIMEOUT_MS);

  child.on('error', (err) => {
    clearTimeout(timer);
    log.write(`\n[wrapper] spawn error: ${err.message}\n`);
    log.end(() => process.exit(127));
  });

  child.on('close', (code, signal) => {
    clearTimeout(timer);
    // (3) exit-code propagation: verbatim child code; 124 on timeout-kill.
    const exitCode = timedOut ? 124 : code == null ? (signal ? 1 : 0) : code;
    log.write(`\n[wrapper] child exited code=${code} signal=${signal} -> wrapper exit ${exitCode}\n`);
    log.end(() => process.exit(exitCode));
  });
}

main();
