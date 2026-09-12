import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { RISK_POLICY } from '../lib/riskPolicy';

describe('risk Hard Stop read-only response contract', () => {
  const route = readFileSync(resolve(__dirname, '../routes/risk.ts'), 'utf8');
  const worker = readFileSync(resolve(__dirname, '../workers/aiWorker.ts'), 'utf8');

  it('exposes the current authoritative threshold independently from the historical trigger snapshot', () => {
    expect(RISK_POLICY.hardStopEquityUsd).toBe(920);
    expect(route).toContain('currentHardStopPolicyEquityUsd: RISK_POLICY.hardStopEquityUsd');
    expect(route).toContain(
      'historicalHardStopTriggerReason: status.riskHistoricalHardStopTriggerReason',
    );
    expect(worker).toContain(
      'riskHistoricalHardStopTriggerReason: this.riskState?.locks.hardStopReason ?? null',
    );
  });
});