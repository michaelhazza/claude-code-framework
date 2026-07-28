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
  // "Function not found" is a HARNESS failure, not a refusal by the function
  // under test. Returned as an ordinary { ok: false } it satisfied every
  // assertion below that only checks `.ok === false`, so deleting the resolver
  // outright would still have left part of this suite green.
  if (line.startsWith('ERR::function Resolve-DistroWorkDir not found')) {
    throw new Error(
      'harness failure: Resolve-DistroWorkDir could not be extracted from install-runner.ps1 — ' +
        'the function is missing or renamed, so nothing below tested the real resolver.'
    );
  }
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

  // Changed 2026-07-28 (adversarial review, finding 7). This previously
  // asserted that a bare `~` resolves to the home directory — encoding the
  // hazard as the contract. The install path untars the runner over this
  // directory and -Uninstall/-Repair run `rm -rf` on it, so accepting `~`
  // meant `-WorkDir ~` would unpack across $HOME and later delete it wholesale.
  it('fails closed on a bare ~ rather than targeting the home directory itself', () => {
    const r = resolveWorkDir('~', '/home/mike');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/home directory/);
  });

  it('rejects the filesystem root', () => {
    expect(resolveWorkDir('/', '/home/mike').ok).toBe(false);
  });

  it('rejects a path on the Windows filesystem (/mnt/*), the generalised C22 trap', () => {
    const r = resolveWorkDir('/mnt/c/files/Claude/automation-v1', '/home/mike');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Windows filesystem/);
    expect(resolveWorkDir('/mnt', '/home/mike').ok).toBe(false);
  });

  it('still accepts a normal dedicated subdirectory of home', () => {
    expect(resolveWorkDir('~/actions-runner/owner-repo', '/home/mike')).toEqual({
      ok: true,
      value: '/home/mike/actions-runner/owner-repo',
    });
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

  // Added 2026-07-28 (dual-reviewer). The floor below the resolver is a set of
  // STRING comparisons, so it only ever saw the spelling it was handed and any
  // alternative spelling of the same directory walked straight through it.
  describe('the floor compares paths, not spellings', () => {
    it('refuses `~//`, which resolved to "$HOME/" and compared unequal to $HOME', () => {
      const r = resolveWorkDir('~//', '/home/mike');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/home directory/);
    });

    it('refuses `~/./`, the same escape by another spelling', () => {
      const r = resolveWorkDir('~/./', '/home/mike');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/home directory/);
    });

    it('refuses a `..` segment rather than resolving it — it defeats the /mnt and home refusals', () => {
      const r = resolveWorkDir('/home/mike/x/../../../mnt/c/files/repo', '/home/mike');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/'\.\.' segment/);
    });

    it('refuses a `..` segment behind a tilde too', () => {
      expect(resolveWorkDir('~/actions-runner/../../../mnt/c', '/home/mike').ok).toBe(false);
    });

    it('still accepts a legitimate path that is merely spelled untidily', () => {
      expect(resolveWorkDir('~/actions-runner//owner-repo/./', '/home/mike')).toEqual({
        ok: true,
        value: '/home/mike/actions-runner/owner-repo',
      });
    });

    it('matches the home directory through an untidy home spelling', () => {
      expect(resolveWorkDir('~', '/home/mike//').ok).toBe(false);
    });
  });
});

/**
 * Extracts an arbitrary single function from the real .ps1 and calls it with
 * one named string argument, the same way resolveWorkDir() does.
 *
 * The argument travels as base64 rather than as a quoted literal: the values
 * under test here deliberately CONTAIN quote characters, and JS and PowerShell
 * do not share a string-escaping convention (PowerShell escapes a double quote
 * inside a double-quoted string as `" or "", never as \"). base64 is
 * [A-Za-z0-9+/=] only, so it needs no escaping in either language.
 */
function callSingleArgFunction(fnName, paramName, value) {
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  const ps = `
$ErrorActionPreference = 'Stop'
$src = Get-Content -LiteralPath ${JSON.stringify(SCRIPT)} -Raw
$ast = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$null)
$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq ${JSON.stringify(fnName)} }, $true)
if (-not $fn) { Write-Output 'HARNESS::function not found'; exit 0 }
. ([scriptblock]::Create($fn.Extent.Text))
$argValue = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
try {
  $out = & ${JSON.stringify(fnName)} -${paramName} $argValue
  Write-Output "OK::$out"
} catch {
  Write-Output "ERR::$($_.Exception.Message)"
}
`;
  const res = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  const line = (res.stdout || '').split(/\r?\n/).find((l) => l.startsWith('OK::') || l.startsWith('ERR::') || l.startsWith('HARNESS::'));
  if (!line) throw new Error(`no verdict from PowerShell. stdout=${res.stdout} stderr=${res.stderr}`);
  if (line.startsWith('HARNESS::')) throw new Error(`harness failure: ${line.slice(9)} (${fnName})`);
  return line.startsWith('OK::') ? { ok: true, value: line.slice(4) } : { ok: false, message: line.slice(5) };
}

// Added 2026-07-28 (dual-reviewer). Windows PowerShell re-escapes embedded
// double quotes while marshalling arguments to a native executable, so a
// `bash -lc` payload containing one does not reach bash intact. Demonstrated
// against the live distro: the 15-char payload  printf %s 'A"B'  made bash
// exit 2 with "unexpected EOF while looking for matching `'". Silently
// shipping a corrupted command is the worst outcome for the function whose
// entire job is making operator-controlled values safe to interpolate.
describe.skipIf(!PS)('ConvertTo-BashSingleQuoted (executed from the real .ps1)', () => {
  it('still single-quotes an ordinary value', () => {
    expect(callSingleArgFunction('ConvertTo-BashSingleQuoted', 'Value', '/home/mike/actions-runner')).toEqual({
      ok: true,
      value: "'/home/mike/actions-runner'",
    });
  });

  it("escapes an embedded single quote rather than breaking out of the literal", () => {
    const r = callSingleArgFunction('ConvertTo-BashSingleQuoted', 'Value', "it's");
    expect(r.ok).toBe(true);
    expect(r.value).toBe("'it'\\''s'");
  });

  it('refuses a value containing a double quote instead of emitting a corrupted payload', () => {
    const r = callSingleArgFunction('ConvertTo-BashSingleQuoted', 'Value', 'A"B');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/double quote/);
  });
});

describe('install-runner.ps1 source invariants', () => {
  it('no bash payload in this file contains a double quote', () => {
    // The constraint documented on Invoke-WslBash. Payloads are the strings
    // passed as -Command, whether inline or via a *Cmd/$probe/$setup variable,
    // so check both shapes. A double quote here would be silently rewritten in
    // transit and bash would parse something other than what is written.
    // A backtick-escaped quote counts: PowerShell's `" produces a literal
    // double quote at runtime, so a payload written as "printf `"%s`" foo"
    // carries the exact characters this invariant forbids. An earlier version
    // of this test skipped them and would have passed such a payload.
    const offenders = [];
    for (const m of SOURCE.matchAll(/-Command\s+'([^']*)'/g)) {
      if (m[1].includes('"')) offenders.push(`inline single-quoted -Command payload: ${m[1].slice(0, 80)}`);
    }
    for (const m of SOURCE.matchAll(/-Command\s+"((?:`.|[^"])*)"/g)) {
      if (/`?"/.test(m[1])) offenders.push(`inline double-quoted -Command payload: ${m[1].slice(0, 80)}`);
    }
    for (const m of SOURCE.matchAll(/\$(?:\w*[Cc]md|probe|setup)\s*=\s*"((?:`.|[^"])*)"/g)) {
      if (/`?"/.test(m[1])) offenders.push(`payload variable: ${m[1].slice(0, 80)}`);
    }
    for (const m of SOURCE.matchAll(/\$(?:\w*[Cc]md|probe|setup)\s*=\s*'([^']*)'/g)) {
      if (m[1].includes('"')) offenders.push(`payload variable (single-quoted): ${m[1].slice(0, 80)}`);
    }
    expect(offenders).toEqual([]);
  });

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

  // Added 2026-07-28 (dual-reviewer). The four invariants below cover fixes
  // whose behaviour needs a live WSL2 distro to exercise, which this suite
  // deliberately does not require. They are source-level rather than
  // behavioural, but each one fails on a revert of the fix it guards, which is
  // exactly what was missing.
  it('the pre-delete assertion does not look for .runner, which config.sh remove deletes', () => {
    const fnAt = SOURCE.indexOf('function Assert-RunnerWorkDirBeforeDelete');
    expect(fnAt).toBeGreaterThan(-1);
    const body = SOURCE.slice(fnAt, SOURCE.indexOf('\n}', fnAt));
    // Both callers run `config.sh remove` immediately before this, and that
    // deletes the settings file, so asserting on it refused every successful
    // uninstall and repair.
    expect(body).not.toContain('/.runner');
    expect(body).toContain('/config.sh');
    expect(body).toContain('/run.sh');
  });

  it('the removal path skips the install-only preconditions', () => {
    const mainAt = SOURCE.indexOf('# -- Main ---');
    const main = SOURCE.slice(mainAt);
    // Requiring Docker, systemd or a private-repo check before an -Uninstall
    // blocked cleanup in exactly the degraded states that make cleanup
    // necessary.
    expect(main).toContain('-RemovalMode:$Uninstall');
    expect(main).toMatch(/if \(\$Uninstall\)[\s\S]{0,900}Show-DeepPreconditions/);
  });

  it('canonicalises the work dir against the distro before trusting the lexical floor', () => {
    const mainAt = SOURCE.indexOf('# -- Main ---');
    const main = SOURCE.slice(mainAt);
    const resolveAt = main.indexOf('$WorkDir = Resolve-DistroWorkDir');
    const assertAt = main.indexOf('Assert-WorkDirCanonicalWithinFloor');
    // A symlink into /mnt passes every lexical refusal; the canonical check has
    // to run after the resolver and before anything touches the path.
    expect(assertAt).toBeGreaterThan(resolveAt);
    expect(main.indexOf('Get-ExistingRunnerConfig')).toBeGreaterThan(assertAt);
  });

  it('reads the PHYSICAL distro home, without a double-quoted bash payload', () => {
    const fnAt = SOURCE.indexOf('function Get-DistroHome');
    const body = SOURCE.slice(fnAt, SOURCE.indexOf('\n}', fnAt));
    // `printf %s "$HOME"` cannot survive the argv hop (see the payload
    // invariant above), and dropping the quotes would word-split a home
    // directory containing a space. Scoped to the -Command payload: the
    // surrounding comment names $HOME deliberately.
    const payloads = [...body.matchAll(/-Command\s+(['"])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
    expect(payloads.length, 'Get-DistroHome must issue exactly one payload').toBe(1);
    expect(payloads[0]).not.toContain('$HOME');
    // `-P` is load-bearing, not cosmetic: plain `pwd` prints the LOGICAL path,
    // so where /home is itself a symlink the home directory would compare
    // unequal to itself and the floor's "refuse the home directory" check
    // would let -WorkDir target it — to be untarred over and later rm -rf'd.
    expect(payloads[0]).toBe('cd ~ && pwd -P');
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
