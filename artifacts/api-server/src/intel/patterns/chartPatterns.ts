/** Original, deterministic OHLC heuristics. These are NOT TA-Lib equivalents,
 * trained predictions, or measured probabilities. See docs/CCC_CHART_PATTERNS.md. */
export const PATTERN_VERSION = 'paper-chart-reference/v1';
export const TIMEFRAMES = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 } as const;
export type Timeframe = keyof typeof TIMEFRAMES;
export type Direction = 'LONG' | 'SHORT' | 'NEUTRAL';
export type Candle = { t:number; o:number; h:number; l:number; c:number };
export interface PatternEvidence {
  id:string; family:'CANDLE'|'REVERSAL'|'CONSOLIDATION'; direction:Direction;
  state:'SHAPE'|'BREAKOUT'; timeframe:Timeframe; availableAt:number;
  trigger:number|null; invalidation:number|null; basis:string;
  /** Stable timestamp anchor(s) of the completed formation, not a sliding row index. */
  formationAt?:number; formationKey?:string;
}
export interface PatternFrame {
  timeframe:Timeframe; status:'OK'|'UNAVAILABLE'|'INVALID'|'STALE'; closedAt:number|null;
  bars:number; volumeConfirmation:'UNAVAILABLE'; findings:PatternEvidence[];
}
export interface PatternAnalysis {
  version:typeof PATTERN_VERSION; purpose:'REFERENCE_ONLY_UNVALIDATED'; evaluatedAt:number;
  frames:PatternFrame[];
}
export type RawCandles = {prices:number[][];source:string}|null;
type Pivot = {i:number;p:number;kind:'HIGH'|'LOW';availableAt:number};
/** Right-side confirmation is required; timestamps represent availability, not the peak date. */
export function confirmedPivots(rows:Candle[], step:number):Pivot[] {
  const out:Pivot[]=[];
  for(let i=2;i<rows.length-2;i++) {
    const neighbors=[rows[i-2],rows[i-1],rows[i+1],rows[i+2]];
    if(neighbors.every(r=>rows[i].h>r.h))out.push({i,p:rows[i].h,kind:'HIGH',availableAt:rows[i+2].t+step});
    if(neighbors.every(r=>rows[i].l<r.l))out.push({i,p:rows[i].l,kind:'LOW',availableAt:rows[i+2].t+step});
  }
  return out;
}
const body=(r:Candle)=>Math.abs(r.c-r.o);
const up=(r:Candle)=>r.c>r.o;
const lowBody=(r:Candle)=>Math.min(r.o,r.c);
const highBody=(r:Candle)=>Math.max(r.o,r.c);
export function analyzePatternFrame(raw:RawCandles,timeframe:Timeframe,now:number):PatternFrame {
  const result:PatternFrame={timeframe,status:'UNAVAILABLE',closedAt:null,bars:0,volumeConfirmation:'UNAVAILABLE',findings:[]};
  if(!raw||raw.source!=='gmx-official-api')return result;
  const step=TIMEFRAMES[timeframe];
  const closed=raw.prices.map(r=>({t:r[0]<1e12?r[0]*1000:r[0],o:r[1],h:r[2],l:r[3],c:r[4]}))
    .filter(r=>r.t+step<=now-2000).sort((a,b)=>a.t-b.t).slice(-240);
  result.bars=closed.length;
  if(closed.length<60)return result;
  if(closed.some((r,i)=>Object.values(r).some(v=>!Number.isFinite(v)||v<=0)||r.t%step!==0
    ||r.h<Math.max(r.o,r.c,r.l)||r.l>Math.min(r.o,r.c,r.h)||(i>0&&r.t-closed[i-1].t!==step))) {
    result.status='INVALID';return result;
  }
  const a=closed.at(-1)!, b=closed.at(-2)!, c=closed.at(-3)!;
  result.closedAt=a.t+step;
  if(now-result.closedAt>step+60_000){result.status='STALE';return result;}
  result.status='OK';
  const atr=closed.slice(-14).reduce((s,r,i)=>s+Math.max(r.h-r.l,Math.abs(r.h-closed[closed.length-15+i].c),Math.abs(r.l-closed[closed.length-15+i].c)),0)/14;
  if(atr<=0)return result;
  const emit=(id:string,family:PatternEvidence['family'],direction:Direction,basis:string,
    trigger:number|null=null,invalidation:number|null=null,state:PatternEvidence['state']='SHAPE',
    formationAt:number=a.t,formationKey=`${id}:${formationAt}`)=>{
    if(!result.findings.some(p=>p.id===id))result.findings.push({id,family,direction,timeframe,
      availableAt:result.closedAt!,trigger,invalidation,state,basis,formationAt,formationKey});
  };
  // Context excludes every candle in a multi-candle formation.
  const trend=(length:number)=>closed[closed.length-length-1].c-closed[closed.length-length-6].c;
  const one=trend(1),two=trend(2),three=trend(3);
  const span=a.h-a.l, size=body(a), lower=lowBody(a)-a.l, upper=a.h-highBody(a);
  if(span>0&&size<=span*.1) {
    const id=lower>=span*.7?'DRAGONFLY_DOJI':upper>=span*.7?'GRAVESTONE_DOJI':'DOJI';
    emit(id,'CANDLE','NEUTRAL','body <= 10% of range; indecision, not directional confirmation');
  } else if(span>0&&size<=span*.3&&lower>=size&&upper>=size)emit('SPINNING_TOP','CANDLE','NEUTRAL','small body with two wicks');
  if(size>=atr*.05&&size<=span*.35) {
    if(lower>=size*2&&upper<=size*.5&&Math.abs(one)>atr)
      emit(one<0?'HAMMER':'HANGING_MAN','CANDLE',one<0?'LONG':'SHORT','lower wick >= 2 bodies; prior five-bar trend',null,one<0?a.l:a.h);
    if(upper>=size*2&&lower<=size*.5&&Math.abs(one)>atr)
      emit(one<0?'INVERTED_HAMMER':'SHOOTING_STAR','CANDLE',one<0?'LONG':'SHORT','upper wick >= 2 bodies; prior five-bar trend',null,one<0?a.l:a.h);
  }
  if(size>atr*.7&&size>=span*.9)emit(up(a)?'BULLISH_MARUBOZU':'BEARISH_MARUBOZU','CANDLE',up(a)?'LONG':'SHORT','body >= 90% range and 0.7 ATR',null,up(a)?a.l:a.h);
  if(up(a)!==up(b)&&body(b)>atr*.1&&Math.abs(two)>atr) {
    const reversal=up(a)?two<0:two>0;
    if(reversal&&lowBody(a)<=lowBody(b)&&highBody(a)>=highBody(b)&&size>body(b))
       emit(up(a)?'BULLISH_ENGULFING':'BEARISH_ENGULFING','CANDLE',up(a)?'LONG':'SHORT','opposite body engulfment after prior trend',null,up(a)?Math.min(a.l,b.l):Math.max(a.h,b.h),'SHAPE',b.t,`${up(a)?'BULLISH_ENGULFING':'BEARISH_ENGULFING'}:${b.t},${a.t}`);
    if(reversal&&lowBody(a)>lowBody(b)&&highBody(a)<highBody(b)&&size<body(b)*.6)
       emit(up(a)?'BULLISH_HARAMI':'BEARISH_HARAMI','CANDLE',up(a)?'LONG':'SHORT','small opposite body contained in prior body',null,up(a)?Math.min(a.l,b.l):Math.max(a.h,b.h),'SHAPE',b.t,`${up(a)?'BULLISH_HARAMI':'BEARISH_HARAMI'}:${b.t},${a.t}`);
    if(reversal&&up(a)&&a.o<=b.c&&a.c>(b.o+b.c)/2&&a.c<b.o)
       emit('PIERCING','CANDLE','LONG','close recovers midpoint after downtrend',null,Math.min(a.l,b.l),'SHAPE',b.t,`PIERCING:${b.t},${a.t}`);
    if(reversal&&!up(a)&&a.o>=b.c&&a.c<(b.o+b.c)/2&&a.c>b.o)
       emit('DARK_CLOUD_COVER','CANDLE','SHORT','close loses midpoint after uptrend',null,Math.max(a.h,b.h),'SHAPE',b.t,`DARK_CLOUD_COVER:${b.t},${a.t}`);
  }
  if(body(c)>atr*.7&&body(b)<body(c)*.35&&size>atr*.5) {
    if(three<-atr&&!up(c)&&up(a)&&a.c>(c.o+c.c)/2&&highBody(b)<=lowBody(c)+atr*.2)
       emit('MORNING_STAR','CANDLE','LONG','three-body reversal, continuous-market gap relaxation',null,Math.min(a.l,b.l,c.l),'SHAPE',c.t,`MORNING_STAR:${c.t},${b.t},${a.t}`);
    if(three>atr&&up(c)&&!up(a)&&a.c<(c.o+c.c)/2&&lowBody(b)>=highBody(c)-atr*.2)
       emit('EVENING_STAR','CANDLE','SHORT','three-body reversal, continuous-market gap relaxation',null,Math.max(a.h,b.h,c.h),'SHAPE',c.t,`EVENING_STAR:${c.t},${b.t},${a.t}`);
  }
  const within=(x:number,r:Candle)=>x>=lowBody(r)&&x<=highBody(r);
  if([a,b,c].every(r=>body(r)>atr*.5)&&within(b.o,c)&&within(a.o,b)) {
    if(three<-atr&&[a,b,c].every(up)&&a.c>b.h&&b.c>c.h&&[a,b,c].every(r=>r.h-r.c<body(r)*.3))
       emit('THREE_WHITE_SOLDIERS','CANDLE','LONG','three rising strong bodies after downtrend',null,c.l,'SHAPE',c.t,`THREE_WHITE_SOLDIERS:${c.t},${b.t},${a.t}`);
    if(three>atr&&[a,b,c].every(r=>!up(r))&&a.c<b.l&&b.c<c.l&&[a,b,c].every(r=>r.c-r.l<body(r)*.3))
       emit('THREE_BLACK_CROWS','CANDLE','SHORT','three falling strong bodies after uptrend',null,c.h,'SHAPE',c.t,`THREE_BLACK_CROWS:${c.t},${b.t},${a.t}`);
  }
  const pivots=confirmedPivots(closed.slice(0,-1),step);
  const n=closed.length-1;
  const highs=pivots.filter(p=>p.kind==='HIGH'&&p.i>=n-80);
  const lows=pivots.filter(p=>p.kind==='LOW'&&p.i>=n-80);
  // Only newly completed breaks contribute; a historical shape is not a fresh entry signal.
  for(const sign of [1,-1]) {
    const peaks=sign===1?highs:lows;
    const opposite=sign===1?lows:highs;
    const direction=sign===1?'SHORT':'LONG';
    const cross=(level:number)=>sign*a.c<sign*level-atr*.1&&sign*b.c>=sign*level-atr*.1;
    for(const count of [2,3]) {
      const p=peaks.slice(-count);if(p.length!==count)continue;
      if(p.some((v,i)=>i>0&&v.i-p[i-1].i<4))continue;
      const before=closed[Math.max(0,p[0].i-8)].c;
      if(sign*(p[0].p-before)<atr*2)continue;
      const valleys=p.slice(1).map((v,i)=>opposite.filter(q=>q.i>p[i].i&&q.i<v.i));
      if(valleys.some(v=>!v.length))continue;
      const necks=valleys.map(v=>sign===1?Math.min(...v.map(q=>q.p)):Math.max(...v.map(q=>q.p)));
      const neck=sign===1?Math.min(...necks):Math.max(...necks);
      const tolerance=atr*.7;
      if(Math.max(...p.map(q=>q.p))-Math.min(...p.map(q=>q.p))<=tolerance
         &&p.every(q=>sign*(q.p-neck)>atr*2)&&cross(neck)) {
         const selectedValleys=valleys.map((v,i)=>v.find(q=>q.p===necks[i])!);
         const anchorTimes=[...p.map(q=>closed[q.i].t),...selectedValleys.map(q=>closed[q.i].t)].sort((x,y)=>x-y);
        emit(`${count===2?'DOUBLE':'TRIPLE'}_${sign===1?'TOP':'BOTTOM'}`,'REVERSAL',direction,
           'confirmed spaced pivots, prior trend, neckline close break',neck,sign===1?Math.max(...p.map(q=>q.p)):Math.min(...p.map(q=>q.p)),'BREAKOUT',
           anchorTimes[0],`${count===2?'DOUBLE':'TRIPLE'}_${sign===1?'TOP':'BOTTOM'}:${anchorTimes.join(',')}`);
       }
      if(count===3&&Math.abs(p[0].p-p[2].p)<=tolerance
        &&sign*(p[1].p-p[0].p)>atr&&sign*(p[1].p-p[2].p)>atr) {
        const v1=valleys[0].find(q=>q.p===necks[0])!,v2=valleys[1].find(q=>q.p===necks[1])!;
        const line=(i:number)=>v1.p+(v2.p-v1.p)*(i-v1.i)/(v2.i-v1.i);
         if(sign*a.c<sign*line(n)-atr*.1&&sign*b.c>=sign*line(n-1)-atr*.1) {
           const anchorTimes=[...p.map(q=>closed[q.i].t),closed[v1.i].t,closed[v2.i].t].sort((x,y)=>x-y);
          emit(sign===1?'HEAD_SHOULDERS':'INVERSE_HEAD_SHOULDERS','REVERSAL',direction,
             'three confirmed peaks, central extreme, sloped neckline close break',line(n),p[2].p,'BREAKOUT',
             anchorTimes[0],`${sign===1?'HEAD_SHOULDERS':'INVERSE_HEAD_SHOULDERS'}:${anchorTimes.join(',')}`);
         }
      }
    }
  }
  // Three touches on each boundary and bounded residuals; fit excludes the breakout candle.
  const hs=highs.slice(-3),ls=lows.slice(-3);
  if(hs.length===3&&ls.length===3) {
    const start=Math.min(hs[0].i,ls[0].i),end=Math.max(hs[2].i,ls[2].i);
    const fit=(ps:Pivot[])=>{
      const x=ps.reduce((s,p)=>s+p.i,0)/ps.length,y=ps.reduce((s,p)=>s+p.p,0)/ps.length;
      const slope=ps.reduce((s,p)=>s+(p.i-x)*(p.p-y),0)/ps.reduce((s,p)=>s+(p.i-x)**2,0);
      return {slope,at:(i:number)=>y+slope*(i-x),valid:ps.every(p=>Math.abs(p.p-(y+slope*(p.i-x)))<=atr*.5)};
    };
    const h=fit(hs),l=fit(ls),w0=h.at(start)-l.at(start),w1=h.at(n)-l.at(n);
    const contained=closed.slice(start,n).every((r,j)=>r.h<=h.at(start+j)+atr*.7&&r.l>=l.at(start+j)-atr*.7);
    if(end-start>=12&&n-end<=12&&h.valid&&l.valid&&w0>atr*2&&w1>atr&&contained) {
      const flat=atr*.03;
      let id:string|null=null;
      if(Math.abs(h.slope)<=flat&&Math.abs(l.slope)<=flat)id='RECTANGLE';
      else if(w1<w0*.8) {
        if(Math.abs(h.slope)<=flat&&l.slope>flat)id='ASCENDING_TRIANGLE';
        else if(Math.abs(l.slope)<=flat&&h.slope<-flat)id='DESCENDING_TRIANGLE';
        else if(h.slope<-flat&&l.slope>flat)id='SYMMETRICAL_TRIANGLE';
        else if(h.slope>flat&&l.slope>h.slope)id='RISING_WEDGE';
        else if(l.slope<-flat&&h.slope<l.slope)id='FALLING_WEDGE';
      } else if(w1>w0*1.2&&h.slope>flat&&l.slope<-flat)id='BROADENING';
      else if(Math.abs(h.slope-l.slope)<flat&&Math.abs(h.slope)>flat)id='PRICE_CHANNEL';
      if(id) {
        const bull=a.c>h.at(n)+atr*.1&&b.c<=h.at(n-1)+atr*.1;
        const bear=a.c<l.at(n)-atr*.1&&b.c>=l.at(n-1)-atr*.1;
        if(bull||bear) {
          const boundaryAnchors=[...hs,...ls].map(q=>closed[q.i].t).sort((x,y)=>x-y);
          const formationAt=boundaryAnchors[0];
          const geometryKey=`${id}:${boundaryAnchors.join(',')}`;
          emit(id,'CONSOLIDATION',bull?'LONG':'SHORT','three confirmed touches per boundary; fresh close beyond fitted line',bull?h.at(n):l.at(n),bull?l.at(n):h.at(n),'BREAKOUT',formationAt,geometryKey);
          const pole=closed[start].c-closed[Math.max(0,start-8)].c;
          if(n-start<=30&&Math.abs(pole)>atr*4&&w0<Math.abs(pole)*.5&&((bull&&pole>0)||(bear&&pole<0))) {
            const flag=id==='PRICE_CHANNEL'&&h.slope*pole<0;
            const pennant=id==='SYMMETRICAL_TRIANGLE';
             if(flag||pennant) {
               const id2=`${bull?'BULL':'BEAR'}_${flag?'FLAG':'PENNANT'}`;
               const flagAnchors=[...boundaryAnchors,closed[Math.max(0,start-8)].t].sort((x,y)=>x-y);
               emit(id2,'CONSOLIDATION',bull?'LONG':'SHORT',
                 'prior eight-bar pole > 4 ATR; consolidation < half pole; continuation close break',bull?h.at(n):l.at(n),bull?l.at(n):h.at(n),'BREAKOUT',
                 flagAnchors[0],`${id2}:${flagAnchors.join(',')}`);
             }
          }
        }
      }
    }
  }
  return result;
}

/** Maximum +/-0.10 influence; correlated detections never get additive votes. */
export function patternReferenceAdjustment(analysis:PatternAnalysis|undefined,side:'LONG'|'SHORT',now:number):number {
  if(!analysis||analysis.version!==PATTERN_VERSION||analysis.purpose!=='REFERENCE_ONLY_UNVALIDATED'
    ||analysis.evaluatedAt>now||now-analysis.evaluatedAt>60_000)return 0;
  const votes: number[]=[];
  for(const tf of Object.keys(TIMEFRAMES) as Timeframe[]) {
    const frame=analysis.frames.find(f=>f.timeframe===tf);
    if(!frame||frame.status!=='OK'||frame.closedAt===null||frame.closedAt>now||now-frame.closedAt>TIMEFRAMES[tf]+60_000)continue;
    const directions=new Set(frame.findings.filter(f=>f.availableAt<=now&&f.timeframe===tf&&f.direction!=='NEUTRAL').map(f=>f.direction));
    votes.push(directions.size===1?(directions.has(side)?1:-1):0);
  }
  return votes.reduce((s,v)=>s+v,0)/3*.1;
}
export function patternSummary(analysis:PatternAnalysis):string {
  return analysis.frames.map(f=>`${f.timeframe}: ${f.status==='OK'?(f.findings.map(p=>`${p.id}(${p.direction})`).join(', ')||'패턴 감지 없음'):f.status}`).join(' / ');
}
