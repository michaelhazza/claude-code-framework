import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const FRAMEWORK_ROOT = path.resolve(__dirname, '../');
const SYNC_JS = path.join(FRAMEWORK_ROOT, 'sync.js');
const CANONICAL_VERSION = fs
  .readFileSync(path.join(FRAMEWORK_ROOT, '.claude', 'FRAMEWORK_VERSION'), 'utf8')
  .trim();

function uuid() { return crypto.randomUUID(); }

function runSync(targetRoot: string, args: string[] = []): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('node', [SYNC_JS, ...args], {
    cwd: targetRoot,
    // GIT_DIR set to a non-existent path so git commands fail gracefully,
    // triggering synthetic-test mode in checkSubmoduleClean (returns clean=true).
    env: { ...process.env, GIT_DIR: '/nonexistent-for-test' },
    encoding: 'utf8',
    timeout: 30000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status ?? 1,
  };
}

function buildMinimalState(overrides: Partial<any> = {}): any {
  return {
    frameworkVersion: '2.1.0',
    adoptedAt: new Date().toISOString(),
    adoptedFromCommit: null,
    profile: 'STANDARD',
    substitutions: {
      PROJECT_NAME: 'Test Project',
      PROJECT_DESCRIPTION: 'a test project',
      STACK_DESCRIPTION: 'Node.js',
      COMPANY_NAME: 'Test Co',
    },
    lastSubstitutionHash: '',
    files: {},
    syncIgnore: [],
    ...overrides,
  };
}

async function writeState(targetRoot: string, state: any): Promise<void> {
  await fsp.mkdir(path.join(targetRoot, '.claude'), { recursive: true });
  await fsp.writeFile(
    path.join(targetRoot, '.claude', '.framework-state.json'),
    JSON.stringify(state, null, 2) + '\n',
    'utf8'
  );
}

async function readState(targetRoot: string): Promise<any> {
  const content = await fsp.readFile(
    path.join(targetRoot, '.claude', '.framework-state.json'),
    'utf8'
  );
  return JSON.parse(content);
}

// ---------------------------------------------------------------------------
// Test 1: customised file gets .framework-new, target untouched
// ---------------------------------------------------------------------------

test('e2e-merge: customised file gets .framework-new, target untouched', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-e2e-merge-${uuid()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    // Set up via --adopt
    const initialState = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, initialState);
    const adoptResult = runSync(tmpDir, ['--adopt']);
    assert.equal(adoptResult.status, 0, `--adopt failed: ${adoptResult.stderr}`);

    // Pick a sync-mode agent file to "customise"
    const agentsDir = path.join(tmpDir, '.claude', 'agents');
    const agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
    assert.ok(agentFiles.length > 0, 'need agent files');
    const testFile = agentFiles[0];
    const testPath = `.claude/agents/${testFile}`;
    const fullPath = path.join(tmpDir, testPath);

    // Record original content
    const originalContent = await fsp.readFile(fullPath, 'utf8');

    // "Customise" the file (append a project-specific note)
    const customisedContent = originalContent + '\n<!-- PROJECT-SPECIFIC CUSTOMISATION -->\n';
    await fsp.writeFile(fullPath, customisedContent, 'utf8');

    // Downgrade state to trigger sync
    const state = await readState(tmpDir);
    state.frameworkVersion = '2.1.0';
    await writeState(tmpDir, state);

    // Run sync
    const syncResult = runSync(tmpDir);
    assert.equal(syncResult.status, 0, `sync failed: ${syncResult.stderr}`);

    // Assert: target file unchanged (still has customisation)
    const afterSyncContent = await fsp.readFile(fullPath, 'utf8');
    assert.ok(afterSyncContent.includes('PROJECT-SPECIFIC CUSTOMISATION'),
      'customised content should be preserved in target file');

    // Assert: .framework-new was written
    const newFilePath = `${fullPath}.framework-new`;
    assert.ok(fs.existsSync(newFilePath), `.framework-new should exist at ${newFilePath}`);

    // Assert: state marks customisedLocally = true
    const newState = await readState(tmpDir);
    assert.equal(newState.files[testPath]?.customisedLocally, true,
      'state should mark file as customisedLocally');

    // Assert: status=customised in stdout
    assert.ok(syncResult.stdout.includes('status=customised'), 'should log status=customised');

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2: startup check blocks next sync when .framework-new unresolved
// ---------------------------------------------------------------------------

test('e2e-merge: startup check blocks next sync when .framework-new unresolved', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-e2e-merge2-${uuid()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    // Set up and adopt
    const initialState = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, initialState);
    const adoptResult = runSync(tmpDir, ['--adopt']);
    assert.equal(adoptResult.status, 0, `--adopt failed: ${adoptResult.stderr}`);

    // Pick a file to customise
    const agentsDir = path.join(tmpDir, '.claude', 'agents');
    const testFile = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'))[0];
    const fullPath = path.join(agentsDir, testFile);
    const original = await fsp.readFile(fullPath, 'utf8');
    await fsp.writeFile(fullPath, original + '\n<!-- CUSTOM -->\n', 'utf8');

    // Downgrade state to trigger sync (creates .framework-new)
    const state = await readState(tmpDir);
    state.frameworkVersion = '2.1.0';
    await writeState(tmpDir, state);

    // First sync creates .framework-new and updates state.frameworkVersion to 2.2.0
    runSync(tmpDir);
    const newFilePath = `${fullPath}.framework-new`;
    assert.ok(fs.existsSync(newFilePath), '.framework-new should exist');

    // Downgrade state.frameworkVersion again so the "already on latest" short-circuit
    // does not fire before the unresolved-merge scan
    const stateAfterFirstSync = await readState(tmpDir);
    stateAfterFirstSync.frameworkVersion = '2.1.0';
    await writeState(tmpDir, stateAfterFirstSync);

    // Next sync without --force should exit 1 (unresolved merge)
    const blockedResult = runSync(tmpDir);
    assert.equal(blockedResult.status, 1, 'sync should exit 1 when .framework-new unresolved');
    assert.ok(blockedResult.stderr.includes('unresolved'), 'stderr should mention unresolved');

    // With --force should proceed
    const forcedResult = runSync(tmpDir, ['--force']);
    assert.equal(forcedResult.status, 0, `--force sync should proceed: ${forcedResult.stderr}`);

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 3: after manual merge + re-run sync, --doctor detects case(b)
// ---------------------------------------------------------------------------

test('e2e-merge: after manual merge + re-run sync, --doctor detects case(b)', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-e2e-merge3-${uuid()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    // Set up, customise, run sync (creates .framework-new)
    const initialState = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, initialState);
    runSync(tmpDir, ['--adopt']);

    const agentsDir = path.join(tmpDir, '.claude', 'agents');
    const testFile = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'))[0];
    const testPath = `.claude/agents/${testFile}`;
    const fullPath = path.join(agentsDir, testFile);
    const original = await fsp.readFile(fullPath, 'utf8');
    await fsp.writeFile(fullPath, original + '\n<!-- CUSTOM -->\n', 'utf8');

    // Downgrade state so sync runs and detects customisation
    const state = await readState(tmpDir);
    state.frameworkVersion = '2.1.0';
    await writeState(tmpDir, state);
    runSync(tmpDir); // creates .framework-new

    const newFilePath = `${fullPath}.framework-new`;
    assert.ok(fs.existsSync(newFilePath), '.framework-new should exist');

    // Simulate operator manual merge: write merged content to target, delete .framework-new
    const mergedContent = original + '\n<!-- CUSTOM KEPT -->\n';
    await fsp.writeFile(fullPath, mergedContent, 'utf8');
    await fsp.unlink(newFilePath);

    // Run --doctor: should detect case(b) (hash mismatch, no .framework-new)
    const doctorResult = runSync(tmpDir, ['--doctor']);
    assert.equal(doctorResult.status, 1, 'doctor should report anomaly');
    assert.ok(doctorResult.stderr.includes('case(b)'), 'doctor should report case(b)');

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 4: same-version maintenance run rebaselines a resolved merge
// (no hand-rewind of state.frameworkVersion — this is the SYNC.md Phase 5
// step 6 / --doctor case(b) flow that previously dead-ended on the
// "already on latest" early exit)
// ---------------------------------------------------------------------------

test('e2e-merge: maintenance run rebaselines resolved .framework-new without state rewind', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-e2e-merge4-${uuid()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    // Adopt, customise a file, and run an upgrade sync (single initial rewind
    // simulates being on an older framework version — the objectionable part
    // was the SECOND rewind needed after the upgrade completed).
    const initialState = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, initialState);
    runSync(tmpDir, ['--adopt']);

    const agentsDir = path.join(tmpDir, '.claude', 'agents');
    const testFile = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'))[0];
    const testPath = `.claude/agents/${testFile}`;
    const fullPath = path.join(agentsDir, testFile);
    const original = await fsp.readFile(fullPath, 'utf8');
    await fsp.writeFile(fullPath, original + '\n<!-- CUSTOM -->\n', 'utf8');

    const state = await readState(tmpDir);
    state.frameworkVersion = '2.1.0';
    await writeState(tmpDir, state);
    runSync(tmpDir); // upgrade run: writes .framework-new, bumps state to canonical

    const stateAfterUpgrade = await readState(tmpDir);
    assert.equal(stateAfterUpgrade.frameworkVersion, CANONICAL_VERSION,
      'upgrade run should have bumped state to the canonical version');
    const newFilePath = `${fullPath}.framework-new`;
    assert.ok(fs.existsSync(newFilePath), '.framework-new should exist');
    assert.equal(stateAfterUpgrade.files[testPath]?.customisedLocally, true);

    // Operator resolves the merge: writes merged content, deletes .framework-new.
    const mergedContent = original + '\n<!-- CUSTOM KEPT AFTER MERGE -->\n';
    await fsp.writeFile(fullPath, mergedContent, 'utf8');
    await fsp.unlink(newFilePath);

    // Re-run sync at the SAME version — no rewind. Must rebaseline, not no-op.
    const maintResult = runSync(tmpDir);
    assert.equal(maintResult.status, 0, `maintenance sync failed: ${maintResult.stderr}`);
    assert.ok(maintResult.stdout.includes('status=rebaselined'),
      `maintenance run should log status=rebaselined, got:\n${maintResult.stdout}`);
    assert.ok(!maintResult.stdout.includes('--- Changelog'),
      'maintenance run must not print a changelog excerpt');

    // State: hash rebaselined to the merged content, customisedLocally cleared,
    // version unchanged.
    const finalState = await readState(tmpDir);
    const entry = finalState.files[testPath];
    assert.equal(entry.customisedLocally, false, 'customisedLocally should be cleared');
    assert.equal(finalState.frameworkVersion, CANONICAL_VERSION, 'no version change');
    const crypto2 = await import('node:crypto');
    const normalised = mergedContent
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      .split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n')
      .replace(/\n+$/, '') + '\n';
    const expectedHash = crypto2.createHash('sha256').update(normalised, 'utf8').digest('hex');
    assert.equal(entry.lastAppliedHash, expectedHash, 'lastAppliedHash should match merged content');

    // Target file untouched by the maintenance pass.
    const afterMaint = await fsp.readFile(fullPath, 'utf8');
    assert.ok(afterMaint.includes('CUSTOM KEPT AFTER MERGE'), 'merged content preserved');

    // --doctor now reports no case(b) anomaly.
    const doctorResult = runSync(tmpDir, ['--doctor']);
    assert.equal(doctorResult.status, 0, `doctor should be clean after rebaseline: ${doctorResult.stderr}`);

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 5: same-version run still blocks on an UNRESOLVED .framework-new
// (no state rewind needed — the early exit used to skip this blocker)
// ---------------------------------------------------------------------------

test('e2e-merge: maintenance run blocks on unresolved .framework-new without state rewind', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-e2e-merge5-${uuid()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    const initialState = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, initialState);
    runSync(tmpDir, ['--adopt']);

    const agentsDir = path.join(tmpDir, '.claude', 'agents');
    const testFile = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'))[0];
    const fullPath = path.join(agentsDir, testFile);
    const original = await fsp.readFile(fullPath, 'utf8');
    await fsp.writeFile(fullPath, original + '\n<!-- CUSTOM -->\n', 'utf8');

    const state = await readState(tmpDir);
    state.frameworkVersion = '2.1.0';
    await writeState(tmpDir, state);
    runSync(tmpDir); // upgrade run: writes .framework-new, state now at canonical

    assert.ok(fs.existsSync(`${fullPath}.framework-new`), '.framework-new should exist');

    // Re-run at the same version WITHOUT rewinding state: must exit 1 on the
    // unresolved merge instead of silently early-exiting "already on latest".
    const blockedResult = runSync(tmpDir);
    assert.equal(blockedResult.status, 1, 'same-version sync should exit 1 when .framework-new unresolved');
    assert.ok(blockedResult.stderr.includes('unresolved'), 'stderr should mention unresolved');

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 6: still-customised files are surfaced (not absorbed) on maintenance runs
// ---------------------------------------------------------------------------

test('e2e-merge: maintenance run surfaces locally-edited files without rebaselining them', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-e2e-merge6-${uuid()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    const initialState = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, initialState);
    runSync(tmpDir, ['--adopt']);

    // Local edit AFTER adoption, with no merge in flight (customisedLocally=false).
    const agentsDir = path.join(tmpDir, '.claude', 'agents');
    const testFile = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'))[0];
    const testPath = `.claude/agents/${testFile}`;
    const fullPath = path.join(agentsDir, testFile);
    const original = await fsp.readFile(fullPath, 'utf8');
    await fsp.writeFile(fullPath, original + '\n<!-- OPERATOR EDIT -->\n', 'utf8');

    const stateBefore = await readState(tmpDir);
    const hashBefore = stateBefore.files[testPath].lastAppliedHash;

    // Same-version run: file must be surfaced as customised, hash NOT absorbed,
    // and no .framework-new written (there is nothing new to merge).
    const maintResult = runSync(tmpDir);
    assert.equal(maintResult.status, 0, `maintenance sync failed: ${maintResult.stderr}`);
    assert.ok(maintResult.stderr.includes(testPath), 'divergent file should be surfaced on stderr');
    assert.ok(!fs.existsSync(`${fullPath}.framework-new`), 'no .framework-new on maintenance runs');

    const stateAfter = await readState(tmpDir);
    assert.equal(stateAfter.files[testPath].lastAppliedHash, hashBefore,
      'local edit must NOT be silently absorbed into the baseline');

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 7: malformed consumer settings.json aborts the run (exit 1, no write)
// ---------------------------------------------------------------------------

test('e2e-merge: malformed consumer settings.json aborts sync with exit 1 and no write', async () => {
  const tmpDir = path.join(os.tmpdir(), `sync-e2e-merge7-${uuid()}`);
  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    const initialState = buildMinimalState({ frameworkVersion: '0.0.0', files: {} });
    await writeState(tmpDir, initialState);
    runSync(tmpDir, ['--adopt']);

    // Corrupt the consumer's settings.json.
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const malformed = '{ "hooks": { broken json\n';
    await fsp.writeFile(settingsPath, malformed, 'utf8');

    // Rewind so a full (upgrade) sync runs the settings-merge path.
    const state = await readState(tmpDir);
    state.frameworkVersion = '2.1.0';
    await writeState(tmpDir, state);

    // --dry-run must also report the error (exit 1).
    const dryResult = runSync(tmpDir, ['--dry-run']);
    assert.equal(dryResult.status, 1, 'dry-run should exit 1 on malformed settings.json');
    assert.ok(dryResult.stderr.includes('not valid JSON'), `stderr should explain: ${dryResult.stderr}`);

    // Real run: exit 1, no state write, settings.json untouched.
    const syncResult = runSync(tmpDir);
    assert.equal(syncResult.status, 1, 'sync should exit 1 on malformed settings.json');
    assert.ok(syncResult.stderr.includes('not valid JSON'), `stderr should explain: ${syncResult.stderr}`);

    const afterContent = await fsp.readFile(settingsPath, 'utf8');
    assert.equal(afterContent, malformed, 'malformed settings.json must not be overwritten');

    const stateAfter = await readState(tmpDir);
    assert.equal(stateAfter.frameworkVersion, '2.1.0',
      'aborted run must not advance state.frameworkVersion');

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
