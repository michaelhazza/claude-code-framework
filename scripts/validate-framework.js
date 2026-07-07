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

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  checkFrontmatter();
  checkSchemas();
  checkBundleHygiene();
  const mdCount = checkMarkdownLinks();

  if (errors.length > 0) {
    console.error(`validate-framework: ${errors.length} error(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    `validate-framework: OK (frontmatter, schemas, links across ${mdCount || 0} managed .md files)`,
  );
}

main();
