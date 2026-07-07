#!/usr/bin/env node
/**
 * PreToolUse hook: bash-config-guard (HITL mode)
 *
 * Closes the Bash bypass around config-protection.js: that hook guards
 * Edit/Write/MultiEdit, but a shell command (`sed -i`, `echo >>`, `tee`,
 * `rm`, ...) could rewrite the hook configuration without ever touching
 * those tools. This hook parses the incoming Bash command for write-shaped
 * operations whose target matches a protected path and interrupts them so
 * Claude has to ask the user for explicit approval first.
 *
 * Read-only usage of the same paths (cat, grep, ls, sed without -i,
 * redirects elsewhere) is always allowed.
 *
 * Protected paths:
 *   .claude/settings.json
 *   .claude/settings.local.json
 *   .claude/hooks/**            (and the .claude/hooks directory itself)
 *
 * SYNC NOTE: this list intentionally mirrors PROTECTED_PATHS in
 * .claude/hooks/config-protection.js (which additionally protects tooling
 * configs by basename, and does NOT cover settings.local.json — Bash write
 * shapes are riskier, so the Bash guard covers it too). config-protection.js
 * exports nothing (it is a run-on-import stdin script), so the list is
 * duplicated here; keep the two in sync when either changes.
 *
 * ── HITL flow ─────────────────────────────────────────────────────────
 * Mirrors config-protection.js: a ONE-SHOT sentinel file at
 * .claude/config-edit-approved containing the protected target's
 * repo-relative path authorises exactly one command, then is deleted.
 *
 * Fails OPEN on parse or logic errors — a bug in this hook must never
 * interrupt a legitimate command.
 *
 * Exit codes (per Claude Code hook contract):
 *   0 — allow the tool call
 *   2 — interrupt the tool call; stderr is fed back to Claude as feedback
 *
 * Tests: .claude/hooks/bash-config-guard.test.js
 *   Run with: node .claude/hooks/bash-config-guard.test.js
 */

import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';

// Matches a token that IS (or ends at) a protected path, whatever prefix the
// path carries ($VAR/..., absolute, relative, ./). See SYNC NOTE above.
const PROTECTED_TARGET_RE =
  /(^|\/)\.claude\/(settings\.json$|settings\.local\.json$|hooks(\/|$))/;

// ── Tokenizer ──────────────────────────────────────────────────────────────

/**
 * Split a shell command into simple commands, each a list of tokens.
 * Handles single/double quotes (a quoted protected path must still be
 * caught) and splits on the common separators ; | & && || and newlines.
 * This is a heuristic tokenizer, not a full shell parser — it errs on the
 * side of catching more (fail-closed for protected targets, fail-open on
 * genuine parse errors via the outer try/catch).
 */
function splitCommands(command) {
  const commands = [];
  let tokens = [];
  let current = '';
  let quote = null; // ', " or null
  let hasCurrent = false;

  const pushToken = () => {
    if (hasCurrent) {
      tokens.push(current);
      current = '';
      hasCurrent = false;
    }
  };
  const pushCommand = () => {
    pushToken();
    if (tokens.length > 0) commands.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else {
        current += ch;
        hasCurrent = true;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasCurrent = true; // empty quotes still make a token
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      current += command[i + 1];
      hasCurrent = true;
      i++;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      pushCommand();
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    if (ch === '>' || ch === '<') {
      // Separate redirection operators into their own tokens, keeping
      // >> / >| together and any attached fd digit (2>) or target (>file).
      pushToken();
      let op = ch;
      while (i + 1 < command.length && (command[i + 1] === '>' || command[i + 1] === '|')) {
        op += command[i + 1];
        i++;
      }
      tokens.push(op);
      continue;
    }
    current += ch;
    hasCurrent = true;
  }
  pushCommand();
  return commands;
}

// ── Write-target extraction ────────────────────────────────────────────────

const isFlag = (t) => t.startsWith('-');

/**
 * Given one simple command's tokens, return the list of tokens that the
 * command would WRITE to (create, modify, remove, or re-permission).
 */
function writeTargets(tokens) {
  const targets = [];

  // Strip leading env assignments and wrappers to find the command word.
  let start = 0;
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])) start++;
  while (start < tokens.length && ['sudo', 'command', 'exec', 'nohup'].includes(tokens[start])) start++;
  const cmd = (tokens[start] || '').replace(/^.*\//, ''); // basename of the command
  const args = tokens.slice(start + 1);

  // 1. Output redirections apply to any command: `> file`, `>> file`,
  //    `2> file`, `&> file`, `>| file` — the token after the operator.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const m = /^(\d*|&)(>{1,2})(\|)?$/.exec(t);
    if (m && i + 1 < tokens.length) {
      targets.push(tokens[i + 1]);
    }
  }

  const positional = args.filter((a) => !isFlag(a) && !/^(\d*|&)>{1,2}\|?$/.test(a));

  switch (cmd) {
    case 'sed':
    case 'perl':
    case 'python':
    case 'python3':
    case 'ruby': {
      // In-place editing: any -i flag (also combined, e.g. -ni, -pi, -i.bak).
      const inPlace = args.some((a) => /^-[a-zA-Z]*i/.test(a));
      if (inPlace) targets.push(...positional);
      break;
    }
    case 'tee':
      targets.push(...positional);
      break;
    case 'cp':
    case 'install':
      // Destination (last positional) is written.
      if (positional.length > 0) targets.push(positional[positional.length - 1]);
      break;
    case 'mv':
      // Source is removed AND destination written — both count.
      targets.push(...positional);
      break;
    case 'rm':
    case 'rmdir':
    case 'unlink':
    case 'shred':
    case 'truncate':
      targets.push(...positional);
      break;
    case 'dd':
      for (const a of args) {
        if (a.startsWith('of=')) targets.push(a.slice(3));
      }
      break;
    case 'chmod':
    case 'chown':
    case 'chattr':
      // First positional is the mode/owner; the rest are targets.
      targets.push(...positional.slice(1));
      break;
    default:
      break;
  }

  return targets;
}

/** Normalise a token for protected-path matching. */
function normaliseTarget(t) {
  return String(t).replace(/\\/g, '/');
}

/**
 * Scan a full Bash command string; return the first protected path a
 * write-shaped operation targets (repo-relative, starting at .claude/),
 * or null when the command is safe.
 */
function findProtectedWrite(command) {
  for (const tokens of splitCommands(command)) {
    for (const target of writeTargets(tokens)) {
      const normalised = normaliseTarget(target);
      const m = PROTECTED_TARGET_RE.exec(normalised);
      if (m) {
        // Sentinel key: the path from `.claude/` onward.
        const idx = normalised.indexOf('.claude/', m.index);
        return normalised.slice(idx === -1 ? m.index : idx);
      }
    }
  }
  return null;
}

// ── HITL sentinel (mirrors config-protection.js) ───────────────────────────

function sentinelPath() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join(projectDir, '.claude', 'config-edit-approved');
}

function readSentinel() {
  try {
    return readFileSync(sentinelPath(), 'utf8').trim();
  } catch {
    return null;
  }
}

function consumeSentinel() {
  try {
    unlinkSync(sentinelPath());
  } catch {
    // ignore — file may already be gone
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  try {
    const payload = raw.trim() ? JSON.parse(raw) : {};

    if (payload.tool_name !== 'Bash') {
      process.exit(0);
    }

    const command = (payload.tool_input && payload.tool_input.command) || '';
    if (!command || typeof command !== 'string') {
      process.exit(0);
    }

    const protectedTarget = findProtectedWrite(command);
    if (!protectedTarget) {
      process.exit(0); // read-only or unrelated — allow
    }

    // One-shot approval sentinel — same file and semantics as
    // config-protection.js, bound to the protected target's path.
    const approved = readSentinel();
    if (approved && approved === protectedTarget) {
      consumeSentinel();
      process.stderr.write(
        `bash-config-guard: one-shot approval consumed for ${protectedTarget}\n`,
      );
      process.exit(0);
    }

    const sentinel = sentinelPath();
    const message = [
      `HITL-APPROVAL-REQUIRED: this Bash command writes to "${protectedTarget}", a protected config path.`,
      ``,
      `The hook configuration (.claude/settings.json, .claude/settings.local.json)`,
      `and the hook scripts themselves (.claude/hooks/**) require explicit human`,
      `approval before any change — including changes made through the shell`,
      `(redirection, sed -i, tee, cp/mv/rm, chmod, ...). Modifying them silently`,
      `would let the agent disable its own guardrails, violating the project`,
      `rule: "Never skip a failing check. Never suppress warnings to make a`,
      `check pass."`,
      ``,
      `Read-only access (cat, grep, ls) is always allowed and does not trigger`,
      `this guard.`,
      ``,
      `ACTION REQUIRED BY CLAUDE — do this NOW, do not defer:`,
      ``,
      `  1. STOP the current tool call.`,
      `  2. Quote the intended command to the user verbatim and explain why`,
      `     the change is needed.`,
      `  3. Ask the user explicitly: "Do you approve this change to`,
      `     ${protectedTarget}?"`,
      `  4. Wait for an explicit yes/no answer in the chat. Do NOT assume`,
      `     approval from tone or context — the user must say yes.`,
      `  5. Do NOT continue with unrelated work in the meantime.`,
      ``,
      `If — and ONLY if — the user says yes in the chat, write the protected`,
      `path to the one-shot sentinel file and retry the exact same command:`,
      ``,
      `    echo '${protectedTarget}' > '${sentinel}'`,
      ``,
      `The sentinel is single-use — it is deleted as soon as it authorises one`,
      `command. NEVER create the sentinel pre-emptively, as a shortcut, or to`,
      `"unblock" yourself without an explicit user approval.`,
    ].join('\n');

    process.stderr.write(message + '\n');
    process.exit(2);
  } catch (err) {
    // Fail open: never block a legitimate command due to a hook bug.
    process.stderr.write(
      `bash-config-guard: internal error, allowing command: ${err && err.message}\n`,
    );
    process.exit(0);
  }
});
