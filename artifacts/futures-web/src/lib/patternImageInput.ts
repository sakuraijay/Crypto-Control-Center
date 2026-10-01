import {evaluateScreenshotPatternReview,SCREENSHOT_PATTERN_MAX_BYTES,type ScreenshotPatternRejectReason} from './screenshotPatternReview';

export const IMAGE_FRAMES=['15m','1h','4h'] as const;
export type ImageFrame=(typeof IMAGE_FRAMES)[number];
export const IMAGE_MAX_DIMENSION=4096;
export const IMAGE_HEADER_BYTES=1024*1024;
export const IMAGE_ANALYZE_PATH='/api/pattern-image/analyze';
export const RETRY_COOLDOWN_MS=8000;
export const REQUEST_TIMEOUT_MS=15000;

export function signatureMime(b:Uint8Array):'image/png'|'image/jpeg'|'image/webp'|null{
  if(b.length>=8&&[137,80,78,71,13,10,26,10].every((n,i)=>b[i]===n))return 'image/png';
  if(b.length>=3&&b[0]===255&&b[1]===216&&b[2]===255)return 'image/jpeg';
  const s=(o:number,t:string)=>[...t].every((c,i)=>b[o+i]===c.charCodeAt(0));
  if(b.length>=16&&s(0,'RIFF')&&s(8,'WEBP'))return 'image/webp';
  return null;
}
const u16be=(b:Uint8Array,o:number)=>(b[o]<<8)|b[o+1];
const u32be=(b:Uint8Array,o:number)=>((b[o]*2**24)+(b[o+1]<<16)+(b[o+2]<<8)+b[o+3]);
const u16le=(b:Uint8Array,o:number)=>b[o]|(b[o+1]<<8);
/** Reads dimensions from the header only; never decodes pixels. */
export function readImageDimensions(b:Uint8Array):{width:number;height:number}|null{
  const mime=signatureMime(b);
  if(mime==='image/png'){ if(b.length<24||u32be(b,8)!==13||String.fromCharCode(b[12],b[13],b[14],b[15])!=='IHDR')return null; return {width:u32be(b,16),height:u32be(b,20)}; }
  if(mime==='image/webp'){
    const t=String.fromCharCode(b[12],b[13],b[14],b[15]);
    if(t==='VP8 '&&b.length>=30)return {width:u16le(b,26)&0x3fff,height:u16le(b,28)&0x3fff};
    if(t==='VP8L'&&b.length>=25&&b[20]===0x2f){const v=(b[21]|(b[22]<<8)|(b[23]<<16)|(b[24]*2**24))>>>0;return {width:(v&0x3fff)+1,height:((v>>>14)&0x3fff)+1};}
    if(t==='VP8X'&&b.length>=30)return {width:(b[24]|(b[25]<<8)|(b[26]<<16))+1,height:(b[27]|(b[28]<<8)|(b[29]<<16))+1};
    return null;
  }
  if(mime==='image/jpeg'){
    let o=2;
    while(o+9<b.length){
      if(b[o]!==0xff){o++;continue;}
      const m=b[o+1];
      if(m===0xff){o++;continue;}
      if(m===0xd8||m===0x01||(m>=0xd0&&m<=0xd7)){o+=2;continue;}
      const len=u16be(b,o+2);
      if(len<2)return null;
      if(m>=0xc0&&m<=0xcf&&m!==0xc4&&m!==0xc8&&m!==0xcc)return {width:u16be(b,o+7),height:u16be(b,o+5)};
      o+=2+len;
    }
  }
  return null;
}
export type LocalCheck={ok:true;mimeType:string;width:number;height:number}|{ok:false;message:string};
const REASON:Record<ScreenshotPatternRejectReason,string>={
  EMPTY_FILE:'빈 파일입니다.',UNSUPPORTED_FILE_TYPE:'PNG, JPEG, WebP만 사용할 수 있습니다.',FILE_TOO_LARGE:'파일은 8 MiB 이하여야 합니다.',
  INVALID_TIMEFRAME:'시간대가 올바르지 않습니다.',IMAGE_TOO_SMALL:'이미지는 640×360 이상이어야 합니다.',
  INSUFFICIENT_COMPLETED_CANDLES:'완료봉 수가 부족합니다.',LOW_EXTRACTION_CONFIDENCE:'판독 신뢰도가 낮습니다.',LAST_CANDLE_NOT_CONFIRMED_CLOSED:'마지막 봉이 완료됐는지 확인되지 않습니다.'};
/** Pure validation of header bytes + declared file; runs before any preview URL exists. */
export function checkImageHeader(file:{name:string;type:string;size:number},head:Uint8Array,timeframe:ImageFrame):LocalCheck{
  if(file.size>SCREENSHOT_PATTERN_MAX_BYTES)return {ok:false,message:REASON.FILE_TOO_LARGE};
  const mime=signatureMime(head);
  if(!mime||mime!==file.type.toLowerCase())return {ok:false,message:'파일 내용이 PNG·JPEG·WebP 형식과 일치하지 않습니다.'};
  const d=readImageDimensions(head);
  if(!d||!(d.width>0)||!(d.height>0))return {ok:false,message:'이미지 크기를 읽을 수 없습니다.'};
  if(d.width>IMAGE_MAX_DIMENSION||d.height>IMAGE_MAX_DIMENSION)return {ok:false,message:'이미지는 4096×4096 이하여야 합니다.'};
  const gate=evaluateScreenshotPatternReview({file,timeframe,image:d});
  if(gate.status==='REJECTED')return {ok:false,message:REASON[gate.reason]};
  return {ok:true,mimeType:mime,width:d.width,height:d.height};
}
export interface FrameDraft{timeframe:ImageFrame;symbol:string;exchange:string;mimeType:string;size:number;width:number;height:number;confirmed:boolean}
const SYMBOL=/^[A-Za-z0-9._/-]{1,40}$/;const EXCH=/^[A-Za-z0-9 ._-]{1,80}$/;
export function validateDrafts(d:FrameDraft[]):string|null{
  if(d.length<1||d.length>3)return '이미지를 1~3개 올려 주세요.';
  if(new Set(d.map(x=>x.timeframe)).size!==d.length)return '시간대가 중복되었습니다.';
  for(const x of d){
    if(!SYMBOL.test(x.symbol.trim()))return `${x.timeframe}: 심볼을 확인해 주세요.`;
    if(!EXCH.test(x.exchange.trim()))return `${x.timeframe}: 거래소를 확인해 주세요.`;
    if(!x.confirmed)return `${x.timeframe}: 시간대·심볼·거래소 확인이 필요합니다.`;
  }
  return null;
}
/** Metadata only. Never image bytes, names or object URLs. */
export function buildAnalyzeBody(d:FrameDraft[]){
  return {images:d.map(x=>({timeframe:x.timeframe,symbol:x.symbol.trim().toUpperCase(),exchange:x.exchange.trim(),mimeType:x.mimeType,size:x.size,width:x.width,height:x.height}))};
}
export function revisionKey(d:FrameDraft[],ids:string[]):string{
  return JSON.stringify([buildAnalyzeBody(d),ids]);
}
export type AnalyzeFailure={retryAfterMs?:number;kind:'SUCCESS'|'TIMEOUT'|'NOT_CONFIGURED'|'AUTH'|'RATE_LIMIT'|'TOO_LARGE'|'BAD_REQUEST'|'UNAVAILABLE'|'NETWORK'|'INVALID_RESPONSE';message:string;retryable:boolean};
export function parseRetryAfter(h:string|null|undefined):number|undefined{
  if(!h||!/^\d{1,6}$/.test(h.trim()))return undefined;
  return Math.min(300,Math.max(1,Number(h)))*1000;
}
export function classifyFailure(status:number|null,body:unknown,retryAfter?:string|null):AnalyzeFailure{
  const o=(body&&typeof body==='object'?body:{}) as Record<string,unknown>;
  if(status===null)return {kind:'NETWORK',message:'네트워크 오류로 요청하지 못했습니다.',retryable:true};
  if(status===503&&o.ok===false&&o.code==='IMAGE_ANALYSIS_NOT_CONFIGURED')return {kind:'NOT_CONFIGURED',message:'이미지 분석 제공자가 아직 연결되지 않았습니다. 입력을 수정하기 전에는 다시 요청하지 않습니다.',retryable:false};
  if(status===401)return {kind:'AUTH',message:'운영자 PIN이 올바르지 않습니다.',retryable:true};
  if(status===429)return {kind:'RATE_LIMIT',message:'요청이 많습니다. 잠시 후 다시 시도해 주세요.',retryable:true,retryAfterMs:parseRetryAfter(retryAfter)};
  if(status===413)return {kind:'TOO_LARGE',message:'요청이 너무 큽니다.',retryable:false};
  if(status===400)return {kind:'BAD_REQUEST',message:'요청 형식이 올바르지 않습니다.',retryable:false};
  if(status===503)return {kind:'UNAVAILABLE',message:'서비스를 일시적으로 사용할 수 없습니다.',retryable:false};
  return {kind:'BAD_REQUEST',message:`예상하지 못한 응답입니다 (${status}).`,retryable:false};
}
export type AttemptRecord={revision:string;failure:AnalyzeFailure;at:number};
/** Decides whether the manual button may fire. */
export function canAnalyze(a:{busy:boolean;revision:string;last:AttemptRecord|null;now:number;hasPin:boolean}):{ok:boolean;reason?:string}{
  if(a.busy)return {ok:false,reason:'분석 요청 중입니다.'};
  if(!a.hasPin)return {ok:false,reason:'운영자 PIN을 입력해 주세요.'};
  const l=a.last;
  if(l&&l.revision===a.revision){
    if(!l.failure.retryable)return {ok:false,reason:'같은 입력으로는 다시 요청하지 않습니다. 이미지나 확인 항목을 수정해 주세요.'};
    const wait=l.at+Math.max(RETRY_COOLDOWN_MS,l.failure.retryAfterMs??0)-a.now;
    if(wait>0)return {ok:false,reason:`${Math.ceil(wait/1000)}초 후 다시 시도할 수 있습니다.`};
  }
  return {ok:true};
}

/** Per-slot generation guard: async work may only commit while its token is current. */
export function createSlotGuard(){
  const gen:Record<string,number>={};let disposed=false;
  return {
    begin(k:string){gen[k]=(gen[k]??0)+1;return gen[k];},
    invalidate(k:string){gen[k]=(gen[k]??0)+1;},
    isCurrent(k:string,t:number){return !disposed&&gen[k]===t;},
    dispose(){disposed=true;},
    get disposed(){return disposed;},
  };
}
