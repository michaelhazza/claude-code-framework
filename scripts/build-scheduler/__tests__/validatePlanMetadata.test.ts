/**
 * validatePlanMetadata.test.ts
 *
 * Tests for parsePlanMetadata (snake→camel normalisation + path canonicalisation)
 * and validatePlanMetadata (structural validation).
 *
 * Run via: npx vitest run scripts/build-scheduler/__tests__/validatePlanMetadata.test.ts
 */

import { describe, it, expect } from 'vitest';
import { parsePlanMetadata, validatePlanMetadata } from '../validatePlanMetadata.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid camelCase chunk for validatePlanMetadata. */
function validChunk(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    declaredFiles: [`scripts/${id}.ts`],
    dependsOn: [] as string[],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validatePlanMetadata — structural rules
// ---------------------------------------------------------------------------

describe('validatePlanMetadata', () => {
  it('A6: chunk missing declaredFiles → ok:false, error names field + chunk', () => {
    const result = validatePlanMetadata([{ id: 'c1', dependsOn: [] }]);
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.field === 'declaredFiles');
    expect(err).toBeDefined();
    expect(err!.chunkId).toBe('c1');
    expect(err!.message).toMatch(/declaredFiles/);
  });

  it('empty declaredFiles array is rejected', () => {
    const result = validatePlanMetadata([{ id: 'c1', declaredFiles: [], dependsOn: [] }]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'declaredFiles')).toBe(true);
  });

  it('missing dependsOn is rejected', () => {
    const result = validatePlanMetadata([{ id: 'c1', declaredFiles: ['src/a.ts'] }]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'dependsOn')).toBe(true);
  });

  it('dependsOn: [] (empty array) is accepted', () => {
    const result = validatePlanMetadata([validChunk('c1')]);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('dangling dependsOn id is rejected', () => {
    const result = validatePlanMetadata([{ id: 'c1', declaredFiles: ['src/a.ts'], dependsOn: ['c99'] }]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'dependsOn' && e.message.includes('c99'))).toBe(true);
  });

  it('duplicate chunk ids are rejected', () => {
    const result = validatePlanMetadata([validChunk('c1'), validChunk('c1')]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'id' && e.message.includes('c1'))).toBe(true);
  });

  it('fully-valid 3-chunk plan → ok:true', () => {
    const result = validatePlanMetadata([
      validChunk('1'),
      validChunk('2'),
      { id: '3', declaredFiles: ['src/c.ts'], dependsOn: ['1', '2'] },
    ]);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('exclusiveResources with non-empty strings is valid', () => {
    const result = validatePlanMetadata([
      { id: 'c1', declaredFiles: ['src/a.ts'], dependsOn: [], exclusiveResources: ['manifest.json'] },
    ]);
    expect(result.ok).toBe(true);
  });

  it('exclusiveResources with an empty string entry is rejected', () => {
    const result = validatePlanMetadata([
      { id: 'c1', declaredFiles: ['src/a.ts'], dependsOn: [], exclusiveResources: [''] },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'exclusiveResources')).toBe(true);
  });

  it('never throws on any malformed input', () => {
    // Completely empty object — should not throw.
    expect(() => validatePlanMetadata([{}])).not.toThrow();
    // null-ish fields — should not throw.
    expect(() => validatePlanMetadata([{ id: undefined, declaredFiles: undefined, dependsOn: undefined }])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// parsePlanMetadata — snake→camel normalisation (OAI-002)
// ---------------------------------------------------------------------------

describe('parsePlanMetadata — snake→camel (OAI-002)', () => {
  it('snake_case fixture from Chunk 1 metadata → ok:true after parsePlanMetadata + validatePlanMetadata', () => {
    // This is the actual Chunk 1 metadata block verbatim from the plan.
    const snakeRaw = [
      {
        id: '1',
        declared_files: [
          'scripts/build-scheduler/computeWaves.ts',
          'scripts/build-scheduler/__tests__/computeWaves.test.ts',
          'manifest.json',
        ],
        depends_on: [] as string[],
        exclusive_resources: ['manifest.json'],
      },
    ];

    const { chunks, pathErrors } = parsePlanMetadata(snakeRaw);
    expect(pathErrors).toHaveLength(0);

    // camelCase fields must be populated.
    expect(chunks[0].declaredFiles).toBeDefined();
    expect(chunks[0].dependsOn).toBeDefined();
    expect(chunks[0].exclusiveResources).toEqual(['manifest.json']);

    const result = validatePlanMetadata(chunks);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('malformed snake_case block (missing declared_files) → ok:false', () => {
    const snakeRaw = [
      {
        id: 'c1',
        // declared_files intentionally omitted
        depends_on: [] as string[],
      },
    ];

    const { chunks, pathErrors } = parsePlanMetadata(snakeRaw);
    expect(pathErrors).toHaveLength(0);

    const result = validatePlanMetadata(chunks);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'declaredFiles')).toBe(true);
  });

  it('camelCase keys are also accepted (idempotent normalisation)', () => {
    const camelRaw = [
      {
        id: 'c1',
        declaredFiles: ['src/a.ts'],
        dependsOn: [] as string[],
      },
    ];

    const { chunks, pathErrors } = parsePlanMetadata(camelRaw);
    expect(pathErrors).toHaveLength(0);
    expect(validatePlanMetadata(chunks).ok).toBe(true);
  });

  it('spec_sections is normalised to specSections', () => {
    const raw = [
      {
        id: 'c1',
        declared_files: ['src/a.ts'],
        depends_on: [] as string[],
        spec_sections: ['§3.1', '§4'],
      },
    ];

    const { chunks } = parsePlanMetadata(raw);
    expect(chunks[0].specSections).toEqual(['§3.1', '§4']);
  });
});

// ---------------------------------------------------------------------------
// parsePlanMetadata — path canonicalisation (round-2 HIGH)
// ---------------------------------------------------------------------------

describe('parsePlanMetadata — path canonicalisation', () => {
  it('./src/a.ts and src/a.ts canonicalise to the same path', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'chunkA',
        declared_files: ['./src/a.ts'],
        depends_on: [] as string[],
      },
      {
        id: 'chunkB',
        declared_files: ['src/a.ts'],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors).toHaveLength(0);
    // Both should resolve to 'src/a.ts'.
    expect(chunks[0].declaredFiles).toEqual(['src/a.ts']);
    expect(chunks[1].declaredFiles).toEqual(['src/a.ts']);
  });

  it('src\\\\a.ts (backslash) and src/a.ts canonicalise to the same path', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'chunkA',
        declared_files: ['src\\a.ts'],
        depends_on: [] as string[],
      },
      {
        id: 'chunkB',
        declared_files: ['src/a.ts'],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors).toHaveLength(0);
    expect(chunks[0].declaredFiles).toEqual(['src/a.ts']);
    expect(chunks[1].declaredFiles).toEqual(['src/a.ts']);
  });

  it('src//a.ts (double slash) canonicalises to src/a.ts', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'c1',
        declared_files: ['src//a.ts'],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors).toHaveLength(0);
    expect(chunks[0].declaredFiles).toEqual(['src/a.ts']);
  });

  it('src/Foo.ts and src/foo.ts treated as same file under case-fold (de-duplication within a chunk)', () => {
    // When both appear in the same chunk they are de-duplicated; only one survives.
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'c1',
        declared_files: ['src/Foo.ts', 'src/foo.ts'],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors).toHaveLength(0);
    // Only one should survive (case-fold de-dup).
    expect(chunks[0].declaredFiles).toHaveLength(1);
  });

  it('src/Foo.ts in chunkA and src/foo.ts in chunkB resolve to the same canonical path', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'chunkA',
        declared_files: ['src/Foo.ts'],
        depends_on: [] as string[],
      },
      {
        id: 'chunkB',
        declared_files: ['src/foo.ts'],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors).toHaveLength(0);
    // Both canonicalise to their original casing (not mutated), but
    // case-folded forms are equal — so computeWaves would treat them as same.
    const aLower = chunks[0].declaredFiles![0].toLowerCase();
    const bLower = chunks[1].declaredFiles![0].toLowerCase();
    expect(aLower).toBe(bLower);
  });

  it('absolute path (Unix /absolute/path.ts) → ValidationError (not accepted)', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'c1',
        declared_files: ['/absolute/path.ts'],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors.length).toBeGreaterThan(0);
    expect(pathErrors[0].chunkId).toBe('c1');
    expect(pathErrors[0].field).toBe('declaredFiles');
    expect(pathErrors[0].message).toMatch(/absolute/i);
    // The file entry should not appear in the canonicalised output.
    expect(chunks[0].declaredFiles).toHaveLength(0);
  });

  it('absolute path (Windows C:/path.ts) → ValidationError', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'c1',
        declared_files: ['C:/path/file.ts'],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors.length).toBeGreaterThan(0);
    expect(pathErrors[0].message).toMatch(/absolute/i);
    expect(chunks[0].declaredFiles).toHaveLength(0);
  });

  it('.. segment → ValidationError', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'c1',
        declared_files: ['src/../secret.ts'],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors.length).toBeGreaterThan(0);
    expect(pathErrors[0].field).toBe('declaredFiles');
    expect(pathErrors[0].message).toMatch(/\.\./);
    expect(chunks[0].declaredFiles).toHaveLength(0);
  });

  it('empty string entry → ValidationError', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'c1',
        declared_files: [''],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors.length).toBeGreaterThan(0);
    expect(pathErrors[0].field).toBe('declaredFiles');
    expect(chunks[0].declaredFiles).toHaveLength(0);
  });

  it('valid and invalid entries mixed: valid ones survive, invalid ones produce errors', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'c1',
        declared_files: ['src/good.ts', '/bad/absolute.ts', 'src/also-good.ts'],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors).toHaveLength(1);
    expect(chunks[0].declaredFiles).toEqual(['src/good.ts', 'src/also-good.ts']);
  });

  it('de-duplicates identical entries within a chunk after normalisation', () => {
    const { chunks, pathErrors } = parsePlanMetadata([
      {
        id: 'c1',
        declared_files: ['src/a.ts', './src/a.ts', 'src//a.ts'],
        depends_on: [] as string[],
      },
    ]);

    expect(pathErrors).toHaveLength(0);
    // All three resolve to 'src/a.ts'; only one should survive.
    expect(chunks[0].declaredFiles).toHaveLength(1);
    expect(chunks[0].declaredFiles![0]).toBe('src/a.ts');
  });
});
