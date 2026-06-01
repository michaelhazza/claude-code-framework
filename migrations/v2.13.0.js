'use strict';

/**
 * v2.13.0 migration — half 1 of 2 (.gitignore for phase markers).
 * Chunk 7 appends the sibling_repos half to the same migrate() function.
 *
 * Half 1 (this chunk): idempotently append the line 'tasks/builds/.phase'
 * (glob: tasks/builds/star/.phase) to the consumer .gitignore so per-build
 * phase marker files are not committed to version control. Phase markers are
 * ephemeral coordination state; they must not appear in git history.
 *
 * Half 2 (Chunk 7): adds `sibling_repos[]` field seeding to
 * .claude/project-registries.json for the cross-repo-scout agent.
 *
 * Idempotent. Safe to re-run. Non-destructive.
 *
 * @param {{ consumerRoot: string, frameworkRoot: string, fromVersion: string, toVersion: string }} ctx
 * @returns {Promise<{ status: 'applied'|'skipped', notes: string[] }>}
 */
async function migrate(ctx) {
  const fs = require('fs');
  const fsp = require('fs/promises');
  const path = require('path');

  const { consumerRoot } = ctx;
  const notes = [];

  // -----------------------------------------------------------------------
  // Half 1 — idempotently append `tasks/builds/*/.phase` to consumer
  // .gitignore. Phase marker files are ephemeral coordination state (written
  // by coordinators, read by the phase-lock hook) and must not be committed.
  // -----------------------------------------------------------------------
  const gitignorePath = path.join(consumerRoot, '.gitignore');
  const gitignoreLine = 'tasks/builds/*/.phase';
  let gitignoreContent = '';
  try { gitignoreContent = fs.readFileSync(gitignorePath, 'utf8'); } catch { /* file absent */ }

  const hasLine = gitignoreContent
    .split(/\r?\n/)
    .some((line) => line.trim() === gitignoreLine);

  if (!hasLine) {
    const sep = gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n') ? '\n' : '';
    const addition = `${sep}${gitignoreLine}\n`;
    await fsp.writeFile(gitignorePath, gitignoreContent + addition, 'utf8');
    notes.push(`Appended ${gitignoreLine} to .gitignore (phase marker files are ephemeral, must not be committed).`);
  } else {
    notes.push(`.gitignore already excludes ${gitignoreLine} — left untouched.`);
  }

  const status = 'applied';
  return { status, notes };
}

module.exports = { migrate };
