// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BetaRcStatusCard } from '../dashboard/BetaRcStatusCard';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BetaRcStatusCard release metadata observability', () => {
  it('labels build-time values separately and renders build/source drift provenance', async () => {
    const executor = {
      engineMode: 'PAPER',
      liveExecutionLocked: false,
      liveTestMode: false,
      serverPaperExec: null,
      operationalDiagnostics: {
        schemaVersion: 2,
        flags: {
          delegatedSignerEnabled: {
            configured: false,
            buildObserved: false,
            approvedTarget: true,
            effective: true,
            status: 'MATCH',
            driftReason: null,
            buildObservationStatus: 'DRIFT',
            buildObservationReason: 'build snapshot differs from current runtime',
          },
          liveTestExecutionLocked: {
            configured: true,
            buildObserved: true,
            approvedTarget: false,
            effective: false,
            status: 'MATCH',
            driftReason: null,
            buildObservationStatus: 'DRIFT',
            buildObservationReason: 'build snapshot differs from current runtime',
          },
        },
        provenance: {
          status: 'DRIFT',
          driftReason: 'embedded release product tree differs from workspace build snapshot',
          sameCommit: true,
          sameProductTree: false,
        },
      },
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('executor/status')
        ? executor
        : url.includes('market-intelligence/status')
          ? { available: false, reason: 'not observed' }
          : { buckets: [] };
      return { ok: true, json: async () => body };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<BetaRcStatusCard />);

    expect(await screen.findByText('Build 환경 관측값 차이 있음 (정보) — 운영 Drift 판정에는 사용하지 않습니다.')).toBeTruthy();
    expect(screen.getByText('값 순서: build-time 관측 / 승인된 Production 목표 / effective runtime', { exact: false })).toBeTruthy();
    expect(screen.getByText('false / true / true · build build snapshot differs from current runtime')).toBeTruthy();
    expect(screen.getByText('true / false / false · build build snapshot differs from current runtime')).toBeTruthy();
    expect(screen.getByText('Build workspace snapshot / embedded release provenance: DRIFT', { exact: false })).toBeTruthy();
    expect(screen.getByText('commit same', { exact: false })).toBeTruthy();
    expect(screen.getByText('tree different', { exact: false })).toBeTruthy();
    expect(screen.getByText('DRIFT / UNAVAILABLE (fail-closed)')).toBeTruthy();
  });
});