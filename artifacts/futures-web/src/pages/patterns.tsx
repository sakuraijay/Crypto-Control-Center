import {useState} from 'react';
import {PATTERN_CATALOG,type PatternDefinition} from '@/lib/patternCatalog';
import {patternName} from '@/lib/virtualTradeEvidencePresentation';
import {PatternPreview} from '@/components/dashboard/PatternPreview';
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '@/components/ui/dialog';
const direction=(value:string)=>({LONG:'상승 참고',SHORT:'하락 참고',NEUTRAL:'방향 중립',BREAKOUT:'돌파 방향 참고'}[value]??value);
export default function PatternsPage(){
  const [selected,setSelected]=useState<PatternDefinition|null>(null);
  return <div className="space-y-6">
    <div className="ccc-page-heading"><div><p className="ccc-eyebrow">CCC · PATTERN LIBRARY</p><h1>CCC 패턴 탐지 <span className="ccc-count">38</span></h1>
      <p>진입 전에 참고하는 38개 규칙 · 그림을 누르면 탐지 조건을 확인할 수 있습니다.</p></div></div>
    <div className="ccc-callout"><strong>15분 · 1시간 · 4시간 완료봉 분석</strong><p>아래 그림은 규칙을 설명하는 예시이며 현재 시장의 탐지 결과가 아닙니다. 실제 거래에 사용된 기록은 거래 상세의 ‘진입 당시 탐지 패턴’에서 확인하세요.</p></div>
    <div className="ccc-pattern-grid">{PATTERN_CATALOG.map((p,i)=><button key={p.id} type="button" className="ccc-pattern-tile" onClick={()=>setSelected(p)} aria-label={`${patternName(p.id)} 상세 설명`}>
      <div className="flex items-center justify-between text-xs text-slate-400"><span>{String(i+1).padStart(2,'0')} · {p.category}</span><span className={p.direction==='SHORT'?'ccc-negative':p.direction==='LONG'?'ccc-positive':''}>{direction(p.direction)}</span></div>
      <PatternPreview pattern={p}/><strong>{patternName(p.id)}</strong><span className="mt-1 block text-[10px] text-slate-400">{p.id}</span>
    </button>)}</div>
    <p className="ccc-caption">20개 캔들형 + 18개 구조형 · 상승·하락 변형 포함 · 패턴은 후보 순위에 제한적으로 반영되며 단독 주문을 만들지 않습니다.</p>
    <Dialog open={!!selected} onOpenChange={open=>{if(!open)setSelected(null);}}><DialogContent className="ccc-dialog"><DialogHeader>
      <DialogTitle>{selected?patternName(selected.id):'패턴 상세'}</DialogTitle><DialogDescription>{selected?.id} · 설명용 예시 · 실제 시세 아님</DialogDescription></DialogHeader>
      {selected&&<><div className="rounded-xl border border-white/10 bg-black/10 p-4"><PatternPreview pattern={selected}/></div>
        <dl className="space-y-4 text-sm leading-7"><div><dt className="font-semibold">패턴의 의미 · {direction(selected.direction)}</dt><dd className="text-slate-300">{selected.meaning}</dd></div>
          <div><dt className="font-semibold">CCC가 탐지하는 조건</dt><dd className="text-slate-300">{selected.rule}</dd></div>
          <div><dt className="font-semibold">매매에 반영되는 방식</dt><dd className="text-slate-300">15분·1시간·4시간 완료봉을 분석합니다. 기존 품질·비용·손실 제한을 통과한 후보의 순위에 최대 ±0.10만 반영합니다. 같은 시간대의 여러 패턴을 독립된 표처럼 합산하지 않습니다.</dd></div>
          <div><dt className="font-semibold">주의할 점</dt><dd className="text-slate-300">{selected.caution}</dd></div></dl>
        <p className="ccc-caption">ATR은 최근 평균 변동폭입니다. 참고 방향은 수익률 예측이나 진입 지시가 아닙니다. 탐지 버전: paper-chart-reference/v1</p>
      </>}
    </DialogContent></Dialog>
  </div>;
}
