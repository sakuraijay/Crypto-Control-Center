import { describe, expect, it, vi } from 'vitest';
import { checkGitHubCiAttestation, findAttestedWorkflowRun } from '../lib/githubCiAttestation';

const SHA = 'a'.repeat(40);
const GOOD_RUN = {
  id: 32324804668,
  run_number: 96,
  workflow_id: 335563590,
  name: 'CI — TypeScript · Build · Tests',
  event: 'pull_request',
  status: 'completed',
  conclusion: 'success',
  head_branch: 'codex/handover-20260820',
  head_sha: SHA,
};

describe('build-bound public GitHub CI attestation', () => {
  it('accepts only the pinned successful workflow for the exact release SHA', () => {
    expect(findAttestedWorkflowRun({ workflow_runs: [GOOD_RUN] }, SHA)).toEqual(GOOD_RUN);
    expect(findAttestedWorkflowRun({ workflow_runs: [{ ...GOOD_RUN, conclusion: 'failure' }] }, SHA)).toBeNull();
    expect(findAttestedWorkflowRun({ workflow_runs: [{ ...GOOD_RUN, head_sha: 'b'.repeat(40) }] }, SHA)).toBeNull();
    expect(findAttestedWorkflowRun({ workflow_runs: [{ ...GOOD_RUN, workflow_id: 1 }] }, SHA)).toBeNull();
    expect(findAttestedWorkflowRun({ workflow_runs: [{ ...GOOD_RUN, event: 'push' }] }, SHA)).toBeNull();
  });

  it('returns attested only after a bounded public API success', async () => {
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(JSON.stringify({ workflow_runs: [GOOD_RUN] }), { status: 200 });
    };
    const result = await checkGitHubCiAttestation({ releaseSha: SHA, fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('run #96');
    expect(requestedUrl).toContain(`head_sha=${SHA}`);
    expect(requestedInit?.headers).not.toHaveProperty('authorization');
  });

  it('fails closed for missing SHA, HTTP errors, malformed payload, and mismatch', async () => {
    expect((await checkGitHubCiAttestation({ releaseSha: null, fetchImpl: vi.fn() })).ok).toBe(false);
    expect((await checkGitHubCiAttestation({
      releaseSha: SHA,
      fetchImpl: vi.fn(async () => new Response('{}', { status: 429 })),
    })).ok).toBe(false);
    expect((await checkGitHubCiAttestation({
      releaseSha: SHA,
      fetchImpl: vi.fn(async () => new Response('{}', { status: 200 })),
    })).ok).toBe(false);
    expect((await checkGitHubCiAttestation({
      releaseSha: SHA,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        workflow_runs: [{ ...GOOD_RUN, head_branch: 'main' }],
      }), { status: 200 })),
    })).ok).toBe(false);
  });
});
