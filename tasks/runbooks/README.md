# Runbooks

A runbook is an operational playbook for a recurring procedure: the exact, tested steps for something an operator (or agent) does more than once — rotating a credential, restoring a backup, reprocessing a failed job batch, cutting a release, recovering from a known incident class. Unlike KNOWLEDGE.md entries (observations) or ADRs (decisions), a runbook is imperative: follow it top to bottom and the procedure is done. Agents read runbooks before performing the procedure they cover, so keep steps literal and copy-pasteable.

Add a runbook the second time you perform a non-trivial procedure by hand, or the first time an incident post-mortem names a recovery path — if it was worth figuring out twice, it is worth writing down once. Name files `<verb>-<subject>.md` (e.g. `rotate-webhook-secrets.md`, `reprocess-dead-letter-queue.md`), one procedure per file. Skeleton:

```markdown
# <Verb subject>
**When to run:** <trigger condition>
**Preconditions:** <access, state, backups required>
**Steps:** <numbered, literal commands>
**Verify:** <how you know it worked>
**Rollback:** <how to undo if it didn't>
```
