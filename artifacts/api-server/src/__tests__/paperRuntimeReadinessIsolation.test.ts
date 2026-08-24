/**
 * Isolated PAPER readiness regression evidence.
 *
 * This suite intentionally imports the runtime only after clearing the module
 * cache and disabling every execution/submission environment gate. All reads
 * are injected and deterministic; any forbidden capability import throws.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const forbidden = vi.hoisted(() => ({
  loads: [] as string[],
}));

function forbiddenModule(name: string): never {
  forbidden.loads.push(name);
  throw new Error(`PAPER readiness imported forbidden capability: ${name}`);
}

vi.mock('@workspace/db', () => forbiddenModule('@workspace/db'));
vi.mock('../lib/delegatedSigner', () => forbiddenModule('delegatedSigner'));
vi.mock('../lib/relaySignerBinding', () => forbiddenModule('relaySignerBinding'));
vi.mock('../lib/gmxApiExecution', () => forbiddenModule('gmxApiExecution'));
vi.mock('../lib/executionIntents', () => forbiddenModule('executionIntents'));
vi.mock('../lib/gmxApiOrders', () => forbiddenModule('gmxApiOrders'));
vi.mock('../lib/gmxCreateOrder', () => forbiddenModule('gmxCreateOrder'));
vi.mock('../lib/riskCapital', () => forbiddenModule('riskCapital'));
vi.mock('../lib/relayOrderAssembly', () => forbiddenModule('relayOrderAssembly'));
vi.mock('../lib/manualCanaryExecutionEvidence', () =>
  forbiddenModule('manualCanaryExecutionEvidence'));
vi.mock('../workers/liveTestExecutor', () => forbiddenModule('liveTestExecutor'));
vi.mock('../workers/aiWorker', () => forbiddenModule('aiWorker'));
vi.mock('../lib/relayLifecycle', () => forbiddenModule('relayLifecycle'));
vi.mock('../lib/relaySubmission', () => forbiddenModule('relaySubmission'));

const NOW = 1_777_000_000_000;
const BTC_MARKET = '0x7C11F78Ce78768518D743E81Fdfa2F860C6b9A77';
const BTC_TOKEN = '0x47904963fc8b2340414262125aF798B9655E58Cd';
const ETH_MARKET = '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336';
const ETH_TOKEN = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const EXECUTION_ENV_KEYS = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'WORKER_ENGINE_MODE',
  'GMX_API_READONLY_ENABLED',
  'GMX_RELAY_READONLY_NETWORK_ENABLED',
  'DELEGATED_SIGNER_ENABLED',
  'GMX_API_ORDER_SUBMISSION_ENABLED',
  'GMX_RELAY_MODE',
  'GMX_RELAY_NETWORK_ENABLED',
  'GMX_RELAY_SUBMISSION_ENABLED',
  'AUTO_WORKER_LIVE_ENABLED',
  'LIVE_TEST_EXECUTION_LOCKED',
  'GMX_WALLET_ADDRESS',
] as const;

const savedEnv = new Map<string, string | undefined>();

function snapshot(symbol: 'BTC' | 'ETH') {
  const observedAt = new Date(NOW - 1_000).toISOString();
  return {
    market: symbol === 'BTC' ? BTC_MARKET : ETH_MARKET,
    isLong: true,
    orderType: 'MarketIncrease' as const,
    notionalUsd: 20,
    positionFeeUsd: 0.01,
    executionFeeUsd: 0.2,
    estimatedPriceImpactUsd: 0.01,
    fundingFeeUsd: 0.01,
    borrowingFeeUsd: 0.01,
    estimatedExitFeeUsd: 0.01,
    estimatedExitPriceImpactUsd: 0,
    totalEstimatedRoundTripCostUsd: 0.25,
    source: 'GMX_API' as const,
    blockNumber: null,
    apiTimestamp: observedAt,
    fetchedAt: observedAt,
    expiresAt: new Date(NOW + 30_000).toISOString(),
    fundingRatePerHourFraction: 0.0005,
    borrowingRatePerHourFraction: 0.0005,
  };
}

function validCanary() {
  return {
    decimals: {
      BTC: { ok: true, detail: 'BTC on-chain decimals verified' },
      ETH: { ok: true, detail: 'ETH on-chain decimals verified' },
    },
    costs: {
      BTC: { ok: true as const, reason: null, snapshot: snapshot('BTC'), roundTripCostUsd: 0.25 },
      ETH: { ok: true as const, reason: null, snapshot: snapshot('ETH'), roundTripCostUsd: 0.25 },
    },
  };
}

function readonlyClient(chainId: number) {
  return {
    getChainId: vi.fn(async () => chainId),
    getCode: vi.fn(async () => '0x1234' as `0x${string}`),
    getGasPrice: vi.fn(async () => 1n),
    getTransactionReceipt: vi.fn(async () => ({})),
    getLogs: vi.fn(async () => []),
    getBlockTimestamp: vi.fn(async () => 1n),
    readContract: vi.fn(async () => 0n),
  };
}

beforeEach(() => {
  forbidden.loads.length = 0;
  vi.resetModules();
  for (const key of EXECUTION_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  vi.doUnmock('viem');
  for (const key of EXECUTION_ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

describe('isolated PAPER runtime readiness', () => {
  it('has a recursively read-only eager local-import closure', () => {
    const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    // manualCanaryReadonlyEvidence is the runtime's intentionally lazy,
    // read-only canary dependency, so include it as an explicit closure root.
    const pending = [join(srcRoot, 'lib/paperRuntimeReadiness.ts')];
    const visited = new Set<string>();
    const forbiddenImport = /@workspace\/db|delegatedSigner|gmxApiExecution|executionIntents|gmxApiOrders|gmxCreateOrder|riskCapital|relayOrderAssembly|manualCanaryExecutionEvidence|liveTestExecutor|aiWorker|relayLifecycle|relaySubmission/;
    const allowedConditionalLazyImport =
      `${join(srcRoot, 'lib/gmxApiReadinessCoordinator.ts')}::../workers/liveTestExecutor`;

    while (pending.length > 0) {
      const filename = pending.pop()!;
      if (visited.has(filename)) continue;
      visited.add(filename);
      const source = readFileSync(filename, 'utf8');
      const eagerImports = [
        ...[...source.matchAll(
          /(?:^|\n)\s*import\s+(type\s+)?(?:(?:[\w$]+|\{[^}]*\}|\*\s+as\s+[\w$]+)(?:\s*,\s*\{[^}]*\})?\s+from\s+)?['"]([^'"]+)['"]/g,
        )]
          .filter((match) => match[1] === undefined)
          .map((match) => match[2]),
        ...[...source.matchAll(
          /(?:^|\n)\s*export\s+(type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g,
        )]
          .filter((match) => match[1] === undefined)
          .map((match) => match[2]),
        ...source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ].map((match) => typeof match === 'string' ? match : match[1]);
      const lazyImports = [
        ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ].map((match) => match[1]);
      const checkedImports = [
        ...eagerImports,
        ...lazyImports.filter((specifier) =>
          `${filename}::${specifier}` !== allowedConditionalLazyImport),
      ];
      if (filename === join(srcRoot, 'lib/gmxApiReadinessCoordinator.ts')) {
        expect(eagerImports).not.toContain('../workers/liveTestExecutor');
        expect(lazyImports).toContain('../workers/liveTestExecutor');
      }

      expect(checkedImports, filename).not.toEqual(
        expect.arrayContaining([expect.stringMatching(forbiddenImport)]),
      );
      expect(source, filename).not.toMatch(
        /\bdb\.(?:insert|update|delete)\s*\(/,
      );

      for (const specifier of checkedImports.filter((value) => value.startsWith('.'))) {
        const base = resolve(dirname(filename), specifier);
        const localFile = [base, `${base}.ts`, join(base, 'index.ts')]
          .find((candidate) => existsSync(candidate));
        expect(localFile, `${filename} -> ${specifier}`).toBeDefined();
        pending.push(localFile!);
      }
    }

    expect([...visited].map((file) => file.slice(srcRoot.length + 1))).toEqual(
      expect.arrayContaining([
        'lib/paperRuntimeReadiness.ts',
        'lib/manualCanaryReadonlyEvidence.ts',
        'lib/gmxApiReadinessCoordinator.ts',
        'lib/stopExecutionCapabilityState.ts',
        'lib/relayReadonlyClient.ts',
        'lib/relayReadinessRefresh.ts',
      ]),
    );
  });

  it('starts the default PAPER scheduler without loading execution capabilities', async () => {
    process.env.WORKER_ENGINE_MODE = 'PAPER';
    delete process.env.GMX_API_READONLY_ENABLED;
    delete process.env.GMX_RELAY_READONLY_NETWORK_ENABLED;

    const runtime = await import('../lib/paperRuntimeReadiness');
    const stopState = await import('../lib/stopExecutionCapabilityState');
    runtime.__resetPaperRuntimeReadinessForTests();

    try {
      runtime.startPaperRuntimeReadinessScheduler();
      await vi.waitFor(() => {
        expect(runtime.getPaperRuntimeReadinessSnapshot().scheduler).toMatchObject({
          running: true,
          inFlight: false,
        });
        expect(runtime.getPaperRuntimeReadinessSnapshot().scheduler.nextRefreshAtMs)
          .not.toBeNull();
      });

      expect(stopState.getStopExecutionCapability()).toEqual({
        available: false,
        reasons: [
          'stop 실행 능력 미평가 — refreshStopExecutionCapability 필요 (fail-closed)',
        ],
        evaluatedAt: null,
      });
      expect(stopState.isStopExecutionAvailable()).toBe(false);
      expect(process.env.DATABASE_URL).toBeUndefined();
      expect(process.env.DELEGATED_SIGNER_ENABLED).toBeUndefined();
      expect(process.env.GMX_API_ORDER_SUBMISSION_ENABLED).toBeUndefined();
      expect(process.env.GMX_RELAY_SUBMISSION_ENABLED).toBeUndefined();
      expect(forbidden.loads).toEqual([]);
    } finally {
      runtime.stopPaperRuntimeReadinessScheduler();
    }
  });

  it('loads and completes from injected read-only evidence without execution capability', async () => {
    const runtime = await import('../lib/paperRuntimeReadiness');
    runtime.__resetPaperRuntimeReadinessForTests();

    const canary = validCanary();
    const client = readonlyClient(42161);
    const status = await runtime.runPaperRuntimeReadinessCycle({
      forceDeployment: true,
      deps: {
        env: {
          WORKER_ENGINE_MODE: 'PAPER',
          GMX_API_READONLY_ENABLED: 'true',
          GMX_RELAY_READONLY_NETWORK_ENABLED: 'true',
        },
        nowMs: () => NOW,
        refreshCanary: vi.fn(async () => canary),
        decimalsSnapshot: vi.fn(() => [
          {
            key: 'btc',
            decimals: 8,
            source: 'sdk-synthetic+onchain-no-code',
            tokenAddress: BTC_TOKEN,
            verifiedAtMs: NOW - 500,
            ageMs: 500,
            stale: false,
          },
          {
            key: 'eth',
            decimals: 18,
            source: 'sdk+onchain',
            tokenAddress: ETH_TOKEN,
            verifiedAtMs: NOW - 500,
            ageMs: 500,
            stale: false,
          },
        ]),
        createReadonlyClient: vi.fn(() => ({ ok: true as const, client })),
        refreshDeployment: vi.fn(async () => ({
          attempted: true,
          atMs: NOW - 250,
          ok: true,
          manifestVersion: 1,
          basis: ['injected read-only deployment evidence'],
          failures: [],
        })),
      },
    });

    expect(status.boundary).toBe('READ_ONLY_NOT_EXECUTION_AUTHORIZATION');
    expect(status.deployment).toMatchObject({ state: 'verified', manifestVersion: 1 });
    expect(status.rpc).toMatchObject({ state: 'verified', chainId: 42161 });
    expect(status.decimals.BTC).toMatchObject({ state: 'verified', decimals: 8 });
    expect(status.decimals.ETH).toMatchObject({ state: 'verified', decimals: 18 });
    for (const symbol of ['BTC', 'ETH'] as const) {
      expect(status.costs[symbol]).toMatchObject({
        state: 'verified',
        source: 'GMX_API',
        positionFeeUsd: 0.01,
        capUsd: 0.4,
        withinCap: true,
      });
      expect(status.costs[symbol].effectiveRoundTripCostUsd).toBeCloseTo(0.25, 12);
    }
    expect(status.scheduler.lastFailureId).toBeNull();
    expect(forbidden.loads).toEqual([]);
  });

  it('keeps absent and invalid injected evidence fail-closed', async () => {
    const runtime = await import('../lib/paperRuntimeReadiness');
    runtime.__resetPaperRuntimeReadinessForTests();

    const client = readonlyClient(1);
    const status = await runtime.runPaperRuntimeReadinessCycle({
      forceDeployment: true,
      deps: {
        env: {
          WORKER_ENGINE_MODE: 'PAPER',
          GMX_API_READONLY_ENABLED: 'true',
          GMX_RELAY_READONLY_NETWORK_ENABLED: 'true',
        },
        nowMs: () => NOW,
        refreshCanary: vi.fn(async () => ({
          decimals: {},
          costs: {},
        }) as never),
        decimalsSnapshot: vi.fn(() => []),
        createReadonlyClient: vi.fn(() => ({ ok: true as const, client })),
        refreshDeployment: vi.fn(async () => ({
          attempted: true,
          atMs: NOW,
          ok: false,
          manifestVersion: null,
          basis: [],
          failures: ['injected invalid deployment evidence'],
        })),
      },
    });

    expect(status.boundary).toBe('READ_ONLY_NOT_EXECUTION_AUTHORIZATION');
    expect(status.scheduler.lastFailureId).toBe('PAPER_READINESS_INCOMPLETE');
    expect(status.deployment).toMatchObject({
      state: 'failed',
      failureId: 'DEPLOYMENT_VERIFICATION_FAILED',
      manifestVersion: null,
    });
    expect(status.rpc).toMatchObject({
      state: 'failed',
      failureId: 'RPC_CHAIN_MISMATCH',
      chainId: null,
    });
    for (const symbol of ['BTC', 'ETH'] as const) {
      expect(status.decimals[symbol]).toMatchObject({
        state: 'failed',
        decimals: null,
      });
      expect(status.costs[symbol]).toMatchObject({
        state: 'failed',
        capUsd: null,
        positionFeeUsd: null,
        effectiveRoundTripCostUsd: null,
        withinCap: null,
      });
    }
    expect(status.blockerIds).toEqual(expect.arrayContaining([
      'btc_decimals',
      'eth_decimals',
      'btc_cost_snapshot',
      'eth_cost_snapshot',
      'deployment',
      'rpc',
    ]));
    expect(forbidden.loads).toEqual([]);
  });

  it('keeps GMX positions outside PAPER readiness and reads zero positions through the isolated read-only helper', async () => {
    // Architectural boundary: paperRuntimeReadiness/manualCanaryReadonlyEvidence
    // do not read account positions. PositionReader evidence is owned by the
    // exported pure read helper in routes/gmx, imported without the app/router
    // composition graph. Injected viem prevents any real RPC request.
    const readContract = vi.fn(async () => []);
    const createPublicClient = vi.fn(() => ({ readContract }));
    vi.doMock('viem', async (importOriginal) => ({
      ...await importOriginal<typeof import('viem')>(),
      createPublicClient,
    }));
    process.env.GMX_WALLET_ADDRESS =
      '0x1111111111111111111111111111111111111111';

    const { fetchServerLiveTestData } = await import('../routes/gmx');
    const result = await fetchServerLiveTestData();

    expect(result).toEqual({ positionCount: 0, subgraphOk: true });
    expect(createPublicClient).toHaveBeenCalledTimes(1);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'getAccountPositions',
      args: expect.arrayContaining([
        process.env.GMX_WALLET_ADDRESS,
        0n,
        20n,
      ]),
    }));
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.DELEGATED_SIGNER_ENABLED).toBeUndefined();
    expect(process.env.GMX_API_ORDER_SUBMISSION_ENABLED).toBeUndefined();
    expect(process.env.GMX_RELAY_SUBMISSION_ENABLED).toBeUndefined();
    expect(forbidden.loads).toEqual([]);
  });
});