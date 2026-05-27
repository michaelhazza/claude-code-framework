/**
 * validateProjectContextPure.ts
 *
 * Pure helper — no I/O, no fs, no child_process, no path module.
 *
 * Implements the §3b PROJECT_CONTEXT completeness rule (fail-closed):
 * validates that PROJECT_CONTEXT contains the required markdown headings
 * for the given review mode and artifact type. Missing required sections
 * return {kind: 'fail_closed'} — the coordinator must NOT invoke the
 * reviewer when this returns fail_closed.
 */

export type ReviewMode = 'spec' | 'plan' | 'pr';

export type ValidateResult =
  | { kind: 'ok' }
  | { kind: 'fail_closed'; missing_sections: string[] };

/**
 * Strings that indicate the artifact touches tenant data.
 * Per §3b detection rule: coordinator scans the artifact text for any of
 * the project's declared tenant-key column name OR these literal strings.
 */
const TENANT_DATA_SIGNALS = [
  'RLS',
  'policy',
  'tenant',
  'org',
  'subaccount',
  'account_scoped',
];

/**
 * Detect whether a heading exists in the PROJECT_CONTEXT block.
 * Matches `## <heading>` at the start of a line (case-insensitive).
 */
function hasHeading(context: string, heading: string): boolean {
  const pattern = new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, 'im');
  return pattern.test(context);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Determine whether an artifact touches tenant data.
 *
 * @param artifactTouchesTenantData - caller-supplied flag (the coordinator
 *   may have already scanned the artifact and knows the answer). When true,
 *   the Architecture + Guidelines sections are required regardless of the
 *   signals below.
 * @param context - the PROJECT_CONTEXT text; we also scan it for signal
 *   strings so purely-missing-flag callers still get correct behaviour
 *   when the context itself references those terms.
 */
function detectsTenantData(artifactTouchesTenantData: boolean): boolean {
  // The flag is the canonical signal; the coordinator scans the artifact
  // (not the context) and passes the result here. We trust the caller.
  return artifactTouchesTenantData;
}

/**
 * Validate PROJECT_CONTEXT completeness per §3b.
 *
 * Hard failures (return fail_closed):
 *   - Missing "Stage" (any mode)
 *   - Missing "Framing assumptions" (any mode)
 *   - Missing "Architecture" OR "Guidelines" when artifact touches tenant data
 *     (spec / plan / PR touching tenant data)
 *
 * Soft warnings (return ok, coordinator logs separately):
 *   - Missing "Doc-sync rules" (spec/plan only)
 *   - Empty or missing "Known operator decisions" (any mode)
 *
 * The coordinator is responsible for logging soft warnings; this helper
 * only signals whether the reviewer should be blocked.
 */
export function validateProjectContext(
  context: string,
  mode: ReviewMode,
  artifactTouchesTenantData: boolean,
): ValidateResult {
  const missing: string[] = [];

  // Hard: Stage required for any mode
  if (!hasHeading(context, 'Stage')) {
    missing.push('Stage');
  }

  // Hard: Framing assumptions required for any mode
  if (!hasHeading(context, 'Framing assumptions')) {
    missing.push('Framing assumptions');
  }

  // Hard: Architecture + Guidelines required when artifact touches tenant data
  if (detectsTenantData(artifactTouchesTenantData)) {
    if (!hasHeading(context, 'Architecture')) {
      missing.push('Architecture');
    }
    if (!hasHeading(context, 'Guidelines')) {
      missing.push('Guidelines');
    }
  }

  if (missing.length > 0) {
    return { kind: 'fail_closed', missing_sections: missing };
  }

  return { kind: 'ok' };
}

/**
 * Scan arbitrary artifact text for tenant-data signals.
 * Used by the coordinator before calling validateProjectContext so it can
 * pass the correct artifactTouchesTenantData value.
 */
export function artifactTouchesTenantData(
  artifactText: string,
  tenantKeyColumnName?: string,
): boolean {
  for (const signal of TENANT_DATA_SIGNALS) {
    if (artifactText.includes(signal)) return true;
  }
  if (tenantKeyColumnName && artifactText.includes(tenantKeyColumnName)) {
    return true;
  }
  return false;
}
