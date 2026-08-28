import { createHash } from 'node:crypto';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;

function check(id, condition, detail, unavailable = false) {
  return {
    id,
    status: unavailable ? 'UNAVAILABLE' : condition ? 'PASS' : 'FAIL',
    detail,
  };
}

function pathValue(root, path) {
  let value = root;
  for (const key of path) {
    if (!value || typeof value !== 'object' || !(key in value)) return undefined;
    value = value[key];
  }
  return value;
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export const HANDOFF_CONTRACT_FILES = Object.freeze([
  'artifacts/api-server/src/lib/confirmedOpenStopHandoff.ts',
  'artifacts/api-server/src/lib/gmxApiSubmitFlow.ts',
  'artifacts/api-server/src/lib/protectionOrders.ts',
  'artifacts/api-server/src/lib/relayLifecycle.ts',
  'artifacts/api-server/src/workers/liveTestExecutor.ts',
  'artifacts/api-server/src/workers/protectionExecutor.ts',
  'artifacts/api-server/src/__tests__/confirmedOpenStopHandoff.test.ts',
  'artifacts/api-server/src/__tests__/gmxApiPrepareDurability.test.ts',
  'artifacts/api-server/src/__tests__/gmxApiStatusReconciler.test.ts',
  'artifacts/api-server/src/__tests__/protection6h2b.lifecycle.test.ts',
]);

export function recomputeBuildId(identity) {
  const identityBasis = JSON.stringify({
    releaseSha: identity.releaseSha,
    productTree: identity.productTree,
    workspaceSource: identity.workspaceSource,
    safetyContractVersion: identity.safetyContract.version,
    handoff: identity.safetyContract.confirmedOpenInitialStop,
    webAssets: identity.webAssets,
    topology: identity.topology,
  });
  return sha256(`${identityBasis}\0${identity.builtAt}`);
}

export function evaluatePostPublishAttestation(input) {
  const reachability = [
    check('health', input.health?.status === 200 && input.health?.body?.status === 'ok',
      `HTTP ${input.health?.status ?? 'unavailable'}`, !input.health),
    check('root', input.root?.status === 302 && input.root?.location === '/futures-web/',
      `HTTP ${input.root?.status ?? 'unavailable'} location=${input.root?.location ?? 'none'}`, !input.root),
    check('web', input.web?.status === 200 && typeof input.web?.body === 'string'
      && input.web.body.includes('<title>Crypto Control Center</title>'),
    `HTTP ${input.web?.status ?? 'unavailable'}`, !input.web),
    check('identity-api', input.identity?.status === 200 && input.identity?.body?.ok === true,
      `HTTP ${input.identity?.status ?? 'unavailable'}`, !input.identity),
    check('safety-api', input.safety?.status === 200 && input.safety?.body?.ok === true,
      `HTTP ${input.safety?.status ?? 'unavailable'}`, !input.safety),
    check('signer-api', input.signer?.status === 200 && input.signer?.body?.ok === true,
      `HTTP ${input.signer?.status ?? 'unavailable'}`, !input.signer),
    check('subaccount-api', input.subaccount?.status === 200 && input.subaccount?.body?.ok === true,
      `HTTP ${input.subaccount?.status ?? 'unavailable'}`, !input.subaccount),
    check('positions-api', input.positions?.status === 200 && Array.isArray(input.positions?.body?.positions),
      `HTTP ${input.positions?.status ?? 'unavailable'}`, !input.positions),
  ];

  const identity = input.identity?.body?.identity;
  const runtime = input.safety?.body?.runtime;
  const database = input.safety?.body?.database;
  const relay = runtime?.relayFlags;
  const checks = [];
  const identityUnavailable = !identity;
  checks.push(
    check('release-sha', typeof identity?.releaseSha === 'string'
      && SHA40.test(identity.releaseSha)
      && typeof input.expectedReleaseSha === 'string'
      && identity.releaseSha === input.expectedReleaseSha,
    `release=${identity?.releaseSha ?? 'unavailable'}`, identityUnavailable),
    check('product-tree', typeof identity?.productTree === 'string'
      && SHA40.test(identity.productTree)
      && typeof input.expectedProductTree === 'string'
      && identity.productTree === input.expectedProductTree,
    `tree=${identity?.productTree ?? 'unavailable'}`, identityUnavailable),
    check('build-id', typeof identity?.buildId === 'string' && SHA64.test(identity.buildId)
      && identity.buildId === recomputeBuildId(identity),
      `build=${identity?.buildId ?? 'unavailable'}`, identityUnavailable),
    check('safety-contract', identity?.safetyContract?.version === 'post-publish-safety/v1',
      `contract=${identity?.safetyContract?.version ?? 'unavailable'}`, identityUnavailable),
    check('task-140-contract',
      identity?.safetyContract?.confirmedOpenInitialStop?.version === 'confirmed-open-initial-stop/v1'
      && SHA64.test(identity?.safetyContract?.confirmedOpenInitialStop?.sha256 ?? '')
      && identity?.safetyContract?.confirmedOpenInitialStop?.sha256 === input.expectedHandoffSha256
      && JSON.stringify(identity?.safetyContract?.confirmedOpenInitialStop?.files)
        === JSON.stringify(HANDOFF_CONTRACT_FILES),
    `handoff=${identity?.safetyContract?.confirmedOpenInitialStop?.version ?? 'unavailable'}`,
    identityUnavailable),
    check('topology-contract', identity?.topology?.processCount === 1
      && identity?.topology?.port === 8080 && identity?.topology?.owner === 'api-server',
    JSON.stringify(identity?.topology ?? null), identityUnavailable),
    check('configured-runtime-port', runtime?.listeningPort === 8080,
      `port=${runtime?.listeningPort ?? 'unavailable'}`, !runtime),
  );

  const expectedAssets = new Map((identity?.webAssets ?? []).map((asset) => [asset.path, asset.sha256]));
  const observedAssets = input.assets ?? [];
  checks.push(check('web-assets',
    expectedAssets.size >= 2
      && observedAssets.length === expectedAssets.size
      && observedAssets.every((asset) => expectedAssets.get(asset.path) === asset.sha256),
    `${observedAssets.length}/${expectedAssets.size} assets matched`,
    identityUnavailable || !Array.isArray(input.assets)));

  const nowMs = input.nowMs ?? Date.now();
  const startedAtMs = Date.parse(runtime?.startedAt ?? '');
  const heartbeatAtMs = Date.parse(runtime?.schedulerHeartbeatAt ?? '');
  const heartbeatAvailable = Number.isFinite(heartbeatAtMs);
  const schedulerFresh = heartbeatAvailable && nowMs - heartbeatAtMs >= 0
    && nowMs - heartbeatAtMs <= 3 * 60_000;
  checks.push(
    check('paper-mode', runtime?.engineMode === 'PAPER', `mode=${runtime?.engineMode ?? 'unavailable'}`, !runtime),
    check('scheduler-cycle', Number.isInteger(runtime?.cycleCount) && runtime.cycleCount > 0
      && Number.isFinite(startedAtMs) && heartbeatAvailable && heartbeatAtMs >= startedAtMs
      && schedulerFresh,
    `cycles=${runtime?.cycleCount ?? 'unavailable'} heartbeat=${runtime?.schedulerHeartbeatAt ?? 'unavailable'} decision=${runtime?.lastDecisionAt ?? 'unavailable'}`,
    !runtime || !heartbeatAvailable),
    check('cold-start-recovered',
      runtime?.lastCycleOutcome === 'SUCCESS' || runtime?.lastCycleOutcome === 'SAFE_SKIP',
      `lastCycleOutcome=${runtime?.lastCycleOutcome ?? 'unavailable'}`,
      runtime?.lastCycleOutcome == null),
    check('live-lock', runtime?.liveExecutionLocked === true && runtime?.liveTestMode === false,
      `locked=${String(runtime?.liveExecutionLocked)} liveTest=${String(runtime?.liveTestMode)}`, !runtime),
    check('revoke-lock', runtime?.activeRevoke === false,
      `activeRevoke=${String(runtime?.activeRevoke)}`, runtime?.activeRevoke == null),
    check('relay-lock', relay?.relaySubmitNetworkEnabled === false
      && relay?.relaySubmissionEnabled === false && relay?.relayMode === 'DISABLED'
      && relay?.delegatedSignerEnabled === false,
    `relayMode=${relay?.relayMode ?? 'unavailable'}`, !relay),
    check('stop-lock', runtime?.stopExecution?.available === false,
      `stopAvailable=${String(runtime?.stopExecution?.available)}`, !runtime?.stopExecution),
    check('signer-lock', input.signer?.body?.initialized === false
      && input.signer?.body?.privateKeyDecrypted === false
      && input.signer?.body?.orderSubmissionEnabled === false,
    `initialized=${String(input.signer?.body?.initialized)}`, !input.signer?.body),
    check('subaccount-lock', input.subaccount?.body?.authEligible === false
      && input.subaccount?.body?.liveEligible === false
      && input.subaccount?.body?.orderSubmissionEnabled === false,
    `state=${input.subaccount?.body?.state ?? 'unavailable'}`, !input.subaccount?.body),
    check('arbitrum-rpc', runtime?.networkChainId === 42161 && runtime?.rpcConfigured === true
      && runtime?.gmxConnected === true && input.positions?.body?.source === 'rpc',
    `chain=${runtime?.networkChainId ?? 'unavailable'} source=${input.positions?.body?.source ?? 'unavailable'}`,
    !runtime || !input.positions?.body),
    check('positions-zero', input.positions?.body?.positions?.length === 0,
      `positions=${input.positions?.body?.positions?.length ?? 'unavailable'}`, !input.positions?.body),
  );

  const zeroFields = [
    'pendingApprovalCount',
    'openPositionCount',
    'blockingIntentCount',
    'openRelayTaskCount',
    'blockingProtectionCount',
    'unsettledTradeCount',
    'duplicateDecisionClaimCount24h',
  ];
  checks.push(check('database-evidence', database?.complete === true
    && zeroFields.every((field) => pathValue(database, [field]) === 0),
  zeroFields.map((field) => `${field}=${String(pathValue(database, [field]))}`).join(' '),
  !database || database.complete !== true));
  checks.push(check('paper-runtime-clear',
    runtime?.paperRuntime?.openPositionCount === 0
      && runtime?.paperRuntime?.pendingClosePresent === false
      && runtime?.paperRuntime?.unresolvedPresent === false
      && runtime?.settlement?.unsettledCount === 0
      && runtime?.settlement?.incomplete === false,
    'open/pending/unresolved/unsettled runtime snapshot', !runtime?.paperRuntime || !runtime?.settlement));

  const aggregate = (items) => items.some((item) => item.status === 'FAIL') ? 'FAIL'
    : items.some((item) => item.status === 'UNAVAILABLE') ? 'UNAVAILABLE' : 'PASS';
  const reachabilityStatus = aggregate(reachability);
  const safetyStatus = aggregate(checks);
  return {
    schemaVersion: 1,
    observedAt: new Date(nowMs).toISOString(),
    publishReachability: { status: reachabilityStatus, checks: reachability },
    runtimeSafety: { status: safetyStatus, checks },
    overall: reachabilityStatus === 'PASS' && safetyStatus === 'PASS' ? 'PASS'
      : reachabilityStatus === 'FAIL' || safetyStatus === 'FAIL' ? 'FAIL' : 'UNAVAILABLE',
  };
}