import { describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const GATE = join(__dirname, '..', 'check-shipped-source.js');

/** Builds a minimal fake framework repo and runs the gate against it by
 *  copying the gate in (the gate resolves the repo root relative to its own
 *  location, so it must live inside the fixture's scripts/). */
function runGateOn(files: Record<string, string>, manifestPaths: string[]): { status: number | null; stdout: string } {
  const root = mkdtempSync(join(tmpdir(), 'shipped-source-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({ managedFiles: manifestPaths.map((path) => ({ path, category: 'test', mode: 'sync' })) }),
  );
  // Engine files the gate always expects.
  writeFileSync(join(root, 'sync.js'), 'import x from "y";\n');
  writeFileSync(join(root, 'scripts', 'run-migrations.js'), 'import x from "y";\n');
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  const gateSource = spawnSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(GATE)}, 'utf8'))`], { encoding: 'utf8' }).stdout;
  writeFileSync(join(root, 'scripts', 'check-shipped-source.js'), gateSource);
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-shipped-source.js'), '--json'], {
    encoding: 'utf8',
    cwd: root,
  });
  return { status: result.status, stdout: result.stdout };
}

describe('check-shipped-source gate', () => {
  test('passes on ESM .js, .cjs CommonJS, and CJS .js governed by a shipped commonjs package.json', () => {
    const { status, stdout } = runGateOn(
      {
        'hooks/esm-hook.js': 'import { x } from "./lib.js";\nexport const y = x;\n',
        'hooks/lib.js': 'export const x = 1;\n',
        'scripts/tool.cjs': 'const fs = require("fs");\nmodule.exports = fs;\n',
        'governed/package.json': '{"type": "commonjs"}\n',
        'governed/legacy.js': 'const fs = require("fs");\nmodule.exports = fs;\n',
      },
      ['hooks/*.js', 'scripts/tool.cjs', 'governed/*'],
    );
    const report = JSON.parse(stdout);
    expect(report.findings).toEqual([]);
    expect(status).toBe(0);
  });

  test('fails on an ungoverned CommonJS .js and on a module-typed subtree with CJS idioms', () => {
    const { status, stdout } = runGateOn(
      {
        'scripts/legacy-scanner.js': 'const fs = require("fs");\nmodule.exports = { fs };\n',
        'hooks/package.json': '{"type": "module"}\n',
        'hooks/bad-hook.js': 'const x = require("y");\n',
      },
      ['scripts/legacy-scanner.js', 'hooks/*'],
    );
    const report = JSON.parse(stdout);
    const files = report.findings.map((finding: { file: string }) => finding.file).sort();
    expect(files).toEqual(['hooks/bad-hook.js', 'scripts/legacy-scanner.js']);
    expect(report.findings.every((finding: { check: string }) => finding.check === 'module-system')).toBe(true);
    expect(status).toBe(1);
  });

  test('fails on a syntax error in a shipped file', () => {
    const { status, stdout } = runGateOn(
      { 'scripts/broken.cjs': 'const x = {;\n' },
      ['scripts/broken.cjs'],
    );
    const report = JSON.parse(stdout);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].check).toBe('parse');
    expect(report.findings[0].file).toBe('scripts/broken.cjs');
    expect(status).toBe(1);
  });

  test('catches non-declaration CommonJS forms (red tests for the bypass class)', () => {
    const bypasses: Record<string, string> = {
      'scripts/side-effect.js': 'require("./side-effect-module");\n',
      'scripts/lazy.js': 'function load() { return require("./lazy-module"); }\nload();\n',
      'scripts/main-guard.js': 'function main() {}\nif (require.main === module) main();\n',
      'scripts/dirname-user.js': 'console.log(__dirname);\n',
      'scripts/filename-user.js': 'const f = __filename;\nconsole.log(f);\n',
      'scripts/conditional.js': 'const enabled = true;\nif (enabled) require("./plugin");\n',
      'scripts/exports-assign.js': 'exports.helper = () => 1;\n',
    };
    for (const [file, content] of Object.entries(bypasses)) {
      const { status, stdout } = runGateOn({ [file]: content }, [file]);
      const report = JSON.parse(stdout);
      expect(report.findings.map((f: { file: string; check: string }) => [f.file, f.check]), `expected module-system finding for ${file}`).toEqual([[file, 'module-system']]);
      expect(status).toBe(1);
    }
  });

  test('mixed CommonJS + ESM idioms in one shipped .js still fails', () => {
    const { status, stdout } = runGateOn(
      { 'scripts/mixed.js': 'import { x } from "./x.js";\nconsole.log(__dirname, x);\n' },
      ['scripts/mixed.js'],
    );
    const report = JSON.parse(stdout);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].check).toBe('module-system');
    expect(report.findings[0].message).toContain('mixes CJS and ESM');
    expect(status).toBe(1);
  });

  test('CommonJS syntax inside comments and strings is NOT an idiom (masked)', () => {
    const { status, stdout } = runGateOn(
      {
        'scripts/prose-only.js':
          '// require("./x") is the old way\n'
          + '/* module.exports = {} used to live here */\n'
          + 'const doc = "call require(\'./x\') if on CJS";\n'
          + 'export const y = doc;\n',
      },
      ['scripts/prose-only.js'],
    );
    const report = JSON.parse(stdout);
    expect(report.findings).toEqual([]);
    expect(status).toBe(0);
  });
});
