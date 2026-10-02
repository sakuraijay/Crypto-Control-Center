import { analyzePatternFrame, TIMEFRAMES, type Candle, type RawCandles, type Timeframe } from './chartPatterns';

export const PATTERN_ENTRY_VERSION = 'paper-pattern-entry/v10' as const;
export type EntryDirection = 'LONG' | 'SHORT';
export type PatternEntryEvidence = {
  eventId:string; durableFormationId:string; symbol:string; patternId:string; timeframe:Timeframe; direction:EntryDirection;
  formationAt:number; confirmedAt:number; triggerPrice:number; referencePrice:number;
  stopPrice:number; targetPrice:number|null; targetBasis:string|null; expiresAt:number; maxHoldMs:number;
  supportingPatternIds:string[]; conflictingPatternIds:string[];
  auxiliary:{formation:string;confirmation:string;entry:string;invalidation:string;exit:string;observedTarget:string|null};
};
export type PatternEntryWaiting = {eventId:string;patternId:string;timeframe:Timeframe;formationAt:number;reason:string;upperTrigger:number|null;lowerTrigger:number|null};
export type PatternEntryConflict = {eventId:string;timeframe:Timeframe;formationAt:number;reason:string;longPatternIds:string[];shortPatternIds:string[]};
export type PatternEntryResult = {version:typeof PATTERN_ENTRY_VERSION;candidates:PatternEntryEvidence[];waiting:PatternEntryWaiting[];conflicts:PatternEntryConflict[]};

export type PatternEntryContract = {
  patternId:string; formation:string; confirmation:string; direction:'LONG'|'SHORT'|'NEUTRAL'|'BREAKOUT';
  entryTrigger:string; invalidationStop:string; exitCriteria:string;
};
const contracts:PatternEntryContract[]=[
  ['DOJI','Completed candle body <=10% of range.','A later completed close beyond formation high/low.','NEUTRAL','Close beyond formation high/low; wait for direction.','Opposite side of formation range.','Observed stop or maximum hold; no synthetic target.'],
  ['DRAGONFLY_DOJI','Completed doji with lower wick >=70% of range.','A later completed close beyond formation high/low.','NEUTRAL','Close beyond formation high/low; wait for direction.','Opposite side of formation range.','Observed stop or maximum hold; no synthetic target.'],
  ['GRAVESTONE_DOJI','Completed doji with upper wick >=70% of range.','A later completed close beyond formation high/low.','NEUTRAL','Close beyond formation high/low; wait for direction.','Opposite side of formation range.','Observed stop or maximum hold; no synthetic target.'],
  ['SPINNING_TOP','Completed small-body candle with two substantial wicks.','A later completed close beyond formation high/low.','NEUTRAL','Close beyond formation high/low; wait for direction.','Opposite side of formation range.','Observed stop or maximum hold; no synthetic target.'],
  ['HAMMER','Completed lower-wick reversal candle after a downtrend.','Closed reversal candle after prior downtrend.','LONG','Completed confirmation close.','Observed formation low.','Observed stop or maximum hold; no synthetic target.'],
  ['HANGING_MAN','Completed lower-wick candle after an uptrend.','Closed reversal candle after prior uptrend.','SHORT','Completed confirmation close.','Observed formation high.','Observed stop or maximum hold; no synthetic target.'],
  ['INVERTED_HAMMER','Completed upper-wick reversal candle after a downtrend.','Closed reversal candle after prior downtrend.','LONG','Completed confirmation close.','Observed formation low.','Observed stop or maximum hold; no synthetic target.'],
  ['SHOOTING_STAR','Completed upper-wick reversal candle after an uptrend.','Closed reversal candle after prior uptrend.','SHORT','Completed confirmation close.','Observed formation high.','Observed stop or maximum hold; no synthetic target.'],
  ['BULLISH_MARUBOZU','Completed bullish body >=90% of range and >=0.7 ATR.','Completed strong bullish candle.','LONG','Completed confirmation close.','Observed formation low.','Observed stop or maximum hold; no synthetic target.'],
  ['BEARISH_MARUBOZU','Completed bearish body >=90% of range and >=0.7 ATR.','Completed strong bearish candle.','SHORT','Completed confirmation close.','Observed formation high.','Observed stop or maximum hold; no synthetic target.'],
  ['BULLISH_ENGULFING','Completed bullish body engulfs prior bearish body after downtrend.','Completed engulfing close.','LONG','Completed confirmation close.','Observed lower formation extreme.','Observed stop or maximum hold; no synthetic target.'],
  ['BEARISH_ENGULFING','Completed bearish body engulfs prior bullish body after uptrend.','Completed engulfing close.','SHORT','Completed confirmation close.','Observed upper formation extreme.','Observed stop or maximum hold; no synthetic target.'],
  ['BULLISH_HARAMI','Completed small bullish body contained in prior bearish body after downtrend.','Completed harami formation candle.','LONG','Completed confirmation close.','Observed lower formation extreme.','Observed stop or maximum hold; no synthetic target.'],
  ['BEARISH_HARAMI','Completed small bearish body contained in prior bullish body after uptrend.','Completed harami formation candle.','SHORT','Completed confirmation close.','Observed upper formation extreme.','Observed stop or maximum hold; no synthetic target.'],
  ['PIERCING','Completed close recovery above prior bearish midpoint after downtrend.','Completed piercing close.','LONG','Completed confirmation close.','Observed lower formation extreme.','Observed stop or maximum hold; no synthetic target.'],
  ['DARK_CLOUD_COVER','Completed close below prior bullish midpoint after uptrend.','Completed dark-cloud close.','SHORT','Completed confirmation close.','Observed upper formation extreme.','Observed stop or maximum hold; no synthetic target.'],
  ['MORNING_STAR','Three completed candles form bullish reversal after downtrend.','Third candle closes above first-body midpoint.','LONG','Completed third-candle close.','Observed three-candle low.','Observed stop or maximum hold; no synthetic target.'],
  ['EVENING_STAR','Three completed candles form bearish reversal after uptrend.','Third candle closes below first-body midpoint.','SHORT','Completed third-candle close.','Observed three-candle high.','Observed stop or maximum hold; no synthetic target.'],
  ['THREE_WHITE_SOLDIERS','Three strong completed rising bodies after downtrend.','Third soldier close confirms sequence.','LONG','Completed third-candle close.','Observed sequence low.','Observed stop or maximum hold; no synthetic target.'],
  ['THREE_BLACK_CROWS','Three strong completed falling bodies after uptrend.','Third crow close confirms sequence.','SHORT','Completed third-candle close.','Observed sequence high.','Observed stop or maximum hold; no synthetic target.'],
  ['DOUBLE_TOP','Two spaced, right-confirmed highs with neckline.','Completed close breaks neckline.','SHORT','Neckline close-break level.','Observed double-top high.','Observed stop or maximum hold; no synthetic target.'],
  ['DOUBLE_BOTTOM','Two spaced, right-confirmed lows with neckline.','Completed close breaks neckline.','LONG','Neckline close-break level.','Observed double-bottom low.','Observed stop or maximum hold; no synthetic target.'],
  ['TRIPLE_TOP','Three spaced, right-confirmed highs with neckline.','Completed close breaks neckline.','SHORT','Neckline close-break level.','Observed triple-top high.','Observed stop or maximum hold; no synthetic target.'],
  ['TRIPLE_BOTTOM','Three spaced, right-confirmed lows with neckline.','Completed close breaks neckline.','LONG','Neckline close-break level.','Observed triple-bottom low.','Observed stop or maximum hold; no synthetic target.'],
  ['HEAD_SHOULDERS','Three right-confirmed highs with central peak and fitted neckline.','Completed close breaks fitted neckline.','SHORT','Fitted neckline close-break level.','Observed right-shoulder high.','Observed stop or maximum hold; no synthetic target.'],
  ['INVERSE_HEAD_SHOULDERS','Three right-confirmed lows with central trough and fitted neckline.','Completed close breaks fitted neckline.','LONG','Fitted neckline close-break level.','Observed right-shoulder low.','Observed stop or maximum hold; no synthetic target.'],
  ['RECTANGLE','Bounded consolidation with three confirmed touches per boundary.','Completed close beyond fitted boundary.','BREAKOUT','Upper boundary close-break for LONG; lower for SHORT.','Opposite fitted boundary.','Observed stop or maximum hold; no synthetic target.'],
  ['ASCENDING_TRIANGLE','Bounded consolidation with flat highs and rising lows.','Completed close beyond fitted boundary.','BREAKOUT','Upper boundary close-break for LONG; lower for SHORT.','Opposite fitted boundary.','Observed stop or maximum hold; no synthetic target.'],
  ['DESCENDING_TRIANGLE','Bounded consolidation with flat lows and falling highs.','Completed close beyond fitted boundary.','BREAKOUT','Upper boundary close-break for LONG; lower for SHORT.','Opposite fitted boundary.','Observed stop or maximum hold; no synthetic target.'],
  ['SYMMETRICAL_TRIANGLE','Bounded consolidation with converging confirmed boundaries.','Completed close beyond fitted boundary.','BREAKOUT','Upper boundary close-break for LONG; lower for SHORT.','Opposite fitted boundary.','Observed stop or maximum hold; no synthetic target.'],
  ['RISING_WEDGE','Bounded consolidation with rising, converging boundaries.','Completed close beyond fitted boundary.','BREAKOUT','Upper boundary close-break for LONG; lower for SHORT.','Opposite fitted boundary.','Observed stop or maximum hold; no synthetic target.'],
  ['FALLING_WEDGE','Bounded consolidation with falling, converging boundaries.','Completed close beyond fitted boundary.','BREAKOUT','Upper boundary close-break for LONG; lower for SHORT.','Opposite fitted boundary.','Observed stop or maximum hold; no synthetic target.'],
  ['BROADENING','Bounded consolidation with expanding confirmed boundaries.','Completed close beyond fitted boundary.','BREAKOUT','Upper boundary close-break for LONG; lower for SHORT.','Opposite fitted boundary.','Observed stop or maximum hold; no synthetic target.'],
  ['PRICE_CHANNEL','Bounded consolidation with parallel sloping boundaries.','Completed close beyond fitted boundary.','BREAKOUT','Upper boundary close-break for LONG; lower for SHORT.','Opposite fitted boundary.','Observed stop or maximum hold; no synthetic target.'],
  ['BULL_FLAG','Bull pole followed by bounded channel and continuation break.','Completed close breaks continuation boundary.','LONG','Continuation boundary close-break.','Observed lower consolidation boundary.','Observed stop or maximum hold; no synthetic target.'],
  ['BEAR_FLAG','Bear pole followed by bounded channel and continuation break.','Completed close breaks continuation boundary.','SHORT','Continuation boundary close-break.','Observed upper consolidation boundary.','Observed stop or maximum hold; no synthetic target.'],
  ['BULL_PENNANT','Bull pole followed by bounded converging pennant and continuation break.','Completed close breaks continuation boundary.','LONG','Continuation boundary close-break.','Observed lower consolidation boundary.','Observed stop or maximum hold; no synthetic target.'],
  ['BEAR_PENNANT','Bear pole followed by bounded converging pennant and continuation break.','Completed close breaks continuation boundary.','SHORT','Continuation boundary close-break.','Observed upper consolidation boundary.','Observed stop or maximum hold; no synthetic target.'],
].map(([patternId,formation,confirmation,direction,entryTrigger,invalidationStop,exitCriteria])=>({patternId,formation,confirmation,direction,entryTrigger,invalidationStop,exitCriteria} as PatternEntryContract));
export const CANONICAL_PATTERN_ENTRY_REGISTRY:readonly PatternEntryContract[]=Object.freeze(contracts);
const registry=new Map(CANONICAL_PATTERN_ENTRY_REGISTRY.map(c=>[c.patternId,c]));
const trustedEvidence=new WeakSet<object>();
export function isTrustedPatternEntryEvidence(value:unknown):value is PatternEntryEvidence {
  return !!value&&typeof value==='object'&&trustedEvidence.has(value as object);
}
/** Runtime-facing name for the in-memory issued-evidence brand guard. */
export const isIssuedPatternEntry = isTrustedPatternEntryEvidence;
const tfNames=Object.keys(TIMEFRAMES) as Timeframe[];
const norm=(raw:RawCandles,tf:Timeframe,now:number):Candle[]=>{
  if(!raw||raw.source!=='gmx-official-api'||!Array.isArray(raw.prices)
    ||raw.prices.some(r=>!Array.isArray(r)||r.length<5||!r.slice(0,5).every(Number.isFinite)))return [];
  return raw.prices.map(r=>({t:r[0]<1e12?r[0]*1000:r[0],o:r[1],h:r[2],l:r[3],c:r[4]}))
    .filter(r=>r.t+TIMEFRAMES[tf]<=now-2000).sort((a,b)=>a.t-b.t).slice(-240);
};
/** Pure recomputation from official raw OHLC: no caller-provided signal labels are accepted. */
export function evaluatePatternEntries(symbol:string,rawCandlesByTimeframe:Partial<Record<Timeframe,RawCandles>>,now:number,mode:'INTRADAY'|'SWING'):PatternEntryResult {
  const candidates:PatternEntryEvidence[]=[],waiting:PatternEntryWaiting[]=[];
  for(const timeframe of tfNames) {
    const raw=rawCandlesByTimeframe[timeframe]??null,rows=norm(raw,timeframe,now);
    if(rows.length<60)continue;
    const frame=analyzePatternFrame(raw,timeframe,now);
    if(frame.status!=='OK')continue;
    const last=rows[rows.length-1]!,step=TIMEFRAMES[timeframe];
    const hold=mode==='INTRADAY'?TIMEFRAMES['1h']:TIMEFRAMES['4h'];
    // Find the first completed breakout in history and freeze it. A later cross never
    // reverses the formation's direction or resets its expiry.
    for(let i=Math.max(0,rows.length-12);i<rows.length;i++) {
      const r=rows[i],range=r.h-r.l,size=Math.abs(r.c-r.o);
      if(range<=0)continue;
      const body=Math.min(r.o,r.c),top=Math.max(r.o,r.c),lower=body-r.l,upper=r.h-top;
      const id=size<=range*.1?(lower>=range*.7?'DRAGONFLY_DOJI':upper>=range*.7?'GRAVESTONE_DOJI':'DOJI')
        :size<=range*.3&&lower>=size&&upper>=size?'SPINNING_TOP':null;
      if(!id)continue;
      const eventId=`${symbol}:${timeframe}:${id}:${r.t}`;
      let first:{direction:EntryDirection;bar:Candle}|null=null;
      for(let j=i+1;j<rows.length;j++) {
        if(rows[j].c>r.h){first={direction:'LONG',bar:rows[j]};break;}
        if(rows[j].c<r.l){first={direction:'SHORT',bar:rows[j]};break;}
      }
      if(!first) {
        waiting.push({eventId,patternId:id,timeframe,formationAt:r.t,reason:'Neutral formation awaits a completed close above its high or below its low.',upperTrigger:r.h,lowerTrigger:r.l});
        continue;
      }
      const confirmedAt=first.bar.t+step,expiresAt=confirmedAt+step*3;
      const invalidated=rows.slice(rows.indexOf(first.bar)).some(c=>first!.direction==='LONG'?c.l<=r.l:c.h>=r.h);
      if(invalidated||now>expiresAt) {
        waiting.push({eventId,patternId:id,timeframe,formationAt:r.t,
          reason:invalidated?'First breakout direction is frozen; observed formation stop was subsequently invalidated.':'First breakout direction is frozen; entry window expired.',
          upperTrigger:r.h,lowerTrigger:r.l});
        continue;
      }
      candidates.push(makeEvidence({symbol,timeframe,id,direction:first.direction,formationAt:r.t,confirmedAt,
        triggerPrice:first.direction==='LONG'?r.h:r.l,referencePrice:first.bar.c,stopPrice:first.direction==='LONG'?r.l:r.h,hold,step,
        confirmation:`First completed candle close ${first.direction==='LONG'?'above':'below'} neutral formation range.`}));
    }
    for(const finding of frame.findings) {
      const contract=registry.get(finding.id);
      if(!contract||finding.direction==='NEUTRAL')continue;
      const dir=finding.direction;
      const formationAt=finding.formationAt??Math.max(0,(finding.availableAt??frame.closedAt!)-step);
      const eventId=`${symbol}:${timeframe}:${finding.formationKey??`${finding.id}:${formationAt}`}`;
      const stop=finding.invalidation;
      if(!Number.isFinite(stop)||stop===null||!(dir==='LONG'?stop<last.c:stop>last.c)) {
        waiting.push({eventId,patternId:finding.id,timeframe,formationAt,reason:'No valid observed formation invalidation stop on the protective side of the completed reference close.',upperTrigger:null,lowerTrigger:null});
        continue;
      }
      candidates.push(makeEvidence({symbol,timeframe,id:finding.id,direction:dir,formationAt,confirmedAt:finding.availableAt,
        triggerPrice:finding.trigger??last.c,referencePrice:last.c,stopPrice:stop,hold,step,confirmation:finding.basis,eventId}));
    }
  }
  // Preserve one evidence object per pattern event; same-side IDs are context, not substitutes.
  for(const c of candidates) {
    c.supportingPatternIds=[...new Set(candidates.filter(x=>x.timeframe===c.timeframe&&x.formationAt===c.formationAt&&x.direction===c.direction).map(x=>x.patternId))].sort();
  }
  const conflicts:PatternEntryConflict[]=[];
  for(const tf of tfNames) {
    const long=candidates.filter(c=>c.timeframe===tf&&c.direction==='LONG'),short=candidates.filter(c=>c.timeframe===tf&&c.direction==='SHORT');
    if(!long.length||!short.length)continue;
    const formationAt=Math.max(...[...long,...short].map(c=>c.formationAt));
    const eventId=`${symbol}:${tf}:CONFLICT:${formationAt}`;
    const longIds=[...new Set(long.flatMap(c=>c.supportingPatternIds))].sort(),shortIds=[...new Set(short.flatMap(c=>c.supportingPatternIds))].sort();
    conflicts.push({eventId,timeframe:tf,formationAt,reason:'Opposite completed pattern evidence on the same timeframe; directional entry withheld.',longPatternIds:longIds,shortPatternIds:shortIds});
    for(const c of [...long,...short])waiting.push({eventId:c.eventId,patternId:c.patternId,timeframe:tf,formationAt:c.formationAt,reason:'CONFLICT: opposite-side completed pattern evidence; no side selected.',upperTrigger:null,lowerTrigger:null});
  }
  const conflicted=new Set(conflicts.map(c=>c.timeframe));
  const output=candidates.filter(c=>!conflicted.has(c.timeframe)).map(c=>{
    const opposing=candidates.filter(x=>x.timeframe===c.timeframe&&x.direction!==c.direction).map(x=>x.patternId);
    const evidence={...c,conflictingPatternIds:[...new Set(opposing)].sort()};
    trustedEvidence.add(evidence);return evidence;
  });
  return {version:PATTERN_ENTRY_VERSION,candidates:output,waiting,conflicts};
}
function makeEvidence(input:{symbol:string;timeframe:Timeframe;id:string;direction:EntryDirection;formationAt:number;confirmedAt:number;triggerPrice:number;referencePrice:number;stopPrice:number;hold:number;step:number;confirmation:string;eventId?:string}):PatternEntryEvidence {
  const contract=registry.get(input.id)!;
  const eventId=input.eventId??`${input.symbol}:${input.timeframe}:${input.id}:${input.formationAt}`;
  const evidence:PatternEntryEvidence={eventId,durableFormationId:eventId,symbol:input.symbol,
    patternId:input.id,timeframe:input.timeframe,direction:input.direction,formationAt:input.formationAt,confirmedAt:input.confirmedAt,
    triggerPrice:input.triggerPrice,referencePrice:input.referencePrice,stopPrice:input.stopPrice,targetPrice:null,targetBasis:null,
    expiresAt:input.confirmedAt+input.step*3,maxHoldMs:input.hold,supportingPatternIds:[input.id],conflictingPatternIds:[],
    auxiliary:{formation:contract.formation,confirmation:input.confirmation,entry:contract.entryTrigger,invalidation:contract.invalidationStop,exit:contract.exitCriteria,observedTarget:null}};
  trustedEvidence.add(evidence);return evidence;
}