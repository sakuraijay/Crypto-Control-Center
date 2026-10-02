import {useState} from 'react';
import {PATTERN_CATALOG,type PatternDefinition} from '@/lib/patternCatalog';
import {patternName} from '@/lib/virtualTradeEvidencePresentation';
import {PatternPreview} from '@/components/dashboard/PatternPreview';
import {PatternImageHelper} from '@/components/dashboard/PatternImageHelper';
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '@/components/ui/dialog';
const neutral = new Set(['DOJI', 'DRAGONFLY_DOJI', 'GRAVESTONE_DOJI', 'SPINNING_TOP']);
const bidirectional = new Set(['RECTANGLE', 'ASCENDING_TRIANGLE', 'DESCENDING_TRIANGLE', 'SYMMETRICAL_TRIANGLE',
  'RISING_WEDGE', 'FALLING_WEDGE', 'BROADENING', 'PRICE_CHANNEL']);
const entryDirection = (pattern: PatternDefinition) => neutral.has(pattern.id) ? 'NEUTRAL'
  : bidirectional.has(pattern.id) ? 'BREAKOUT' : pattern.direction;
const direction=(value:string)=>({LONG:'상승 패턴',SHORT:'하락 패턴',NEUTRAL:'후속 확인까지 중립',BREAKOUT:'확인된 돌파 방향'}[value]??value);
export default function PatternsPage(){
  const [selected,setSelected]=useState<PatternDefinition|null>(null);
  return <div className="space-y-6">
    <div className="ccc-page-heading"><div><p className="ccc-eyebrow">CCC · PATTERN LIBRARY</p><h1>CCC 패턴 탐지 <span className="ccc-count">38</span></h1>
      <p>PAPER의 38개 패턴 전략 · 그림을 누르면 형태와 탐지 조건을 확인할 수 있습니다.</p></div></div>
    <PatternImageHelper/>
    <div className="ccc-callout"><strong>15분 · 1시간 · 4시간 완료봉 분석</strong><p>아래 그림은 규칙을 설명하는 예시이며 현재 시장의 탐지 결과가 아닙니다. 새 PAPER 거래는 상세의 ‘진입 주도 패턴’, 이전 거래는 ‘진입 당시 탐지 패턴’ 기록으로 구분합니다.</p></div>
    <div className="ccc-pattern-grid">{PATTERN_CATALOG.map((p,i)=><button key={p.id} type="button" className="ccc-pattern-tile" onClick={()=>setSelected(p)} aria-label={`${patternName(p.id)} 상세 설명`}>
      <div className="flex items-center justify-between text-xs text-slate-400"><span>{String(i+1).padStart(2,'0')} · {p.category}</span><span className={entryDirection(p)==='SHORT'?'ccc-negative':entryDirection(p)==='LONG'?'ccc-positive':''}>{direction(entryDirection(p))}</span></div>
      <PatternPreview pattern={p}/><strong>{patternName(p.id)}</strong><span className="mt-1 block text-[10px] text-slate-400">{p.id}</span>
    </button>)}</div>
    <p className="ccc-caption">20개 캔들형 + 18개 구조형 · PAPER v10에서는 공식 완료봉과 확정 pivot으로 각 패턴이 독립 진입 후보를 생성합니다. 중립은 후속 완료봉 돌파를 기다리며 충돌과 안전 검사를 통과해야 주문됩니다. 이전 정책의 패턴은 순위 참고용이며, 아래 예시 그림·스크린샷 분석은 주문 권한이 없습니다.</p>
    <Dialog open={!!selected} onOpenChange={open=>{if(!open)setSelected(null);}}><DialogContent className="ccc-dialog"><DialogHeader>
      <DialogTitle>{selected?patternName(selected.id):'패턴 상세'}</DialogTitle><DialogDescription>{selected?.id} · 설명용 예시 · 실제 시세 아님</DialogDescription></DialogHeader>
      {selected&&<><div className="rounded-xl border border-white/10 bg-black/10 p-4"><PatternPreview pattern={selected}/></div>
        <dl className="space-y-4 text-sm leading-7"><div><dt className="font-semibold">패턴의 의미 · {direction(entryDirection(selected))}</dt><dd className="text-slate-300">{selected.meaning}</dd></div>
          <div><dt className="font-semibold">CCC가 탐지하는 조건</dt><dd className="text-slate-300">{selected.rule}</dd></div>
          <div><dt className="font-semibold">새 PAPER 정책의 매매 반영</dt><dd className="text-slate-300">
            각 패턴은 공식 완료봉·확정 pivot을 근거로 독립 후보를 생성합니다.
            {entryDirection(selected)==='NEUTRAL'
              ? ' 중립 형태만으로 주문하지 않습니다. 후속 완료봉 종가가 형태의 고점·저점을 처음 돌파한 방향을 고정하고 반대쪽 범위를 관측 손절로 사용합니다.'
              : entryDirection(selected)==='BREAKOUT'
                ? ' 상방·하방 경계 돌파가 완료봉으로 확인된 방향을 따르며 반대쪽 관측 경계를 손절로 사용합니다.'
                : ' 완성된 형태와 방향별 트리거를 확인하고 형태의 관측 무효화 가격을 손절로 사용합니다.'}
            {' '}품질·모멘텀·국면·변동성·손익비는 보조 정보입니다. 지지 패턴은 기록하고 방향 충돌은 주문을 보류하며 동일 사건으로 재주문하지 않습니다. 유효 시세·실제 추정 비용·계좌 손실·위험·단일 포지션 한도는 유지합니다. 현재 목표 가격은 만들지 않으며 관측 손절 또는 최대 보유시간(단타 1시간·스윙 4시간)으로 청산합니다.
          </dd></div>
          <div><dt className="font-semibold">주의할 점</dt><dd className="text-slate-300">{selected.caution}</dd></div></dl>
        <p className="ccc-caption">ATR은 최근 평균 변동폭입니다. 설명 그림은 수익률 예측·진입 지시가 아닙니다. 공통 형태 탐지: paper-chart-reference/v1 · 새 PAPER 진입: paper-pattern-entry/v10. 이전 정책의 순위 참고 기록과 스크린샷 분석은 새 진입 권한으로 전환하지 않습니다.</p>
      </>}
    </DialogContent></Dialog>
  </div>;
}
