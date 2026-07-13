#!/usr/bin/env tsx
/**
 * skill-routing-evals.ts
 *
 * Skill-routing eval runner (I/O module). Loads every `.claude/skills/<name>/SKILL.md`
 * frontmatter, runs the deterministic lexical-routing checks from
 * skill-routing-evalsPure.ts against the case files in evals/skill-routing/,
 * and prints a per-skill report:
 *
 *   - positive prompts must rank their skill within top_k (default 3)
 *   - negative prompts must not rank it #1; with an "owner" the declared
 *     owner skill must additionally outrank it (pairwise routing)
 *   - no two skill descriptions may be near-duplicates (cosine >= 0.75 is an
 *     error, >= 0.5 a warning) unless the pair is on COLLISION_EXEMPT below
 *   - skills with no case file are listed as a warning (coverage)
 *
 * Case file format (pinned — evals/skill-routing/README.md):
 *   {"skill": "<name>", "top_k": 3, "positive": ["prompt", ...],
 *    "negative": ["plain prompt", {"prompt": "...", "owner": "<other-skill>"}]}
 *
 * Usage: npm run eval:routing  (npx tsx scripts/skill-routing-evals.ts)
 * Exit codes: 0 ok (warnings allowed) · 1 any trigger failure, malformed
 * skill/case file, or non-exempt error-level collision.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCorpus,
  evaluateCase,
  pairwiseCollisions,
  summarize,
  validateRoutingCase,
  type CaseEvaluation,
  type RoutingCase,
  type SkillDoc,
} from './skill-routing-evalsPure.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(ROOT, '.claude', 'skills');
const CASES_DIR = join(ROOT, 'evals', 'skill-routing');

/**
 * Collision exemption allowlist — validator-owned so contributors cannot
 * self-exempt from inside a skill file. Every pair carries a one-line reason.
 * Exempt only deliberate siblings; a new collision means the two descriptions
 * need disambiguating vocabulary, not an entry here.
 */
const COLLISION_EXEMPT: Array<[string, string]> = [
  // (none yet — the 21-skill catalogue currently has no pair at or above the 0.75 error threshold)
];

// ── loading ───────────────────────────────────────────────────────────────────

function loadSkills(errors: string[]): SkillDoc[] {
  if (!existsSync(SKILLS_DIR)) {
    errors.push(`skills directory not found: ${SKILLS_DIR}`);
    return [];
  }
  const skills: SkillDoc[] = [];
  for (const dir of readdirSync(SKILLS_DIR)) {
    const file = join(SKILLS_DIR, dir, 'SKILL.md');
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');
    const m = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
    const name = m ? (m[1].match(/^name:\s*(.+)$/m) || [])[1] : undefined;
    const description = m ? (m[1].match(/^description:\s*(.+)$/m) || [])[1] : undefined;
    if (!name || !description) {
      errors.push(`.claude/skills/${dir}/SKILL.md: frontmatter missing "name" or "description" — routing is broken for this skill`);
      continue;
    }
    skills.push({ name: name.trim(), description: description.trim() });
  }
  return skills;
}

interface LoadedCase {
  file: string;
  routingCase: RoutingCase;
}

function loadCases(errors: string[]): LoadedCase[] {
  if (!existsSync(CASES_DIR)) return [];
  const out: LoadedCase[] = [];
  for (const f of readdirSync(CASES_DIR)) {
    if (!f.endsWith('.json')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(CASES_DIR, f), 'utf8'));
    } catch (err) {
      errors.push(`evals/skill-routing/${f}: invalid JSON — ${(err as Error).message}`);
      continue;
    }
    const { case: routingCase, error } = validateRoutingCase(parsed, `evals/skill-routing/${f}`);
    if (error) errors.push(error);
    else if (routingCase) out.push({ file: f, routingCase });
  }
  return out;
}

// ── report ────────────────────────────────────────────────────────────────────

function main(): void {
  const loadErrors: string[] = [];
  const skills = loadSkills(loadErrors);
  const cases = loadCases(loadErrors);
  const corpus = buildCorpus(skills);

  let errors = 0;
  let warnings = 0;

  console.log(`skill-routing-evals: ${skills.length} skills, ${cases.length} case file(s)\n`);

  for (const e of loadErrors) {
    console.log(`  FAIL ${e}`);
    errors++;
  }

  // Coverage: every skill should ship a routing case file.
  const covered = new Set(cases.map((c) => c.routingCase.skill));
  const uncovered = skills.map((s) => s.name).filter((n) => !covered.has(n));
  if (uncovered.length > 0) {
    console.log(`  WARN ${uncovered.length} skill(s) have no routing case file in evals/skill-routing/:`);
    for (const n of uncovered) console.log(`       - ${n}`);
    warnings++;
  }

  // Trigger evals per case file.
  const evaluations: CaseEvaluation[] = [];
  for (const { file, routingCase } of cases) {
    const ev = evaluateCase(routingCase, corpus);
    evaluations.push(ev);
    if (ev.failures.length === 0) {
      console.log(`  ok   ${ev.skill}: ${ev.passed} check(s) passed (${file})`);
      continue;
    }
    for (const f of ev.failures) {
      console.log(`  FAIL ${ev.skill}: ${f.message} (${file})`);
      if (f.prompt) console.log(`       "${f.prompt}"`);
      if (f.top3.length > 0) {
        console.log(`       top 3: ${f.top3.map((r) => `${r.name} (${r.score.toFixed(2)})`).join(', ')}`);
      }
      errors++;
    }
  }

  // Routing collisions across the catalogue.
  for (const c of pairwiseCollisions(corpus, COLLISION_EXEMPT)) {
    const pct = `${(c.similarity * 100).toFixed(0)}% similar`;
    if (c.exempt) {
      console.log(`  note exempted collision: ${c.a} <-> ${c.b} descriptions ${pct}`);
    } else if (c.level === 'error') {
      console.log(`  FAIL collision: ${c.a} <-> ${c.b} descriptions ${pct} (>= 75%)`);
      errors++;
    } else {
      console.log(`  WARN overlap: ${c.a} <-> ${c.b} descriptions ${pct}`);
      warnings++;
    }
  }

  const s = summarize(evaluations);
  const rate = s.rank1Rate === null ? 'n/a' : `${(s.rank1Rate * 100).toFixed(0)}%`;
  console.log(`\n${s.checksPassed} checks passed — ${errors} error(s), ${warnings} warning(s)`);
  console.log(`trigger rank-1 rate: ${rate} (${s.rank1}/${s.positives} positive prompts rank their skill first)`);
  console.log(errors ? 'FAILED' : 'PASSED');
  process.exit(errors ? 1 : 0);
}

main();
