#!/usr/bin/env node
// Growth gate (prevention control C5 — framework cost-optimization, 2026-08-07).
// Every NEW always-loaded behavioural addition in a release must justify its
// footprint in the CHANGELOG, so the fleet/skill/hook/command surface cannot
// quietly regrow the per-session context cost the F1 batch just cut.
//
// What it enforces: for each file ADDED since the previous release under
//   .claude/agents/     (a new agent — excludes _retired/, extensions/, *.test.*)
//   .claude/skills/     (a new skill — its SKILL.md)
//   .claude/hooks/      (a new hook entry .js — excludes *.test.js, package.json)
//   .claude/commands/   (a new command)
// the current version's CHANGELOG section MUST carry a structured declaration
// line:
//
//   > growth-gate: <path-or-name> — replaces: <what it replaces | none: why nothing existing covers it>; footprint: <N bytes | not-always-loaded>
//
// The two required fields are `replaces:` (what it replaces / why nothing does)
// and `footprint:` (its always-loaded byte cost, or `not-always-loaded`). A new
// file with no matching declaration fails the release.
//
// Scope (precision over recall — deliberate): only new FILES in the four
// behavioural classes are diffed. "tier" and "always-loaded doc section"
// additions from the report C5 wording are enforced by the release-CHECKLIST
// prose in .claude/commands/release.md, not mechanically (they are not cleanly
// diffable). Renames and modifications are not additions and are ignored.
//
// Exit codes:
//   0  no new behavioural files, or every new file is declared. Also 0 (with a
//      loud WARN) when the base ref cannot be resolved (tagless/shallow checkout)
//      — a release runs where tags exist; a dev checkout should not hard-block.
//   1  one or more new behavioural files lack a growth-gate declaration.
//
// Config (env, all optional):
//   GATE_ROOT       repo root (default process.cwd()).
//   GATE_BASE_REF   ref to diff HEAD against (default: `v<previous-version>`
//                   derived from the 2nd `## ` heading in .claude/CHANGELOG.md).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const GATE_ID = 'verify-growth-gate';
const ROOT = path.resolve(process.env.GATE_ROOT || process.cwd());

function git(args) {
  return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
}
function gitOk(args) {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
}

function read(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return null;
  }
}

const changelog = read('.claude/CHANGELOG.md');
if (!changelog) {
  console.error(`[FAIL] ${GATE_ID}: .claude/CHANGELOG.md not found at ${ROOT}`);
  process.exit(1);
}
const currentVersion = (read('.claude/FRAMEWORK_VERSION') || '').trim();
if (!currentVersion) {
  console.error(`[FAIL] ${GATE_ID}: .claude/FRAMEWORK_VERSION not found/empty`);
  process.exit(1);
}

// Resolve the base ref.
const headings = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)\b/gm)].map((m) => m[1]);
const prevVersion = headings.find((v) => v !== currentVersion);
const baseRef = process.env.GATE_BASE_REF || (prevVersion ? `v${prevVersion}` : null);

if (!baseRef || !gitOk(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`])) {
  console.log(`[GATE] ${GATE_ID}: WARN base ref ${baseRef || '(none)'} unresolvable — cannot diff for new files; skipping (fail-open). Release-time run has tags.`);
  process.exit(0);
}

// New (Added) files since baseRef.
let diff = '';
try {
  diff = git(['diff', '--name-status', '--diff-filter=A', `${baseRef}`, 'HEAD']);
} catch (err) {
  console.log(`[GATE] ${GATE_ID}: WARN git diff failed (${err.message}) — skipping (fail-open).`);
  process.exit(0);
}

const added = diff
  .split('\n')
  .filter(Boolean)
  .map((l) => l.split('\t'))
  .filter((p) => p[0] && p[0].startsWith('A'))
  .map((p) => p[1]);

/** Behavioural additions needing a declaration, with the token to match in the CHANGELOG. */
const behavioural = [];
for (const f of added) {
  if (/^\.claude\/agents\/[^/]+\.md$/.test(f) && !f.includes('/_retired/') && !f.endsWith('.test.md')) {
    behavioural.push({ file: f, name: path.basename(f, '.md'), kind: 'agent' });
  } else if (/^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(f)) {
    behavioural.push({ file: f, name: f.split('/')[2], kind: 'skill' });
  } else if (/^\.claude\/hooks\/[^/]+\.js$/.test(f) && !f.endsWith('.test.js')) {
    behavioural.push({ file: f, name: path.basename(f, '.js'), kind: 'hook' });
  } else if (/^\.claude\/commands\/[^/]+\.md$/.test(f)) {
    behavioural.push({ file: f, name: path.basename(f, '.md'), kind: 'command' });
  }
}

if (behavioural.length === 0) {
  console.log(`[GATE] ${GATE_ID}: violations=0 base=${baseRef} new_behavioural=0`);
  process.exit(0);
}

// Current version's CHANGELOG section.
const secStart = changelog.search(new RegExp(`^## ${currentVersion.replace(/\./g, '\\.')}\\b`, 'm'));
let section = '';
if (secStart >= 0) {
  const rest = changelog.slice(secStart + 1);
  const nextIdx = rest.search(/^## \S/m);
  section = nextIdx >= 0 ? rest.slice(0, nextIdx) : rest;
}
const declarations = [...section.matchAll(/^> growth-gate:\s*(.+)$/gm)].map((m) => m[1]);

const violations = [];
for (const b of behavioural) {
  const decl = declarations.find(
    (d) => (d.includes(b.file) || new RegExp(`\\b${b.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(d)),
  );
  if (!decl) {
    violations.push(`${b.kind} ${b.file}: no \`> growth-gate:\` declaration in the v${currentVersion} CHANGELOG section`);
  } else if (!/replaces:/i.test(decl) || !/footprint:/i.test(decl)) {
    violations.push(`${b.kind} ${b.file}: declaration is missing ${!/replaces:/i.test(decl) ? '`replaces:`' : ''}${!/replaces:/i.test(decl) && !/footprint:/i.test(decl) ? ' + ' : ''}${!/footprint:/i.test(decl) ? '`footprint:`' : ''}`);
  }
}

if (violations.length > 0) {
  console.error(`${GATE_ID}: ${violations.length} new behavioural addition(s) undeclared in the v${currentVersion} CHANGELOG:`);
  for (const v of violations) console.error(`  [growth-gate] ${v}`);
  console.error('  Add one line per new file to the CHANGELOG entry:');
  console.error('  > growth-gate: <path> — replaces: <what|none: why>; footprint: <N bytes|not-always-loaded>');
  console.error(`[GATE] ${GATE_ID}: violations=${violations.length} base=${baseRef} new_behavioural=${behavioural.length}`);
  process.exit(1);
}

console.log(`[GATE] ${GATE_ID}: violations=0 base=${baseRef} new_behavioural=${behavioural.length} (all declared)`);
process.exit(0);
