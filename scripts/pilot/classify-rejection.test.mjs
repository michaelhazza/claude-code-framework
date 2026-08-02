/**
 * classify-rejection.test.mjs
 *
 * Offline unit test of the pure classifier — no live token, no network.
 * Covers the branches spec §12.B Chunk B1 calls out explicitly: a forbidden
 * action unexpectedly succeeding (FAIL, named), an auth/network error
 * (INCONCLUSIVE), and the positive control observed rejected (FAIL), plus
 * the all-expected-met PASS path and the never-throws contract.
 */
import { describe, expect, it } from 'vitest';
import { classifyRejection } from './classify-rejection.mjs';

/** A full set of six passing probes, mirroring rejection-test.sh's cases. */
function passingProbes() {
  return [
    { name: 'positive-control', action: 'push-feature-branch-open-pr', expected: 'allowed', observed: 'allowed' },
    { name: 'direct-push-default', action: 'direct-push', expected: 'rejected', observed: 'rejected' },
    { name: 'force-push-default', action: 'force-push', expected: 'rejected', observed: 'rejected' },
    { name: 'delete-default-branch', action: 'delete-branch', expected: 'rejected', observed: 'rejected' },
    { name: 'merge-without-approval', action: 'merge-pr', expected: 'rejected', observed: 'rejected' },
    { name: 'agent-approval-openclaw-pr', action: 'approve-pr', expected: 'rejected', observed: 'rejected' },
    { name: 'agent-approval-claude-pr', action: 'approve-pr', expected: 'rejected', observed: 'rejected' },
  ];
}

describe('classifyRejection', () => {
  it('returns PASS when every probe met its expected outcome', () => {
    const result = classifyRejection(passingProbes());
    expect(result.verdict).toBe('PASS');
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('returns FAIL, naming the action, when a forbidden action is observed allowed', () => {
    const probes = passingProbes();
    probes[1] = { name: 'direct-push-default', action: 'direct-push', expected: 'rejected', observed: 'allowed' };
    const result = classifyRejection(probes);
    expect(result.verdict).toBe('FAIL');
    expect(result.reasons.some((r) => r.includes('direct-push') && r.toLowerCase().includes('allowed'))).toBe(true);
  });

  it('returns FAIL when the positive control is observed rejected', () => {
    const probes = passingProbes();
    probes[0] = { name: 'positive-control', action: 'push-feature-branch-open-pr', expected: 'allowed', observed: 'rejected' };
    const result = classifyRejection(probes);
    expect(result.verdict).toBe('FAIL');
    expect(result.reasons.some((r) => r.includes('positive-control'))).toBe(true);
  });

  it('returns INCONCLUSIVE on an auth/network error observation', () => {
    const probes = passingProbes();
    probes[2] = { name: 'force-push-default', action: 'force-push', expected: 'rejected', observed: 'error', detail: 'auth failure: 401' };
    const result = classifyRejection(probes);
    expect(result.verdict).toBe('INCONCLUSIVE');
    expect(result.reasons.some((r) => r.includes('force-push-default') && r.includes('401'))).toBe(true);
  });

  it('prefers FAIL over INCONCLUSIVE when both are present in the same run', () => {
    const probes = passingProbes();
    probes[1] = { name: 'direct-push-default', action: 'direct-push', expected: 'rejected', observed: 'allowed' };
    probes[2] = { name: 'force-push-default', action: 'force-push', expected: 'rejected', observed: 'error' };
    const result = classifyRejection(probes);
    expect(result.verdict).toBe('FAIL');
  });

  it('names both the OpenClaw-authored and Claude-authored agent-approval probes when either fails', () => {
    const probes = passingProbes();
    probes[5] = { name: 'agent-approval-openclaw-pr', action: 'approve-pr', expected: 'rejected', observed: 'allowed' };
    const result = classifyRejection(probes);
    expect(result.verdict).toBe('FAIL');
    expect(result.reasons.some((r) => r.includes('agent-approval-openclaw-pr'))).toBe(true);
  });

  it('is INCONCLUSIVE with no exception on an empty probe list', () => {
    const result = classifyRejection([]);
    expect(result.verdict).toBe('INCONCLUSIVE');
  });

  it('never throws on malformed input', () => {
    for (const bad of [null, undefined, 'a string', 42, {}, [null, undefined, 42, 'x']]) {
      expect(() => classifyRejection(bad)).not.toThrow();
      const result = classifyRejection(bad);
      expect(['PASS', 'FAIL', 'INCONCLUSIVE']).toContain(result.verdict);
    }
  });

  it('treats an unrecognised expected/observed value as INCONCLUSIVE, not a crash', () => {
    const probes = [{ name: 'bad-probe', action: 'x', expected: 'maybe', observed: 'allowed' }];
    const result = classifyRejection(probes);
    expect(result.verdict).toBe('INCONCLUSIVE');
  });
});
