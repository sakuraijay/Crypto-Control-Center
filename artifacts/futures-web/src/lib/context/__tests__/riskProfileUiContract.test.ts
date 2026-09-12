import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('risk profile web contract', () => {
  const context = readFileSync(resolve(__dirname, '../StrategyContext.tsx'), 'utf8');
  const page = readFileSync(resolve(__dirname, '../../../pages/strategy.tsx'), 'utf8');

  it('uses the dedicated profile API and sends the operator PIN only in its header', () => {
    expect(context).toContain("apiUrl('data/risk-profile')");
    expect(context).toContain("'x-operator-pin': pin");
    expect(context).not.toMatch(/body:\s*JSON\.stringify\(\{\s*profile,\s*pin/);
  });

  it('polls only while pending and exposes applied/requested/boundary state', () => {
    expect(context).toContain('if (riskProfile?.pending)');
    expect(context).toContain('timer = setTimeout(() =>');
    expect(page).toContain('Applied');
    expect(page).toContain('Requested');
    expect(page).toContain('Cycle boundary');
    expect(page).toContain('riskProfile.reason');
  });

  it('requires explicit confirmation and clears the local PIN after each request', () => {
    expect(page).toContain('Confirm Profile Change');
    expect(page).toContain('Warning: Aggressive mode');
    expect(page).toMatch(/finally\s*\{\s*setPin\(''\)/);
    expect(page).toContain('type="password"');
  });
});