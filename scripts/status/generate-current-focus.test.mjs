/**
 * generate-current-focus.test.mjs
 *
 * Vitest self-test for scripts/status/generate-current-focus.mjs. Spawns the
 * real generator as a child process against isolated temp-dir fixtures — no
 * committed fixture tree (spec §14: "Fixtures are constructed in temp dirs
 * at test time"). Also validates the spec §8.1 example instance against
 * schemas/build-status.schema.json with ajv.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GENERATOR = path.join(HERE, 'generate-current-focus.mjs');
const SCHEMA_PATH = path.resolve(HERE, '..', '..', 'schemas', 'build-status.schema.json');
const BEGIN_MARKER = '<!-- STATUS:GENERATED:BEGIN -->';
const END_MARKER = '<!-- STATUS:GENERATED:END -->';

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), `generate-current-focus-${crypto.randomUUID()}-`));
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Baseline valid, active status.json record. Callers override fields. */
function baseRecord(slug, overrides = {}) {
  return {
    contract_version: 'build-status.v1',
    slug,
    title: `Title for ${slug}`,
    classification: 'Standard',
    phase: 'build',
    status: 'BUILDING',
    branch: `branch-${slug}`,
    pr: null,
    gates: { s0: 'pass' },
    gate_evidence: {},
    blockers: [],
    summary: `Summary for ${slug}`,
    updated_at: '2026-07-28T00:00:00Z',
    updated_by: 'builder',
    ...overrides,
  };
}

/** Writes tasks/builds/<slug>/status.json with raw text (already-serialised
 *  string, so invalid-JSON fixtures can be authored directly). */
function writeStatusRaw(root, slug, rawText) {
  const dir = path.join(root, 'tasks', 'builds', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), rawText, 'utf8');
}

function writeStatus(root, slug, overrides = {}) {
  writeStatusRaw(root, slug, JSON.stringify(baseRecord(slug, overrides), null, 2));
}

function writeCurrentFocus(root, content) {
  const dir = path.join(root, 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'current-focus.md'), content, 'utf8');
}

function readCurrentFocus(root) {
  return fs.readFileSync(path.join(root, 'tasks', 'current-focus.md'), 'utf8');
}

function runGenerator(root) {
  const res = spawnSync(process.execPath, [GENERATOR, '--root', root], {
    encoding: 'utf8',
    timeout: 60000,
  });
  return { status: res.status ?? -1, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/** Every `build_slug: <slug>` line in file order — the exact line format the
 *  phase-lock hook (C9) reads from inside the marker region. */
function buildSlugLines(text) {
  return [...text.matchAll(/^build_slug: (.+)$/gm)].map((m) => m[1]);
}

describe('build-status.schema.json', () => {
  it('spec §8.1 example instance validates', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);

    const exampleInstance = {
      contract_version: 'build-status.v1',
      slug: 'dev-pipeline-v2',
      title: 'Development Pipeline v2',
      classification: 'Major',
      phase: 'spec',
      status: 'PLANNING',
      branch: 'claude/personal-ai-agent-system-1mqzyh',
      pr: null,
      gates: { s0: 'pass', duplication_check: 'proceed', g5: null, verify: null, merge_gate: null },
      gate_evidence: {
        s0: { sha: 'ee629f849', run_ids: [], url: null, completed_at: '2026-07-26T00:00:00Z' },
      },
      blockers: [],
      summary: 'Phase 1 in flight; spec under review tiers.',
      updated_at: '2026-07-26T00:00:00Z',
      updated_by: 'spec-coordinator',
    };

    const valid = validate(exampleInstance);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('generate-current-focus.mjs', () => {
  it('absent markers + legacy mission-control comment: markers inserted below it, legacy block byte-preserved', () => {
    const root = makeTempRoot();
    try {
      const legacyBlock =
        '<!-- mission-control\n' +
        'build_slug: legacy-slug\n' +
        'status: PLANNING\n' +
        '-->\n';
      const prose = '\n# Current Focus\n\nSome prose stays here.\n';
      writeCurrentFocus(root, legacyBlock + prose);
      writeStatus(root, 'active-one', { status: 'BUILDING' });

      const r = runGenerator(root);
      expect(r.status, r.stdout + r.stderr).toBe(0);

      const out = readCurrentFocus(root);
      expect(out.startsWith(legacyBlock)).toBe(true);
      const beginIdx = out.indexOf(BEGIN_MARKER);
      const endIdx = out.indexOf(END_MARKER);
      expect(beginIdx).toBeGreaterThan(legacyBlock.length - 1);
      expect(endIdx).toBeGreaterThan(beginIdx);
      // Everything after the generated block is byte-identical to the original prose.
      expect(out.slice(out.indexOf(END_MARKER) + END_MARKER.length + 1)).toBe(prose);
      expect(out).toContain('build_slug: legacy-slug');
      expect(out).toContain('build_slug: active-one');
    } finally {
      rmrf(root);
    }
  });

  it('duplicate markers: non-zero exit, file unchanged', () => {
    const root = makeTempRoot();
    try {
      const original =
        `${BEGIN_MARKER}\nold content 1\n${END_MARKER}\n` +
        `${BEGIN_MARKER}\nold content 2\n${END_MARKER}\n`;
      writeCurrentFocus(root, original);
      writeStatus(root, 'active-one');

      const r = runGenerator(root);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/markers/i);
      expect(readCurrentFocus(root)).toBe(original);
    } finally {
      rmrf(root);
    }
  });

  it('invalid JSON status.json: INVALID line inside the block, exit 0, other builds still listed', () => {
    const root = makeTempRoot();
    try {
      writeStatus(root, 'good-build');
      writeStatusRaw(root, 'bad-build', '{ not valid json');

      const r = runGenerator(root);
      expect(r.status, r.stdout + r.stderr).toBe(0);

      const out = readCurrentFocus(root);
      expect(out).toMatch(/INVALID: bad-build — invalid JSON:/);
      expect(out).toContain('build_slug: good-build');
    } finally {
      rmrf(root);
    }
  });

  it('slug !== directory: exact INVALID wording', () => {
    const root = makeTempRoot();
    try {
      writeStatus(root, 'dir-a', { slug: 'different-slug' });

      const r = runGenerator(root);
      expect(r.status, r.stdout + r.stderr).toBe(0);

      const out = readCurrentFocus(root);
      expect(out).toContain('INVALID: dir-a — slug different-slug does not match directory dir-a');
    } finally {
      rmrf(root);
    }
  });

  it('ordering: status priority, then updated_at desc, then slug asc; terminal builds excluded', () => {
    const root = makeTempRoot();
    try {
      writeStatus(root, 'a-planning', { status: 'PLANNING', updated_at: '2026-07-20T00:00:00Z' });
      writeStatus(root, 'b-building', { status: 'BUILDING', updated_at: '2026-07-25T00:00:00Z' });
      writeStatus(root, 'c-building', { status: 'BUILDING', updated_at: '2026-07-25T00:00:00Z' });
      writeStatus(root, 'd-reviewing', { status: 'REVIEWING', updated_at: '2026-07-22T00:00:00Z' });
      writeStatus(root, 'e-mergeready', { status: 'MERGE_READY', updated_at: '2026-07-21T00:00:00Z' });
      writeStatus(root, 'f-merged', { status: 'MERGED', updated_at: '2026-07-27T00:00:00Z' });
      writeStatus(root, 'g-abandoned', { status: 'ABANDONED', updated_at: '2026-07-27T00:00:00Z' });

      const r = runGenerator(root);
      expect(r.status, r.stdout + r.stderr).toBe(0);

      const out = readCurrentFocus(root);
      expect(out).not.toContain('f-merged');
      expect(out).not.toContain('g-abandoned');

      const slugs = buildSlugLines(out);
      expect(slugs).toEqual(['e-mergeready', 'd-reviewing', 'b-building', 'c-building', 'a-planning']);
    } finally {
      rmrf(root);
    }
  });

  it('idempotence: second run over its own output is byte-identical', () => {
    const root = makeTempRoot();
    try {
      writeStatus(root, 'active-one', { status: 'BUILDING' });
      writeStatus(root, 'active-two', { status: 'REVIEWING' });

      const first = runGenerator(root);
      expect(first.status, first.stdout + first.stderr).toBe(0);
      const afterFirst = readCurrentFocus(root);

      const second = runGenerator(root);
      expect(second.status, second.stdout + second.stderr).toBe(0);
      const afterSecond = readCurrentFocus(root);

      expect(afterSecond).toBe(afterFirst);
    } finally {
      rmrf(root);
    }
  });

  it('atomicity smoke: no *.tmp residue after a failing (duplicate-markers) run', () => {
    const root = makeTempRoot();
    try {
      const original = `${BEGIN_MARKER}\nold\n${END_MARKER}\n${BEGIN_MARKER}\nold2\n${END_MARKER}\n`;
      writeCurrentFocus(root, original);
      writeStatus(root, 'active-one');

      const r = runGenerator(root);
      expect(r.status).not.toBe(0);

      const tasksDirEntries = fs.readdirSync(path.join(root, 'tasks'));
      const tmpResidue = tasksDirEntries.filter((name) => name.includes('.tmp'));
      expect(tmpResidue).toEqual([]);
    } finally {
      rmrf(root);
    }
  });
});
