import {describe,it,expect} from 'vitest';
import {CANONICAL_PATTERN_ENTRY_REGISTRY,evaluatePatternEntries,isIssuedPatternEntry,isTrustedPatternEntryEvidence,PATTERN_ENTRY_VERSION} from '../intel/patterns/patternEntryStrategies';
import {confirmedPivots,TIMEFRAMES,type RawCandles,type Timeframe} from '../intel/patterns/chartPatterns';

const ids=`DOJI DRAGONFLY_DOJI GRAVESTONE_DOJI SPINNING_TOP HAMMER HANGING_MAN INVERTED_HAMMER SHOOTING_STAR BULLISH_MARUBOZU BEARISH_MARUBOZU BULLISH_ENGULFING BEARISH_ENGULFING BULLISH_HARAMI BEARISH_HARAMI PIERCING DARK_CLOUD_COVER MORNING_STAR EVENING_STAR THREE_WHITE_SOLDIERS THREE_BLACK_CROWS DOUBLE_TOP DOUBLE_BOTTOM TRIPLE_TOP TRIPLE_BOTTOM HEAD_SHOULDERS INVERSE_HEAD_SHOULDERS RECTANGLE ASCENDING_TRIANGLE DESCENDING_TRIANGLE SYMMETRICAL_TRIANGLE RISING_WEDGE FALLING_WEDGE BROADENING PRICE_CHANNEL BULL_FLAG BEAR_FLAG BULL_PENNANT BEAR_PENNANT`.split(' ');
const base=Math.floor(1_700_000_000_000/900_000)*900_000;
const raw=(rows:number[][]):RawCandles=>({source:'gmx-official-api',prices:rows});
const candleData=(breakout:boolean,incomplete=false)=>{
  const rows:number[][]=[];
  for(let i=0;i<67;i++){const t=base+i*900_000;rows.push([t,100,101,99,100.5]);}
  rows.push([base+67*900_000,100,102,98,100]);
  rows.push([base+68*900_000,100,breakout?104:101,99,breakout?103:100]);
  if(incomplete)rows.push([base+69*900_000,103,100_000,1,99_999]);
  return rows;
};
describe('paper pattern entry v10',()=>{
  it('has one explicit formation/confirmation/direction/trigger/stop/exit contract for each of the exact 38 catalog ids',()=>{
    expect(CANONICAL_PATTERN_ENTRY_REGISTRY).toHaveLength(38);
    expect(CANONICAL_PATTERN_ENTRY_REGISTRY.map(x=>x.patternId).sort()).toEqual([...ids].sort());
    for(const c of CANONICAL_PATTERN_ENTRY_REGISTRY)for(const field of ['formation','confirmation','direction','entryTrigger','invalidationStop','exitCriteria'] as const)
      expect(c[field].length,`${c.patternId} ${field}`).toBeGreaterThan(0);
  });
  it('waits for neutral follow-up, then emits an observed-stop entry with stable event identity',()=>{
    const now=base+70*900_000;
    const waiting=evaluatePatternEntries('ETH',{'15m':raw(candleData(false))},now,'INTRADAY');
    expect(waiting.version).toBe(PATTERN_ENTRY_VERSION);
    expect(waiting.waiting.some(w=>w.patternId==='DOJI'&&w.upperTrigger===102&&w.lowerTrigger===98)).toBe(true);
    const confirmed=evaluatePatternEntries('ETH',{'15m':raw(candleData(true))},now,'INTRADAY');
    const doji=confirmed.candidates.find(c=>c.patternId==='DOJI');
    expect(doji?.direction).toBe('LONG');
    expect(doji?.stopPrice).toBe(98);
    expect(doji?.targetPrice).toBeNull();
    expect(doji?.targetBasis).toBeNull();
    expect(doji?.durableFormationId).toBe(doji?.eventId);
    expect(isIssuedPatternEntry(doji)).toBe(true);
    expect(isTrustedPatternEntryEvidence(doji)).toBe(true);
    expect(isTrustedPatternEntryEvidence({...doji})).toBe(false);
    expect(evaluatePatternEntries('ETH',{'15m':raw(candleData(true))},now,'INTRADAY').candidates.find(c=>c.patternId==='DOJI')?.eventId).toBe(doji?.eventId);
  });
  it('withholds simultaneous opposite neutral breakouts with a named conflict',()=>{
    const rows:number[][]=[];
    for(let i=0;i<66;i++)rows.push([base+i*900_000,100,101,99,100.5]);
    rows.push([base+66*900_000,90,92,88,90]);
    rows.push([base+67*900_000,100,101,99,100.5]);
    rows.push([base+68*900_000,100,102,98,100]);
    rows.push([base+69*900_000,100,101,94,95]);
    const result=evaluatePatternEntries('ETH',{'15m':raw(rows)},base+71*900_000,'INTRADAY');
    expect(result.conflicts.some(c=>c.timeframe==='15m'&&c.longPatternIds.includes('DOJI')&&c.shortPatternIds.includes('DOJI'))).toBe(true);
    expect(result.candidates.filter(c=>c.timeframe==='15m')).toEqual([]);
    expect(result.waiting.some(w=>w.reason.startsWith('CONFLICT:'))).toBe(true);
  });
  it('reports the newest neutral candle as waiting and freezes its first breakout after a later opposite cross',()=>{
    const waitingRows=candleData(false);
    const latest=waitingRows[waitingRows.length-1];
    latest[1]=100;latest[2]=102;latest[3]=98;latest[4]=100;
    const waiting=evaluatePatternEntries('ETH',{'15m':raw(waitingRows)},base+70*900_000,'INTRADAY');
    expect(waiting.waiting.some(w=>w.patternId==='DOJI'&&w.formationAt===latest[0])).toBe(true);

    const frozen=candleData(true);
    frozen.push([base+69*900_000,103,104,96,97]);
    const result=evaluatePatternEntries('ETH',{'15m':raw(frozen)},base+71*900_000,'INTRADAY');
    const original=base+67*900_000;
    expect(result.candidates.some(c=>c.patternId==='DOJI'&&c.formationAt===original)).toBe(false);
    expect(result.waiting.some(w=>w.patternId==='DOJI'&&w.formationAt===original&&w.reason.includes('First breakout direction is frozen'))).toBe(true);
  });
  it('uses timeframe-adaptive holds and ignores malformed/gapped data and future completed bars',()=>{
    for(const tf of ['1h','4h'] as const) {
      const step=TIMEFRAMES[tf],start=Math.floor(1_700_000_000_000/step)*step,rows:number[][]=[];
      for(let i=0;i<57;i++)rows.push([start+i*step,100,101,99,100.5]);
      rows.push([start+57*step,100,102,98,100]);
      rows.push([start+58*step,100,104,99,103]);
      rows.push([start+59*step,103,104,102,103.5]);
      const result=evaluatePatternEntries('ETH',{[tf]:raw(rows)},start+61*step,'INTRADAY');
      expect(result.candidates.find(c=>c.patternId==='DOJI')?.maxHoldMs).toBe(TIMEFRAMES['1h']);
      const swing=evaluatePatternEntries('ETH',{[tf]:raw(rows)},start+61*step,'SWING');
      expect(swing.candidates.find(c=>c.patternId==='DOJI')?.maxHoldMs).toBe(TIMEFRAMES['4h']);
      const later=raw([...rows,[start+61*step,103,1_000,1,999]]);
      expect(evaluatePatternEntries('ETH',{[tf]:later},start+61*step,'INTRADAY').candidates.map(c=>c.eventId))
        .toEqual(result.candidates.map(c=>c.eventId));
    }
    const good=candleData(true);
    const gap=good.map(r=>[...r]);gap[20][0]+=900_000;
    expect(evaluatePatternEntries('ETH',{'15m':raw(gap)},base+70*900_000,'INTRADAY').candidates).toEqual([]);
    const malformed={source:'gmx-official-api',prices:[...good.slice(0,60),null]} as unknown as RawCandles;
    expect(evaluatePatternEntries('ETH',{'15m':malformed},base+70*900_000,'INTRADAY').candidates).toEqual([]);
  });
  it('retains structural formation identity across a repeated neckline recross',()=>{
    const rows:number[][]=[];
    for(let i=0;i<66;i++)rows.push([base+i*900_000,100,101,99,100]);
    rows[20]=[base+20*900_000,100,120,99,110];
    rows[25]=[base+25*900_000,95,100,90,95];
    rows[30]=[base+30*900_000,100,120,99,110];
    rows[64]=[base+64*900_000,105,107,104,106];
    rows[65]=[base+65*900_000,106,107,84,85];
    const first=evaluatePatternEntries('ETH',{'15m':raw(rows)},base+67*900_000,'INTRADAY');
    const original=first.candidates.find(c=>c.patternId==='DOUBLE_TOP');
    expect(original).toBeDefined();
    const recross=[...rows,[base+66*900_000,85,105,84,100],[base+67*900_000,100,101,84,85]];
    const second=evaluatePatternEntries('ETH',{'15m':raw(recross)},base+69*900_000,'INTRADAY');
    expect(second.candidates.find(c=>c.patternId==='DOUBLE_TOP')?.durableFormationId).toBe(original?.durableFormationId);
  });
  it('ignores an incomplete trailing candle and requires right-side pivot confirmation',()=>{
    const now=base+70*900_000;
    const clean=evaluatePatternEntries('ETH',{'15m':raw(candleData(true))},now,'SWING');
    const mutated=evaluatePatternEntries('ETH',{'15m':raw(candleData(true,true))},now,'SWING');
    expect(mutated.candidates.map(c=>c.eventId)).toEqual(clean.candidates.map(c=>c.eventId));
    const rows=Array.from({length:5},(_,i)=>({t:i*10,o:5,h:i===3?10:6,l:i===3?1:4,c:5}));
    expect(confirmedPivots(rows,10)).toEqual([]);
    expect(confirmedPivots([...rows,{t:50,o:5,h:6,l:4,c:5},{t:60,o:5,h:6,l:4,c:5}],10).some(p=>p.i===3&&p.availableAt===60)).toBe(true);
  });
});