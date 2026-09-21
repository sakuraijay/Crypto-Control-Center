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
  it.each(['{broken',JSON.stringify({version:'wrong'}),JSON.stringify({...advanceVirtualDiagnostics(input()).state,sessionId:'other'})])('preserves corrupt evidence without granting or blocking execution: %s',raw=>{
    const r=advanceVirtualDiagnostics({...input(),raw});
    expect(r.state).toBeNull();expect(r.summary.status).toBe('UNAVAILABLE');
  });
  it('sanitizes provider details and refuses future/out-of-order candle counts',()=>{
    const i=input();i.analysis[0].reason='COST_UNAVAILABLE https://private.example?key=secret';
    const r=advanceVirtualDiagnostics({...i,records:[{...i.records[0],sourceCandleCloseTime:now+1}]});
    expect(JSON.stringify(r.summary)).not.toContain('secret');
    expect(r.state?.buckets[0].counts.EVALUATED_CANDLE).toBeUndefined();
  });
});
