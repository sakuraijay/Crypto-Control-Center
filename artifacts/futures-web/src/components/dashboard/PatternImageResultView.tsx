import {patternName} from '@/lib/virtualTradeEvidencePresentation';
import {OBSERVED_EVIDENCE_LABELS,UNIVERSAL_LIMITS,UNVERIFIABLE_LABELS,deriveAlignment,deriveFrameDirection,type DerivedDirection,type ImageAnalysisResult,type PatternDirection,type PatternItem,type PatternVerdict} from '@/lib/patternImageResult';
const DIR:Record<DerivedDirection,string>={LONG:'상승 참고',SHORT:'하락 참고',NEUTRAL:'중립',UNKNOWN:'방향 알 수 없음',CONFLICT:'프레임 내 상승·하락 충돌'};
const ALIGN={ALIGNED:'시간대 방향 일치',CONFLICT:'시간대 방향 충돌',INSUFFICIENT:'비교할 방향 부족',UNAVAILABLE:'심볼·거래소가 달라 시간대 비교 불가'} as const;
const GROUPS:{status:PatternVerdict;label:string}[]=[{status:'CANDIDATE',label:'후보'},{status:'NO_MATCH',label:'해당 없음'},{status:'UNREADABLE',label:'판독 불가'}];
function Row({p}:{p:PatternItem}){
  return <li className="py-1 text-xs leading-6" data-testid={`row-${p.id}`}><strong>{patternName(p.id)}</strong> <span className="text-slate-500">{p.id}</span>{p.status==='CANDIDATE'&&<span className="text-slate-400"> · {DIR[p.direction as PatternDirection]}</span>}
    {p.observedEvidence.length>0&&<ul className="list-disc pl-5 text-slate-300">{p.observedEvidence.map(e=><li key={e}>관찰: {OBSERVED_EVIDENCE_LABELS[e]}</li>)}</ul>}
    <p className="pl-5 text-slate-400">확인 불가: {[...new Set([...UNIVERSAL_LIMITS,...p.unverifiableConditions])].map(c=>UNVERIFIABLE_LABELS[c]).join(' · ')}</p></li>;
}
export function PatternImageResultView({result}:{result:ImageAnalysisResult}){
  const al=deriveAlignment(result.frames);
  return <div className="space-y-3" data-testid="pattern-image-result">
    <div className="ccc-callout"><strong>{ALIGN[al.status]}</strong><p>화면에서 관찰된 근거만 표시합니다. 가격·확률·정확한 캔들 값은 제공하지 않으며 주문을 만들지 않습니다.</p></div>
    {result.frames.map(f=><section key={f.timeframe} className="ccc-panel p-4" data-testid={`frame-${f.timeframe}`}>
      <h3 className="text-sm font-semibold">{f.timeframe} · {f.symbol} · {f.exchange} · {DIR[deriveFrameDirection(f)]}</h3>
      {GROUPS.map(g=>{const rows=f.patterns.filter(p=>p.status===g.status);return <details key={g.status} open={g.status==='CANDIDATE'} className="mt-2"><summary className="ccc-caption">{g.label} {rows.length}</summary>
        <ul>{rows.map(p=><Row key={p.id} p={p}/>)}</ul></details>;})}
    </section>)}
  </div>;
}
