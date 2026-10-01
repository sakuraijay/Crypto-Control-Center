import {useCallback,useEffect,useRef,useState} from 'react';
import {ImagePlus,ScanSearch,Trash2,RefreshCw,ShieldAlert} from 'lucide-react';
import {REQUEST_TIMEOUT_MS,createSlotGuard,IMAGE_ANALYZE_PATH,IMAGE_FRAMES,IMAGE_HEADER_BYTES,buildAnalyzeBody,canAnalyze,checkImageHeader,classifyFailure,revisionKey,validateDrafts,type AnalyzeFailure,type AttemptRecord,type FrameDraft,type ImageFrame} from '@/lib/patternImageInput';
import {parseImageAnalysisResult,type ImageAnalysisResult} from '@/lib/patternImageResult';
import {PatternImageResultView} from './PatternImageResultView';
const LABEL:Record<ImageFrame,string>={'15m':'15분','1h':'1시간','4h':'4시간'};
type Slot={url:string;draft:FrameDraft;v:number};
export function PatternImageHelper(){
  const [slots,setSlots]=useState<Partial<Record<ImageFrame,Slot>>>({});
  const [errors,setErrors]=useState<Partial<Record<ImageFrame,string>>>({});
  const [pin,setPin]=useState('');
  const [busy,setBusy]=useState(false);
  const [failure,setFailure]=useState<AnalyzeFailure|null>(null);
  const [result,setResult]=useState<ImageAnalysisResult|null>(null);
  const [now,setNow]=useState(Date.now());
  const [last,setLast]=useState<AttemptRecord|null>(null);
  const busyRef=useRef(false);const abortRef=useRef<AbortController|null>(null);const urls=useRef(new Set<string>());const guard=useRef(createSlotGuard());const [processing,setProcessing]=useState(0);
  useEffect(()=>{guard.current=createSlotGuard();const g=guard.current;return()=>{g.dispose();abortRef.current?.abort();urls.current.forEach(u=>URL.revokeObjectURL(u));urls.current.clear();};},[]);
  useEffect(()=>{if(!last||last.failure.kind==='NOT_CONFIGURED')return;const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[last]);
  const drop=(tf:ImageFrame,s?:Slot)=>{if(s){URL.revokeObjectURL(s.url);urls.current.delete(s.url);}};
  const edit=(tf:ImageFrame,fn:(s:Slot)=>Slot)=>{if(busyRef.current)return;setResult(null);setFailure(null);setSlots(p=>p[tf]?{...p,[tf]:fn(p[tf]!)}:p);};
  const pick=useCallback(async(tf:ImageFrame,file?:File)=>{
    if(!file||busyRef.current)return;
    const owner=guard.current;const token=owner.begin(tf);const cur=()=>guard.current===owner&&owner.isCurrent(tf,token);
    setProcessing(n=>n+1);setResult(null);setFailure(null);
    setErrors(e=>({...e,[tf]:undefined}));
    try{
      const head=new Uint8Array(await file.slice(0,IMAGE_HEADER_BYTES).arrayBuffer());
      const c=checkImageHeader(file,head,tf);
      if(!c.ok){if(cur())setErrors(e=>({...e,[tf]:c.message}));return;}
      if(!cur())return;
      if(typeof createImageBitmap!=='function'){setErrors(e=>({...e,[tf]:'이 브라우저는 안전한 이미지 해독을 지원하지 않아 사용할 수 없습니다.'}));return;}
      const bmp=await createImageBitmap(file);const okDim=bmp.width===c.width&&bmp.height===c.height;bmp.close();
      if(!cur())return;
      if(!okDim){setErrors(e=>({...e,[tf]:'이미지를 안전하게 해독하지 못했습니다.'}));return;}
      if(!cur())return;
      const url=URL.createObjectURL(file);urls.current.add(url);
      setSlots(p=>{drop(tf,p[tf]);return {...p,[tf]:{url,v:(p[tf]?.v??0)+1,draft:{timeframe:tf,symbol:p[tf]?.draft.symbol??'',exchange:p[tf]?.draft.exchange??'',mimeType:c.mimeType,size:file.size,width:c.width,height:c.height,confirmed:false}}};});
    }catch{if(cur())setErrors(e=>({...e,[tf]:'이미지를 읽지 못했습니다.'}));}
    finally{if(!guard.current.disposed)setProcessing(n=>n-1);}
  },[]);
  const drafts=IMAGE_FRAMES.flatMap(t=>slots[t]?[slots[t]!.draft]:[]);
  const revision=revisionKey(drafts,IMAGE_FRAMES.map(t=>String(slots[t]?.v??0)));
  const invalid=validateDrafts(drafts);
  const gate=canAnalyze({busy:busy||processing>0,revision,last,now,hasPin:pin.trim().length>0});
  const analyze=async()=>{
    if(busyRef.current||invalid||!canAnalyze({busy:false,revision,last,now:Date.now(),hasPin:pin.trim().length>0}).ok)return;
    busyRef.current=true;setBusy(true);setFailure(null);setResult(null);
    const ac=new AbortController();abortRef.current=ac;const rev=revision;let timedOut=false;const timer=setTimeout(()=>{timedOut=true;ac.abort();},REQUEST_TIMEOUT_MS);const body0=buildAnalyzeBody(drafts);
    const fail=(f:AnalyzeFailure)=>{setFailure(f);setLast({revision:rev,failure:f,at:Date.now()});setNow(Date.now());};
    try{
      const res=await fetch(IMAGE_ANALYZE_PATH,{method:'POST',credentials:'include',signal:ac.signal,headers:{'content-type':'application/json','x-operator-pin':pin},body:JSON.stringify(body0)});
      const body=await res.json().catch(()=>null);
      if(!res.ok)fail(classifyFailure(res.status,body,res.headers.get('retry-after')));
      else{const p=parseImageAnalysisResult(body,body0.images);
        if(p.ok){setResult(p.value);setLast({revision:rev,at:Date.now(),failure:{kind:'SUCCESS',message:'',retryable:false}});}else fail({kind:'INVALID_RESPONSE',message:p.error,retryable:false});}
    }catch(e){if(timedOut)fail({kind:'TIMEOUT',message:'요청 시간이 초과되었습니다.',retryable:true});else if((e as Error).name!=='AbortError')fail(classifyFailure(null,null));}
    finally{clearTimeout(timer);if(guard.current.disposed)return;busyRef.current=false;if(abortRef.current===ac)abortRef.current=null;setBusy(false);}
  };
  return <section className="ccc-panel p-5 space-y-4" data-testid="pattern-image-helper" aria-label="스크린샷 수동 분석 도우미">
    <div><p className="ccc-eyebrow">MANUAL SCREENSHOT HELPER</p><h2 className="text-base font-semibold mt-1">차트 스크린샷 수동 분석</h2>
      <p className="ccc-caption mt-1">이미지는 이 브라우저에만 머물며 저장되거나 서버로 전송되지 않습니다. 요청에는 크기·형식 정보만 담깁니다.</p></div>
    <div className="ccc-inline-alert" role="status" data-testid="provider-status"><ShieldAlert size={16}/>이미지 분석 제공자 연결 안 됨 · 분석 요청을 보내도 현재는 분석 결과를 만들 수 없습니다.</div>
    <div className="grid gap-3 md:grid-cols-3">{IMAGE_FRAMES.map(tf=>{const s=slots[tf];return <div key={tf} className="ccc-pattern-tile space-y-2" data-testid={`slot-${tf}`}>
      <strong>{LABEL[tf]} ({tf})</strong>
      {s?<><img src={s.url} alt={`${LABEL[tf]} 차트 미리보기`} className="w-full rounded-md border border-white/10 max-h-40 object-contain bg-black/20"/>
        <p className="text-[11px] text-slate-400">{s.draft.width}×{s.draft.height} · {(s.draft.size/1048576).toFixed(2)} MiB</p>
        <input disabled={busy} className="ccc-input" placeholder="심볼 (예: BTCUSDT)" aria-label={`${tf} 심볼`} value={s.draft.symbol} onChange={e=>edit(tf,x=>({...x,v:x.v+1,draft:{...x.draft,symbol:e.target.value,confirmed:false}}))}/>
        <input disabled={busy} className="ccc-input" placeholder="거래소" aria-label={`${tf} 거래소`} value={s.draft.exchange} onChange={e=>edit(tf,x=>({...x,v:x.v+1,draft:{...x.draft,exchange:e.target.value,confirmed:false}}))}/>
        <label className="flex gap-2 text-[11px] items-start"><input disabled={busy} type="checkbox" checked={s.draft.confirmed} onChange={e=>edit(tf,x=>({...x,v:x.v+1,draft:{...x.draft,confirmed:e.target.checked}}))}/>이 이미지는 {LABEL[tf]}봉, 위 심볼·거래소가 맞습니다.</label>
        <div className="flex gap-2"><label className="ccc-icon-button" title="교체"><RefreshCw size={14}/><input hidden disabled={busy} type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>{pick(tf,e.target.files?.[0]);e.target.value='';}}/></label>
          <button type="button" className="ccc-icon-button" title="삭제" aria-label={`${tf} 삭제`} disabled={busy} onClick={()=>{if(busyRef.current)return;guard.current.invalidate(tf);drop(tf,s);setSlots(p=>{const n={...p};delete n[tf];return n;});setResult(null);setFailure(null);}}><Trash2 size={14}/></button></div></>
      :<label className="flex flex-col items-center gap-2 py-6 text-xs text-slate-400 cursor-pointer"><ImagePlus size={20}/>PNG·JPEG·WebP · 8 MiB 이하 · 640×360 이상<input hidden disabled={busy} type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>{pick(tf,e.target.files?.[0]);e.target.value='';}}/></label>}
      {errors[tf]&&<p role="alert" className="ccc-negative text-xs">{errors[tf]}</p>}</div>;})}</div>
    <div className="flex flex-wrap items-center gap-3">
      <input type="password" autoComplete="off" className="ccc-input max-w-56" placeholder="운영자 PIN (저장 안 됨)" aria-label="운영자 PIN" value={pin} onChange={e=>setPin(e.target.value)}/>
      <button type="button" className="ccc-session-action ccc-icon-button px-4 gap-2 whitespace-nowrap" style={{width:'auto',minWidth:112}} disabled={!gate.ok||!!invalid||processing>0} onClick={analyze} data-testid="button-analyze"><ScanSearch size={14}/>{busy?'분석 요청 중…':'분석하기'}</button>
      <span className="ccc-caption" aria-live="polite">{processing>0?`이미지 검증 중… (${processing})`:drafts.length===0?'이미지를 올려 주세요.':invalid??gate.reason??'준비되었습니다. 버튼을 눌러야만 요청합니다.'}</span></div>
    {failure&&<div className="ccc-inline-alert" role="alert" data-testid="analyze-error">{failure.message}</div>}
    {result&&<PatternImageResultView result={result}/>}
  </section>;
}
