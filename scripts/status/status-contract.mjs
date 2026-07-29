/**
 * status-contract.mjs — the single reader-side contract for status.json.
 *
 * WHY THIS EXISTS
 * `generate-current-focus.mjs` validated records against
 * schemas/build-status.schema.json; `board-sync.mjs` checked only that the JSON
 * parsed and the slug matched its directory. So the two consumers of the same
 * file could disagree: the generator would classify a record INVALID and refuse
 * to render it while board-sync happily published it to a card. Worse, a
 * malformed record reaching board-sync surfaced as a "gh failure" — a
 * misleading diagnosis pointing at GitHub for a defect in local data.
 * (External review round 3.)
 *
 * Both readers now share this module, so "valid" means one thing.
 *
 * Ajv is loaded dynamically and the module degrades to a structural floor when
 * it is unavailable: these scripts are stdlib-only by design so they can run in
 * a bare consumer checkout, and a hard dependency would trade a real capability
 * for a validation nicety.
 *
 * THE FLOOR IS DERIVED FROM THE SCHEMA, NOT HAND-WRITTEN (external review round
 * 4). The first version listed six checks by hand and claimed to cover "the
 * dereferences the renderers actually perform". It did not: it checked that
 * `blockers` was an array but never the shape of its elements, so
 * `blockers: [null]` passed the floor and then threw on `blocker.cleared_at`
 * inside buildCardBody — which the per-record catch reported as a "gh failure",
 * pointing the operator at GitHub for a defect in local data. It also missed
 * `title`, `branch` and `pr`, all of which the card renderer dereferences.
 *
 * A hand-maintained mirror of a schema is the exact drift class this build
 * already wrote a guard for, so the floor now reads `required`, `properties`
 * and `items` straight out of the schema JSON and enforces them generically.
 * Parsing JSON needs no dependency; only ajv's richer keywords are lost. That
 * makes the schema file itself a hard runtime requirement, which it already
 * was in practice: readStatusEnum() cannot resolve the board's columns without
 * it either.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'schemas',
  'build-status.schema.json'
);

let compiledValidator = null;

/** Compiled ajv validator, or `false` when ajv/the schema are unavailable. */
export async function getSchemaValidator() {
  if (compiledValidator !== null) return compiledValidator;
  try {
    const [{ default: Ajv }, formats] = await Promise.all([
      import('ajv'),
      import('ajv-formats').catch(() => ({ default: null })),
    ]);
    const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
    const ajv = new Ajv({ allErrors: false, strict: false });
    if (formats.default) formats.default(ajv);
    compiledValidator = ajv.compile(schema);
  } catch {
    compiledValidator = false;
  }
  return compiledValidator;
}

let cachedSchema = null;

/** The parsed schema, or null when it cannot be read or parsed. */
async function readSchema() {
  if (cachedSchema !== null) return cachedSchema;
  try {
    cachedSchema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
  } catch {
    cachedSchema = false;
  }
  return cachedSchema || null;
}

/** The status enum from the schema, or null when the schema cannot be read. */
export async function readStatusEnum() {
  const schema = await readSchema();
  return schema?.properties?.status?.enum ?? null;
}

/** JSON Schema's `type` semantics, which differ from typeof for null and arrays. */
function matchesJsonType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    // JSON Schema's `object` excludes null and arrays; plain typeof does not.
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    default: return true; // unknown keyword — do not invent a constraint
  }
}

/** The type names a property definition permits, flattening the `oneOf` shapes
 *  the schema uses for nullable fields (`pr`, `blocker.cleared_at`). */
function permittedTypes(propSchema) {
  if (!propSchema) return [];
  if (typeof propSchema.type === 'string') return [propSchema.type];
  if (Array.isArray(propSchema.type)) return propSchema.type;
  const branches = propSchema.oneOf ?? propSchema.anyOf;
  if (Array.isArray(branches)) return branches.flatMap(permittedTypes);
  return [];
}

/** Generic required-keys + declared-types check against a schema fragment.
 *  Returns an error string, or null. `at` prefixes the path in messages. */
function checkAgainstFragment(value, fragment, at) {
  const missing = (fragment.required ?? []).filter(
    (key) => !Object.prototype.hasOwnProperty.call(value, key)
  );
  if (missing.length > 0) return `${at} missing required field(s): ${missing.join(', ')}`;

  for (const [key, propSchema] of Object.entries(fragment.properties ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue; // absent and not required
    const types = permittedTypes(propSchema);
    if (types.length > 0 && !types.some((t) => matchesJsonType(value[key], t))) {
      return `${at}${key} must be ${types.join(' or ')}`;
    }

    // One level into arrays-of-objects. This is not general recursion: it is
    // exactly the `blockers[]` shape, whose elements the card renderer
    // dereferences and whose malformed elements were the reported crash.
    if (propSchema.type === 'array' && propSchema.items && Array.isArray(value[key])) {
      for (const [i, element] of value[key].entries()) {
        const itemTypes = permittedTypes(propSchema.items);
        if (itemTypes.length > 0 && !itemTypes.some((t) => matchesJsonType(element, t))) {
          return `${at}${key}[${i}] must be ${itemTypes.join(' or ')}`;
        }
        if (element !== null && typeof element === 'object') {
          const nested = checkAgainstFragment(element, propSchema.items, `${at}${key}[${i}].`);
          if (nested) return nested;
        }
      }
    }
  }
  return null;
}

/**
 * Returns an error string for a malformed record, or null.
 *
 * Ajv when available; otherwise the schema-derived structural floor above.
 * A missing or unparseable schema is an ERROR, not a pass: without it neither
 * path can say what a valid record is, and returning null there would mean
 * "valid" — silently disabling the check this module exists to perform.
 */
export async function validateRecordShape(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return 'record must be a JSON object';
  }

  const validate = await getSchemaValidator();
  if (validate) {
    if (validate(data)) return null;
    const err = validate.errors?.[0];
    return `schema-invalid: ${err ? `${err.instancePath || '(root)'} ${err.message}` : 'unknown validation error'}`;
  }

  const schema = await readSchema();
  if (!schema) {
    return `cannot read ${path.basename(SCHEMA_PATH)} — unable to validate this record. `
      + 'The schema ships with the framework; a missing or unparseable copy means a broken sync, not an optional file.';
  }
  return checkAgainstFragment(data, schema, '');
}
