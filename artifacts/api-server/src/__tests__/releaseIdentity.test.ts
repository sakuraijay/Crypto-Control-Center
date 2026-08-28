import { describe, expect, it } from 'vitest';
import {
  CONFIRMED_OPEN_HANDOFF_CONTRACT_FILES,
  parseReleaseIdentity,
} from '../lib/releaseIdentity';

const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const HASH = 'c'.repeat(64);

function identity() {
  return {
    schemaVersion: 1,
    releaseSha: SHA,
    productTree: TREE,
    buildId: HASH,
    builtAt: '2026-08-28T10:00:00.000Z',
    workspaceSource: { headSha: SHA, productTree: TREE },
    configuredSafetyFlags: {
      engineMode: 'PAPER' as const,
      autoWorkerLiveEnabled: false,
      liveTestExecutionLocked: true,
      delegatedSignerEnabled: false,
      gmxOrderSubmissionEnabled: false,
      relaySubmissionEnabled: false,
      relaySubmitNetworkEnabled: false,
      relayMode: 'DISABLED' as const,
    },
    safetyContract: {
      version: 'post-publish-safety/v1',
      confirmedOpenInitialStop: {
        version: 'confirmed-open-initial-stop/v1',
        sha256: HASH,
        files: [...CONFIRMED_OPEN_HANDOFF_CONTRACT_FILES],
      },
    },
    topology: { processCount: 1, port: 8080, owner: 'api-server' },
    webAssets: [
      { path: '/assets/index-a.js', sha256: HASH },
      { path: '/assets/index-a.css', sha256: HASH },
    ],
  };
}

describe('release identity parser', () => {
  it('accepts the exact versioned provenance and Task #140 contract', () => {
    expect(parseReleaseIdentity(identity())).toEqual(identity());
  });

  it.each([
    ['release sha', (v: ReturnType<typeof identity>) => { v.releaseSha = 'bad'; }],
    ['product tree', (v: ReturnType<typeof identity>) => { v.productTree = 'bad'; }],
    ['build id', (v: ReturnType<typeof identity>) => { v.buildId = 'bad'; }],
    ['workspace source', (v: ReturnType<typeof identity>) => {
      v.workspaceSource.productTree = 'bad';
    }],
    ['configured safety flags', (v: ReturnType<typeof identity>) => {
      v.configuredSafetyFlags.relayMode = 'bad' as 'DISABLED';
    }],
    ['safety contract', (v: ReturnType<typeof identity>) => {
      v.safetyContract.version = 'wrong' as 'post-publish-safety/v1';
    }],
    ['handoff contract', (v: ReturnType<typeof identity>) => {
      v.safetyContract.confirmedOpenInitialStop.version =
        'wrong' as 'confirmed-open-initial-stop/v1';
    }],
    ['handoff file allowlist', (v: ReturnType<typeof identity>) => {
      v.safetyContract.confirmedOpenInitialStop.files =
        ['confirmedOpenStopHandoff.test.ts'] as unknown as
          typeof v.safetyContract.confirmedOpenInitialStop.files;
    }],
    ['topology', (v: ReturnType<typeof identity>) => { v.topology.port = 3000 as 8080; }],
    ['assets', (v: ReturnType<typeof identity>) => { v.webAssets = []; }],
  ])('rejects malformed or detached %s evidence', (_name, mutate) => {
    const value = identity();
    mutate(value);
    expect(parseReleaseIdentity(value)).toBeNull();
  });
});