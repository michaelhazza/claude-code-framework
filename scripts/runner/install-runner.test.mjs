/**
 * install-runner.test.mjs
 *
 * Vitest regression suite for scripts/runner/install-runner.ps1 (dev-pipeline-v2
 * Chunk 14, hardened after the Chunk 22 spike).
 *
 * The defect this file exists to prevent: `$WorkDir` defaulted to
 * `~/actions-runner/<slug>` and was then single-quoted into every `bash -lc`
 * payload (the injection defence). Bash does not expand `~` inside single
 * quotes, so `mkdir -p '~/actions-runner/...'` created a LITERAL directory
 * named `~` relative to bash's CWD -- which, for wsl.exe launched from a
 * Windows directory, is that directory under /mnt/c. A live spike installed
 * 666 MB of runner into the pilot repo's working tree, where the runner's own
 * symlinks then broke `git add -A`. `-WhatIf` could not catch it: the preview
 * prints the unexpanded string, which looks correct.
 *
 * Behavioural tests below execute the REAL Resolve-DistroWorkDir function by
 * extracting it from the .ps1 via PowerShell's own parser (AST) and invoking
 * it -- so the logic under test is the shipped logic, not a copy. Source
 * invariants cover the wiring that a pure-function test cannot see: that the
 * resolver is actually called before any payload interpolation, and that the
 * file stays ASCII-only.
 *
 * Skips (never fails) when no PowerShell host is available, so the suite stays
 * green on Linux CI runners; the source-invariant tests run everywhere.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'install-runner.ps1');
const SOURCE = fs.readFileSync(SCRIPT, 'utf8');

/** First PowerShell host on PATH, or null when none is usable. */
function findPowerShell() {
  for (const exe of ['pwsh', 'powershell']) {
    const probe = spawnSync(exe, ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return exe;
  }
  return null;
}

const PS = findPowerShell();

/**
 * Extracts Resolve-DistroWorkDir from the real .ps1 using the PowerShell
 * parser, defines it in a clean session, and calls it. Returns either the
 * resolved path or the thrown message -- exactly what an operator would hit.
 */
function resolveWorkDir(inputPath, homeDir) {
  const ps = `
$ErrorActionPreference = 'Stop'
$src = Get-Content -LiteralPath ${JSON.stringify(SCRIPT)} -Raw
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$null)
$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Resolve-DistroWorkDir' }, $true)
if (-not $fn) { Write-Output 'ERR::function Resolve-DistroWorkDir not found'; exit 0 }
. ([scriptblock]::Create($fn.Extent.Text))
try {
  $out = Resolve-DistroWorkDir -Path ${JSON.stringify(inputPath)} -HomeDir ${JSON.stringify(homeDir)}
  Write-Output "OK::$out"
} catch {
  Write-Output "ERR::$($_.Exception.Message)"
}
`;
  const res = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  const line = (res.stdout || '').split(/\r?\n/).find((l) => l.startsWith('OK::') || l.startsWith('ERR::'));
  if (!line) throw new Error(`no verdict from PowerShell. stdout=${res.stdout} stderr=${res.stderr}`);
  return line.startsWith('OK::')
    ? { ok: true, value: line.slice(4) }
    : { ok: false, message: line.slice(5) };
}

describe.skipIf(!PS)('Resolve-DistroWorkDir (executed from the real .ps1)', () => {
  it('expands a leading ~/ against the distro home -- the defect that shipped', () => {
    const r = resolveWorkDir('~/actions-runner/michaelhazza-automation-v1', '/home/mike');
    expect(r).toEqual({ ok: true, value: '/home/mike/actions-runner/michaelhazza-automation-v1' });
  });

  it('never returns a path that still contains a tilde', () => {
    const r = resolveWorkDir('~/actions-runner/x', '/home/mike');
    expect(r.ok).toBe(true);
    expect(r.value).not.toContain('~');
  });

  it('resolves a bare ~ to the home directory itself', () => {
    expect(resolveWorkDir('~', '/home/mike')).toEqual({ ok: true, value: '/home/mike' });
  });

  it('passes absolute paths through unchanged', () => {
    expect(resolveWorkDir('/opt/runner', '/home/mike')).toEqual({ ok: true, value: '/opt/runner' });
  });

  it('does not double up separators when home has a trailing slash', () => {
    expect(resolveWorkDir('~/actions-runner', '/home/mike/')).toEqual({
      ok: true,
      value: '/home/mike/actions-runner',
    });
  });

  it('fails closed on a relative path rather than landing it under /mnt/c', () => {
    const r = resolveWorkDir('actions-runner/foo', '/home/mike');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/mnt\/c/);
    expect(r.message).toMatch(/repo working tree/);
  });

  it('fails closed on a ~user form it cannot resolve', () => {
    expect(resolveWorkDir('~root/actions-runner', '/home/mike').ok).toBe(false);
  });

  it('rejects a non-absolute home directory instead of building a bad path', () => {
    const r = resolveWorkDir('~/actions-runner', 'home/mike');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not absolute/);
  });
});

describe('install-runner.ps1 source invariants', () => {
  it('resolves the work dir before the main flow hands it to any function', () => {
    // The functions that quote $WorkDir into a bash payload are DEFINED above
    // the main flow but EXECUTE from it, so textual order across the whole
    // file proves nothing. The real invariant is scoped to the main flow: the
    // resolver must run before the first call that passes $WorkDir down.
    // Inside the functions $WorkDir is their own (already-resolved) parameter.
    const mainAt = SOURCE.indexOf('# -- Main ---');
    expect(mainAt, 'main-flow banner must exist').toBeGreaterThan(-1);
    const main = SOURCE.slice(mainAt);

    const resolveAt = main.indexOf('$WorkDir = Resolve-DistroWorkDir');
    expect(resolveAt, 'main flow must reassign $WorkDir through the resolver').toBeGreaterThan(-1);

    const handOffs = [...main.matchAll(/-WorkDir\s+\$WorkDir/g)].map((m) => m.index);
    expect(handOffs.length, 'main flow must pass $WorkDir to the worker functions').toBeGreaterThan(0);
    for (const at of handOffs) {
      expect(at, 'main flow passes $WorkDir onward before resolving it').toBeGreaterThan(resolveAt);
    }
  });

  it('quotes $WorkDir into bash payloads only from inside the worker functions', () => {
    // Guards the other half: if a future edit interpolates $WorkDir directly
    // in the main flow it would bypass the parameter path this file relies on.
    const mainAt = SOURCE.indexOf('# -- Main ---');
    const main = SOURCE.slice(mainAt);
    const resolveAt = main.indexOf('$WorkDir = Resolve-DistroWorkDir');
    for (const m of main.matchAll(/ConvertTo-BashSingleQuoted\s+"?\$WorkDir/g)) {
      expect(m.index, 'unresolved $WorkDir quoted into a payload').toBeGreaterThan(resolveAt);
    }
  });

  it('keeps the resolver after the -WhatIf early exit so a preview never boots the VM', () => {
    // Get-DistroHome starts the WSL2 VM; -WhatIf documents that it does not.
    const whatIfExit = SOURCE.indexOf('if ($WhatIfPreference)');
    expect(whatIfExit).toBeGreaterThan(-1);
    expect(SOURCE.indexOf('Get-DistroHome -Distro')).toBeGreaterThan(whatIfExit);
  });

  it('stays ASCII-only (Chunk 14 constraint -- PS 5.1 reads it without a BOM)', () => {
    const offenders = [];
    for (let i = 0; i < SOURCE.length; i += 1) {
      if (SOURCE.charCodeAt(i) > 127) {
        offenders.push(`index ${i}: ${JSON.stringify(SOURCE[i])}`);
        if (offenders.length >= 5) break;
      }
    }
    expect(offenders).toEqual([]);
  });

  it('parses under the PowerShell parser with no syntax errors', () => {
    if (!PS) return;
    const ps = `
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseInput(
  (Get-Content -LiteralPath ${JSON.stringify(SCRIPT)} -Raw), [ref]$null, [ref]$errors)
if ($errors -and $errors.Count -gt 0) { Write-Output "ERR::$($errors[0].Message)" } else { Write-Output 'OK::parsed' }
`;
    const res = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
    expect(res.stdout).toContain('OK::parsed');
  });
});
