import { describe, expect, it } from 'vitest';
import { deriveOperationalDiagnostics } from '../lib/operationalDiagnostics';
import type { ReleaseIdentity } from '../lib/releaseIdentity';

const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

function identity(
  workspaceTree = TREE,
  configuredOverrides: Partial<ReleaseIdentity['configuredSafetyFlags']> = {},
): ReleaseIdentity {
  return {
    schemaVersion: 1,
    releaseSha: SHA,
    productTree: TREE,
    buildId: 'c'.repeat(64),
    builtAt: '2026-08-28T10:00:00.000Z',
    workspaceSource: { headSha: SHA, productTree: workspaceTree },
    configuredSafetyFlags: {
      engineMode: 'PAPER',
      autoWorkerLiveEnabled: false,
      liveTestExecutionLocked: true,
      delegatedSignerEnabled: false,
      gmxOrderSubmissionEnabled: false,
      relaySubmissionEnabled: false,
      relaySubmitNetworkEnabled: false,
      relayMode: 'DISABLED',
      ...configuredOverrides,
    },
    safetyContract: {
      version: 'post-publish-safety/v1',
      confirmedOpenInitialStop: {
        version: 'confirmed-open-initial-stop/v1',
        sha256: 'd'.repeat(64),
        files: [],
      },
    },
    topology: { processCount: 1, port: 8080, owner: 'api-server' },
    webAssets: [],
  };
}

const relayOff = {
  relaySubmitNetworkEnabled: false,
  relaySubmissionEnabled: false,
  relayMode: 'DISABLED' as const,
};

describe('operational configured/effective diagnostics', () => {
  it('reports matching safe flags and matching product provenance', () => {
    const result = deriveOperationalDiagnostics({}, {
      engineMode: 'PAPER',
      liveExecutionLocked: true,
      relayFlags: relayOff,
    }, identity());
    expect(result.flags.engineMode.status).toBe('MATCH');
    expect(result.flags.gmxOrderSubmissionEnabled).toMatchObject({
      configured: false, effective: false, status: 'MATCH',
    });
    expect(result.provenance).toMatchObject({
      status: 'MATCH', sameCommit: true, sameProductTree: true,
    });
  });

  it('explains a build-configured flag that differs from the current process', () => {
    const result = deriveOperationalDiagnostics({
      LIVE_TEST_EXECUTION_LOCKED: 'false',
    }, {
      engineMode: 'PAPER',
      liveExecutionLocked: false,
      relayFlags: relayOff,
    }, identity(TREE, {
      delegatedSignerEnabled: true,
      gmxOrderSubmissionEnabled: true,
      liveTestExecutionLocked: true,
    }));
    expect(result.flags.delegatedSignerEnabled).toMatchObject({
      configured: true, effective: false, status: 'DRIFT',
    });
    expect(result.flags.gmxOrderSubmissionEnabled).toMatchObject({
      configured: true, effective: false, status: 'DRIFT',
    });
    expect(result.flags.liveTestExecutionLocked).toMatchObject({
      configured: true, effective: false, status: 'DRIFT',
    });
  });

  it('reports product-tree mismatch and missing evidence without claiming match', () => {
    const runtime = {
      engineMode: 'PAPER' as const,
      liveExecutionLocked: true,
      relayFlags: relayOff,
    };
    expect(deriveOperationalDiagnostics({}, runtime, identity('e'.repeat(40))).provenance.status)
      .toBe('DRIFT');
    expect(deriveOperationalDiagnostics({}, runtime, null).provenance.status)
      .toBe('UNAVAILABLE');
  });

  it('preserves unavailable relay effective evidence', () => {
    const result = deriveOperationalDiagnostics({}, {
      engineMode: 'PAPER',
      liveExecutionLocked: true,
      relayFlags: null,
    }, identity());
    expect(result.flags.relayMode.status).toBe('UNAVAILABLE');
    expect(result.flags.relaySubmitNetworkEnabled.effective).toBeNull();
  });

  it('does not claim configured evidence when release identity is missing', () => {
    const result = deriveOperationalDiagnostics({}, {
      engineMode: 'PAPER',
      liveExecutionLocked: true,
      relayFlags: relayOff,
    }, null);
    expect(result.flags.engineMode).toMatchObject({
      configured: null, effective: 'PAPER', status: 'UNAVAILABLE',
    });
  });
});