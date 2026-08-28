export const RELEASE_IDENTITY_SCHEMA_VERSION = 1 as const;
export const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const CONFIRMED_OPEN_HANDOFF_CONTRACT_FILES = [
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
] as const;

declare const __RELEASE_IDENTITY__: unknown;

export interface ReleaseIdentity {
  schemaVersion: 1;
  releaseSha: string;
  productTree: string;
  buildId: string;
  builtAt: string;
  workspaceSource: {
    headSha: string;
    productTree: string;
  };
  configuredSafetyFlags: {
    engineMode: 'PAPER' | 'LIVE';
    autoWorkerLiveEnabled: boolean;
    liveTestExecutionLocked: boolean;
    delegatedSignerEnabled: boolean;
    gmxOrderSubmissionEnabled: boolean;
    relaySubmissionEnabled: boolean;
    relaySubmitNetworkEnabled: boolean;
    relayMode: 'DISABLED' | 'DRY_RUN' | 'LIVE';
  };
  safetyContract: {
    version: 'post-publish-safety/v1';
    confirmedOpenInitialStop: {
      version: 'confirmed-open-initial-stop/v1';
      sha256: string;
      files: string[];
    };
  };
  topology: {
    processCount: 1;
    port: 8080;
    owner: 'api-server';
  };
  webAssets: Array<{ path: string; sha256: string }>;
}

export function parseReleaseIdentity(value: unknown): ReleaseIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<ReleaseIdentity>;
  const handoff = v.safetyContract?.confirmedOpenInitialStop;
  const flags = v.configuredSafetyFlags;
  if (v.schemaVersion !== RELEASE_IDENTITY_SCHEMA_VERSION
      || typeof v.releaseSha !== 'string' || !RELEASE_SHA_PATTERN.test(v.releaseSha)
      || typeof v.productTree !== 'string' || !RELEASE_SHA_PATTERN.test(v.productTree)
      || typeof v.buildId !== 'string' || !SHA256_PATTERN.test(v.buildId)
      || typeof v.builtAt !== 'string' || !Number.isFinite(Date.parse(v.builtAt))
      || typeof v.workspaceSource?.headSha !== 'string'
      || !RELEASE_SHA_PATTERN.test(v.workspaceSource.headSha)
      || typeof v.workspaceSource?.productTree !== 'string'
      || !RELEASE_SHA_PATTERN.test(v.workspaceSource.productTree)
      || (flags?.engineMode !== 'PAPER' && flags?.engineMode !== 'LIVE')
      || typeof flags?.autoWorkerLiveEnabled !== 'boolean'
      || typeof flags?.liveTestExecutionLocked !== 'boolean'
      || typeof flags?.delegatedSignerEnabled !== 'boolean'
      || typeof flags?.gmxOrderSubmissionEnabled !== 'boolean'
      || typeof flags?.relaySubmissionEnabled !== 'boolean'
      || typeof flags?.relaySubmitNetworkEnabled !== 'boolean'
      || (flags?.relayMode !== 'DISABLED' && flags?.relayMode !== 'DRY_RUN' && flags?.relayMode !== 'LIVE')
      || v.safetyContract?.version !== 'post-publish-safety/v1'
      || handoff?.version !== 'confirmed-open-initial-stop/v1'
      || typeof handoff.sha256 !== 'string' || !SHA256_PATTERN.test(handoff.sha256)
      || !Array.isArray(handoff.files)
      || JSON.stringify(handoff.files) !== JSON.stringify(CONFIRMED_OPEN_HANDOFF_CONTRACT_FILES)
      || v.topology?.processCount !== 1 || v.topology.port !== 8080
      || v.topology.owner !== 'api-server'
      || !Array.isArray(v.webAssets) || v.webAssets.length < 2
      || v.webAssets.some((asset) =>
        !asset || typeof asset.path !== 'string' || !/^\/assets\/.+\.(js|css)$/.test(asset.path)
        || typeof asset.sha256 !== 'string' || !SHA256_PATTERN.test(asset.sha256))) {
    return null;
  }
  return v as ReleaseIdentity;
}

export function getReleaseIdentity(): ReleaseIdentity | null {
  if (typeof __RELEASE_IDENTITY__ === 'undefined') return null;
  return parseReleaseIdentity(__RELEASE_IDENTITY__);
}