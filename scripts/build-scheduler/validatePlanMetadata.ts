/**
 * validatePlanMetadata.ts
 *
 * Plan-metadata contract: parse + validate chunk metadata blocks.
 *
 * Public contract:
 *   parsePlanMetadata(raw)      — single snake→camel normalisation point.
 *   validatePlanMetadata(chunks) — structural validator; NEVER throws.
 *
 * Path canonicalisation contract (round-2 HIGH):
 *   parsePlanMetadata canonicalises EVERY declared_files entry:
 *     - replaces \ → /
 *     - collapses // → /
 *     - resolves . segments
 *     - rejects absolute paths, .. segments, and empty strings (→ ValidationError)
 *     - de-duplicates within a chunk after normalisation
 *     - case-folded canonical form used for intersection; original casing preserved for display
 *
 * This module does NOT implement wave logic (see computeWaves.ts).
 */

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RawChunkMetadata {
  id?: string;
  specSections?: string[];
  declaredFiles?: string[];   // required, non-empty
  dependsOn?: string[];       // required, may be empty array
  exclusiveResources?: string[]; // optional
}

export interface ValidationError {
  chunkId: string | '<unknown>';
  field: string;
  message: string;
}

export interface ValidatePlanResult {
  ok: boolean;
  errors: ValidationError[];
}

// ---------------------------------------------------------------------------
// Internal: path canonicalisation
// ---------------------------------------------------------------------------

/**
 * Canonicalises a single declared_files path entry.
 * Returns the normalised path, or null if the path is invalid (caller emits error).
 */
function canonicalisePath(raw: string): { canonical: string; caseFolded: string } | null {
  if (raw === '') return null;

  // Replace backslashes with forward slashes (Windows path separators).
  let p = raw.replace(/\\/g, '/');

  // Reject absolute paths (Unix: leading /, Windows: drive letter C:/).
  if (/^\//.test(p) || /^[a-zA-Z]:/.test(p)) return null;

  // Reject paths containing .. segments.
  const segments = p.split('/');
  for (const seg of segments) {
    if (seg === '..') return null;
  }

  // Resolve . segments (keep non-. segments only).
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === '.') continue;
    if (seg === '') continue; // handles // via split
    resolved.push(seg);
  }

  const canonical = resolved.join('/');

  // After resolution, if empty (e.g. was just './' or '') — reject.
  if (canonical === '') return null;

  return { canonical, caseFolded: canonical.toLowerCase() };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses an array of raw (snake_case) chunk metadata objects into camelCase
 * RawChunkMetadata[]. This is the SINGLE normalisation point for snake→camel
 * key mapping. Also canonicalises every declared_files path entry.
 *
 * Invalid paths are surfaced as ValidationError objects in the returned tuple.
 * This function NEVER throws.
 */
export function parsePlanMetadata(
  raw: Array<Record<string, unknown>>,
): { chunks: RawChunkMetadata[]; pathErrors: ValidationError[] } {
  const chunks: RawChunkMetadata[] = [];
  const pathErrors: ValidationError[] = [];

  for (const item of raw) {
    const id = typeof item['id'] === 'string' ? item['id'] : undefined;
    const chunkId: string | '<unknown>' = id ?? '<unknown>';

    // snake_case → camelCase mapping.
    const specSections = Array.isArray(item['spec_sections'])
      ? (item['spec_sections'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : Array.isArray(item['specSections'])
        ? (item['specSections'] as unknown[]).filter((s): s is string => typeof s === 'string')
        : undefined;

    const rawDependsOn = item['depends_on'] ?? item['dependsOn'];
    const dependsOn = Array.isArray(rawDependsOn)
      ? (rawDependsOn as unknown[]).filter((s): s is string => typeof s === 'string')
      : undefined;

    const rawExclusiveResources = item['exclusive_resources'] ?? item['exclusiveResources'];
    const exclusiveResources = Array.isArray(rawExclusiveResources)
      ? (rawExclusiveResources as unknown[]).filter((s): s is string => typeof s === 'string')
      : undefined;

    // Canonicalise declared_files entries.
    const rawDeclaredFiles = item['declared_files'] ?? item['declaredFiles'];
    let declaredFiles: string[] | undefined;

    if (Array.isArray(rawDeclaredFiles)) {
      const seen = new Set<string>(); // case-folded for de-dup
      const canonicalised: string[] = [];

      for (const entry of rawDeclaredFiles as unknown[]) {
        if (typeof entry !== 'string') {
          pathErrors.push({
            chunkId,
            field: 'declaredFiles',
            message: `declared_files entry is not a string: ${JSON.stringify(entry)}`,
          });
          continue;
        }

        if (entry === '') {
          pathErrors.push({
            chunkId,
            field: 'declaredFiles',
            message: 'declared_files entry is an empty string',
          });
          continue;
        }

        const result = canonicalisePath(entry);
        if (result === null) {
          // Determine specific rejection reason for the error message.
          let reason = 'invalid path';
          const forwardSlashed = entry.replace(/\\/g, '/');
          if (/^\//.test(forwardSlashed) || /^[a-zA-Z]:/.test(forwardSlashed)) {
            reason = 'absolute paths are not permitted';
          } else if (forwardSlashed.split('/').includes('..')) {
            reason = '".." segments are not permitted';
          } else if (entry === '' || forwardSlashed.replace(/\//g, '') === '') {
            reason = 'empty path after normalisation';
          }
          pathErrors.push({
            chunkId,
            field: 'declaredFiles',
            message: `declared_files entry rejected (${reason}): ${entry}`,
          });
          continue;
        }

        // De-duplicate by case-folded canonical form.
        if (!seen.has(result.caseFolded)) {
          seen.add(result.caseFolded);
          canonicalised.push(result.canonical);
        }
      }

      declaredFiles = canonicalised;
    }

    chunks.push({
      id,
      specSections,
      declaredFiles,
      dependsOn,
      exclusiveResources,
    });
  }

  return { chunks, pathErrors };
}

/**
 * Validates an array of RawChunkMetadata (already camelCase, paths canonicalised).
 * Returns a ValidatePlanResult. NEVER throws — all errors are returned as structured
 * ValidationError objects.
 */
export function validatePlanMetadata(chunks: RawChunkMetadata[]): ValidatePlanResult {
  const errors: ValidationError[] = [];

  const knownIds = new Set<string>();
  const seenIds = new Set<string>();

  // Collect all ids first (needed for dangling-dep check).
  for (const chunk of chunks) {
    if (typeof chunk.id === 'string' && chunk.id !== '') {
      knownIds.add(chunk.id);
    }
  }

  for (const chunk of chunks) {
    const chunkId: string | '<unknown>' = typeof chunk.id === 'string' && chunk.id !== ''
      ? chunk.id
      : '<unknown>';

    // Duplicate id check.
    if (chunkId !== '<unknown>') {
      if (seenIds.has(chunk.id as string)) {
        errors.push({
          chunkId,
          field: 'id',
          message: `duplicate chunk id: "${chunk.id}"`,
        });
      } else {
        seenIds.add(chunk.id as string);
      }
    }

    // declaredFiles: required, non-empty.
    if (!Array.isArray(chunk.declaredFiles)) {
      errors.push({
        chunkId,
        field: 'declaredFiles',
        message: 'declaredFiles is required but missing',
      });
    } else if (chunk.declaredFiles.length === 0) {
      errors.push({
        chunkId,
        field: 'declaredFiles',
        message: 'declaredFiles must not be empty',
      });
    }

    // dependsOn: required (empty array is OK).
    if (!Array.isArray(chunk.dependsOn)) {
      errors.push({
        chunkId,
        field: 'dependsOn',
        message: 'dependsOn is required but missing',
      });
    } else {
      // Dangling dependency id check.
      for (const depId of chunk.dependsOn) {
        if (!knownIds.has(depId)) {
          errors.push({
            chunkId,
            field: 'dependsOn',
            message: `depends_on references unknown chunk id: "${depId}"`,
          });
        }
      }
    }

    // exclusiveResources: if present, must be an array of non-empty strings.
    if (chunk.exclusiveResources !== undefined) {
      if (!Array.isArray(chunk.exclusiveResources)) {
        errors.push({
          chunkId,
          field: 'exclusiveResources',
          message: 'exclusiveResources must be an array when present',
        });
      } else {
        for (const res of chunk.exclusiveResources) {
          if (typeof res !== 'string' || res === '') {
            errors.push({
              chunkId,
              field: 'exclusiveResources',
              message: `exclusiveResources entry must be a non-empty string: ${JSON.stringify(res)}`,
            });
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
