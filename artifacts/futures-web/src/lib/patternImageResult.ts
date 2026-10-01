import {PATTERN_CATALOG} from './patternCatalog';
import {IMAGE_FRAMES,type ImageFrame} from './patternImageInput';

export const CANONICAL_IDS=PATTERN_CATALOG.map(p=>p.id);
export const OBSERVED_EVIDENCE_LABELS={BODY_SMALL:'몸통이 작게 보임',LONG_LOWER_WICK:'긴 아래꼬리가 보임',LONG_UPPER_WICK:'긴 위꼬리가 보임',HIGHER_LOWS:'저점이 높아지는 모양',LOWER_HIGHS:'고점이 낮아지는 모양',RANGE_COMPRESSION:'가격 범위가 좁아지는 모양',SUPPORT_TOUCH:'지지선으로 보이는 구간 접촉',RESISTANCE_TOUCH:'저항선으로 보이는 구간 접촉'} as const;
export const UNVERIFIABLE_LABELS={EXACT_OHLC:'정확한 시가·고가·저가·종가 확인 불가',VOLUME:'거래량 확인 불가',CLOSED_CANDLE:'완료봉 여부 확인 불가',SYMBOL_LABEL:'심볼 표시 확인 불가',TIMEFRAME_LABEL:'시간대 표시 확인 불가',BLUR:'이미지가 흐림',PRICE_SCALE:'가격 축 확인 불가',NOT_A_CHART:'차트로 보이지 않음'} as const;
export type ObservedCode=keyof typeof OBSERVED_EVIDENCE_LABELS;
export type UnverifiableCode=keyof typeof UNVERIFIABLE_LABELS;
export const UNIVERSAL_LIMITS:UnverifiableCode[]=['EXACT_OHLC','CLOSED_CANDLE'];
export type PatternVerdict='CANDIDATE'|'NO_MATCH'|'UNREADABLE';
export type PatternDirection='LONG'|'SHORT'|'NEUTRAL'|'UNKNOWN';
export type DerivedDirection=PatternDirection|'CONFLICT';
export interface PatternItem{id:string;status:PatternVerdict;direction:PatternDirection;observedEvidence:ObservedCode[];unverifiableConditions:UnverifiableCode[]}
export interface FrameResult{timeframe:ImageFrame;symbol:string;exchange:string;patterns:PatternItem[]}
export interface ImageAnalysisResult{ok:true;frames:FrameResult[]}
export interface RequestedFrame{timeframe:string;symbol:string;exchange:string}
export type Alignment={status:'ALIGNED'|'CONFLICT'|'INSUFFICIENT'|'UNAVAILABLE';direction:'LONG'|'SHORT'|null};
const VERDICTS=['CANDIDATE','NO_MATCH','UNREADABLE'];const DIRS=['LONG','SHORT','NEUTRAL','UNKNOWN'];
const isObj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(o:Record<string,unknown>,keys:string[])=>Object.keys(o).length===keys.length&&keys.every(k=>k in o);
const codeList=(v:unknown,allowed:object)=>Array.isArray(v)&&v.length<=10&&new Set(v).size===v.length&&v.every(s=>typeof s==='string'&&Object.prototype.hasOwnProperty.call(allowed,s));

/** Strict, fail-closed. Frames must match the request exactly (timeframe+symbol+exchange). Unknown keys rejected. */
export function parseImageAnalysisResult(raw:unknown,requested:RequestedFrame[]):{ok:true;value:ImageAnalysisResult}|{ok:false;error:string}{
  const bad=(error:string)=>({ok:false as const,error});
  if(!isObj(raw)||!exact(raw,['ok','frames'])||raw.ok!==true||!Array.isArray(raw.frames))return bad('응답 형식이 올바르지 않습니다.');
  if(raw.frames.length!==requested.length)return bad('요청한 프레임 수와 응답이 일치하지 않습니다.');
  const seen=new Set<string>();const frames:FrameResult[]=[];
  for(const f of raw.frames){
    if(!isObj(f)||!exact(f,['timeframe','symbol','exchange','patterns'])||!IMAGE_FRAMES.includes(f.timeframe as ImageFrame)||!Array.isArray(f.patterns))return bad('프레임 형식이 올바르지 않습니다.');
    const tf=f.timeframe as ImageFrame;
    if(seen.has(tf))return bad('중복된 시간대가 있습니다.');seen.add(tf);
    const req=requested.find(r=>r.timeframe===tf);
    if(!req)return bad(`${tf}: 요청하지 않은 프레임입니다.`);
    if(f.symbol!==req.symbol||f.exchange!==req.exchange)return bad(`${tf}: 응답의 심볼·거래소가 요청과 다릅니다.`);
    if(f.patterns.length!==CANONICAL_IDS.length)return bad(`${tf}: 38개 패턴이 모두 필요합니다.`);
    const ids=new Set<string>();const patterns:PatternItem[]=[];
    for(const p of f.patterns){
      if(!isObj(p)||!exact(p,['id','status','direction','observedEvidence','unverifiableConditions']))return bad(`${tf}: 패턴 형식이 올바르지 않습니다.`);
      if(typeof p.id!=='string'||!CANONICAL_IDS.includes(p.id)||ids.has(p.id))return bad(`${tf}: 알 수 없거나 중복된 패턴 id입니다.`);
      ids.add(p.id);
      if(!VERDICTS.includes(p.status as string)||!DIRS.includes(p.direction as string))return bad(`${tf}: 상태 또는 방향 값이 올바르지 않습니다.`);
      if(!codeList(p.observedEvidence,OBSERVED_EVIDENCE_LABELS)||!codeList(p.unverifiableConditions,UNVERIFIABLE_LABELS))return bad(`${tf}: 근거 목록이 올바르지 않습니다.`);
      if(p.status==='CANDIDATE'&&(p.observedEvidence as string[]).length<1)return bad(`${tf}: 후보에는 관찰 근거가 필요합니다.`);
      if(p.status==='UNREADABLE'&&(p.unverifiableConditions as string[]).length<1)return bad(`${tf}: 판독 불가에는 사유가 필요합니다.`);
      if(p.status!=='CANDIDATE'&&p.direction!=='UNKNOWN')return bad(`${tf}: 후보가 아니면 방향은 알 수 없음이어야 합니다.`);
      patterns.push(p as unknown as PatternItem);
    }
    frames.push({timeframe:tf,symbol:f.symbol as string,exchange:f.exchange as string,patterns});
  }
  return {ok:true,value:{ok:true,frames}};
}
/** Derived locally from candidates. LONG+SHORT in one frame is CONFLICT; neutral-only is NEUTRAL. */
export function deriveFrameDirection(f:FrameResult):DerivedDirection{
  const d=new Set(f.patterns.filter(p=>p.status==='CANDIDATE').map(p=>p.direction));
  if(d.has('LONG')&&d.has('SHORT'))return 'CONFLICT';
  if(d.has('LONG'))return 'LONG';
  if(d.has('SHORT'))return 'SHORT';
  if(d.has('NEUTRAL'))return 'NEUTRAL';
  return 'UNKNOWN';
}
export function deriveAlignment(frames:FrameResult[]):Alignment{
  if(new Set(frames.map(f=>`${f.symbol}|${f.exchange}`)).size>1)return {status:'UNAVAILABLE',direction:null};
  const dirs=frames.map(deriveFrameDirection);
  if(dirs.includes('CONFLICT'))return {status:'CONFLICT',direction:null};
  const dd=dirs.filter(d=>d==='LONG'||d==='SHORT');
  if(new Set(dd).size===2)return {status:'CONFLICT',direction:null};
  if(dd.length>=2)return {status:'ALIGNED',direction:dd[0] as 'LONG'|'SHORT'};
  return {status:'INSUFFICIENT',direction:null};
}
