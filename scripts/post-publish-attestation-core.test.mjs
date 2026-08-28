import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluatePostPublishAttestation,
  HANDOFF_CONTRACT_FILES,
  recomputeBuildId,
} from './post-publish-attestation-core.mjs';

const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const HASH = 'c'.repeat(64);
const now = Date.parse('2026-08-28T10:02:00.000Z');

function validInput() {
  const identity = {
    schemaVersion: 1,
    releaseSha: SHA,
    productTree: TREE,
    buildId: '',
    builtAt: '2026-08-28T10:00:00.000Z',
    workspaceSource: { headSha: SHA, productTree: TREE },
    configuredSafetyFlags: {
      engineMode: 'PAPER',
      autoWorkerLiveEnabled: false,
      liveTestExecutionLocked: true,
      delegatedSignerEnabled: false,
      gmxOrderSubmissionEnabled: false,
      relaySubmissionEnabled: false,
      relaySubmitNetworkEnabled: false,
      relayMode: 'DISABLED',
    },
    safetyContract: {
      version: 'post-publish-safety/v1',
      confirmedOpenInitialStop: {
        version: 'confirmed-open-initial-stop/v1',
        sha256: HASH,
        files: [...HANDOFF_CONTRACT_FILES],
      },
    },
    topology: { processCount: 1, port: 8080, owner: 'api-server' },
    webAssets: [
      { path: '/assets/index.js', sha256: HASH },
      { path: '/assets/index.css', sha256: HASH },
    ],
  };
  identity.buildId = recomputeBuildId(identity);
  return {
    nowMs: now,
    expectedReleaseSha: SHA,
    expectedProductTree: TREE,
    expectedHandoffSha256: HASH,
    health: { status: 200, body: { status: 'ok' } },
    root: { status: 302, location: '/futures-web/', body: '' },
    web: { status: 200, body: '<title>Crypto Control Center</title>' },
    identity: { status: 200, body: { ok: true, identity } },
    safety: {
      status: 200,
      body: {
        ok: true,
        runtime: {
          listeningPort: 8080, engineMode: 'PAPER',
          startedAt: '2026-08-28T10:00:00.000Z',
          cycleCount: 2,
          schedulerHeartbeatAt: '2026-08-28T10:01:30.000Z',
          lastDecisionAt: '2026-08-28T10:00:30.000Z',
          lastCycleAt: '2026-08-28T10:00:30.000Z',
          lastCycleOutcome: 'SUCCESS',
          lastCycleHasError: false,
          liveExecutionLocked: true, liveTestMode: false, activeRevoke: false,
          networkChainId: 42161, rpcConfigured: true, gmxConnected: true,
          relayFlags: {
            relaySubmitNetworkEnabled: false, relaySubmissionEnabled: false,
            relayMode: 'DISABLED', delegatedSignerEnabled: false,
          },
          stopExecution: { available: false },
          paperRuntime: {
            openPositionCount: 0, pendingClosePresent: false, unresolvedPresent: false,
          },
          settlement: { unsettledCount: 0, incomplete: false },
        },
        database: {
          complete: true,
          pendingApprovalCount: 0, openPositionCount: 0, blockingIntentCount: 0,
          openRelayTaskCount: 0, blockingProtectionCount: 0,
          unsettledTradeCount: 0, duplicateDecisionClaimCount24h: 0,
        },
      },
    },
    signer: {
      status: 200,
      body: { ok: true, initialized: false, privateKeyDecrypted: false, orderSubmissionEnabled: false },
    },
    subaccount: {
      status: 200,
      body: { ok: true, state: 'SIGNER_DISABLED', authEligible: false, liveEligible: false, orderSubmissionEnabled: false },
    },
    positions: { status: 200, body: { source: 'rpc', positions: [] } },
    assets: [
      { path: '/assets/index.js', sha256: HASH },
      { path: '/assets/index.css', sha256: HASH },
    ],
  };
}

test('passes only with matching provenance and complete fail-closed runtime evidence', () => {
  const report = evaluatePostPublishAttestation(validInput());
  assert.equal(report.publishReachability.status, 'PASS');
  assert.equal(report.runtimeSafety.status, 'PASS');
  assert.equal(report.overall, 'PASS');
});

test('fails for wrong source, asset mismatch, unexpected unlock, stale cycle, or blockers', () => {
  const cases = [
    (i) => { i.expectedReleaseSha = 'd'.repeat(40); },
    (i) => { i.assets[0].sha256 = 'e'.repeat(64); },
    (i) => { i.safety.body.runtime.liveExecutionLocked = false; },
    (i) => { i.safety.body.runtime.schedulerHeartbeatAt = '2026-08-28T09:00:00.000Z'; },
    (i) => { i.safety.body.database.blockingIntentCount = 1; },
  ];
  for (const mutate of cases) {
    const input = validInput();
    mutate(input);
    assert.equal(evaluatePostPublishAttestation(input).overall, 'FAIL');
  }
});

test('reports unavailable instead of zero when an endpoint or DB evidence is missing', () => {
  const input = validInput();
  input.safety.body.database.complete = false;
  input.safety.body.database.unsettledTradeCount = null;
  assert.equal(evaluatePostPublishAttestation(input).runtimeSafety.status, 'UNAVAILABLE');
  delete input.positions;
  assert.equal(evaluatePostPublishAttestation(input).publishReachability.status, 'UNAVAILABLE');
});

test('fails closed while cold-start latest cycle still has an error', () => {
  const input = validInput();
  input.safety.body.runtime.lastCycleOutcome = 'ERROR';
  input.safety.body.runtime.lastCycleHasError = true;
  assert.equal(evaluatePostPublishAttestation(input).overall, 'FAIL');
});

test('passes duplicate-skip cadence when heartbeat is fresh but the last new decision is old', () => {
  const input = validInput();
  input.safety.body.runtime.schedulerHeartbeatAt = '2026-08-28T10:01:50.000Z';
  input.safety.body.runtime.lastDecisionAt = '2026-08-28T09:30:00.000Z';
  input.safety.body.runtime.lastCycleAt = '2026-08-28T09:30:00.000Z';
  input.safety.body.runtime.lastCycleOutcome = 'SAFE_SKIP';
  assert.equal(evaluatePostPublishAttestation(input).overall, 'PASS');
});

test('fresh error heartbeat remains FAIL and a later successful recovery passes', () => {
  const input = validInput();
  input.safety.body.runtime.schedulerHeartbeatAt = '2026-08-28T10:01:55.000Z';
  input.safety.body.runtime.lastCycleOutcome = 'ERROR';
  input.safety.body.runtime.lastCycleHasError = true;
  assert.equal(evaluatePostPublishAttestation(input).overall, 'FAIL');

  input.safety.body.runtime.schedulerHeartbeatAt = '2026-08-28T10:01:59.000Z';
  input.safety.body.runtime.lastCycleOutcome = 'SUCCESS';
  input.safety.body.runtime.lastCycleHasError = false;
  assert.equal(evaluatePostPublishAttestation(input).overall, 'PASS');
});

test('missing restart heartbeat is unavailable until the restarted scheduler completes a cycle', () => {
  const input = validInput();
  input.safety.body.runtime.schedulerHeartbeatAt = null;
  input.safety.body.runtime.lastCycleOutcome = null;
  assert.equal(evaluatePostPublishAttestation(input).runtimeSafety.status, 'UNAVAILABLE');

  input.safety.body.runtime.schedulerHeartbeatAt = '2026-08-28T10:01:59.000Z';
  input.safety.body.runtime.lastCycleOutcome = 'SUCCESS';
  assert.equal(evaluatePostPublishAttestation(input).overall, 'PASS');
});

test('unsafe evidence wins over unrelated unavailable evidence', () => {
  const input = validInput();
  input.safety.body.runtime.liveExecutionLocked = false;
  input.safety.body.database.complete = false;
  input.safety.body.database.unsettledTradeCount = null;
  assert.equal(evaluatePostPublishAttestation(input).runtimeSafety.status, 'FAIL');
});