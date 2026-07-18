/**
 * Tests for scripts/check-profiles.js - the profile/inventory reconciliation
 * gate. Runner: Vitest (per docs/testing-conventions.md).
 *
 * Every test builds a self-consistent fixture repo (agents / skills /
 * commands / hooks / manifest.json / README.md / ADAPT.md) in a temp dir,
 * then perturbs exactly one claim and asserts the gate reports it with the
 * right file, check id, and claimed/actual values. A clean fixture must pass;
 * a fixture whose anchors are missing must FAIL (exit 2), never pass.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseReadme, parseAdapt, collectGroundTruth, runGate } = require('../check-profiles.js');
const SCRIPT_PATH = require.resolve('../check-profiles.js');

// --------------------------------------------------------------------------
// fixture builder
// --------------------------------------------------------------------------

const tempRoots: string[] = [];
afterAll(() => {
  for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

interface Fixture {
  agents: string[];
  minimal: string[];
  standardExtras: string[];
  fullExtras: string[];
  leadSkills: string[];
  distilledSkills: string[];
  commands: string[];
  hooks: string[];
  // doc-claim overrides (default: consistent with disk)
  readme?: Partial<DocNumbers> & { hookNames?: string[]; fullExtras?: string[]; skipSkillsRow?: boolean };
  adapt?: Partial<DocNumbers> & { hookNames?: string[]; fullExtras?: string[]; skipSection12?: boolean };
  // ground-truth perturbations
  manifestSkills?: string[];
  manifestHooks?: string[];
  skillDirsWithoutSkillMd?: string[];
  strayAgentEntries?: boolean;
}

interface DocNumbers {
  agentCount: number;
  hookCount: number;
  skillCount: number;
  distilledCount: number;
  commandCount: number;
  minimalCount: number;
  standardCount: number;
  fullCount: number;
}

function ticks(names: string[]): string {
  return names.map((n) => '`' + n + '`').join(', ');
}

function defaults(): Fixture {
  const minimal = ['triage-agent', 'pr-reviewer'];
  const standardExtras = ['architect', 'builder'];
  const fullExtras = ['hotfix', 'spec-reviewer', 'validate-setup'];
  return {
    agents: [...minimal, ...standardExtras, ...fullExtras],
    minimal,
    standardExtras,
    fullExtras,
    leadSkills: ['grill-me', 'zoom-out'],
    distilledSkills: ['fail-loud', 'test-discipline', 'wire-it-through'],
    commands: ['claudeupdate', 'release'],
    hooks: ['correction-nudge', 'long-doc-guard', 'phase-lock'],
  };
}

function numbers(f: Fixture): DocNumbers {
  return {
    agentCount: f.agents.length,
    hookCount: f.hooks.length,
    skillCount: f.leadSkills.length + f.distilledSkills.length,
    distilledCount: f.distilledSkills.length,
    commandCount: f.commands.length,
    minimalCount: f.minimal.length,
    standardCount: f.minimal.length + f.standardExtras.length,
    fullCount: f.minimal.length + f.standardExtras.length + f.fullExtras.length,
  };
}

function renderReadme(f: Fixture): string {
  const n = { ...numbers(f), ...(f.readme ?? {}) };
  const hookNames = f.readme?.hookNames ?? f.hooks;
  const fullExtras = f.readme?.fullExtras ?? f.fullExtras;
  const skillsRow = f.readme?.skipSkillsRow
    ? ''
    : `| \`.claude/skills/\` | ${n.skillCount} portable skills: ${f.leadSkills.join(', ')}, and ${n.distilledCount} distilled-judgment skills (${f.distilledSkills.join(', ')}) |\n`;
  return (
    `# Fixture README\n\n## What ships\n\n` +
    `| Path | Contents |\n|------|----------|\n` +
    `| \`.claude/agents/\` | ${n.agentCount} agent definitions (with placeholders; \`_retired/\` excluded) |\n` +
    `| \`.claude/commands/\` | ${n.commandCount} operator commands: ${f.commands.map((c) => '`/' + c + '`').join(', ')} |\n` +
    `| \`.claude/hooks/\` | ${n.hookCount} portable hooks: ${ticks(hookNames)} |\n` +
    skillsRow +
    `\n## Profiles\n\n` +
    `- **MINIMAL (${n.minimalCount})** — ${ticks(f.minimal)}. Solo dev baseline.\n` +
    `- **STANDARD (${n.standardCount})** — MINIMAL + ${ticks(f.standardExtras)}. Default for most projects.\n` +
    `- **FULL (${n.fullCount})** — STANDARD + ${ticks(fullExtras)}. Large projects.\n`
  );
}

function renderAdapt(f: Fixture): string {
  const n = { ...numbers(f), ...(f.adapt ?? {}) };
  const hookNames = f.adapt?.hookNames ?? f.hooks;
  const fullExtras = f.adapt?.fullExtras ?? f.fullExtras;
  const section12 = f.adapt?.skipSection12
    ? ''
    : `## 12. Profile reference\n\n` +
      `### MINIMAL (${n.minimalCount} agents) — solo dev\n\n${ticks(f.minimal)}.\n\n` +
      `### STANDARD (${n.standardCount} agents) — small team\n\nMINIMAL ${n.minimalCount} plus: ${ticks(f.standardExtras)}.\n\n` +
      `### FULL (${n.fullCount} agents) — large project\n\nSTANDARD ${n.standardCount} plus: ${ticks(fullExtras)}.\n\n` +
      `Use when the project supports the overhead.\n`;
  return (
    `# ADAPT.md fixture\n\n## 1. What this bundle is\n\nThe framework ships:\n` +
    `- ${n.agentCount} agent definitions in \`.claude/agents/\` (with placeholders; \`_retired/\` is excluded)\n` +
    `- ${n.hookCount} portable hooks in \`.claude/hooks/\` (${ticks(hookNames)}) + a \`.claude/settings.json\` registering them\n\n` +
    `Plus the **profile selection**: MINIMAL (${n.minimalCount} agents) / STANDARD (${n.standardCount}) / FULL (${n.fullCount}). See section 12.\n\n` +
    `## 6. Phase 1.5\n\nAsk the operator: "Which profile? MINIMAL (${n.minimalCount}) / STANDARD (${n.standardCount}) / FULL (${n.fullCount})."\n\n` +
    `## 10. Phase 5 - Verify\n\n` +
    `1. \`ls .claude/agents/\` — count matches profile (${n.minimalCount} / ${n.standardCount} / ${n.fullCount}, excluding \`_retired/\`).\n` +
    `2. \`ls .claude/hooks/\` — ${n.hookCount} hook scripts present (plus their \`.test.js\` files and \`package.json\`).\n\n` +
    section12
  );
}

function renderManifest(f: Fixture): string {
  const skills = f.manifestSkills ?? [...f.leadSkills, ...f.distilledSkills];
  const hooks = f.manifestHooks ?? f.hooks;
  const managedFiles = [
    { path: '.claude/agents/*.md', category: 'agent', mode: 'sync' },
    { path: '.claude/commands/*.md', category: 'command', mode: 'sync' },
    { path: '.claude/hooks/package.json', category: 'hook', mode: 'sync' },
    ...hooks.map((h) => ({ path: `.claude/hooks/${h}.js`, category: 'hook', mode: 'sync' })),
    ...hooks.map((h) => ({ path: `.claude/hooks/${h}.test.js`, category: 'hook', mode: 'sync' })),
    ...skills.map((s) => ({ path: `.claude/skills/${s}/SKILL.md`, category: 'skill', mode: 'sync' })),
    { path: 'docs/decisions/0001-*.md', category: 'adr', mode: 'sync' },
  ];
  return JSON.stringify({ frameworkVersion: '0.0.0', managedFiles }, null, 2);
}

function buildFixture(overrides: Partial<Fixture> = {}): string {
  const f: Fixture = { ...defaults(), ...overrides };
  const root = mkdtempSync(join(tmpdir(), 'check-profiles-'));
  tempRoots.push(root);

  const agentsDir = join(root, '.claude', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const a of f.agents) writeFileSync(join(agentsDir, `${a}.md`), `# ${a}\n`);
  if (f.strayAgentEntries) {
    // must all be excluded from the agent count
    mkdirSync(join(agentsDir, '_retired'), { recursive: true });
    writeFileSync(join(agentsDir, '_retired', 'old-agent.md'), '# retired\n');
    writeFileSync(join(agentsDir, '_retired', 'older.md.retired'), '# retired\n');
    mkdirSync(join(agentsDir, 'extensions'), { recursive: true });
    writeFileSync(join(agentsDir, 'extensions', 'extra.md'), '# extension\n');
    writeFileSync(join(agentsDir, 'stray.md.retired'), '# stray\n');
    writeFileSync(join(agentsDir, 'notes.txt'), 'not an agent\n');
  }

  for (const s of [...f.leadSkills, ...f.distilledSkills]) {
    const d = join(root, '.claude', 'skills', s);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'SKILL.md'), `# ${s}\n`);
  }
  for (const s of f.skillDirsWithoutSkillMd ?? []) {
    mkdirSync(join(root, '.claude', 'skills', s), { recursive: true });
  }

  const commandsDir = join(root, '.claude', 'commands');
  mkdirSync(commandsDir, { recursive: true });
  for (const c of f.commands) writeFileSync(join(commandsDir, `${c}.md`), `# /${c}\n`);

  const hooksDir = join(root, '.claude', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, 'package.json'), '{"type":"commonjs"}\n');
  for (const h of f.hooks) {
    writeFileSync(join(hooksDir, `${h}.js`), `'use strict';\n`);
    writeFileSync(join(hooksDir, `${h}.test.js`), `'use strict';\n`);
  }

  writeFileSync(join(root, 'manifest.json'), renderManifest(f));
  writeFileSync(join(root, 'README.md'), renderReadme(f));
  writeFileSync(join(root, 'ADAPT.md'), renderAdapt(f));
  return root;
}

function findingsBy(result: { findings: Finding[] }, check: string): Finding[] {
  return result.findings.filter((f) => f.check === check);
}

interface Finding {
  group: string;
  file: string;
  line: number | null;
  check: string;
  claimed: unknown;
  actual: unknown;
  message: string;
}

// --------------------------------------------------------------------------
// clean fixture
// --------------------------------------------------------------------------

describe('clean fixture', () => {
  it('a fully consistent repo passes with zero findings and exit 0', () => {
    const root = buildFixture();
    const result = runGate(root);
    expect(result.parseErrors).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});

// --------------------------------------------------------------------------
// ground truth collection
// --------------------------------------------------------------------------

describe('ground truth', () => {
  it('excludes _retired/, extensions/, *.md.retired, and non-md files from the agent count', () => {
    const root = buildFixture({ strayAgentEntries: true });
    const truth = collectGroundTruth(root);
    expect(truth.disk.agents).toEqual([...defaults().agents].sort());
    // and the stray entries do not break an otherwise-consistent gate run
    expect(runGate(root).findings).toEqual([]);
  });

  it('hook entry files exclude *.test.js and package.json', () => {
    const root = buildFixture();
    const truth = collectGroundTruth(root);
    expect(truth.disk.hooks).toEqual([...defaults().hooks].sort());
  });

  it('a skill dir without SKILL.md is an anomaly finding, not a counted skill', () => {
    const root = buildFixture({ skillDirsWithoutSkillMd: ['half-baked'] });
    const truth = collectGroundTruth(root);
    expect(truth.disk.skills).not.toContain('half-baked');
    const result = runGate(root);
    const anomalies = findingsBy(result, 'skill-dir-missing-skill-md');
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].file).toBe('.claude/skills/half-baked');
    expect(result.exitCode).toBe(1);
  });

  it('manifest skill list missing a disk skill is a ground-truth finding', () => {
    const f = defaults();
    const root = buildFixture({ manifestSkills: [...f.leadSkills, ...f.distilledSkills].slice(0, -1) });
    const result = runGate(root);
    const missing = findingsBy(result, 'manifest-skills-vs-disk-missing');
    expect(missing).toHaveLength(1);
    expect(missing[0].file).toBe('manifest.json');
    expect(missing[0].message).toContain('wire-it-through');
  });

  it('manifest hook entry with no file on disk is a phantom finding', () => {
    const root = buildFixture({ manifestHooks: [...defaults().hooks, 'ghost-hook'] });
    // ghost-hook.js is never written to disk, so manifest lists a phantom...
    const result = runGate(root);
    const phantom = findingsBy(result, 'manifest-hooks-vs-disk-phantom');
    expect(phantom).toHaveLength(1);
    expect(phantom[0].message).toContain('ghost-hook');
  });

  it('zero agents on disk is fatal (proof-of-life), exit 2', () => {
    const root = buildFixture({ agents: [] });
    const result = runGate(root);
    expect(result.exitCode).toBe(2);
    expect(result.parseErrors[0].message).toMatch(/proof-of-life/);
  });
});

// --------------------------------------------------------------------------
// README ship counts
// --------------------------------------------------------------------------

describe('README ship counts', () => {
  it('wrong hook count is reported with file, line, claimed, actual', () => {
    const root = buildFixture({ readme: { hookCount: 4 } });
    const result = runGate(root);
    const count = findingsBy(result, 'hooks-count').filter((f) => f.group === 'readme-ship-counts');
    expect(count).toHaveLength(1);
    expect(count[0].file).toBe('README.md');
    expect(count[0].line).toBeGreaterThan(0);
    expect(count[0].claimed).toBe(4);
    expect(count[0].actual).toBe(3);
    // internal arithmetic also fires: row claims 4 but lists 3 names
    expect(findingsBy(result, 'hooks-arithmetic').filter((f) => f.file === 'README.md')).toHaveLength(1);
    expect(result.exitCode).toBe(1);
  });

  it('phantom hook name in README list is reported; missing disk hook likewise', () => {
    const f = defaults();
    const root = buildFixture({
      readme: { hookNames: [f.hooks[0], f.hooks[1], 'ghost-hook'] },
    });
    const result = runGate(root);
    const phantom = findingsBy(result, 'hooks-names-phantom').filter((x) => x.file === 'README.md');
    const missing = findingsBy(result, 'hooks-names-missing').filter((x) => x.file === 'README.md');
    expect(phantom).toHaveLength(1);
    expect(phantom[0].message).toContain('ghost-hook');
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain(f.hooks[2]);
  });

  it('skills-row arithmetic: total claim not equal to lead + distilled sub-claim', () => {
    const root = buildFixture({ readme: { skillCount: 6 } }); // disk has 5
    const result = runGate(root);
    expect(findingsBy(result, 'skills-count')).toHaveLength(1); // 6 vs disk 5
    const arith = findingsBy(result, 'skills-arithmetic');
    expect(arith).toHaveLength(1);
    expect(arith[0].claimed).toBe(6);
    expect(arith[0].actual).toBe(5);
  });

  it('distilled sub-claim count vs its own paren list length', () => {
    const root = buildFixture({ readme: { distilledCount: 4, skillCount: 6 } }); // lists 3 names
    const result = runGate(root);
    const d = findingsBy(result, 'skills-distilled-list');
    expect(d).toHaveLength(1);
    expect(d[0].claimed).toBe(4);
    expect(d[0].actual).toBe(3);
  });

  it('agent ship-count drift is reported against disk', () => {
    const root = buildFixture({ readme: { agentCount: 28 } });
    const result = runGate(root);
    const a = findingsBy(result, 'agents-count').filter((x) => x.file === 'README.md');
    expect(a).toHaveLength(1);
    expect(a[0].claimed).toBe(28);
    expect(a[0].actual).toBe(7);
  });
});

// --------------------------------------------------------------------------
// profile claims
// --------------------------------------------------------------------------

describe('profile claims', () => {
  it('ADAPT FULL triple drift (the 28-vs-29 class) fires once per occurrence, at each line', () => {
    const root = buildFixture({ adapt: { fullCount: 6 } }); // disk full = 7
    const result = runGate(root);
    const triples = findingsBy(result, 'profile-count-full');
    // three triple occurrences: profile-selection line, Phase 1.5 line, Phase 5 line
    expect(triples).toHaveLength(3);
    for (const t of triples) {
      expect(t.file).toBe('ADAPT.md');
      expect(t.claimed).toBe(6);
      expect(t.actual).toBe(7);
    }
    expect(new Set(triples.map((t) => t.line)).size).toBe(3);
    // section 12 header also claims 6 while its enumeration resolves to 7
    const hdr = findingsBy(result, 'profile-full-count-vs-enum').filter((x) => x.file === 'ADAPT.md');
    expect(hdr).toHaveLength(1);
    // and 6 vs disk 7
    const disk = findingsBy(result, 'profile-full-count-vs-disk').filter((x) => x.file === 'ADAPT.md');
    expect(disk).toHaveLength(1);
    // cross-doc count drift: README says 7, ADAPT header says 6
    const cross = findingsBy(result, 'profile-full-count').filter((x) => x.group === 'cross-doc');
    expect(cross).toHaveLength(1);
  });

  it('ADAPT FULL enumeration omitting an agent (the regression-scribe class) is caught three ways', () => {
    const f = defaults();
    const root = buildFixture({ adapt: { fullExtras: f.fullExtras.slice(0, -1) } }); // omit validate-setup
    const result = runGate(root);
    // 1. header count no longer matches the enumeration
    const hdr = findingsBy(result, 'profile-full-count-vs-enum').filter((x) => x.file === 'ADAPT.md');
    expect(hdr).toHaveLength(1);
    expect(hdr[0].claimed).toBe(7);
    expect(hdr[0].actual).toBe(6);
    // 2. FULL enumeration vs disk: validate-setup missing
    const miss = findingsBy(result, 'profile-full-vs-disk-missing').filter((x) => x.file === 'ADAPT.md');
    expect(miss).toHaveLength(1);
    expect(miss[0].message).toContain('validate-setup');
    // 3. cross-doc: README FULL lists it, ADAPT section 12 does not
    const cross = findingsBy(result, 'profile-full-names');
    expect(cross).toHaveLength(1);
    expect(cross[0].message).toContain('only in README: [validate-setup]');
  });

  it('a profile naming an agent that does not exist on disk is flagged', () => {
    const root = buildFixture({ readme: { fullExtras: [...defaults().fullExtras, 'imaginary-agent'] } });
    const result = runGate(root);
    const unknown = findingsBy(result, 'profile-full-unknown-agents').filter((x) => x.file === 'README.md');
    expect(unknown).toHaveLength(1);
    expect(unknown[0].message).toContain('imaginary-agent');
  });

  it('embedded base-size claim ("STANDARD n plus:") is verified against the base enumeration', () => {
    const root = buildFixture({ adapt: { standardCount: 5 } }); // real standard = 4
    const result = runGate(root);
    // FULL enum line says "STANDARD 5 plus:" but STANDARD resolves to 4
    const base = findingsBy(result, 'profile-full-base-claim');
    expect(base).toHaveLength(1);
    expect(base[0].claimed).toBe(5);
    expect(base[0].actual).toBe(4);
    // and the STANDARD header itself (5) no longer matches its enumeration (4)
    expect(findingsBy(result, 'profile-standard-count-vs-enum').filter((x) => x.file === 'ADAPT.md')).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// parse failures must fail loudly
// --------------------------------------------------------------------------

describe('anchor breakage fails loudly (exit 2, never a pass)', () => {
  it('README missing the skills ship row is a parse error', () => {
    const root = buildFixture({ readme: { skipSkillsRow: true } });
    const result = runGate(root);
    expect(result.exitCode).toBe(2);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([]); // reconciliation is not attempted on broken anchors
    expect(result.parseErrors.some((p: { check: string }) => p.check === 'readme-skills-row')).toBe(true);
  });

  it('ADAPT missing section 12 is a parse error', () => {
    const root = buildFixture({ adapt: { skipSection12: true } });
    const result = runGate(root);
    expect(result.exitCode).toBe(2);
    const checks = result.parseErrors.map((p: { check: string }) => p.check);
    expect(checks).toContain('adapt-s12-minimal');
    expect(checks).toContain('adapt-s12-full');
  });

  it('parseReadme / parseAdapt report every broken anchor on empty input', () => {
    const r = parseReadme('# empty\n');
    expect(r.parseErrors.length).toBeGreaterThanOrEqual(7); // 4 ship rows + 3 profile bullets
    const a = parseAdapt('# empty\n');
    expect(a.parseErrors.length).toBeGreaterThanOrEqual(7); // 2 bundle lines + 2 triples + phase5 + 3 headers
  });
});

// --------------------------------------------------------------------------
// CLI contract
// --------------------------------------------------------------------------

describe('CLI', () => {
  function runCli(root: string): { status: number | null; stdout: string } {
    const res = spawnSync(process.execPath, [SCRIPT_PATH, '--root', root, '--json'], { encoding: 'utf8' });
    return { status: res.status, stdout: res.stdout };
  }

  it('clean fixture: exit 0, ok:true, ground truth in JSON', () => {
    const { status, stdout } = runCli(buildFixture());
    expect(status).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(true);
    expect(out.findings).toEqual([]);
    expect(out.groundTruth.disk.agents).toHaveLength(7);
  });

  it('mismatch fixture: exit 1, findings serialised', () => {
    const { status, stdout } = runCli(buildFixture({ adapt: { fullCount: 6 } }));
    expect(status).toBe(1);
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(false);
    expect(out.findings.length).toBeGreaterThan(0);
  });

  it('broken anchors: exit 2, parse errors serialised', () => {
    const { status, stdout } = runCli(buildFixture({ readme: { skipSkillsRow: true } }));
    expect(status).toBe(2);
    const out = JSON.parse(stdout);
    expect(out.parseErrors.length).toBeGreaterThan(0);
    expect(out.findings).toEqual([]);
  });
});
