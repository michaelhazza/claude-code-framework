/**
 * audit-context-packs.ts
 *
 * Pure function: validates that every anchor reference in docs/context-packs/*.md
 * resolves to a declared anchor in architecture.md.
 *
 * Run via: npx tsx scripts/audit-context-packs.ts
 *
 * Exit 0 — all anchors resolved (or no packs present).
 * Exit 1 — one or more anchors missing; prints <pack>:<line> <anchor> per miss.
 *
 * Also importable as a pure module (no side effects on import).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PackAnchorMiss {
  pack: string;
  anchor: string;
  line: number;
}

export interface AuditContextPacksInput {
  packs: Array<{ path: string; content: string }>;
  architectureMarkdown: string;
}

export type AuditContextPacksResult =
  | { kind: 'ok' }
  | { kind: 'fail'; missing: PackAnchorMiss[] };

// ---------------------------------------------------------------------------
// GFM heading slug algorithm
// ---------------------------------------------------------------------------

function gfmSlug(heading: string): string {
  // GitHub's heading-anchor slugger preserves underscores in addition to
  // hyphens and alphanumerics — `# State machine (usability_state)` renders
  // to `state-machine-usability_state`, not `state-machine-usabilitystate`.
  // Without `_` in the allow-list, valid links in context packs would be
  // falsely reported as broken anchors.
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// ---------------------------------------------------------------------------
// Declared anchors — parse architecture.md
// ---------------------------------------------------------------------------

function extractDeclaredAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();

  // 1. Explicit <a id="..."></a> tags — highest precedence.
  const aIdRe = /<a\s+id="([^"]+)"\s*(?:\/>|><\/a>|>.*?<\/a>)/g;
  let m: RegExpExecArray | null;
  while ((m = aIdRe.exec(markdown)) !== null) {
    anchors.add(m[1]);
  }

  // 2. Heading-derived slugs with GFM duplicate-suffix algorithm.
  //    Track counts globally across the file (not reset per section).
  //    Skip heading-shape lines inside fenced code blocks — they are example markup,
  //    not real declared anchors (closes the ghost-anchor false-positive corridor).
  const seenSlugs = new Map<string, number>();
  const lines = markdown.split('\n');
  const fenced = buildFenceMask(lines);
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const headingMatch = /^#{1,6}\s+(.+)$/.exec(lines[i]);
    if (!headingMatch) continue;
    // Strip inline code and links from heading text before slugging.
    const text = headingMatch[1]
      .replace(/`[^`]*`/g, (s) => s.slice(1, -1))
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    const base = gfmSlug(text);
    if (!base) continue;
    // GitHub's slug-assignment algorithm: first occurrence uses the bare base;
    // subsequent occurrences get `-1`, `-2`, etc. If the candidate slug already
    // collides with a slug claimed by an earlier heading (natural or suffixed),
    // keep incrementing until a free slot is found. Matches GitHub's renderer
    // for sequences like `# Setup` / `# Setup` / `# Setup 1` → setup, setup-1,
    // setup-1-1.
    let count = seenSlugs.get(base) ?? 0;
    let candidate = count === 0 ? base : `${base}-${count}`;
    while (anchors.has(candidate)) {
      count += 1;
      candidate = `${base}-${count}`;
    }
    anchors.add(candidate);
    seenSlugs.set(base, count + 1);
  }

  return anchors;
}

// ---------------------------------------------------------------------------
// GFM fence tracking — returns true when a line is inside a fenced code block
// ---------------------------------------------------------------------------

/**
 * Returns an array of booleans, one per line, indicating whether that line is
 * inside a GFM fenced code block (``` or ~~~, opening fence >=3 chars).
 */
function buildFenceMask(lines: string[]): boolean[] {
  const mask: boolean[] = new Array(lines.length).fill(false);
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inFence) {
      const fenceOpen = /^(`{3,}|~{3,})/.exec(line);
      if (fenceOpen) {
        inFence = true;
        fenceChar = fenceOpen[1][0];
        fenceLen = fenceOpen[1].length;
        mask[i] = true; // opening fence line is "inside"
      }
    } else {
      mask[i] = true;
      // Check for closing fence: same char, >= opening length, optional trailing whitespace.
      const closeRe = new RegExp(`^(\\${fenceChar}{${fenceLen},})\\s*$`);
      if (closeRe.test(line)) {
        inFence = false;
      }
    }
  }
  return mask;
}

// ---------------------------------------------------------------------------
// Reference anchor extraction — parse a single pack file
// ---------------------------------------------------------------------------

/**
 * Extract all anchor references from a pack file.
 * Returns an array of { anchor, line } (1-indexed line numbers).
 */
function extractPackAnchors(content: string): Array<{ anchor: string; line: number }> {
  const refs: Array<{ anchor: string; line: number }> = [];
  const lines = content.split('\n');
  const fenced = buildFenceMask(lines);

  // Track whether we are under a "- `architecture.md`:" style source-block heading.
  // Such headings introduce a list of anchor refs as bare backtick fragments.
  let underSourceBlockHeading = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];

    if (fenced[i]) {
      // Inside a fenced block — anchors here are code examples, not refs.
      underSourceBlockHeading = false;
      continue;
    }

    // Detect source-block heading: a list item or heading containing `architecture.md`:
    //   - `architecture.md`:
    //   ### `architecture.md` sections
    if (/`architecture\.md`/.test(line)) {
      underSourceBlockHeading = true;
    } else if (/^#{1,6}\s/.test(line)) {
      // A new markdown heading always resets the source-block context.
      underSourceBlockHeading = false;
    } else if (/^[-*]\s/.test(line)) {
      // A top-level list item (no leading whitespace) that doesn't look like an
      // anchor ref resets the context. Sub-items (indented) may be anchor-ref lines
      // and do NOT reset the context — let the bare-fragment check run on them.
      // Underscore is part of the GFM-slug allow-list (see gfmSlug above), so
      // the regex must accept `_` to match anchors like `state-machine-usability_state`.
      if (!/`#[a-z0-9_-]+`/.test(line)) {
        underSourceBlockHeading = false;
      }
    }

    // Form 1: Markdown links — [text](architecture.md#anchor) or [text](#anchor)
    const mdLinkRe = /\[([^\]]*)\]\((?:architecture\.md)?#([^)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = mdLinkRe.exec(line)) !== null) {
      refs.push({ anchor: m[2], line: lineNo });
    }

    // Form 2: Bare backtick fragment under source-block heading: `#anchor-id`
    // Mirror the declared-anchor slug character class — must include `_` so
    // underscore-bearing anchors are extracted and validated.
    if (underSourceBlockHeading) {
      const bareFragRe = /`(#[a-z0-9_-]+)`/g;
      while ((m = bareFragRe.exec(line)) !== null) {
        // Strip the leading '#'
        refs.push({ anchor: m[1].slice(1), line: lineNo });
      }
    }
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Pure exported function
// ---------------------------------------------------------------------------

export function auditContextPacks(input: AuditContextPacksInput): AuditContextPacksResult {
  if (input.packs.length === 0) {
    return { kind: 'ok' };
  }

  const declared = extractDeclaredAnchors(input.architectureMarkdown);
  const missing: PackAnchorMiss[] = [];

  for (const pack of input.packs) {
    const refs = extractPackAnchors(pack.content);
    for (const ref of refs) {
      if (!declared.has(ref.anchor)) {
        missing.push({ pack: pack.path, anchor: ref.anchor, line: ref.line });
      }
    }
  }

  return missing.length === 0 ? { kind: 'ok' } : { kind: 'fail', missing };
}

// ---------------------------------------------------------------------------
// CLI entrypoint — guarded so import has no side effects
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const ARCH_PATH = join(PROJECT_DIR, 'architecture.md');

  (async () => {
    try {
      // Read pack files from docs/context-packs/. If the directory is absent
      // OR contains no *.md files, there is nothing to validate — short-circuit
      // to exit 0 to match the pure helper's "empty packs returns ok" contract.
      // This must run BEFORE the architecture.md existence check: a consumer
      // with no context packs and no architecture.md should not have
      // finalisation falsely blocked by this advisory check.
      const packPaths: string[] = [];
      const packsDir = join(PROJECT_DIR, 'docs', 'context-packs');
      if (existsSync(packsDir)) {
        for (const f of readdirSync(packsDir)) {
          if (f.endsWith('.md')) packPaths.push(join(packsDir, f));
        }
      }

      if (packPaths.length === 0) {
        process.stdout.write('OK\n');
        process.exit(0);
      }

      // Read architecture.md — only required when there are packs to validate.
      if (!existsSync(ARCH_PATH)) {
        process.stderr.write(`audit-context-packs: architecture.md not found at ${ARCH_PATH}\n`);
        process.exit(1);
      }
      const architectureMarkdown = readFileSync(ARCH_PATH, 'utf8');

      const packs = packPaths.map((p) => ({
        path: basename(p),
        content: readFileSync(p, 'utf8'),
      }));

      const result = auditContextPacks({ packs, architectureMarkdown });

      if (result.kind === 'ok') {
        process.stdout.write('OK\n');
        process.exit(0);
      } else {
        for (const miss of result.missing) {
          process.stdout.write(`${miss.pack}:${miss.line} ${miss.anchor}\n`);
        }
        process.exit(1);
      }
    } catch (err) {
      process.stderr.write(`audit-context-packs: unexpected error: ${(err as Error).message}\n`);
      process.exit(1);
    }
  })();
}
