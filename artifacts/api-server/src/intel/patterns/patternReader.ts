import {analyzePatternFrame,PATTERN_VERSION,TIMEFRAMES,type Timeframe,type RawCandles,type PatternAnalysis} from './chartPatterns';
interface Cache {bucket:number;fetchedAt:number;raw:RawCandles}
/** Persisted cache avoids repeat GMX requests across cycles and worker restarts.
 * Failure is neutral evidence and retries after 60s, never a new order source. */
export async function readPatternCandles(symbol:string,deps:{
  read(key:string):Promise<string|null>;write(key:string,value:unknown):Promise<void>;
  fetch(symbol:string,tf:Timeframe,count:number):Promise<RawCandles>;now():number;
}):Promise<{raw:RawCandles;rawCandlesByTimeframe:Partial<Record<Timeframe,RawCandles>>;analysis:PatternAnalysis}> {
  const frames=await Promise.all((Object.keys(TIMEFRAMES) as Timeframe[]).map(async tf=>{
    const now=deps.now(),bucket=Math.floor((now-2000)/TIMEFRAMES[tf]);
    const key=`paper_chart_reference_v1:${symbol}:${tf}`;
    let cache:Cache|null=null;
    try {cache=JSON.parse(await deps.read(key)??'null');}catch{/* corrupt cache is disposable */}
    const valid=cache&&Number.isFinite(cache.fetchedAt)&&cache.fetchedAt<=now
      &&((cache.bucket===bucket&&cache.raw?.source==='gmx-official-api'&&Array.isArray(cache.raw.prices)&&cache.raw.prices.length<=241
        &&cache.raw.prices.every(r=>Array.isArray(r)&&r.length>=5&&r.slice(0,5).every(Number.isFinite)))
        ||(!cache.raw&&now-cache.fetchedAt<60_000));
    let raw=valid?cache!.raw:null;
    if(!valid) {
      try {raw=await deps.fetch(symbol,tf,240);}catch{raw=null;}
      if(raw&&(!Array.isArray(raw.prices)||raw.prices.length>241))raw=null;
      await deps.write(key,{bucket,fetchedAt:deps.now(),raw});
    }
    return {tf,raw};
  }));
  const now=deps.now();
  const rawCandlesByTimeframe:Partial<Record<Timeframe,RawCandles>>={};
  for(const frame of frames)rawCandlesByTimeframe[frame.tf]=frame.raw;
  return {raw:frames.find(f=>f.tf==='15m')?.raw??null,rawCandlesByTimeframe,analysis:{version:PATTERN_VERSION,
    purpose:'REFERENCE_ONLY_UNVALIDATED',evaluatedAt:now,
    frames:frames.map(f=>analyzePatternFrame(f.raw,f.tf,now))}};
}
