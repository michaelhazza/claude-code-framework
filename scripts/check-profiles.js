#!/usr/bin/env node
'use strict';

/**
 * check-profiles.js - profile/inventory reconciliation gate.
 *
 * The framework's inventory claims live in prose: the README.md "What ships"
 * table + "Profiles" section, and ADAPT.md's bundle summary (section 1),
 * profile-selection lines (sections 3/6), Phase 5 smoke-check counts, and the
 * section 12 profile reference. Ship counts have historically been patched by
 * hand and drift from disk. This gate reconciles every such claim against
 * ground truth and against each other.
 *
 * Ground truth:
 *   - agents:   .claude/agents/*.md            (files only; subdirectories such
 *               as _retired/ or extensions/ are excluded; *.md.retired never
 *               matches because the extension test is anchored on .md)
 *   - skills:   .claude/skills/<name>/SKILL.md (a dir without SKILL.md is an
 *               anomaly finding, not a countable skill)
 *   - commands: .claude/commands/*.md
 *   - hooks:    .claude/hooks/*.js entry files (excluding *.test.js and
 *               package.json)
 *   - manifest: manifest.json managedFiles entries per category (agent,
 *               command, hook, skill); globs are expanded against disk
 *
 * Check groups:
 *   ground-truth        manifest category lists vs disk; skill-dir anomalies
 *   readme-ship-counts  README "What ships" rows (agents / commands / hooks /
 *                       skills): counts, enumerated names, internal arithmetic
 *   readme-profiles     README Profiles bullets: count vs enumeration, names
 *                       exist on disk, FULL set == disk set
 *   adapt-inventory     ADAPT section 1 bundle counts, every
 *                       "MINIMAL (n) / STANDARD (n) / FULL (n)" triple,
 *                       Phase 5 "(n / n / n)" and hook-script counts
 *   adapt-profiles      ADAPT section 12: header count vs enumeration,
 *                       embedded base-size claims ("STANDARD 10 plus:"),
 *                       names exist on disk, FULL set == disk set
 *   cross-doc           README vs ADAPT per-profile name sets and counts
 *
 * Parsing is anchored-but-tolerant: every claim is located by a specific
 * anchor regex. A missing anchor is a PARSE ERROR and the gate fails loudly
 * (exit 2) - a gate whose input pattern breaks must fail, not pass.
 *
 * Usage: node scripts/check-profiles.js [--json] [--root <dir>]
 * Exit:  0 = all claims reconcile; 1 = mismatch finding(s);
 *        2 = parse error / unreadable input (findings not computed).
 */

const fs = require('fs');
const path = require('path');

/** Valid agent / skill / hook / command basename. */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const GROUP_ORDER = [
  'ground-truth',
  'readme-ship-counts',
  'readme-profiles',
  'adapt-inventory',
  'adapt-profiles',
  'cross-doc',
];

class FatalError extends Error {}

// --------------------------------------------------------------------------
// small helpers
// --------------------------------------------------------------------------

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Backticked tokens that look like artifact names (leading "/" stripped). */
function backtickNames(s) {
  const out = [];
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const raw = m[1].replace(/^\//, '');
    if (NAME_RE.test(raw)) out.push(raw);
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Minimal glob expansion: "*" within a single path segment only (the manifest
 * uses nothing richer). Returns matching FILES (absolute paths).
 */
function expandGlob(root, pattern) {
  const segs = String(pattern).split('/');
  let cur = [root];
  for (const seg of segs) {
    const next = [];
    if (seg.includes('*')) {
      const re = new RegExp('^' + seg.split('*').map(escapeRe).join('[^/\\\\]*') + '$');
      for (const dir of cur) {
        let entries;
        try {
          entries = fs.readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of entries) if (re.test(name)) next.push(path.join(dir, name));
      }
    } else {
      for (const dir of cur) {
        const p = path.join(dir, seg);
        if (fs.existsSync(p)) next.push(p);
      }
    }
    cur = next;
  }
  return cur.filter((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

// --------------------------------------------------------------------------
// ground truth
// --------------------------------------------------------------------------

function collectGroundTruth(root) {
  const anomalies = [];
  const mustExist = (p, what) => {
    if (!fs.existsSync(p)) throw new FatalError(`${what} not found: ${p}`);
    return p;
  };

  // agents: top-level .md files only. Subdirectories (_retired/, extensions/,
  // anything else) are never descended into; ".md.retired" fails the /\.md$/
  // anchor.
  const agentsDir = mustExist(path.join(root, '.claude', 'agents'), 'agents directory');
  const agents = fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.md$/.test(e.name))
    .map((e) => e.name.replace(/\.md$/, ''))
    .sort();
  if (agents.length === 0) {
    throw new FatalError(`proof-of-life failed: zero agent .md files in ${agentsDir}`);
  }

  // skills: directories containing SKILL.md
  const skillsDir = mustExist(path.join(root, '.claude', 'skills'), 'skills directory');
  const skills = [];
  for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md'))) {
      skills.push(e.name);
    } else {
      anomalies.push({
        file: `.claude/skills/${e.name}`,
        line: null,
        check: 'skill-dir-missing-skill-md',
        claimed: null,
        actual: null,
        message: `skill directory has no SKILL.md; not countable as a shipped skill`,
      });
    }
  }
  skills.sort();

  const commandsDir = mustExist(path.join(root, '.claude', 'commands'), 'commands directory');
  const commands = fs
    .readdirSync(commandsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.md$/.test(e.name))
    .map((e) => e.name.replace(/\.md$/, ''))
    .sort();

  // hooks: entry scripts only (exclude *.test.js; package.json fails /\.js$/)
  const hooksDir = mustExist(path.join(root, '.claude', 'hooks'), 'hooks directory');
  const hooks = fs
    .readdirSync(hooksDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.js$/.test(e.name) && !/\.test\.js$/.test(e.name))
    .map((e) => e.name.replace(/\.js$/, ''))
    .sort();

  // manifest category lists
  const manifestPath = mustExist(path.join(root, 'manifest.json'), 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new FatalError(`manifest.json unparseable: ${e.message}`);
  }
  if (!Array.isArray(manifest.managedFiles)) {
    throw new FatalError('manifest.json has no managedFiles array');
  }

  const manAgents = new Set();
  const manCommands = new Set();
  const manHooks = new Set();
  const manSkills = new Set();
  for (const entry of manifest.managedFiles) {
    if (!entry || typeof entry.path !== 'string') continue;
    const cat = entry.category;
    if (cat === 'agent') {
      for (const f of expandGlob(root, entry.path)) {
        if (/\.md$/.test(f)) manAgents.add(path.basename(f, '.md'));
      }
    } else if (cat === 'command') {
      for (const f of expandGlob(root, entry.path)) {
        if (/\.md$/.test(f)) manCommands.add(path.basename(f, '.md'));
      }
    } else if (cat === 'hook') {
      const base = entry.path.split('/').pop();
      if (/\.js$/.test(base) && !/\.test\.js$/.test(base)) {
        manHooks.add(base.replace(/\.js$/, ''));
      }
    } else if (cat === 'skill') {
      const m = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(entry.path);
      if (m) manSkills.add(m[1]);
    }
  }

  return {
    disk: { agents, skills, commands, hooks },
    manifest: {
      agents: [...manAgents].sort(),
      skills: [...manSkills].sort(),
      commands: [...manCommands].sort(),
      hooks: [...manHooks].sort(),
    },
    anomalies,
  };
}

// --------------------------------------------------------------------------
// README.md parsing
// --------------------------------------------------------------------------

function parseReadme(input) {
  const text = String(input).replace(/\r\n/g, '\n');
  const parseErrors = [];
  const fail = (check, message) => parseErrors.push({ file: 'README.md', check, message });
  const out = { shipCounts: {}, profiles: {}, parseErrors };

  // "What ships" rows -------------------------------------------------------
  let m = /^\|\s*`\.claude\/agents\/`\s*\|\s*(\d+)\s+agent definitions\b[^\n]*$/m.exec(text);
  if (m) out.shipCounts.agents = { line: lineOf(text, m.index), count: Number(m[1]) };
  else fail('readme-agents-row', 'anchor not found: "| `.claude/agents/` | <N> agent definitions ..." table row');

  m = /^\|\s*`\.claude\/commands\/`\s*\|\s*(\d+)\s+operator commands:([^\n]*)$/m.exec(text);
  if (m) {
    const names = [];
    const re = /`\/([a-z0-9-]+)`/g;
    let c;
    while ((c = re.exec(m[2])) !== null) names.push(c[1]);
    if (names.length === 0) fail('readme-commands-names', 'commands row found but no backticked `/name` tokens parsed');
    else out.shipCounts.commands = { line: lineOf(text, m.index), count: Number(m[1]), names };
  } else fail('readme-commands-row', 'anchor not found: "| `.claude/commands/` | <N> operator commands: ..." table row');

  m = /^\|\s*`\.claude\/hooks\/`\s*\|\s*(\d+)\s+portable hooks:([^\n]*)$/m.exec(text);
  if (m) {
    const names = backtickNames(m[2]);
    if (names.length === 0) fail('readme-hooks-names', 'hooks row found but no backticked hook names parsed');
    else out.shipCounts.hooks = { line: lineOf(text, m.index), count: Number(m[1]), names };
  } else fail('readme-hooks-row', 'anchor not found: "| `.claude/hooks/` | <N> portable hooks: ..." table row');

  m = /^\|\s*`\.claude\/skills\/`\s*\|\s*(\d+)\s+portable skills:([^\n]*)$/m.exec(text);
  if (m) {
    const line = lineOf(text, m.index);
    const rest = m[2];
    // "..., and <N> <adjective> skills (<comma list>)" tail sub-claim
    const tail = /,?\s*and\s+(\d+)\s+[a-z][a-z-]*\s+skills\s*\(([^)]*)\)/.exec(rest);
    if (!tail) {
      fail('readme-skills-tail', 'skills row found but the "and <N> ... skills (<list>)" sub-claim did not parse');
    } else {
      // lead names: everything before the tail, parentheticals stripped
      const head = rest.slice(0, tail.index).replace(/\([^)]*\)/g, ' ');
      const leadNames = head.split(',').map((s) => s.trim()).filter(Boolean);
      const distilledNames = tail[2].split(',').map((s) => s.trim()).filter(Boolean);
      const bad = leadNames.concat(distilledNames).filter((n) => !NAME_RE.test(n));
      if (bad.length) {
        fail('readme-skills-tokens', `skills row produced unparseable skill token(s): ${bad.join(' | ')}`);
      } else {
        out.shipCounts.skills = {
          line,
          count: Number(m[1]),
          leadNames,
          distilled: { count: Number(tail[1]), names: distilledNames },
          allNames: leadNames.concat(distilledNames),
        };
      }
    }
  } else fail('readme-skills-row', 'anchor not found: "| `.claude/skills/` | <N> portable skills: ..." table row');

  // Profiles bullets --------------------------------------------------------
  for (const name of ['MINIMAL', 'STANDARD', 'FULL']) {
    const re = new RegExp('^-\\s+\\*\\*' + name + '\\s*\\((\\d+)\\)\\*\\*\\s*[\\u2014\\u2013-]+\\s*([^\\n]*)$', 'm');
    const pm = re.exec(text);
    if (!pm) {
      fail(`readme-profile-${name.toLowerCase()}`, `anchor not found: "- **${name} (<N>)** ..." profile bullet`);
      continue;
    }
    const tailText = pm[2];
    const baseM = /^(MINIMAL|STANDARD)\s*\+/.exec(tailText);
    const extras = backtickNames(tailText);
    if (extras.length === 0) {
      fail(`readme-profile-${name.toLowerCase()}-names`, `profile bullet for ${name} has no backticked agent names`);
      continue;
    }
    const ln = lineOf(text, pm.index);
    out.profiles[name] = { line: ln, enumLine: ln, count: Number(pm[1]), base: baseM ? baseM[1] : null, baseClaimCount: null, extras };
  }

  return out;
}

// --------------------------------------------------------------------------
// ADAPT.md parsing
// --------------------------------------------------------------------------

function parseAdapt(input) {
  const text = String(input).replace(/\r\n/g, '\n');
  const parseErrors = [];
  const fail = (check, message) => parseErrors.push({ file: 'ADAPT.md', check, message });
  const out = { inventory: {}, tripleClaims: [], phase5Hooks: null, profiles: {}, parseErrors };

  // section 1 bundle summary ------------------------------------------------
  let m = /^-\s+(\d+)\s+agent definitions in `\.claude\/agents\/`/m.exec(text);
  if (m) out.inventory.agents = { line: lineOf(text, m.index), count: Number(m[1]) };
  else fail('adapt-agents-line', 'anchor not found: "- <N> agent definitions in `.claude/agents/`" bundle summary line');

  m = /^-\s+(\d+)\s+portable hooks in `\.claude\/hooks\/`\s*\(([^)]*)\)/m.exec(text);
  if (m) {
    const names = backtickNames(m[2]);
    if (names.length === 0) fail('adapt-hooks-names', 'hooks bundle line found but no backticked hook names parsed');
    else out.inventory.hooks = { line: lineOf(text, m.index), count: Number(m[1]), names };
  } else fail('adapt-hooks-line', 'anchor not found: "- <N> portable hooks in `.claude/hooks/` (`...`)" bundle summary line');

  // "MINIMAL (n) / STANDARD (n) / FULL (n)" triples (sections 3 and 6) ------
  const p1 = /MINIMAL\s*\((\d+)(?:\s*agents)?\)\s*\/\s*STANDARD\s*\((\d+)(?:\s*agents)?\)\s*\/\s*FULL\s*\((\d+)(?:\s*agents)?\)/g;
  let t;
  let p1Count = 0;
  while ((t = p1.exec(text)) !== null) {
    out.tripleClaims.push({ line: lineOf(text, t.index), minimal: Number(t[1]), standard: Number(t[2]), full: Number(t[3]), snippet: t[0] });
    p1Count++;
  }
  if (p1Count === 0) fail('adapt-profile-triple', 'anchor not found: "MINIMAL (n) / STANDARD (n) / FULL (n)" profile-selection line');

  // Phase 5 "count matches profile (n / n / n" ------------------------------
  const p2 = /profile\s*\((\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/g;
  let p2Count = 0;
  while ((t = p2.exec(text)) !== null) {
    out.tripleClaims.push({ line: lineOf(text, t.index), minimal: Number(t[1]), standard: Number(t[2]), full: Number(t[3]), snippet: t[0] });
    p2Count++;
  }
  if (p2Count === 0) fail('adapt-profile-count-check', 'anchor not found: Phase 5 "count matches profile (n / n / n ..." smoke-check line');

  m = /(\d+)\s+hook scripts present/.exec(text);
  if (m) out.phase5Hooks = { line: lineOf(text, m.index), count: Number(m[1]) };
  else fail('adapt-phase5-hooks', 'anchor not found: Phase 5 "<N> hook scripts present" smoke-check line');

  // section 12 profile reference --------------------------------------------
  const lines = text.split('\n');
  for (const name of ['MINIMAL', 'STANDARD', 'FULL']) {
    const headerRe = new RegExp('^###\\s+' + name + '\\s*\\((\\d+)\\s*agents?\\)');
    let idx = -1;
    let headerCount = null;
    for (let i = 0; i < lines.length; i++) {
      const hm = headerRe.exec(lines[i]);
      if (hm) {
        idx = i;
        headerCount = Number(hm[1]);
        break;
      }
    }
    if (idx === -1) {
      fail(`adapt-s12-${name.toLowerCase()}`, `anchor not found: section 12 "### ${name} (<N> agents)" header`);
      continue;
    }
    let j = idx + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    const enumText = j < lines.length ? lines[j] : '';
    const extras = backtickNames(enumText);
    if (extras.length === 0) {
      fail(`adapt-s12-${name.toLowerCase()}-names`, `section 12 ${name} enumeration line (first non-empty line after the header) has no backticked agent names`);
      continue;
    }
    const baseM = /^(MINIMAL|STANDARD)\s+(\d+)\s+plus:/.exec(enumText.trim());
    out.profiles[name] = {
      line: idx + 1,
      enumLine: j + 1,
      count: headerCount,
      base: baseM ? baseM[1] : null,
      baseClaimCount: baseM ? Number(baseM[2]) : null,
      extras,
    };
  }

  return out;
}

// --------------------------------------------------------------------------
// reconciliation
// --------------------------------------------------------------------------

function resolveProfile(profiles, name, seen) {
  seen = seen || new Set();
  if (seen.has(name)) return null;
  seen.add(name);
  const p = profiles[name];
  if (!p) return null;
  if (!p.base) return p.extras.slice();
  const base = resolveProfile(profiles, p.base, seen);
  if (!base) return null;
  return base.concat(p.extras);
}

function reconcile(readme, adapt, truth) {
  const findings = [];
  const disk = truth.disk;
  const man = truth.manifest;
  const push = (group, file, line, check, claimed, actual, message) =>
    findings.push({ group, file, line, check, claimed, actual, message });

  const compareSets = (group, file, line, check, docNames, truthNames, docLabel, truthLabel) => {
    const missing = truthNames.filter((n) => !docNames.includes(n)).sort();
    const phantom = docNames.filter((n) => !truthNames.includes(n)).sort();
    if (missing.length) {
      push(group, file, line, `${check}-missing`, docNames.slice().sort(), truthNames.slice().sort(),
        `${truthLabel} has ${missing.length} entr${missing.length === 1 ? 'y' : 'ies'} absent from ${docLabel}: ${missing.join(', ')}`);
    }
    if (phantom.length) {
      push(group, file, line, `${check}-phantom`, docNames.slice().sort(), truthNames.slice().sort(),
        `${docLabel} names ${phantom.length} entr${phantom.length === 1 ? 'y' : 'ies'} with no counterpart in ${truthLabel}: ${phantom.join(', ')}`);
    }
  };

  // -- ground truth ----------------------------------------------------------
  for (const a of truth.anomalies) findings.push(Object.assign({ group: 'ground-truth' }, a));
  compareSets('ground-truth', 'manifest.json', null, 'manifest-agents-vs-disk', man.agents, disk.agents,
    'manifest.json agent entries', 'disk (.claude/agents/*.md)');
  compareSets('ground-truth', 'manifest.json', null, 'manifest-commands-vs-disk', man.commands, disk.commands,
    'manifest.json command entries', 'disk (.claude/commands/*.md)');
  compareSets('ground-truth', 'manifest.json', null, 'manifest-hooks-vs-disk', man.hooks, disk.hooks,
    'manifest.json hook entries', 'disk (.claude/hooks/*.js entry files)');
  compareSets('ground-truth', 'manifest.json', null, 'manifest-skills-vs-disk', man.skills, disk.skills,
    'manifest.json skill entries', 'disk (.claude/skills/*/SKILL.md)');

  // -- README ship counts ----------------------------------------------------
  const sc = readme.shipCounts;
  if (sc.agents && sc.agents.count !== disk.agents.length) {
    push('readme-ship-counts', 'README.md', sc.agents.line, 'agents-count', sc.agents.count, disk.agents.length,
      `README claims ${sc.agents.count} agent definitions; disk has ${disk.agents.length}`);
  }
  if (sc.commands) {
    if (sc.commands.count !== disk.commands.length) {
      push('readme-ship-counts', 'README.md', sc.commands.line, 'commands-count', sc.commands.count, disk.commands.length,
        `README claims ${sc.commands.count} operator commands; disk has ${disk.commands.length}`);
    }
    if (sc.commands.names.length !== sc.commands.count) {
      push('readme-ship-counts', 'README.md', sc.commands.line, 'commands-arithmetic', sc.commands.count, sc.commands.names.length,
        `commands row claims ${sc.commands.count} but enumerates ${sc.commands.names.length} names`);
    }
    compareSets('readme-ship-counts', 'README.md', sc.commands.line, 'commands-names', sc.commands.names, disk.commands,
      'README commands list', 'disk (.claude/commands/*.md)');
  }
  if (sc.hooks) {
    if (sc.hooks.count !== disk.hooks.length) {
      push('readme-ship-counts', 'README.md', sc.hooks.line, 'hooks-count', sc.hooks.count, disk.hooks.length,
        `README claims ${sc.hooks.count} portable hooks; disk has ${disk.hooks.length} entry files`);
    }
    if (sc.hooks.names.length !== sc.hooks.count) {
      push('readme-ship-counts', 'README.md', sc.hooks.line, 'hooks-arithmetic', sc.hooks.count, sc.hooks.names.length,
        `hooks row claims ${sc.hooks.count} but enumerates ${sc.hooks.names.length} names`);
    }
    compareSets('readme-ship-counts', 'README.md', sc.hooks.line, 'hooks-names', sc.hooks.names, disk.hooks,
      'README hooks list', 'disk (.claude/hooks/*.js entry files)');
  }
  if (sc.skills) {
    if (sc.skills.count !== disk.skills.length) {
      push('readme-ship-counts', 'README.md', sc.skills.line, 'skills-count', sc.skills.count, disk.skills.length,
        `README claims ${sc.skills.count} portable skills; disk has ${disk.skills.length}`);
    }
    const enumerated = sc.skills.leadNames.length + sc.skills.distilled.count;
    if (enumerated !== sc.skills.count) {
      push('readme-ship-counts', 'README.md', sc.skills.line, 'skills-arithmetic', sc.skills.count, enumerated,
        `skills row claims ${sc.skills.count} but ${sc.skills.leadNames.length} lead names + "${sc.skills.distilled.count} ... skills" sub-claim = ${enumerated}`);
    }
    if (sc.skills.distilled.names.length !== sc.skills.distilled.count) {
      push('readme-ship-counts', 'README.md', sc.skills.line, 'skills-distilled-list', sc.skills.distilled.count, sc.skills.distilled.names.length,
        `the "and ${sc.skills.distilled.count} ... skills (...)" sub-claim enumerates ${sc.skills.distilled.names.length} names`);
    }
    compareSets('readme-ship-counts', 'README.md', sc.skills.line, 'skills-names', sc.skills.allNames, disk.skills,
      'README skills list', 'disk (.claude/skills/*/SKILL.md)');
  }

  // -- profile checks (shared for both docs) ----------------------------------
  const checkProfiles = (docLabel, file, profiles, group) => {
    const resolved = {};
    for (const name of ['MINIMAL', 'STANDARD', 'FULL']) {
      const p = profiles[name];
      if (!p) continue;
      const r = resolveProfile(profiles, name);
      resolved[name] = r;
      if (!r) continue;
      const key = name.toLowerCase();
      const dupes = r.filter((n, i) => r.indexOf(n) !== i);
      if (dupes.length) {
        push(group, file, p.enumLine, `profile-${key}-duplicates`, r.slice().sort(), null,
          `${docLabel} ${name} enumeration contains duplicate agent name(s): ${[...new Set(dupes)].sort().join(', ')}`);
      }
      if (p.count !== r.length) {
        push(group, file, p.line, `profile-${key}-count-vs-enum`, p.count, r.length,
          `${docLabel} claims ${name} (${p.count}) but its enumeration resolves to ${r.length} agents`);
      }
      const unknown = r.filter((n) => !disk.agents.includes(n)).sort();
      if (unknown.length) {
        push(group, file, p.enumLine, `profile-${key}-unknown-agents`, unknown, disk.agents,
          `${docLabel} ${name} names agent(s) not on disk: ${unknown.join(', ')}`);
      }
      if (p.baseClaimCount != null && p.base) {
        const baseResolved = resolveProfile(profiles, p.base);
        if (baseResolved && p.baseClaimCount !== baseResolved.length) {
          push(group, file, p.enumLine, `profile-${key}-base-claim`, p.baseClaimCount, baseResolved.length,
            `"${p.base} ${p.baseClaimCount} plus:" but ${p.base} actually resolves to ${baseResolved.length} agents`);
        }
      }
    }
    const fp = profiles.FULL;
    if (fp && resolved.FULL) {
      if (fp.count !== disk.agents.length) {
        push(group, file, fp.line, 'profile-full-count-vs-disk', fp.count, disk.agents.length,
          `${docLabel} claims FULL (${fp.count}) but disk has ${disk.agents.length} agents (FULL must ship every agent)`);
      }
      compareSets(group, file, fp.enumLine, 'profile-full-vs-disk', resolved.FULL, disk.agents,
        `${docLabel} FULL enumeration`, 'disk (.claude/agents/*.md)');
    }
    return resolved;
  };

  const readmeResolved = checkProfiles('README.md Profiles', 'README.md', readme.profiles, 'readme-profiles');
  const adaptResolved = checkProfiles('ADAPT.md section 12', 'ADAPT.md', adapt.profiles, 'adapt-profiles');

  // -- ADAPT inventory ---------------------------------------------------------
  const inv = adapt.inventory;
  if (inv.agents && inv.agents.count !== disk.agents.length) {
    push('adapt-inventory', 'ADAPT.md', inv.agents.line, 'agents-count', inv.agents.count, disk.agents.length,
      `ADAPT bundle summary claims ${inv.agents.count} agent definitions; disk has ${disk.agents.length}`);
  }
  if (inv.hooks) {
    if (inv.hooks.count !== disk.hooks.length) {
      push('adapt-inventory', 'ADAPT.md', inv.hooks.line, 'hooks-count', inv.hooks.count, disk.hooks.length,
        `ADAPT bundle summary claims ${inv.hooks.count} portable hooks; disk has ${disk.hooks.length} entry files`);
    }
    if (inv.hooks.names.length !== inv.hooks.count) {
      push('adapt-inventory', 'ADAPT.md', inv.hooks.line, 'hooks-arithmetic', inv.hooks.count, inv.hooks.names.length,
        `ADAPT hooks bundle line claims ${inv.hooks.count} but enumerates ${inv.hooks.names.length} names`);
    }
    compareSets('adapt-inventory', 'ADAPT.md', inv.hooks.line, 'hooks-names', inv.hooks.names, disk.hooks,
      'ADAPT bundle hook list', 'disk (.claude/hooks/*.js entry files)');
  }
  const refs = {
    minimal: adaptResolved.MINIMAL ? adaptResolved.MINIMAL.length : null,
    standard: adaptResolved.STANDARD ? adaptResolved.STANDARD.length : null,
    full: disk.agents.length,
  };
  for (const triple of adapt.tripleClaims) {
    for (const key of ['minimal', 'standard', 'full']) {
      if (refs[key] != null && triple[key] !== refs[key]) {
        const basis = key === 'full' ? 'disk agent count' : 'section 12 enumeration';
        push('adapt-inventory', 'ADAPT.md', triple.line, `profile-count-${key}`, triple[key], refs[key],
          `profile-count claim "${triple.snippet.trim().slice(0, 80)}": ${key.toUpperCase()} claimed ${triple[key]}, actual ${refs[key]} (${basis})`);
      }
    }
  }
  if (adapt.phase5Hooks && adapt.phase5Hooks.count !== disk.hooks.length) {
    push('adapt-inventory', 'ADAPT.md', adapt.phase5Hooks.line, 'phase5-hooks-count', adapt.phase5Hooks.count, disk.hooks.length,
      `Phase 5 smoke check claims ${adapt.phase5Hooks.count} hook scripts; disk has ${disk.hooks.length} entry files`);
  }

  // -- cross-doc ----------------------------------------------------------------
  for (const name of ['MINIMAL', 'STANDARD', 'FULL']) {
    const key = name.toLowerCase();
    const pa = readme.profiles[name];
    const pb = adapt.profiles[name];
    if (pa && pb && pa.count !== pb.count) {
      push('cross-doc', 'README.md<->ADAPT.md', null, `profile-${key}-count`, pa.count, pb.count,
        `README claims ${name} (${pa.count}) but ADAPT section 12 header claims (${pb.count})`);
    }
    const a = readmeResolved[name];
    const b = adaptResolved[name];
    if (a && b) {
      const onlyReadme = a.filter((n) => !b.includes(n)).sort();
      const onlyAdapt = b.filter((n) => !a.includes(n)).sort();
      if (onlyReadme.length || onlyAdapt.length) {
        push('cross-doc', 'README.md<->ADAPT.md', null, `profile-${key}-names`, a.slice().sort(), b.slice().sort(),
          `${name} agent lists differ; only in README: [${onlyReadme.join(', ') || 'none'}]; only in ADAPT section 12: [${onlyAdapt.join(', ') || 'none'}]`);
      }
    }
  }

  sortFindings(findings);
  return findings;
}

function sortFindings(findings) {
  findings.sort((x, y) => {
    const g = GROUP_ORDER.indexOf(x.group) - GROUP_ORDER.indexOf(y.group);
    if (g !== 0) return g;
    if (x.file !== y.file) return x.file < y.file ? -1 : 1;
    const lx = x.line == null ? Infinity : x.line;
    const ly = y.line == null ? Infinity : y.line;
    if (lx !== ly) return lx - ly;
    return x.check < y.check ? -1 : x.check > y.check ? 1 : 0;
  });
}

// --------------------------------------------------------------------------
// gate driver
// --------------------------------------------------------------------------

function runGate(root) {
  let truth = null;
  const parseErrors = [];
  try {
    truth = collectGroundTruth(root);
  } catch (e) {
    if (e instanceof FatalError) {
      return { ok: false, exitCode: 2, findings: [], parseErrors: [{ file: '(ground-truth)', check: 'ground-truth', message: e.message }], truth: null };
    }
    throw e;
  }

  const readDoc = (rel) => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    } catch (e) {
      parseErrors.push({ file: rel, check: 'read', message: `cannot read ${rel}: ${e.message}` });
      return null;
    }
  };
  const readmeText = readDoc('README.md');
  const adaptText = readDoc('ADAPT.md');
  let readme = null;
  let adapt = null;
  if (readmeText != null) {
    readme = parseReadme(readmeText);
    parseErrors.push(...readme.parseErrors);
  }
  if (adaptText != null) {
    adapt = parseAdapt(adaptText);
    parseErrors.push(...adapt.parseErrors);
  }
  if (parseErrors.length > 0) {
    // Anchors broke: reconciliation would be incomplete and misleading.
    return { ok: false, exitCode: 2, findings: [], parseErrors, truth };
  }

  const findings = reconcile(readme, adapt, truth);
  return { ok: findings.length === 0, exitCode: findings.length === 0 ? 0 : 1, findings, parseErrors: [], truth };
}

function formatReport(result, root) {
  const lines = [];
  lines.push('check-profiles: profile/inventory reconciliation gate');
  if (root) lines.push(`root: ${root}`);
  if (result.truth) {
    const d = result.truth.disk;
    const m = result.truth.manifest;
    lines.push(`ground truth (disk):     agents=${d.agents.length} skills=${d.skills.length} commands=${d.commands.length} hooks=${d.hooks.length}`);
    lines.push(`ground truth (manifest): agents=${m.agents.length} skills=${m.skills.length} commands=${m.commands.length} hooks=${m.hooks.length}`);
  }
  if (result.parseErrors.length > 0) {
    lines.push('', `PARSE ERRORS (${result.parseErrors.length}): an expected inventory anchor could not be located.`);
    for (const p of result.parseErrors) lines.push(`  ${p.file} [${p.check}] ${p.message}`);
    lines.push('', 'GATE: FAIL (parse). Fix the doc format or update the gate anchors; a broken anchor must never pass.');
    return lines.join('\n');
  }
  if (result.findings.length === 0) {
    lines.push('', 'GATE: PASS. Every profile/inventory claim reconciles with disk and manifest.');
    return lines.join('\n');
  }
  lines.push('', `FINDINGS (${result.findings.length}):`);
  let lastGroup = null;
  for (const f of result.findings) {
    if (f.group !== lastGroup) {
      lines.push('', `[${f.group}]`);
      lastGroup = f.group;
    }
    const loc = f.line != null ? `${f.file}:${f.line}` : f.file;
    const cv = typeof f.claimed === 'number' && typeof f.actual === 'number' ? `  claimed=${f.claimed} actual=${f.actual}` : '';
    lines.push(`  ${loc}  ${f.check}${cv}`);
    lines.push(`      ${f.message}`);
  }
  const groups = new Set(result.findings.map((f) => f.group));
  lines.push('', `GATE: FAIL. ${result.findings.length} finding(s) across ${groups.size} group(s).`);
  return lines.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const ri = argv.indexOf('--root');
  const root = ri !== -1 && argv[ri + 1] ? path.resolve(argv[ri + 1]) : path.resolve(__dirname, '..');
  const result = runGate(root);
  if (json) {
    console.log(JSON.stringify({
      ok: result.ok,
      exitCode: result.exitCode,
      groundTruth: result.truth ? { disk: result.truth.disk, manifest: result.truth.manifest } : null,
      findings: result.findings,
      parseErrors: result.parseErrors,
    }, null, 2));
  } else {
    console.log(formatReport(result, root));
  }
  process.exit(result.exitCode);
}

if (require.main === module) main();

module.exports = {
  parseReadme,
  parseAdapt,
  collectGroundTruth,
  reconcile,
  resolveProfile,
  runGate,
  formatReport,
  expandGlob,
};
