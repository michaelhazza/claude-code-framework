#!/usr/bin/env node
'use strict';
/**
 * validate-framework.js — structural health checks for the framework repo.
 *
 * Checks:
 *   1. Frontmatter — every .claude/skills/* /SKILL.md has a non-empty `name`
 *      and `description`; every .claude/commands/*.md has a non-empty
 *      `description`.
 *   2. Schemas — every schemas/*.json compiles under ajv (+ ajv-formats),
 *      with cross-file $refs resolvable.
 *   3. Markdown links — every relative link in a MANAGED .md file (per
 *      manifest.json managedFiles) resolves to a file in this repo.
 *      Exemptions: http(s)/mailto links, pure anchors (#...), template
 *      placeholders ({slug}, {{var}}), and the allowlist at
 *      scripts/validate-framework-allowlist.json:
 *        - consumerFiles: paths that exist only in CONSUMER repos (the
 *          framework legitimately cites them, e.g. architecture.md,
 *          CLAUDE.md, tasks/** artifacts). Supports exact paths and
 *          `dir/**` prefixes.
 *        - knownIssues: temporarily suppressed genuinely-broken links,
 *          each entry `{ "file", "target", "note" }`. Fix the doc and
 *          remove the entry — do NOT let this section grow silently.
 *   4. Agent frontmatter — every active agent definition (.claude/agents/*.md,
 *      excluding the _retired/ subdir and *.md.retired renames) has YAML
 *      frontmatter with non-empty `name` and `description`; `name` matches
 *      the filename stem; `model`/`tools`, when present, are non-empty and
 *      well-formed. Per-file failures.
 *   5. Hook wiring — every hook command registered in .claude/settings.json
 *      resolves to an existing file, and every entry-hook implementation
 *      under .claude/hooks/ (excluding *.test.* files and package.json) is
 *      registered in settings.json. Shared-library files that are require()d
 *      by hooks rather than registered directly go in the allowlist under
 *      `hookLibraries` (repo-relative paths). An unregistered hook ships dead.
 *   6. ADR index — the ADR set the framework ships (manifest category "adr",
 *      living in docs/decisions/) is cross-checked three ways: every manifest
 *      "adr" glob matches at least one file on disk; every index row in the
 *      per-directory README.md resolves to a disk file (and its link text
 *      matches the file's number); every NNNN-*.md ADR on disk has an index
 *      row. The framework DOES ship an index (docs/decisions/README.md
 *      § Index) — if that index is ever intentionally removed, update this
 *      check; it fails loudly on a missing index rather than silently
 *      passing with "no index to validate".
 *
 * Run: node scripts/validate-framework.js   (or `npm run validate`)
 * Exit 0 when all checks pass, 1 otherwise.
 */

const { existsSync, readdirSync, readFileSync, statSync } = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude-framework']);
const ALLOWLIST_PATH = path.join(__dirname, 'validate-framework-allowlist.json');

const errors = [];

function rel(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join('/');
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// ── 1. Frontmatter ──────────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(content);
  if (!m) return null;
  const fields = {};
  let currentKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      currentKey = kv[1];
      fields[currentKey] = kv[2].trim();
    } else if (currentKey && /^\s+\S/.test(line)) {
      // folded/indented continuation line
      fields[currentKey] = (fields[currentKey] + ' ' + line.trim()).trim();
    }
  }
  return fields;
}

function checkFrontmatter() {
  // Skills: .claude/skills/*/SKILL.md — require name + description
  const skillsDir = path.join(REPO_ROOT, '.claude', 'skills');
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) {
        errors.push(`frontmatter: .claude/skills/${entry.name}/ has no SKILL.md`);
        continue;
      }
      const fm = parseFrontmatter(readFileSync(skillFile, 'utf8'));
      if (!fm) {
        errors.push(`frontmatter: ${rel(skillFile)} has no frontmatter block`);
        continue;
      }
      if (!fm.name) errors.push(`frontmatter: ${rel(skillFile)} missing non-empty "name"`);
      if (!fm.description) errors.push(`frontmatter: ${rel(skillFile)} missing non-empty "description"`);
    }
  }

  // Commands: .claude/commands/*.md — require description
  const commandsDir = path.join(REPO_ROOT, '.claude', 'commands');
  if (existsSync(commandsDir)) {
    for (const entry of readdirSync(commandsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const cmdFile = path.join(commandsDir, entry.name);
      const fm = parseFrontmatter(readFileSync(cmdFile, 'utf8'));
      if (!fm) {
        errors.push(`frontmatter: ${rel(cmdFile)} has no frontmatter block`);
        continue;
      }
      if (!fm.description) errors.push(`frontmatter: ${rel(cmdFile)} missing non-empty "description"`);
    }
  }
}

// ── 1b. Skill overlay pointer coverage ──────────────────────────────────────
// Every .claude/skills/*/SKILL.md must carry the canonical skill-overlay
// pointer line (see references/skill-overlay-convention.md). The stable
// substring the gate greps for is the literal overlay path. A skill missing
// it fails validation — this is the enforceable half of the convention;
// framework-doctor Check 6 is the consumer-side advisory view.

const SKILL_POINTER_SUBSTRING = '.claude/context/skill-context.md';

function checkSkillPointers() {
  const skillsDir = path.join(REPO_ROOT, '.claude', 'skills');
  if (!existsSync(skillsDir)) return;
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(skillFile)) continue; // frontmatter check already reports a missing SKILL.md
    const body = readFileSync(skillFile, 'utf8');
    if (!body.includes(SKILL_POINTER_SUBSTRING)) {
      errors.push(
        `skill-pointer: ${rel(skillFile)} is missing the skill-overlay pointer line ` +
          `(expected substring "${SKILL_POINTER_SUBSTRING}"; see references/skill-overlay-convention.md)`,
      );
    }
  }
}

// ── 2. Schemas compile under ajv ────────────────────────────────────────────

function checkSchemas() {
  let Ajv, addFormats;
  try {
    Ajv = require('ajv');
    addFormats = require('ajv-formats');
  } catch (err) {
    errors.push(`schemas: ajv/ajv-formats not installed — run npm install (${err.message})`);
    return;
  }

  const schemasDir = path.join(REPO_ROOT, 'schemas');
  if (!existsSync(schemasDir)) return;

  const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);

  const schemaFiles = readdirSync(schemasDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(schemasDir, f));

  // First pass: register every schema so cross-file $refs resolve.
  const registered = [];
  for (const file of schemaFiles) {
    let schema;
    try {
      schema = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`schemas: ${rel(file)} is not valid JSON (${err.message})`);
      continue;
    }
    const key = schema.$id || rel(file);
    try {
      ajv.addSchema(schema, key);
      registered.push({ file, key });
    } catch (err) {
      errors.push(`schemas: ${rel(file)} failed to register (${err.message})`);
    }
  }

  // Second pass: force compilation.
  for (const { file, key } of registered) {
    try {
      const validate = ajv.getSchema(key);
      if (typeof validate !== 'function') {
        errors.push(`schemas: ${rel(file)} did not produce a validator`);
      }
    } catch (err) {
      errors.push(`schemas: ${rel(file)} failed to compile (${err.message})`);
    }
  }
}

// ── 3. Markdown link check over managed .md files ───────────────────────────

/** Translate a manifest glob (supports *, {a,b}) into a RegExp. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') re += '[^/]*';
    else if (ch === '{') {
      const end = glob.indexOf('}', i);
      const alts = glob.slice(i + 1, end).split(',');
      re += '(?:' + alts.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
      i = end;
    } else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function loadAllowlist() {
  try {
    const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
    return {
      consumerFiles: Array.isArray(raw.consumerFiles) ? raw.consumerFiles : [],
      knownIssues: Array.isArray(raw.knownIssues) ? raw.knownIssues : [],
    };
  } catch (err) {
    errors.push(`links: allowlist unreadable at ${rel(ALLOWLIST_PATH)} (${err.message})`);
    return { consumerFiles: [], knownIssues: [] };
  }
}

function isAllowlistedConsumerFile(target, consumerFiles) {
  for (const entry of consumerFiles) {
    if (entry.endsWith('/**')) {
      const prefix = entry.slice(0, -2); // keep trailing '/'
      if (target.startsWith(prefix)) return true;
    } else if (target === entry) {
      return true;
    }
  }
  return false;
}

function checkMarkdownLinks() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'manifest.json'), 'utf8'));
  } catch (err) {
    errors.push(`links: manifest.json unreadable (${err.message})`);
    return;
  }

  const patterns = (manifest.managedFiles || []).map((e) => globToRegExp(e.path));
  const allFiles = walk(REPO_ROOT, []).map(rel);
  const managedMd = allFiles.filter(
    (f) => f.endsWith('.md') && patterns.some((re) => re.test(f)),
  );

  const { consumerFiles, knownIssues } = loadAllowlist();
  const knownIssueSet = new Set(knownIssues.map((k) => `${k.file}::${k.target}`));
  const usedKnownIssues = new Set();

  const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

  for (const mdFile of managedMd) {
    const content = readFileSync(path.join(REPO_ROOT, mdFile), 'utf8');

    // Strip fenced code blocks — links inside code samples are illustrative.
    const withoutCode = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

    let m;
    while ((m = LINK_RE.exec(withoutCode)) !== null) {
      let target = m[1].trim();
      if (!target) continue;
      if (/^(https?:|mailto:|#)/i.test(target)) continue; // external / anchor-only
      if (/[{}<>]/.test(target)) continue; // template placeholder ({slug}, {{var}}, <path>)
      target = target.split('#')[0]; // drop anchors
      if (!target) continue;
      try {
        target = decodeURI(target);
      } catch {
        /* keep raw */
      }

      // Resolve relative to the containing file, falling back to repo root
      // (many framework docs cite repo-root-relative paths from nested files).
      const fromFile = path.normalize(path.join(path.dirname(mdFile), target));
      const fromRoot = path.normalize(target.replace(/^\.\//, ''));
      const resolvedRel = [fromFile, fromRoot].map((p) => p.split(path.sep).join('/'));

      if (resolvedRel.some((p) => existsSync(path.join(REPO_ROOT, p)))) continue;

      // Consumer-only cite?
      if (resolvedRel.some((p) => isAllowlistedConsumerFile(p, consumerFiles))) continue;
      if (isAllowlistedConsumerFile(target, consumerFiles)) continue;

      // Known (temporarily suppressed) issue?
      const issueKey = `${mdFile}::${m[1].trim()}`;
      if (knownIssueSet.has(issueKey)) {
        usedKnownIssues.add(issueKey);
        continue;
      }

      errors.push(`links: ${mdFile} → "${m[1].trim()}" does not resolve`);
    }
  }

  // Stale suppressions are debt — flag them so the list shrinks over time.
  for (const key of knownIssueSet) {
    if (!usedKnownIssues.has(key)) {
      const [file, target] = key.split('::');
      errors.push(
        `links: stale knownIssues entry (link no longer present/broken): ${file} → "${target}" — remove it from the allowlist`,
      );
    }
  }

  return managedMd.length;
}

// ── Bundle hygiene ──────────────────────────────────────────────────────────
// The shipped bundle must carry only scaffolding under tasks/ — real build
// artifacts, review logs, and raw model output are origin-project pollution
// that propagates to every consumer (audit issue #32, B8).

function checkBundleHygiene() {
  const buildsDir = path.join(REPO_ROOT, 'tasks', 'builds');
  if (existsSync(buildsDir)) {
    for (const name of readdirSync(buildsDir)) {
      if (name !== '_example') {
        errors.push(`bundle-hygiene: tasks/builds/${name} — only _example/ may ship; archive or delete before release`);
      }
    }
  }
  const logsDir = path.join(REPO_ROOT, 'tasks', 'review-logs');
  const allowedLogs = new Set(['README.md', 'prompt-evolution-log.md']);
  if (existsSync(logsDir)) {
    for (const name of readdirSync(logsDir)) {
      if (!allowedLogs.has(name)) {
        errors.push(`bundle-hygiene: tasks/review-logs/${name} — only README.md and prompt-evolution-log.md may ship`);
      }
    }
  }
}

// ── 4. Agent frontmatter ────────────────────────────────────────────────────
// The agent fleet had no deterministic gate — checkFrontmatter covers only
// skills and commands. Every ACTIVE agent (.claude/agents/*.md; the _retired/
// subdir and *.md.retired renames are excluded — retired agents keep their
// original frontmatter under a dated filename, so stem-matching would
// misfire) must carry frontmatter with non-empty name + description, a name
// matching the filename stem, and — when present — non-empty, well-formed
// model / tools keys.

const MODEL_RE = /^[A-Za-z0-9._-]+$/; // opus | sonnet | haiku | inherit | full model ids
const TOOL_ENTRY_RE = /^(\*|[A-Za-z][A-Za-z0-9_-]*)$/; // Read, Bash, TodoWrite, mcp__x__y, *

function checkAgentFrontmatter(root = REPO_ROOT, errs = errors) {
  const agentsDir = path.join(root, '.claude', 'agents');
  if (!existsSync(agentsDir)) {
    errs.push('agent-frontmatter: .claude/agents/ not found — agent fleet missing, nothing to validate (fail-loud)');
    return 0;
  }

  let count = 0;
  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    // Subdirectories (e.g. _retired/) are not active agents. Files that are
    // not plain .md (e.g. *.md.retired) are excluded by the suffix test.
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    count += 1;
    const agentFile = path.join(agentsDir, entry.name);
    const relFile = `.claude/agents/${entry.name}`;
    const fm = parseFrontmatter(readFileSync(agentFile, 'utf8'));
    if (!fm) {
      errs.push(`agent-frontmatter: ${relFile} has no frontmatter block`);
      continue;
    }
    if (!fm.name) {
      errs.push(`agent-frontmatter: ${relFile} missing non-empty "name"`);
    } else {
      const stem = entry.name.replace(/\.md$/, '');
      if (fm.name !== stem) {
        errs.push(`agent-frontmatter: ${relFile} "name" is "${fm.name}" but filename stem is "${stem}"`);
      }
    }
    if (!fm.description) {
      errs.push(`agent-frontmatter: ${relFile} missing non-empty "description"`);
    }
    if ('model' in fm) {
      if (!fm.model) {
        errs.push(`agent-frontmatter: ${relFile} has an empty "model" key`);
      } else if (!MODEL_RE.test(fm.model)) {
        errs.push(`agent-frontmatter: ${relFile} "model" is malformed: "${fm.model}"`);
      }
    }
    if ('tools' in fm) {
      if (!fm.tools) {
        errs.push(`agent-frontmatter: ${relFile} has an empty "tools" key`);
      } else {
        const entries = fm.tools.split(',').map((t) => t.trim());
        for (const tool of entries) {
          if (!tool) {
            errs.push(`agent-frontmatter: ${relFile} "tools" has an empty entry: "${fm.tools}"`);
          } else if (!TOOL_ENTRY_RE.test(tool)) {
            errs.push(`agent-frontmatter: ${relFile} "tools" entry is malformed: "${tool}"`);
          }
        }
      }
    }
  }

  if (count === 0) {
    errs.push('agent-frontmatter: no agent .md files found in .claude/agents/ — the framework ships an agent fleet (fail-loud)');
  }
  return count;
}

// ── 5. Hook wiring ──────────────────────────────────────────────────────────
// Two directions. Forward: every hook command registered in
// .claude/settings.json that references a repo path (via $CLAUDE_PROJECT_DIR
// or a relative .claude/hooks/ path) must resolve to an existing file — a
// registration pointing at a deleted hook fails at runtime in every consumer.
// Reverse: every entry-hook implementation under .claude/hooks/ (top level;
// *.test.* files and package.json are not hooks) must be registered —
// an unregistered hook ships dead. Shared-library files that hooks require()
// instead of being registered belong in the allowlist under `hookLibraries`
// (as of v2.44 every non-test .js in .claude/hooks/ IS a registered entry
// hook, so the list ships empty). A missing allowlist file is tolerated
// (fixture roots) — absence can only produce MORE errors, never mask one.

const HOOK_SOURCE_RE = /\.(js|cjs|mjs)$/;
const HOOK_TEST_RE = /\.test\.(js|cjs|mjs)$/;

function readAllowlistArray(root, key) {
  const allowlistPath = path.join(root, 'scripts', 'validate-framework-allowlist.json');
  if (!existsSync(allowlistPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(allowlistPath, 'utf8'));
    return Array.isArray(raw[key]) ? raw[key] : [];
  } catch {
    return []; // loadAllowlist() already reports an unreadable allowlist
  }
}

/** Extract repo-relative file paths referenced by a hook command string. */
function extractHookCommandPaths(command) {
  const paths = [];
  // $CLAUDE_PROJECT_DIR (optionally braced / quote-adjacent) + path remainder
  const varRe = /\$\{?CLAUDE_PROJECT_DIR\}?"?([^\s"']+)/g;
  let m;
  while ((m = varRe.exec(command)) !== null) paths.push(m[1].replace(/^\//, ''));
  // bare repo-relative .claude/hooks/... tokens
  const relRe = /(?:^|[\s"'=])(\.claude\/hooks\/[^\s"']+)/g;
  while ((m = relRe.exec(command)) !== null) paths.push(m[1]);
  return [...new Set(paths)];
}

function checkHookWiring(root = REPO_ROOT, errs = errors) {
  const settingsPath = path.join(root, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    errs.push('hook-wiring: .claude/settings.json not found — hook registrations missing (fail-loud)');
    return 0;
  }
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    errs.push(`hook-wiring: .claude/settings.json is not valid JSON (${err.message})`);
    return 0;
  }

  const hooksConfig = settings.hooks;
  if (!hooksConfig || typeof hooksConfig !== 'object' || Object.keys(hooksConfig).length === 0) {
    errs.push('hook-wiring: .claude/settings.json has no "hooks" registrations (fail-loud)');
    return 0;
  }

  // Forward direction: registered command paths resolve on disk.
  const registeredPaths = new Set();
  for (const [event, groups] of Object.entries(hooksConfig)) {
    if (!Array.isArray(groups)) {
      errs.push(`hook-wiring: settings.json hooks.${event} is not an array`);
      continue;
    }
    for (const group of groups) {
      const hookList = group && Array.isArray(group.hooks) ? group.hooks : [];
      if (hookList.length === 0) {
        errs.push(`hook-wiring: settings.json hooks.${event} has a matcher group with no hooks`);
      }
      for (const hook of hookList) {
        const command = hook && typeof hook.command === 'string' ? hook.command : '';
        if (!command) {
          errs.push(`hook-wiring: settings.json hooks.${event} has a hook entry with no command`);
          continue;
        }
        const cmdPaths = extractHookCommandPaths(command);
        if (cmdPaths.length === 0 && command.includes('.claude/hooks')) {
          // References the hooks dir in a shape we cannot statically resolve —
          // never let that silently pass.
          errs.push(`hook-wiring: settings.json hooks.${event} command references .claude/hooks but no path could be extracted: "${command}"`);
        }
        for (const p of cmdPaths) {
          const normalized = path.normalize(p).split(path.sep).join('/');
          if (!existsSync(path.join(root, normalized))) {
            errs.push(`hook-wiring: settings.json hooks.${event} registers "${normalized}" which does not exist`);
          }
          registeredPaths.add(normalized);
        }
      }
    }
  }

  // Reverse direction: every entry hook on disk is registered.
  const hooksDir = path.join(root, '.claude', 'hooks');
  if (!existsSync(hooksDir)) {
    errs.push('hook-wiring: .claude/hooks/ not found — hook implementations missing (fail-loud)');
    return registeredPaths.size;
  }
  const hookLibraries = readAllowlistArray(root, 'hookLibraries');
  const librarySet = new Set(hookLibraries);
  const usedLibraries = new Set();

  let entryCount = 0;
  for (const entry of readdirSync(hooksDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!HOOK_SOURCE_RE.test(entry.name) || HOOK_TEST_RE.test(entry.name)) continue;
    const relFile = `.claude/hooks/${entry.name}`;
    if (librarySet.has(relFile)) {
      usedLibraries.add(relFile);
      continue; // shared library, not an entry hook
    }
    entryCount += 1;
    if (!registeredPaths.has(relFile)) {
      errs.push(`hook-wiring: ${relFile} is not registered in .claude/settings.json — an unregistered hook ships dead (register it or allowlist it under "hookLibraries")`);
    }
  }

  if (entryCount === 0 && librarySet.size === 0) {
    errs.push('hook-wiring: no hook implementation files found in .claude/hooks/ (fail-loud)');
  }

  // Stale allowlist entries are debt — same policy as knownIssues. An entry
  // is stale if the file is registered in settings.json (then it is an entry
  // hook, not a library — registration wins) or if it no longer exists.
  for (const lib of hookLibraries) {
    if (registeredPaths.has(lib)) {
      errs.push(`hook-wiring: stale hookLibraries allowlist entry "${lib}" — it is registered in settings.json (so it is an entry hook, not a library); remove it from the allowlist`);
    } else if (!usedLibraries.has(lib)) {
      errs.push(`hook-wiring: stale hookLibraries allowlist entry "${lib}" — no such file exists on disk; remove it from the allowlist`);
    }
  }

  return entryCount;
}

// ── 6. ADR index ────────────────────────────────────────────────────────────
// The framework ships its ADR set via manifest category "adr" (docs/decisions/
// NNNN-*.md plus README.md + _template.md) and an index table in
// docs/decisions/README.md § Index. Cross-checked three ways:
//   a. every manifest "adr" glob matches at least one file on disk;
//   b. every index row [NNNN](./file.md) resolves to a disk file, and the
//      link text NNNN matches the file's number prefix;
//   c. every NNNN-*.md ADR on disk has an index row.
// The index EXISTS today — a missing README.md is a regression and fails
// loudly here; this check never reports "no index to validate" for this repo.
// (If the framework ever intentionally drops the index, update this check in
// the same commit.)

const ADR_FILE_RE = /^\d{4}-.+\.md$/;
const ADR_ROW_RE = /\[(\d{4})\]\(\.\/([^)#\s]+\.md)\)/g;

function checkAdrIndex(root = REPO_ROOT, errs = errors) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  } catch (err) {
    errs.push(`adr-index: manifest.json unreadable (${err.message})`);
    return 0;
  }

  const adrEntries = (manifest.managedFiles || []).filter((e) => e.category === 'adr');
  if (adrEntries.length === 0) {
    errs.push('adr-index: manifest.json has no category "adr" entries — the framework ships ADRs (fail-loud; update this check if that ever intentionally changes)');
    return 0;
  }

  // Locate the directories the ADR set lives in (today: docs/decisions).
  const adrDirs = [...new Set(adrEntries.map((e) => path.posix.dirname(e.path)))];

  // Collect disk files per dir, and verify each manifest glob matches disk.
  const diskFilesByDir = new Map();
  for (const dir of adrDirs) {
    const absDir = path.join(root, dir);
    if (!existsSync(absDir)) {
      errs.push(`adr-index: manifest "adr" directory ${dir}/ does not exist on disk`);
      diskFilesByDir.set(dir, []);
      continue;
    }
    diskFilesByDir.set(
      dir,
      readdirSync(absDir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name),
    );
  }
  const allDiskRel = [];
  for (const [dir, names] of diskFilesByDir) {
    for (const n of names) allDiskRel.push(`${dir}/${n}`);
  }
  for (const entry of adrEntries) {
    const re = globToRegExp(entry.path);
    if (!allDiskRel.some((f) => re.test(f))) {
      errs.push(`adr-index: manifest "adr" entry "${entry.path}" matches no file on disk`);
    }
  }

  let adrCount = 0;
  for (const [dir, names] of diskFilesByDir) {
    const adrFiles = names.filter((n) => ADR_FILE_RE.test(n));
    adrCount += adrFiles.length;

    const indexPath = path.join(root, dir, 'README.md');
    if (!existsSync(indexPath)) {
      errs.push(`adr-index: ${dir}/README.md not found — the ADR index is missing (fail-loud)`);
      continue;
    }

    // Strip fenced code + inline code so illustrative rows don't count.
    const content = readFileSync(indexPath, 'utf8')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`\n]*`/g, '');

    const rowTargets = new Set();
    let m;
    ADR_ROW_RE.lastIndex = 0;
    while ((m = ADR_ROW_RE.exec(content)) !== null) {
      const [, linkNumber, target] = m;
      rowTargets.add(target);
      // b. row target exists on disk
      if (!names.includes(target)) {
        errs.push(`adr-index: ${dir}/README.md index row [${linkNumber}](./${target}) points at a missing file`);
      }
      // b. link text matches the file's number prefix
      if (!target.startsWith(`${linkNumber}-`)) {
        errs.push(`adr-index: ${dir}/README.md index row [${linkNumber}](./${target}) — link text does not match the file's number prefix`);
      }
    }

    if (rowTargets.size === 0) {
      errs.push(`adr-index: ${dir}/README.md contains no parseable index rows (expected [NNNN](./NNNN-slug.md) links) (fail-loud)`);
      continue;
    }

    // c. every disk ADR has an index row
    for (const adrFile of adrFiles) {
      if (!rowTargets.has(adrFile)) {
        errs.push(`adr-index: ${dir}/${adrFile} exists on disk but has no index row in ${dir}/README.md`);
      }
    }
  }

  if (adrCount === 0) {
    errs.push('adr-index: no NNNN-*.md ADR files found on disk in the manifest "adr" directories (fail-loud)');
  }
  return adrCount;
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  checkFrontmatter();
  checkSkillPointers();
  checkSchemas();
  checkBundleHygiene();
  const agentCount = checkAgentFrontmatter();
  const hookCount = checkHookWiring();
  const adrCount = checkAdrIndex();
  const mdCount = checkMarkdownLinks();

  if (errors.length > 0) {
    console.error(`validate-framework: ${errors.length} error(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    `validate-framework: OK (frontmatter, schemas, ${agentCount} agents, ` +
      `${hookCount} wired hooks, ${adrCount} indexed ADRs, links across ${mdCount || 0} managed .md files)`,
  );
}

if (require.main === module) {
  main();
}

// Exported for scripts/__tests__/validate-framework-extensions.test.ts —
// each check takes (root, errs) so tests run against fixture trees without
// touching this repo. CLI behaviour is unchanged (require.main guard above).
module.exports = {
  parseFrontmatter,
  checkAgentFrontmatter,
  checkHookWiring,
  checkAdrIndex,
};
