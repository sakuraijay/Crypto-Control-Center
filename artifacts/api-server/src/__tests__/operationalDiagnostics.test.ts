import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPROVED_PRODUCTION_SAFETY_TARGET,
  deriveOperationalDiagnostics,
} from '../lib/operationalDiagnostics';
import type { ReleaseIdentity } from '../lib/releaseIdentity';

const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const MANUAL_CANARY_PATH = resolve(import.meta.dirname, '../../docs/manual-canary.md');

const DOCUMENTED_TARGET_BINDINGS = {
  WORKER_ENGINE_MODE: 'engineMode',
  AUTO_WORKER_LIVE_ENABLED: 'autoWorkerLiveEnabled',
  DELEGATED_SIGNER_ENABLED: 'delegatedSignerEnabled',
  GMX_API_ORDER_SUBMISSION_ENABLED: 'gmxOrderSubmissionEnabled',
  LIVE_TEST_EXECUTION_LOCKED: 'liveTestExecutionLocked',
  GMX_RELAY_SUBMISSION_ENABLED: 'relaySubmissionEnabled',
  GMX_RELAY_NETWORK_ENABLED: 'relaySubmitNetworkEnabled',
  GMX_RELAY_MODE: 'relayMode',
} as const satisfies Record<string, keyof typeof APPROVED_PRODUCTION_SAFETY_TARGET>;

function manualCanaryTargetDrift(document: string): string[] {
  const section = document
    .split('## 실제 실행 전 필요한 것 (이 작업에서는 변경하지 않음)')[1]
    ?.split(/\n## /)[0];
  if (!section) return ['approved Production target section missing'];

  const entries = [...section.matchAll(/^- `([A-Z0-9_]+)=([^`]+)`$/gm)];
  const documented = new Map<string, string[]>();
  for (const [, envName, rawValue] of entries) {
    documented.set(envName, [...(documented.get(envName) ?? []), rawValue]);
  }

  const drift: string[] = [];
  for (const [envName, targetKey] of Object.entries(DOCUMENTED_TARGET_BINDINGS)) {
    const values = documented.get(envName) ?? [];
    if (values.length === 0) {
      drift.push(`missing ${envName}`);
      continue;
    }
    if (values.length !== 1) {
      drift.push(`duplicate ${envName}`);
      continue;
    }
    const expected = String(APPROVED_PRODUCTION_SAFETY_TARGET[targetKey]);
    if (values[0] !== expected) {
      drift.push(`${envName}: expected ${expected}, got ${values[0]}`);
    }
  }

  for (const envName of documented.keys()) {
    if (!(envName in DOCUMENTED_TARGET_BINDINGS)) {
      drift.push(`unexpected documented target ${envName}`);
    }
  }
  return drift;
}

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

describe('operational build/approved/effective diagnostics', () => {
  it('binds the exact user-approved Production safety target', () => {
    expect(APPROVED_PRODUCTION_SAFETY_TARGET).toEqual({
      engineMode: 'PAPER',
      autoWorkerLiveEnabled: false,
      liveTestExecutionLocked: false,
      delegatedSignerEnabled: true,
      gmxOrderSubmissionEnabled: true,
      relaySubmissionEnabled: false,
      relaySubmitNetworkEnabled: false,
      relayMode: 'DISABLED',
    });
  });

  it('keeps the manual Canary operating target bound to the approved safety target', () => {
    const manualCanary = readFileSync(MANUAL_CANARY_PATH, 'utf8');
    expect(manualCanaryTargetDrift(manualCanary)).toEqual([]);
  });

  it('fails closed when a documented target drifts or is missing', () => {
    const manualCanary = readFileSync(MANUAL_CANARY_PATH, 'utf8');
    expect(manualCanaryTargetDrift(
      manualCanary.replace('`WORKER_ENGINE_MODE=PAPER`', '`WORKER_ENGINE_MODE=LIVE`'),
    )).toContain('WORKER_ENGINE_MODE: expected PAPER, got LIVE');
    expect(manualCanaryTargetDrift(
      manualCanary.replace('- `GMX_RELAY_MODE=DISABLED`', ''),
    )).toContain('missing GMX_RELAY_MODE');
  });

  it('keeps the approved target bound to the checked-in Production overrides', () => {
    const replitConfig = readFileSync(resolve(import.meta.dirname, '../../../../.replit'), 'utf8');
    const sharedSection = replitConfig
      .split('[userenv.shared]')[1]
      ?.split(/\n\s*\[/)[0] ?? '';
    const productionSection = replitConfig
      .split('[userenv.production]')[1]
      ?.split(/\n\s*\[/)[0] ?? '';
    expect(sharedSection).toContain('WORKER_ENGINE_MODE = "PAPER"');
    expect(sharedSection).toContain('AUTO_WORKER_LIVE_ENABLED = "false"');
    expect(productionSection).toContain('DELEGATED_SIGNER_ENABLED = "true"');
    expect(productionSection).toContain('GMX_API_ORDER_SUBMISSION_ENABLED = "true"');
    expect(productionSection).toContain('LIVE_TEST_EXECUTION_LOCKED = "false"');
    expect(productionSection).toContain('GMX_RELAY_SUBMISSION_ENABLED = "false"');
    expect(productionSection).toContain('GMX_RELAY_NETWORK_ENABLED = "false"');
    expect(productionSection).toContain('GMX_RELAY_MODE = "DISABLED"');
    expect(APPROVED_PRODUCTION_SAFETY_TARGET.engineMode).toBe('PAPER');
    expect(APPROVED_PRODUCTION_SAFETY_TARGET.autoWorkerLiveEnabled).toBe(false);
    expect(APPROVED_PRODUCTION_SAFETY_TARGET.relaySubmissionEnabled).toBe(false);
    expect(APPROVED_PRODUCTION_SAFETY_TARGET.relaySubmitNetworkEnabled).toBe(false);
    expect(APPROVED_PRODUCTION_SAFETY_TARGET.relayMode).toBe('DISABLED');
    expect(APPROVED_PRODUCTION_SAFETY_TARGET).toMatchObject({
      delegatedSignerEnabled: true,
      gmxOrderSubmissionEnabled: true,
      liveTestExecutionLocked: false,
    });
  });

  it('reports approved target/runtime match separately from differing build observations', () => {
    const result = deriveOperationalDiagnostics({
      DELEGATED_SIGNER_ENABLED: 'true',
      GMX_API_ORDER_SUBMISSION_ENABLED: 'true',
      LIVE_TEST_EXECUTION_LOCKED: 'false',
    }, {
      engineMode: 'PAPER',
      liveExecutionLocked: false,
      relayFlags: relayOff,
    }, identity());
    expect(result.flags.engineMode.status).toBe('MATCH');
    expect(result.flags.gmxOrderSubmissionEnabled).toMatchObject({
      buildObserved: false,
      configured: false,
      approvedTarget: true,
      effective: true,
      status: 'MATCH',
      buildObservationStatus: 'DRIFT',
    });
    expect(result.flags.delegatedSignerEnabled).toMatchObject({
      buildObserved: false, approvedTarget: true, effective: true, status: 'MATCH',
      buildObservationStatus: 'DRIFT',
    });
    expect(result.flags.liveTestExecutionLocked).toMatchObject({
      configured: true, buildObserved: true, approvedTarget: false, effective: false, status: 'MATCH',
      buildObservationStatus: 'DRIFT',
    });
    expect(result.provenance).toMatchObject({
      status: 'MATCH', sameCommit: true, sameProductTree: true,
    });
  });

  it('reports drift only when effective runtime differs from the approved target', () => {
    const result = deriveOperationalDiagnostics({}, {
      engineMode: 'PAPER',
      liveExecutionLocked: true,
      relayFlags: relayOff,
    }, identity());
    expect(result.flags.delegatedSignerEnabled).toMatchObject({
      buildObserved: false, approvedTarget: true, effective: false, status: 'DRIFT',
    });
    expect(result.flags.gmxOrderSubmissionEnabled).toMatchObject({
      buildObserved: false, approvedTarget: true, effective: false, status: 'DRIFT',
    });
    expect(result.flags.liveTestExecutionLocked).toMatchObject({
      buildObserved: true, approvedTarget: false, effective: true, status: 'DRIFT',
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

  it('keeps approved/runtime comparison available when build observation is missing', () => {
    const result = deriveOperationalDiagnostics({
      DELEGATED_SIGNER_ENABLED: 'true',
      GMX_API_ORDER_SUBMISSION_ENABLED: 'true',
      LIVE_TEST_EXECUTION_LOCKED: 'false',
    }, {
      engineMode: 'PAPER',
      liveExecutionLocked: false,
      relayFlags: relayOff,
    }, null);
    expect(result.flags.engineMode).toMatchObject({
      configured: null,
      buildObserved: null,
      approvedTarget: 'PAPER',
      effective: 'PAPER',
      status: 'MATCH',
      buildObservationStatus: 'UNAVAILABLE',
    });
  });
});