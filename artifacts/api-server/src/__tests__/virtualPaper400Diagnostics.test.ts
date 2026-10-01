import { describe, it, expect } from 'vitest';
import { advanceVirtualDiagnostics } from '../workers/virtualPaper400Diagnostics';
import { virtualReplaySignal } from './helpers/virtualPaper400Replay';
const now = Date.parse('2026-09-22T01:00:10Z');
const input = () => ({ raw: null as string | null, sessionId: 'test', now,
  records: [virtualReplaySignal(now)], analysis: [{symbol:'BTC',reason:'candidate'}],
  diagnostics: [{symbol:'BTC',reason:'MODE_HORIZON_COST_CAP'}], status:'NO_TRADE', reason:'NO_ELIGIBLE_CLOSED_CANDLE_SIGNAL',
  openCount:0,closeCount:0,lastOpenAtMs:null,sessionStartedAtMs:now-3_600_000 });
describe('bounded durable PAPER diagnostics', () => {
  it('counts each symbol/completed candle once across restart and distinguishes polls from signals', () => {
    const a=advanceVirtualDiagnostics(input());
    const b=advanceVirtualDiagnostics({...input(),raw:JSON.stringify(a.state),now:now+60_000});
    expect(b.summary.status).toBe('OBSERVED');
    if(b.summary.status!=='OBSERVED')throw Error('fixture');
    expect(b.summary.counts).toMatchObject({EVALUATED_CANDLE:1,DIRECTIONAL_CANDIDATE:1,OBSERVED_MINUTE:2,'ENTRY_REJECT:MODE_HORIZON_COST_CAP':1});
    expect(b.summary.minutesWithoutNewEntry).toBe(61);
    expect(b.summary.ledger).toEqual({opens:0,closes:0});
    expect(b.summary.historyReconstructed).toBe(false);
  });
  it('drops expired buckets but retains cursors and never manufactures old history', () => {
    const a=advanceVirtualDiagnostics(input());
    const b=advanceVirtualDiagnostics({...input(),raw:JSON.stringify(a.state),now:now+25*3_600_000});
    expect(b.state?.buckets).toHaveLength(1);
    expect(b.state?.buckets[0].counts.EVALUATED_CANDLE).toBeUndefined();
    expect(b.state?.since).toBe(now);
  });
  it('accepts pre-incident v1 buckets and rejects malformed incident history',()=>{
    const first=advanceVirtualDiagnostics(input());
    const legacy=JSON.parse(JSON.stringify(first.state));
    delete legacy.buckets[0].incidents;
    expect(advanceVirtualDiagnostics({...input(),raw:JSON.stringify(legacy),now:now+60_000}).summary.status).toBe('OBSERVED');
    legacy.buckets[0].incidents=[{minute:Math.floor((now+3_600_000)/60_000),kind:'ENTRY_REJECT',symbol:'BTC',detail:'x'}];
    expect(advanceVirtualDiagnostics({...input(),raw:JSON.stringify(legacy),now:now+60_000}).summary.status).toBe('UNAVAILABLE');
  });
  it.each(['{broken',JSON.stringify({version:'wrong'}),JSON.stringify({...advanceVirtualDiagnostics(input()).state,sessionId:'other'})])('preserves corrupt evidence without granting or blocking execution: %s',raw=>{
    const r=advanceVirtualDiagnostics({...input(),raw});
    expect(r.state).toBeNull();expect(r.summary.status).toBe('UNAVAILABLE');
  });
  it('sanitizes provider details and refuses future/out-of-order candle counts',()=>{
    const i=input();i.analysis[0].reason='COST_UNAVAILABLE https://private.example?key=secret';
    const r=advanceVirtualDiagnostics({...i,records:[{...i.records[0],sourceCandleCloseTime:now+1}]});
    expect(JSON.stringify(r.summary)).not.toContain('secret');
    expect(r.summary.status).toBe('OBSERVED');
    if (!('counts' in r.summary) || !('recentIncidents' in r.summary)) throw Error('fixture');
    const summary = r.summary as { counts: Record<string, number>; recentIncidents: unknown[] };
    expect(summary.counts['ANALYSIS_COST_UNAVAILABLE:BTC']).toBe(1);
    expect(summary.recentIncidents).toEqual([expect.objectContaining({
      kind: 'ANALYSIS_COST_UNAVAILABLE', symbol: 'BTC',
    })]);
    expect(r.state?.buckets[0].counts.EVALUATED_CANDLE).toBeUndefined();
  });
  it('attributes a missing accepted candle without claiming an upstream cause',()=>{
    const zec = { ...virtualReplaySignal(now - 3_600_000), symbol: 'ZEC' };
    const first = advanceVirtualDiagnostics({ ...input(),
      records: [zec],
      analysis: [{ symbol: 'ZEC', reason: 'candidate' }], diagnostics: [] });
    const btc = { ...virtualReplaySignal(now), symbol: 'BTC' };
    const result = advanceVirtualDiagnostics({ ...input(), raw: JSON.stringify(first.state), now: now + 60_000,
      records: [btc], analysis: [
        { symbol: 'BTC', reason: 'candidate' },
        { symbol: 'ZEC', reason: 'ANALYSIS_PARTIAL: completed candle record unavailable' },
      ], diagnostics: [] });
    expect(result.summary.status).toBe('OBSERVED');
    if (result.summary.status !== 'OBSERVED') throw Error('fixture');
    expect(result.summary.counts).toMatchObject({
      'ANALYSIS_NOT_EVALUATED:ZEC': 1,
      'SOURCE_CANDLE_NOT_ACCEPTED:ZEC': 1,
    });
    expect(result.summary.recentIncidents).toContainEqual(expect.objectContaining({
      kind: 'SOURCE_CANDLE_NOT_ACCEPTED', symbol: 'ZEC',
    }));
    expect(result.state?.cursors.ZEC).toBe(zec.sourceCandleCloseTime);
  });
  it('aggregates measured signal and safety evidence once per symbol candle and survives restart', () => {
    const evidence = {
      id: `ETH:${now - 15 * 60_000}`, symbol: 'ETH', closedAt: now - 15 * 60_000,
      evaluatedAt: new Date(now - 10_000).toISOString(),
      policyVersion: 'virtual400-daily/v8' as const, eligible: false, reason: 'NO_OBSERVED_STRUCTURE_TARGET',
      kind: 'SIGNAL' as const,
      conditions: [
        { name: 'atrFraction', value: .006, operator: 'between', threshold: .004, passed: true },
        { name: 'netRewardRisk', value: 0.92, operator: '>=', threshold: 1.5, passed: false },
        { name: 'roundTripCostUsd', value: null, operator: '<=', threshold: 2, passed: null, unit: 'USD' },
      ],
    };
    const legacyEvidence = { ...evidence, policyVersion: 'virtual400-daily/v7' as const, reason: 'WEAK_MOMENTUM' };
    const first = advanceVirtualDiagnostics({ ...input(), adaptiveEvaluations: [evidence, legacyEvidence],
      diagnostics: [{ symbol: 'ETH', reason: 'PAPER_MARKET_QUALITY:NO_OBSERVED_STRUCTURE_TARGET' },
        { symbol: 'ETH', reason: 'PAPER_NET_REWARD_RISK_BELOW_1_5' }], nextEvaluationAt: now + 60_000 });
    const second = advanceVirtualDiagnostics({ ...input(), raw: JSON.stringify(first.state), now: now + 60_000,
      adaptiveEvaluations: [evidence, legacyEvidence], nextEvaluationAt: now + 90_000 });
    expect(first.state?.evaluationCursors).toEqual({
      'ETH:virtual400-daily/v8': evidence.closedAt, 'ETH:virtual400-daily/v7': evidence.closedAt,
    });
    expect(second.summary.status).toBe('OBSERVED');
    if (second.summary.status !== 'OBSERVED') throw Error('fixture');
    expect(second.summary.counts).toMatchObject({
      'EXPERIMENT_REJECT:PAPER_MARKET_QUALITY:NO_OBSERVED_STRUCTURE_TARGET': 1,
      'EXPERIMENT_REJECT:PAPER_NET_REWARD_RISK_BELOW_1_5': 1,
    });
    expect(second.summary.adaptiveEvaluations).toMatchObject({
      status: 'OBSERVED', candidates: 2, rejected: 2, eligible: 0,
      signal: { candidates: 2, rejected: 2 }, safety: { candidates: 0 },
      byPolicy: [
        { version: 'virtual400-daily/v8', candidates: 1, rejected: 1 },
        { version: 'virtual400-daily/v7', candidates: 1, rejected: 1 },
      ],
      rejectionReasons: expect.arrayContaining([{ reason: 'NO_OBSERVED_STRUCTURE_TARGET', count: 1 }]),
      nextEvaluationAt: new Date(now + 90_000).toISOString(),
      conditions: expect.arrayContaining([
        expect.objectContaining({ name: 'netRewardRisk', observed: 2, failed: 2, mean: .92, meanThreshold: 1.5 }),
        expect.objectContaining({ name: 'roundTripCostUsd', observed: 0, missing: 2, mean: null }),
      ]),
    });
    expect(second.state?.buckets[0].entryEvaluations?.candidates).toBe(2);
    expect(second.summary.entryEvaluations).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'ETH', policyVersion: 'virtual400-daily/v8', evaluatedAt: now - 10_000 }),
    ]));
  });
  it('records safety-gate failures separately from signal scores, and does not use future evaluation times', () => {
    const evidence = {
      id: `BTC:${now - 15 * 60_000}`, symbol: 'BTC', closedAt: now - 15 * 60_000, evaluatedAt: new Date(now).toISOString(),
      policyVersion: 'virtual400-daily/v8' as const, eligible: false, reason: 'PAPER_DAILY_LOSS_5_PERCENT',
      kind: 'ECONOMICS' as const, conditions: [
        { name: 'dailyLossPct', value: 5.2, operator: '<', threshold: 5, passed: false, unit: '%' },
        { name: 'positionCap', value: 1, operator: '=', threshold: 0, passed: false },
      ],
    };
    const result = advanceVirtualDiagnostics({ ...input(), adaptiveEvaluations: [evidence], nextEvaluationAt: now - 1 });
    expect(result.summary.status).toBe('OBSERVED');
    if (result.summary.status !== 'OBSERVED') throw Error('fixture');
    expect(result.summary.adaptiveEvaluations).toMatchObject({
      candidates: 1, safety: { candidates: 1, rejected: 1 }, signal: { candidates: 0 }, nextEvaluationAt: null,
    });
    if (result.summary.status === 'OBSERVED') {
      expect(result.summary.entryEvaluations).toContainEqual(expect.objectContaining({
        kind: 'SAFETY', conditions: expect.arrayContaining([expect.objectContaining({ name: 'positionCap', operator: '==' })]),
      }));
    }
  });
});
