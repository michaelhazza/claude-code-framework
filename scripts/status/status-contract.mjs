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
 * for a validation nicety. The floor deliberately covers the dereferences the
 * renderers actually perform, which are the crash vectors.
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

/** The status enum from the schema, or null when the schema cannot be read. */
export async function readStatusEnum() {
  try {
    const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
    return schema.properties?.status?.enum ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns an error string for a key-complete but malformed record, or null.
 * Schema-first, with a structural floor covering exactly the dereferences
 * buildCardBody / buildBody / compareRecords perform.
 */
export async function validateRecordShape(data) {
  const validate = await getSchemaValidator();
  if (validate) {
    if (validate(data)) return null;
    const err = validate.errors?.[0];
    return `schema-invalid: ${err ? `${err.instancePath || '(root)'} ${err.message}` : 'unknown validation error'}`;
  }
  if (!Array.isArray(data.blockers)) return 'blockers must be an array';
  if (typeof data.summary !== 'string') return 'summary must be a string';
  if (typeof data.updated_at !== 'string') return 'updated_at must be a string';
  if (typeof data.phase !== 'string') return 'phase must be a string';
  if (typeof data.status !== 'string') return 'status must be a string';
  if (typeof data.slug !== 'string') return 'slug must be a string';
  return null;
}
