import {describe,it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {readFileSync} from 'node:fs';
import {createSlotGuard,parseRetryAfter,checkImageHeader,readImageDimensions,signatureMime,buildAnalyzeBody,canAnalyze,classifyFailure,validateDrafts,RETRY_COOLDOWN_MS,type FrameDraft} from '../patternImageInput';
import {parseImageAnalysisResult,CANONICAL_IDS,deriveAlignment,deriveFrameDirection} from '../patternImageResult';
import {PatternImageResultView} from '@/components/dashboard/PatternImageResultView';
import {PatternImageHelper} from '@/components/dashboard/PatternImageHelper';
import {evaluateScreenshotPatternReview} from '../screenshotPatternReview';
const png=(w:number,h:number)=>{const b=new Uint8Array(32);b.set([137,80,78,71,13,10,26,10]);const v=new DataView(b.buffer);v.setUint32(8,13);b.set([73,72,68,82],12);v.setUint32(16,w);v.setUint32(20,h);return b;};
const jpeg=(w:number,h:number)=>new Uint8Array([255,216,255,224,0,4,0,0,255,192,0,11,8,h>>8,h&255,w>>8,w&255,1,0,0,0,0]);
const f=(type:string,size=1000)=>({name:'a',type,size});
const draft=(tf:'15m'|'1h'|'4h',o:Partial<FrameDraft>={}):FrameDraft=>({timeframe:tf,symbol:'btcusdt',exchange:'Binance',mimeType:'image/png',size:10,width:800,height:600,confirmed:true,...o});
const frame=(tf:string,dir?:string,sym='BTCUSDT')=>({timeframe:tf,symbol:sym,exchange:'Binance',patterns:CANONICAL_IDS.map((id,i)=>i===0&&dir?{id,status:'CANDIDATE',direction:dir,observedEvidence:['BODY_SMALL'],unverifiableConditions:[]}:{id,status:'NO_MATCH',direction:'UNKNOWN',observedEvidence:[],unverifiableConditions:[]})});
describe('image input',()=>{
  it('reads real signatures and dimensions',()=>{
    expect(signatureMime(png(1,1))).toBe('image/png');expect(readImageDimensions(png(800,600))).toEqual({width:800,height:600});
    expect(readImageDimensions(jpeg(1024,768))).toEqual({width:1024,height:768});expect(signatureMime(new Uint8Array([1,2,3]))).toBeNull();
  });
  it('rejects spoofed type, small, huge, oversized',()=>{
    expect(checkImageHeader(f('image/png'),png(800,600),'1h').ok).toBe(true);
    expect(checkImageHeader(f('image/jpeg'),png(800,600),'1h').ok).toBe(false);
    expect(checkImageHeader(f('image/png'),png(600,300),'1h').ok).toBe(false);
    expect(checkImageHeader(f('image/png'),png(5000,600),'1h').ok).toBe(false);
    expect(checkImageHeader(f('image/png',9*1024*1024),png(800,600),'1h').ok).toBe(false);
  });
  it('request has metadata only, 1-3 unique, confirmation required',()=>{
    const body=buildAnalyzeBody([draft('15m')]);
    expect(Object.keys(body.images[0]).sort()).toEqual(['exchange','height','mimeType','size','symbol','timeframe','width']);
    expect(validateDrafts([])).not.toBeNull();expect(validateDrafts([draft('1h'),draft('1h')])).not.toBeNull();
    expect(validateDrafts([draft('1h',{confirmed:false})])).not.toBeNull();expect(validateDrafts([draft('1h')])).toBeNull();
  });
  it('retry policy: cooldown for retryable, blocked for missing provider until edit',()=>{
    const nc=classifyFailure(503,{ok:false,code:'IMAGE_ANALYSIS_NOT_CONFIGURED',error:'x'});
    const base={busy:false,revision:'r',now:1000};
    expect(canAnalyze({...base,last:{revision:'r',failure:nc,at:0}}).ok).toBe(false);
    expect(canAnalyze({...base,revision:'r2',last:{revision:'r',failure:nc,at:0}}).ok).toBe(true);
    const net=classifyFailure(null,null);
    expect(canAnalyze({...base,last:{revision:'r',failure:net,at:900}}).ok).toBe(false);
    expect(canAnalyze({...base,now:900+RETRY_COOLDOWN_MS,last:{revision:'r',failure:net,at:900}}).ok).toBe(true);
    expect(canAnalyze({...base,busy:true,last:null}).ok).toBe(false);expect(classifyFailure(401,{}).retryable).toBe(true);
  });
  it('preserves quality gate: no extraction means analysis not allowed',()=>{
    const g=evaluateScreenshotPatternReview({file:f('image/png'),timeframe:'1h',image:{width:800,height:600}});
    expect(g.status).toBe('READY_FOR_EXTRACTION');expect(g.analysisAllowed).toBe(false);
  });
  it('preserves 38 list and dialog on page, helper placed above',()=>{
    const s=readFileSync('src/pages/patterns.tsx','utf8');
    expect(CANONICAL_IDS).toHaveLength(38);expect(s).toContain('PATTERN_CATALOG.map');expect(s).toContain('<Dialog');expect(s.indexOf('<PatternImageHelper/>')).toBeLessThan(s.indexOf('ccc-pattern-grid'));
  });
  it('helper never sends bytes and cleans up',()=>{
    const s=readFileSync('src/components/dashboard/PatternImageHelper.tsx','utf8');
    expect(s).not.toMatch(/base64|FormData|readAsDataURL/);expect(s).toContain('revokeObjectURL');expect(s).toContain('abort()');expect(s).not.toMatch(/localStorage|sessionStorage/);
  });
  it('allows a first manual attempt without any operator credential',()=>{
    expect(canAnalyze({busy:false,revision:'r',now:1000,last:null})).toEqual({ok:true});
    expect(classifyFailure(401,{}).message).not.toMatch(/PIN/);
    expect(classifyFailure(403,{}).kind).toBe('AUTH');
  });
  it('renders no PIN field or advice and honestly explains the missing provider',()=>{
    const html=renderToStaticMarkup(createElement(PatternImageHelper));
    expect(html).not.toMatch(/PIN|type="password"/);
    expect(html).toContain('이미지 분석 제공자 연결 안 됨');
    expect(html).toContain('현재는 분석 결과를 만들 수 없습니다');
    const source=readFileSync('src/components/dashboard/PatternImageHelper.tsx','utf8');
    expect(source).not.toMatch(/hasPin|setPin|x-operator-pin/);
    expect(source).toContain("headers:{'content-type':'application/json'}");
  });
  it('keeps server Retry-After restrictions even without a PIN gate',()=>{
    const failure=classifyFailure(429,{},'30');
    const base={busy:false,revision:'r',last:{revision:'r',failure,at:1000}};
    expect(canAnalyze({...base,now:9000}).ok).toBe(false);
    expect(canAnalyze({...base,now:31000}).ok).toBe(true);
  });
});
describe('evidence trust boundary and rendering',()=>{
  const R2=[{timeframe:'15m',symbol:'BTCUSDT',exchange:'Binance'}];
  const withP=(o:Record<string,unknown>)=>{const f=frame('15m','LONG');Object.assign(f.patterns[0],o);return {ok:true,frames:[f]};};
  it('rejects free text, unknown codes, blank candidates, reasonless UNREADABLE',()=>{
    for(const t of ['가격 67,000 돌파','상승 확률 80%','완료봉 확정'])expect(parseImageAnalysisResult(withP({observedEvidence:[t]}),R2).ok).toBe(false);
    expect(parseImageAnalysisResult(withP({unverifiableConditions:['완료봉 확정']}),R2).ok).toBe(false);
    expect(parseImageAnalysisResult(withP({observedEvidence:['PRICE_TARGET']}),R2).ok).toBe(false);
    expect(parseImageAnalysisResult(withP({observedEvidence:[]}),R2).ok).toBe(false);
    expect(parseImageAnalysisResult(withP({status:'UNREADABLE',direction:'UNKNOWN',observedEvidence:[]}),R2).ok).toBe(false);
    expect(parseImageAnalysisResult(withP({status:'UNREADABLE',direction:'UNKNOWN',observedEvidence:[],unverifiableConditions:['BLUR']}),R2).ok).toBe(true);
  });
  it('renders all 38 rows with universal OHLC/closed-candle limits',()=>{
    const v=(parseImageAnalysisResult({ok:true,frames:[frame('15m','LONG')]},R2) as any).value;
    const html=renderToStaticMarkup(createElement(PatternImageResultView,{result:v}));
    expect((html.match(/data-testid="row-/g)||[]).length).toBe(38);
    expect((html.match(/정확한 시가·고가·저가·종가 확인 불가/g)||[]).length).toBe(38);
    expect((html.match(/완료봉 여부 확인 불가/g)||[]).length).toBe(38);
  });
  it('binds frames to request and flags mixed symbols / conflicts',()=>{
    expect(parseImageAnalysisResult({ok:true,frames:[frame('15m',undefined,'ETHUSDT')]},R2).ok).toBe(false);
    expect(parseImageAnalysisResult({ok:true,frames:[frame('1h')]},R2).ok).toBe(false);
    expect(parseImageAnalysisResult({ok:true,frames:[frame('15m'),frame('1h')]},R2).ok).toBe(false);
    const mk=(a:any,b:any)=>[a,b].map(x=>(parseImageAnalysisResult({ok:true,frames:[x]},[{timeframe:x.timeframe,symbol:x.symbol,exchange:'Binance'}]) as any).value.frames[0]);
    expect(deriveAlignment(mk(frame('15m','LONG'),frame('1h','LONG','ETHUSDT'))).status).toBe('UNAVAILABLE');
    const both=frame('1h','LONG');both.patterns[1]={id:both.patterns[1].id,status:'CANDIDATE',direction:'SHORT',observedEvidence:['BODY_SMALL'],unverifiableConditions:[]} as any;
    expect(deriveFrameDirection(mk(both,both)[0])).toBe('CONFLICT');
    const neu=frame('1h');neu.patterns[0]={...neu.patterns[0],status:'CANDIDATE',direction:'NEUTRAL',observedEvidence:['BODY_SMALL']} as any;
    expect(deriveFrameDirection(mk(neu,neu)[0])).toBe('NEUTRAL');
  });
  it('slot guard blocks stale/unmounted commits; retry-after honored; PNG needs IHDR',()=>{
    const g=createSlotGuard();const t1=g.begin('1h');g.invalidate('1h');expect(g.isCurrent('1h',t1)).toBe(false);
    const t2=g.begin('1h');expect(g.isCurrent('1h',t2)).toBe(true);g.dispose();expect(g.isCurrent('1h',t2)).toBe(false);
    expect(parseRetryAfter('30')).toBe(30000);expect(parseRetryAfter('abc')).toBeUndefined();
    const bad=png(800,600);bad[12]=0;expect(readImageDimensions(bad)).toBeNull();
  });
});
describe('result validation and render',()=>{
  const ok=(frames:unknown[])=>({ok:true,frames});
  const R=(...t:string[])=>t.map(timeframe=>({timeframe,symbol:'BTCUSDT',exchange:'Binance'}));
  it('accepts full 38-id frames',()=>expect(parseImageAnalysisResult(ok([frame('15m','LONG')]),R('15m')).ok).toBe(true));
  it('rejects missing/duplicate/unknown ids, extra keys, bad enums',()=>{
    const m=frame('1h');m.patterns.pop();expect(parseImageAnalysisResult(ok([m]),R('1h')).ok).toBe(false);
    const d=frame('1h');d.patterns[1]={...d.patterns[0]};expect(parseImageAnalysisResult(ok([d]),R('1h')).ok).toBe(false);
    const x=frame('1h');(x.patterns[0] as Record<string,unknown>).probability=0.8;expect(parseImageAnalysisResult(ok([x]),R('1h')).ok).toBe(false);
    const e=frame('1h');(e.patterns[0] as Record<string,unknown>).direction='UP';expect(parseImageAnalysisResult(ok([e]),R('1h')).ok).toBe(false);
    expect(parseImageAnalysisResult({...ok([frame('1h')]),price:1},R('1h')).ok).toBe(false);
    expect(parseImageAnalysisResult(ok([frame('1h'),frame('1h')]),R('1h')).ok).toBe(false);
  });
  it('derives direction and alignment locally',()=>{
    const p=(tf:string,d?:string)=>(parseImageAnalysisResult(ok([frame(tf,d)]),R(tf)) as any).value.frames[0];
    expect(deriveFrameDirection(p('1h','SHORT'))).toBe('SHORT');expect(deriveFrameDirection(p('1h'))).toBe('UNKNOWN');
    expect(deriveAlignment([p('15m','LONG'),p('1h','LONG')]).status).toBe('ALIGNED');
    expect(deriveAlignment([p('15m','LONG'),p('1h','SHORT')]).status).toBe('CONFLICT');
    expect(deriveAlignment([p('15m','LONG'),p('1h')]).status).toBe('INSUFFICIENT');
  });
  it('renders evidence without price/probability claims',()=>{
    const v=(parseImageAnalysisResult(ok([frame('15m','LONG')]),R('15m')) as any).value;
    const html=renderToStaticMarkup(createElement(PatternImageResultView,{result:v}));
    expect(html).toContain('몸통이 작게 보임');expect(html).toContain('상승 참고');expect(html).not.toMatch(/%|목표가|\$\d/);
  });
});
