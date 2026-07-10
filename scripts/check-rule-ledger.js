#!/usr/bin/env node
'use strict';
/**
 * check-rule-ledger.js — coverage checker for references/rule-classification.md.
 *
 * Framework-only tooling (NOT a managed/synced file — do not add to manifest.json).
 * Plain node, zero dependencies.
 *
 * Enforces the coverage contract pinned in the ledger preamble
 * (references/rule-classification.md § Contract):
 *
 *   Pass 1 — file coverage: every behavioural managed file (manifest categories
 *            agent/skill/command/hook, globs expanded) has >=1 ledger row whose
 *            anchor starts with its path.
 *   Pass 2 — heading + anchor coverage: (a) every heading in every behavioural
 *            markdown file maps to a ledger row (rule or no-rules marker);
 *            (b) every ledger anchor resolves to a real file + heading at HEAD
 *            (hook .js anchors carry no '#' — file existence suffices).
 *   Pass 3 — dangling references (opt-in via --deleted <file>): grep the repo
 *            for each literal string from a newline-separated list; any hit fails.
 *   Pass 4 — autonomy-ladder keyword coverage: any pinned keyword that appears in
 *            a *coordinator*.md agent file must also appear in
 *            references/autonomy-ladder.md.
 *
 * Exit 0 = every pass that ran is green. Non-zero + per-failure report otherwise.
 *
 * Usage:
 *   node scripts/check-rule-ledger.js [--deleted <path-to-newline-list>]
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const LEDGER_REL = 'references/rule-classification.md';
const AUTONOMY_LADDER_REL = 'references/autonomy-ladder.md';
const BEHAVIOURAL_CATEGORIES = new Set(['agent', 'skill', 'command', 'hook']);

// Files that live in a behavioural category but carry no behavioural directives.
const EXCLUDED_LITERAL = new Set(['.claude/hooks/package.json']);
const EXCLUDED_PREFIXES = ['.claude/agents/_retired/'];
// Test files (verification code, not behavioural contracts) are excluded — this
// matches the F4 generator, which lists wargame-nudge.js but not its .test.js.
const TEST_FILE_RE = /\.test\.(js|ts|mjs|cjs|mts|cts)$/;

// Pass 4 pinned keyword list (WS5 acceptance).
const AUTONOMY_KEYWORDS = [
  'ready-to-merge',
  '--admin',
  'plan gate',
  'unattended',
  'auto-apply',
  'auto-fix',
  'auto-merge',
  'REVIEW_GAP',
  'PLAN_GAP',
  'label',
];

// Directories never walked when grepping the repo (Pass 3).
const GREP_SKIP_DIRS = new Set(['.git', 'node_modules', '.claude-framework']);

// ---------------------------------------------------------------------------
// Slug algorithm — EXACTLY per the ledger preamble § Contract:
//   lowercase; strip non-alphanumerics except spaces/hyphens; trim;
//   collapse spaces to hyphens.
// Ordinal suffix (-2, -3, ...) is applied by the caller for repeats within a
// single file, in document order.
// ---------------------------------------------------------------------------

/**
 * Slugify a single heading's text (no ordinal suffix).
 * @param {string} text
 * @returns {string}
 */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '') // strip non-alphanumerics except spaces/hyphens
    .trim()
    .replace(/ +/g, '-'); // collapse spaces to hyphens
}

// ---------------------------------------------------------------------------
// Heading extraction — markdown #..#### only, skipping YAML frontmatter and
// fenced code blocks. Returns slugs in document order with ordinal suffixes.
// ---------------------------------------------------------------------------

/**
 * @param {string} markdown
 * @returns {{ slugs: string[], headings: Array<{level:number,text:string,slug:string}> }}
 */
function extractHeadingSlugs(markdown) {
  const lines = markdown.split(/\r?\n/);
  let i = 0;

  // Skip a leading YAML frontmatter block: first non-empty line is `---`.
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    i = 1;
    while (i < lines.length && lines[i].trim() !== '---') i++;
    if (i < lines.length) i++; // consume the closing ---
  }

  let inFence = false;
  let fenceMarker = '';
  const seen = new Map(); // base slug -> count
  /** @type {Array<{level:number,text:string,slug:string}>} */
  const headings = [];

  for (; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Fenced code block toggling (``` or ~~~, 3+ chars).
    const fenceOpen = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceOpen) {
      const marker = fenceOpen[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    if (inFence) continue;

    const m = line.match(/^(#{1,4})\s+(.*)$/);
    if (!m) continue;
    const level = m[1].length;
    // Strip trailing '#' (closed ATX headings) and whitespace.
    const rawText = m[2].replace(/\s+#+\s*$/, '').trim();
    const base = slugify(rawText);
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    const slug = count === 1 ? base : `${base}-${count}`;
    headings.push({ level, text: rawText, slug });
  }

  return { slugs: headings.map((h) => h.slug), headings };
}

// ---------------------------------------------------------------------------
// Ledger parsing — collect every anchor row across all sections.
// ---------------------------------------------------------------------------

/**
 * @param {string} ledgerText
 * @returns {Array<{ anchor: string, file: string, slug: string|null, line: number }>}
 */
function parseLedgerAnchors(ledgerText) {
  const lines = ledgerText.split(/\r?\n/);
  /** @type {Array<{ anchor: string, file: string, slug: string|null, line: number }>} */
  const rows = [];
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (!line.startsWith('|')) continue;
    const cells = line.split('|');
    // cells[0] is '' (before first pipe); first data cell is cells[1].
    const first = (cells[1] || '').trim();
    const bt = first.match(/^`([^`]+)`$/);
    if (!bt) continue;
    const anchor = bt[1];
    if (!/\.(md|js)/.test(anchor)) continue; // path-shaped anchors only
    const hashIdx = anchor.indexOf('#');
    const file = hashIdx === -1 ? anchor : anchor.slice(0, hashIdx);
    const slug = hashIdx === -1 ? null : anchor.slice(hashIdx + 1);
    rows.push({ anchor, file, slug, line: n + 1 });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Glob expansion — ports sync.js expandGlob (`*` and `{a,b,c}` only).
// ---------------------------------------------------------------------------

/**
 * @param {string} pattern
 * @param {string} rootDir
 * @returns {string[]}
 */
function expandGlob(pattern, rootDir) {
  if (pattern.includes('**')) {
    throw new Error('** not supported; use multiple manifest entries instead.');
  }
  if (path.isAbsolute(pattern) || pattern.split('/').includes('..')) {
    throw new Error(`manifest path must be relative without '..': ${pattern}`);
  }

  const braceMatch = pattern.match(/\{([^}]+)\}/);
  /** @type {string[]} */
  let patterns;
  if (braceMatch) {
    const prefix = pattern.slice(0, braceMatch.index);
    const suffix = pattern.slice(braceMatch.index + braceMatch[0].length);
    patterns = braceMatch[1].split(',').map((alt) => prefix + alt + suffix);
  } else {
    patterns = [pattern];
  }

  /** @type {Set<string>} */
  const results = new Set();
  for (const pat of patterns) {
    const segments = pat.split('/');
    const lastSeg = segments[segments.length - 1];
    const dirSegments = segments.slice(0, -1);
    const dirPath = dirSegments.length > 0 ? path.join(rootDir, ...dirSegments) : rootDir;

    if (lastSeg.includes('*')) {
      let entries;
      try {
        entries = fs.readdirSync(dirPath);
      } catch {
        continue;
      }
      const starParts = lastSeg.split('*');
      const prefix = starParts[0];
      const suffix = starParts[starParts.length - 1];
      for (const entry of entries) {
        if (
          entry.startsWith(prefix) &&
          entry.endsWith(suffix) &&
          entry.length >= prefix.length + suffix.length
        ) {
          results.add([...dirSegments, entry].join('/'));
        }
      }
    } else {
      if (fs.existsSync(path.join(rootDir, pat))) results.add(pat);
    }
  }
  return Array.from(results).sort();
}

// ---------------------------------------------------------------------------
// Behavioural managed-file list from manifest.json.
// ---------------------------------------------------------------------------

/**
 * @param {string} rootDir
 * @returns {string[]} sorted relative paths
 */
function behaviouralFiles(rootDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
  /** @type {Set<string>} */
  const out = new Set();
  for (const entry of manifest.managedFiles) {
    if (!BEHAVIOURAL_CATEGORIES.has(entry.category)) continue;
    for (const rel of expandGlob(entry.path, rootDir)) {
      if (EXCLUDED_LITERAL.has(rel)) continue;
      if (EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) continue;
      if (TEST_FILE_RE.test(rel)) continue;
      out.add(rel);
    }
  }
  return Array.from(out).sort();
}

function isMarkdown(rel) {
  return rel.endsWith('.md');
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

/**
 * Pass 1 — every behavioural file has >=1 ledger row whose anchor starts with
 * its path.
 * @returns {{ ok: boolean, failures: string[] }}
 */
function pass1(files, ledgerRows) {
  const anchors = ledgerRows.map((r) => r.anchor);
  const failures = [];
  for (const f of files) {
    // A row covers `f` if its anchor is `f` (hook) or `f#...` (markdown heading).
    const covered = anchors.some((a) => a === f || a.startsWith(f + '#'));
    if (!covered) failures.push(`no ledger row for behavioural file: ${f}`);
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Pass 2 — heading coverage (a) + anchor resolution (b).
 * @returns {{ ok: boolean, failures: string[] }}
 */
function pass2(files, ledgerRows, rootDir) {
  const failures = [];
  const anchorSet = new Set(ledgerRows.map((r) => r.anchor));

  // (a) every heading of every behavioural markdown file maps to a ledger row.
  for (const f of files) {
    if (!isMarkdown(f)) continue;
    const md = fs.readFileSync(path.join(rootDir, f), 'utf8');
    const { slugs } = extractHeadingSlugs(md);
    for (const slug of slugs) {
      const anchor = `${f}#${slug}`;
      if (!anchorSet.has(anchor)) {
        failures.push(`heading not in ledger: ${anchor}`);
      }
    }
  }

  // (b) every ledger anchor resolves to a real file (+ heading for md).
  const headingCache = new Map();
  for (const row of ledgerRows) {
    const abs = path.join(rootDir, row.file);
    if (!fs.existsSync(abs)) {
      failures.push(`anchor file missing: ${row.anchor} (ledger line ${row.line})`);
      continue;
    }
    if (row.slug === null) continue; // hook .js — file existence suffices
    if (!headingCache.has(row.file)) {
      headingCache.set(row.file, new Set(extractHeadingSlugs(fs.readFileSync(abs, 'utf8')).slugs));
    }
    if (!headingCache.get(row.file).has(row.slug)) {
      failures.push(`anchor heading unresolved: ${row.anchor} (ledger line ${row.line})`);
    }
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Pass 3 — dangling references to deleted strings. Skipped without --deleted.
 * @returns {{ ok: boolean, skipped: boolean, failures: string[], note?: string }}
 */
function pass3(deletedListPath, rootDir) {
  if (!deletedListPath) {
    return { ok: true, skipped: true, failures: [], note: 'no --deleted flag; pass 3 skipped' };
  }
  const raw = fs.readFileSync(deletedListPath, 'utf8');
  const needles = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const failures = [];

  /** @param {string} dir */
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (GREP_SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const abs = path.join(dir, entry.name);
        const rel = path.relative(rootDir, abs).split(path.sep).join('/');
        if (rel === LEDGER_REL) continue; // exclude the ledger itself
        let content;
        try {
          content = fs.readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (let ln = 0; ln < lines.length; ln++) {
          for (const needle of needles) {
            if (lines[ln].includes(needle)) {
              failures.push(`dangling "${needle}": ${rel}:${ln + 1}`);
            }
          }
        }
      }
    }
  }
  walk(rootDir);
  return { ok: failures.length === 0, skipped: false, failures };
}

/**
 * Pass 4 — autonomy-ladder keyword coverage.
 * @returns {{ ok: boolean, failures: string[], report: Array<{keyword:string,inCoordinator:boolean,inLadder:boolean}> }}
 */
function pass4(rootDir) {
  const coordinatorFiles = expandGlob('.claude/agents/*.md', rootDir).filter((f) =>
    /coordinator/.test(path.basename(f))
  );
  // Case-insensitive concept coverage: a keyword listed lowercase (e.g. auto-merge)
  // is covered by a sentence-initial capitalisation in the ladder ("Auto-merge to
  // main"). Matching case-sensitively would be a brittle false positive.
  const coordinatorText = coordinatorFiles
    .map((f) => fs.readFileSync(path.join(rootDir, f), 'utf8'))
    .join('\n')
    .toLowerCase();
  const ladderText = fs.readFileSync(path.join(rootDir, AUTONOMY_LADDER_REL), 'utf8').toLowerCase();

  const failures = [];
  const report = [];
  for (const kw of AUTONOMY_KEYWORDS) {
    const needle = kw.toLowerCase();
    const inCoordinator = coordinatorText.includes(needle);
    const inLadder = ladderText.includes(needle);
    report.push({ keyword: kw, inCoordinator, inLadder });
    if (inCoordinator && !inLadder) {
      failures.push(`keyword in coordinator but missing from autonomy-ladder.md: "${kw}"`);
    }
  }
  return { ok: failures.length === 0, failures, report };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { deleted: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--deleted') {
      args.deleted = argv[i + 1];
      i++;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = REPO_ROOT;

  const ledgerText = fs.readFileSync(path.join(rootDir, LEDGER_REL), 'utf8');
  const ledgerRows = parseLedgerAnchors(ledgerText);
  const files = behaviouralFiles(rootDir);

  const r1 = pass1(files, ledgerRows);
  const r2 = pass2(files, ledgerRows, rootDir);
  const r3 = pass3(args.deleted, rootDir);
  const r4 = pass4(rootDir);

  const out = [];
  out.push('rule-ledger coverage checker');
  out.push('============================');
  out.push(`ledger: ${LEDGER_REL}  (${ledgerRows.length} anchor rows)`);
  out.push(`behavioural files: ${files.length}`);
  out.push('');

  const report = (label, res) => {
    if (res.skipped) {
      out.push(`${label}: SKIPPED — ${res.note}`);
      return;
    }
    out.push(`${label}: ${res.ok ? 'PASS' : 'FAIL (' + res.failures.length + ')'}`);
    for (const f of res.failures) out.push(`    - ${f}`);
  };

  report('Pass 1 (file coverage)', r1);
  report('Pass 2 (heading + anchor coverage)', r2);
  report('Pass 3 (dangling references)', r3);
  out.push(`Pass 4 (autonomy-ladder keywords): ${r4.ok ? 'PASS' : 'FAIL (' + r4.failures.length + ')'}`);
  for (const row of r4.report) {
    const mark = !row.inCoordinator ? 'n/a' : row.inLadder ? 'ok' : 'MISSING';
    out.push(`    - ${row.keyword}: coordinator=${row.inCoordinator} ladder=${row.inLadder} [${mark}]`);
  }

  const failed = !r1.ok || !r2.ok || !r3.ok || !r4.ok;
  out.push('');
  out.push(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
  process.stdout.write(out.join('\n') + '\n');
  process.exit(failed ? 1 : 0);
}

module.exports = {
  slugify,
  extractHeadingSlugs,
  parseLedgerAnchors,
  expandGlob,
  behaviouralFiles,
  pass1,
  pass2,
  pass3,
  pass4,
};

if (require.main === module) main();
