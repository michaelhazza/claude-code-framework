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

// Advisory mode downgrades a fail-closed (can't resolve the baseline) to a
// warning-exit-0 for LOCAL dev. It must be opt-in — release/CI defaults to
// fail-CLOSED so a tagless/shallow checkout or a bad ref can never silently
// disable the enforcement this gate exists to be.
const ADVISORY = /^(1|true|yes)$/i.test(process.env.GATE_GROWTH_ADVISORY || '');
function unresolved(msg) {
  if (ADVISORY) {
    console.log(`[GATE] ${GATE_ID}: WARN ${msg} — GATE_GROWTH_ADVISORY set, skipping (advisory).`);
    process.exit(0);
  }
  console.error(`[FAIL] ${GATE_ID}: ${msg}. The growth control cannot verify new additions and defaults to FAIL-CLOSED. Fix the baseline (fetch tags / correct GATE_BASE_REF), or set GATE_GROWTH_ADVISORY=1 for local-only advisory mode.`);
  process.exit(1);
}

// Resolve the base ref.
const headings = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)\b/gm)].map((m) => m[1]);
const prevVersion = headings.find((v) => v !== currentVersion);
const baseRef = process.env.GATE_BASE_REF || (prevVersion ? `v${prevVersion}` : null);

// No previous version at all = the first release. There is nothing to diff
// against, so there are legitimately no "new since last release" files — pass.
if (!prevVersion && !process.env.GATE_BASE_REF) {
  console.log(`[GATE] ${GATE_ID}: violations=0 base=(first release) new_behavioural=0`);
  process.exit(0);
}
if (!baseRef || !gitOk(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`])) {
  unresolved(`base ref ${baseRef || '(none)'} is unresolvable — cannot diff for new files`);
}

// New (Added) files since baseRef.
let diff = '';
try {
  diff = git(['diff', '--name-status', '--diff-filter=A', `${baseRef}`, 'HEAD']);
} catch (err) {
  unresolved(`git diff against ${baseRef} failed (${err.message})`);
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

// A declaration must name the addition and carry NON-EMPTY replaces: + footprint:
// values (an empty `replaces: ; footprint:` is not an audit). footprint must be
// `<N> bytes` or `not-always-loaded`. Match by FULL PATH first (unambiguous); a
// bare-name match is a fallback and is flagged as ambiguous if two additions
// share it, so one declaration cannot silently cover two different new files.
const FOOTPRINT_RE = /footprint:\s*(\d+\s*bytes|not-always-loaded)\b/i;
const REPLACES_RE = /replaces:\s*\S/i;
function nameMatchers(decl, b) {
  const byPath = decl.includes(b.file);
  const byName = new RegExp(`(^|[\\s\`(/])${b.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s\`).,;:]|$)`).test(decl);
  return { byPath, byName };
}
const violations = [];
for (const b of behavioural) {
  const matches = declarations.filter((d) => { const m = nameMatchers(d, b); return m.byPath || m.byName; });
  const pathMatches = declarations.filter((d) => d.includes(b.file));
  const decl = pathMatches[0] || matches[0];
  if (!decl) {
    violations.push(`${b.kind} ${b.file}: no \`> growth-gate:\` declaration in the v${currentVersion} CHANGELOG section`);
    continue;
  }
  // Ambiguity guard: a bare-name-only declaration shared by >1 addition, with no
  // full-path declaration, cannot be trusted to cover this specific file.
  if (pathMatches.length === 0) {
    const otherNameSharers = behavioural.filter((o) => o !== b && nameMatchers(decl, o).byName && !declarations.some((d) => d.includes(o.file)));
    if (otherNameSharers.length > 0) {
      violations.push(`${b.kind} ${b.file}: declaration matches by bare name only and is shared with ${otherNameSharers.length} other addition(s) — use the full path \`${b.file}\` in the declaration`);
      continue;
    }
  }
  const missing = [];
  if (!REPLACES_RE.test(decl)) missing.push('non-empty `replaces:`');
  if (!FOOTPRINT_RE.test(decl)) missing.push('`footprint:` as `<N> bytes` or `not-always-loaded`');
  if (missing.length) {
    violations.push(`${b.kind} ${b.file}: declaration is missing ${missing.join(' + ')}`);
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
