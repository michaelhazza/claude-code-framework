#!/usr/bin/env node
'use strict';
/**
 * check-shipped-source.js — parse + module-system gate over shipped source.
 *
 * Motivation: the entire 2.43.1–2.43.3 release series was consumer-discovered
 * breakage in framework-shipped JS (lint failures, and a CommonJS `.js`
 * scanner crashing under a consumer's `"type": "module"` — fixed by renaming
 * to `.cjs`). The framework repo itself runs no gate over its own shipped
 * scripts/hooks, so consumers find these first. This gate makes the two
 * mechanical classes impossible to ship:
 *
 *   1. PARSE — every shipped .js/.cjs/.mjs file (plus the sync/migration
 *      engines, which consumers execute in place) must pass `node --check`.
 *   2. MODULE SYSTEM — a manifest-shipped `.js` file whose content is
 *      CommonJS must be governed by a SHIPPED package.json declaring
 *      `"type": "commonjs"` in its subtree; otherwise a consumer whose root
 *      package.json says `"type": "module"` will load it as ESM and crash.
 *      Fix is a `.cjs` rename (the 2.43.3 check-secrets fix) or a scoped
 *      package.json (the .claude/hooks/ pattern, which declares "module" —
 *      so hooks .js files must be ESM).
 *
 * Zero dependencies, CommonJS, exit 1 on any failure. `--json` for machine
 * output. Fails loudly if the manifest is unreadable.
 */

const { readFileSync, readdirSync, statSync, existsSync } = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

/** Engine files consumers execute in place (not synced, but a parse error
 *  here bricks /claudeupdate exactly like a bad shipped file). */
const ENGINE_FILES = ['sync.js', 'scripts/run-migrations.js'];

const SOURCE_EXT_RE = /\.(js|cjs|mjs)$/;

// ---------------------------------------------------------------------------
// Minimal glob support for manifest paths (segments with `*`; `**` spans).
// ---------------------------------------------------------------------------

function globToRegExp(glob) {
  const escaped = glob
    .split(/(\*\*|\*)/)
    .map((part) => {
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      return part.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${escaped}$`);
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function shippedFiles(manifest, allFiles) {
  const patterns = manifest.managedFiles.map((entry) => globToRegExp(entry.path));
  return allFiles.filter((file) => {
    const rel = path.relative(REPO_ROOT, file).replaceAll('\\', '/');
    return patterns.some((pattern) => pattern.test(rel));
  });
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function nodeCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  return result.status === 0 ? null : (result.stderr || 'node --check failed').trim().split('\n')[0];
}

// ── Source masking ──────────────────────────────────────────────────────────
// State-machine masker blanking the CONTENTS of comments, string/template
// literals, and REGEX LITERALS while KEEPING template-interpolation code.
// Both halves matter for correctness of the module-system gate:
//   - `${require('./x')}` is executable CommonJS inside a template — it must
//     stay visible to the markers (blanking it is a false NEGATIVE);
//   - `/require\s*\(/` in a pure-ESM scanner is prose, not code — it must be
//     blanked (matching it is a false POSITIVE).
// Regex-literal detection uses the standard preceding-token heuristic with
// newline recovery. Ported from the consumer's proven implementation
// (automation-v1 scripts/lib/cronRegistrationAuditPure.ts maskSource).

const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^',
]);
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await', 'throw',
]);

function maskJsSource(source) {
  const out = new Array(source.length);
  const stack = [{ kind: 'code', interpolation: false, braceDepth: 0 }];
  const isIdent = (c) => /[\w$]/.test(c);
  let lastCode = '';
  let lastToken = '';
  let tokenActive = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = i + 1 < source.length ? source[i + 1] : '';
    const state = stack[stack.length - 1];
    const blanked = ch === '\n' ? '\n' : ' ';

    if (state.kind === 'code') {
      if (ch === '/' && next === '/') { stack.push({ kind: 'line' }); out[i] = ' '; continue; }
      if (ch === '/' && next === '*') { stack.push({ kind: 'block' }); out[i] = ' '; continue; }
      if (ch === "'" || ch === '"') {
        stack.push({ kind: ch === "'" ? 'single' : 'double' });
        out[i] = ch; lastCode = ch; lastToken = ''; tokenActive = false;
        continue;
      }
      if (ch === '`') {
        stack.push({ kind: 'template' });
        out[i] = ch; lastCode = ch; lastToken = ''; tokenActive = false;
        continue;
      }
      if (ch === '/') {
        const regexStart = lastCode === ''
          || REGEX_PRECEDERS.has(lastCode)
          || (isIdent(lastCode) && REGEX_KEYWORDS.has(lastToken));
        if (regexStart) { stack.push({ kind: 'regex', inClass: false }); out[i] = ch; continue; }
      }
      if (state.interpolation && ch === '}') {
        if (state.braceDepth === 0) { stack.pop(); out[i] = ch; continue; }
        state.braceDepth -= 1;
      } else if (state.interpolation && ch === '{') {
        state.braceDepth += 1;
      }
      out[i] = ch;
      if (!/\s/.test(ch)) {
        if (isIdent(ch)) { lastToken = tokenActive ? lastToken + ch : ch; tokenActive = true; }
        else { lastToken = ''; tokenActive = false; }
        lastCode = ch;
      } else {
        tokenActive = false;
      }
      continue;
    }

    if (state.kind === 'single' || state.kind === 'double') {
      if (ch === '\\' && next !== '') { out[i] = ' '; out[i + 1] = next === '\n' ? '\n' : ' '; i += 1; continue; }
      if ((state.kind === 'single' && ch === "'") || (state.kind === 'double' && ch === '"') || ch === '\n') {
        stack.pop(); out[i] = ch; continue; // newline pop = unterminated-literal recovery
      }
      out[i] = blanked;
      continue;
    }

    if (state.kind === 'template') {
      if (ch === '\\' && next !== '') { out[i] = ' '; out[i + 1] = next === '\n' ? '\n' : ' '; i += 1; continue; }
      if (ch === '`') { stack.pop(); out[i] = ch; continue; }
      if (ch === '$' && next === '{') {
        out[i] = ' '; out[i + 1] = '{'; i += 1;
        stack.push({ kind: 'code', interpolation: true, braceDepth: 0 });
        continue;
      }
      out[i] = blanked;
      continue;
    }

    if (state.kind === 'line') {
      if (ch === '\n') { stack.pop(); out[i] = '\n'; continue; }
      out[i] = ' ';
      continue;
    }

    if (state.kind === 'block') {
      if (ch === '*' && next === '/') { stack.pop(); out[i] = ' '; out[i + 1] = ' '; i += 1; continue; }
      out[i] = blanked;
      continue;
    }

    // regex
    if (ch === '\\' && next !== '') { out[i] = ' '; out[i + 1] = next === '\n' ? '\n' : ' '; i += 1; continue; }
    if (ch === '\n') { stack.pop(); out[i] = '\n'; continue; } // regex literals cannot span lines — misdetection recovery
    if (state.inClass) {
      if (ch === ']') state.inClass = false;
      out[i] = ' ';
      continue;
    }
    if (ch === '[') { state.inClass = true; out[i] = ' '; continue; }
    if (ch === '/') { stack.pop(); out[i] = ch; continue; }
    out[i] = ' ';
  }
  return out.join('');
}

// CommonJS markers, matched over MASKED source. Broader than declaration
// assignment on purpose: bare side-effect `require('./x')`, lazy `require`
// inside functions, `require.main === module`, `module.*`, `exports.*` /
// `exports =`, and `__dirname`/`__filename` all crash at load or at run
// time when the file is interpreted as ESM. `(?<![.\w$])` keeps member
// accesses like `pkg.require(` and identifiers like `myrequire` out.
const CJS_MARKER_RES = [
  /(?<![.\w$])require\s*[.(]/,
  /(?<![.\w$])module\s*\./,
  /(?<![.\w$])exports\s*[.=]/,
  /(?<![.\w$])__dirname(?![\w$])/,
  /(?<![.\w$])__filename(?![\w$])/,
];
const ESM_IDIOM_RE = /^\s*import[\s('"]|^\s*export\s|import\s*\.\s*meta/m;

/** Module type governing `rel` per the SHIPPED files: nearest shipped
 *  package.json wins; no shipped package.json => consumer root governs,
 *  which the framework cannot know => 'unknown'. */
function governingType(rel, shippedPackageJsons) {
  let dir = path.posix.dirname(rel);
  while (true) {
    const candidate = dir === '.' ? 'package.json' : `${dir}/package.json`;
    if (shippedPackageJsons.has(candidate)) return shippedPackageJsons.get(candidate);
    if (dir === '.') return 'unknown';
    dir = path.posix.dirname(dir);
  }
}

function main() {
  const findings = [];
  const manifestPath = path.join(REPO_ROOT, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(manifest.managedFiles)) throw new Error('managedFiles is not an array');
  } catch (error) {
    console.error(`[check-shipped-source] cannot read manifest.json: ${error.message}`);
    process.exit(1);
  }

  const allFiles = walk(REPO_ROOT, []);
  const shipped = shippedFiles(manifest, allFiles);
  const shippedRel = shipped.map((file) => path.relative(REPO_ROOT, file).replaceAll('\\', '/'));

  // Shipped package.json files declare the module type of their subtree in
  // the consumer too (they sync along with the code).
  const shippedPackageJsons = new Map();
  for (const rel of shippedRel) {
    if (path.posix.basename(rel) === 'package.json') {
      try {
        const parsed = JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
        shippedPackageJsons.set(rel, parsed.type === 'module' ? 'module' : 'commonjs');
      } catch {
        findings.push({ check: 'parse', severity: 'blocker', file: rel, message: 'shipped package.json is not valid JSON' });
      }
    }
  }

  const sourceRel = shippedRel.filter((rel) => SOURCE_EXT_RE.test(rel));
  for (const engine of ENGINE_FILES) {
    if (!existsSync(path.join(REPO_ROOT, engine))) {
      findings.push({ check: 'parse', severity: 'blocker', file: engine, message: 'engine file missing — update ENGINE_FILES if it moved' });
    } else if (!sourceRel.includes(engine)) {
      sourceRel.push(engine);
    }
  }

  for (const rel of sourceRel.sort()) {
    const abs = path.join(REPO_ROOT, rel);
    const parseError = nodeCheck(abs);
    if (parseError) {
      findings.push({ check: 'parse', severity: 'blocker', file: rel, message: parseError });
      continue;
    }
    if (!rel.endsWith('.js')) continue; // .cjs/.mjs are self-describing
    const masked = maskJsSource(readFileSync(abs, 'utf8'));
    const isCjs = CJS_MARKER_RES.some((re) => re.test(masked));
    const isEsm = ESM_IDIOM_RE.test(masked);
    if (!isCjs) continue; // pure ESM or idiom-free .js is safe under either type
    const type = governingType(rel, shippedPackageJsons);
    if (type === 'commonjs') continue;
    findings.push({
      check: 'module-system',
      severity: 'blocker',
      file: rel,
      message: type === 'module'
        ? 'CommonJS idioms in a .js file governed by a shipped package.json with "type": "module" — it will crash at load'
        : `CommonJS idioms in a shipped .js file with no shipped package.json governing it — an ESM consumer ("type": "module") will crash loading it${isEsm ? ' (file mixes CJS and ESM idioms)' : ''}`,
    });
  }

  const summary = `[check-shipped-source] ${sourceRel.length} shipped source file(s) checked, ${findings.length} failure(s).`;
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ checked: sourceRel.length, findings }, null, 2));
  } else {
    console.log(summary);
    for (const finding of findings) {
      console.log(`  - [${finding.check}] ${finding.file}: ${finding.message}`);
    }
    if (findings.length > 0) {
      console.log('  fix: rename CommonJS .js to .cjs (2.43.3 precedent) or ship a scoped package.json; parse failures show node\'s first error line.');
    }
  }
  if (findings.length > 0) process.exit(1);
}

main();
