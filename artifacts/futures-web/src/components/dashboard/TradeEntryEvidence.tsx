import {amount,timestamp} from '@/lib/virtual400Presentation';
import {patternName,timeframeName,patternAlignment,frameStatus,regimeName,patternBasis,type TradeEntryEvidence as Evidence} from '@/lib/virtualTradeEvidencePresentation';
export function TradeEntryEvidence({evidence:e}:{evidence?:Evidence|null}) {
  if(!e)return <div className="ccc-callout"><strong>진입 당시 분석 기록</strong><p>이 거래에는 상세 분석 기록이 없습니다. 현재 차트로 과거 진입 근거를 추정하지 않습니다.</p></div>;
  return <div className="space-y-3">
    <div className="ccc-callout"><strong>진입 판단 요약</strong>
      <p>시장 상태: {regimeName(e.quality.regime)} · 진입 품질 조건: {e.quality.eligible===true?'통과':e.quality.eligible===false?'미충족':'기록 없음'}</p>
      <p>가격 모멘텀: {amount(e.momentumPct,true)}% · 평균 변동폭(ATR): {amount(e.quality.atrPct)}%</p>
      <p>판단 시각: {timestamp(new Date(e.evaluatedAt).toISOString(),true)} PHT</p>
      <p>완료봉 기준: {timestamp(new Date(e.closedAt).toISOString(),true)} PHT</p>
    </div>
    <div className="ccc-callout"><strong>진입 당시 탐지 패턴</strong>
      <p>패턴은 진입 후보의 우선순위에 참고됩니다. 패턴 하나만으로 진입한 거래라는 의미는 아닙니다.</p>
      {e.patternStatus!=='RECORDED'?<p className="mt-2">이 거래에는 패턴 분석 기록이 없습니다.</p>:<>
        <p>실제 후보 순위 보정: {e.patternAdjustment===null?'기록 없음':`${e.patternAdjustment>0?'+':''}${e.patternAdjustment.toFixed(3)}`} <span>(수익률·승률 아님)</span></p>
        <p>동일 시간대의 중복 근거는 합산하지 않으며, 반대 방향 근거는 상쇄합니다.</p>
        {e.frames.map((f,i)=><div key={`${f.timeframe}:${i}`} className="mt-3 border-t border-white/10 pt-3">
          <strong>{timeframeName(f.timeframe)} · {frameStatus(f.status)}</strong>
          {f.closedAt!==null&&<p>마감: {timestamp(new Date(f.closedAt).toISOString(),true)} PHT · {f.bars??'—'}개 봉</p>}
          {!f.findings.length&&<p>{f.status==='OK'?'탐지된 패턴 없음':'확인 가능한 패턴 자료 없음'}</p>}
          {f.findings.map((p,j)=><div key={`${p.id}:${j}`} className="mt-2 rounded border border-white/10 p-3">
            <strong>{patternName(p.id)} · {patternAlignment(p.alignment)}</strong>
            <p>{p.direction==='LONG'?'상승 방향':p.direction==='SHORT'?'하락 방향':'중립'} · {p.state==='BREAKOUT'?'종가 돌파 확인':'캔들 형태 감지'}</p>
            <p>{patternBasis(p.basis)}</p>
            {(p.trigger!==null||p.invalidation!==null)&&<p>돌파 기준 가격: {amount(p.trigger,false,6)} · 패턴 무효화 기준: {amount(p.invalidation,false,6)}</p>}
            <p className="text-xs text-slate-400">규칙: {p.id} · 거래량 확인 불가</p>
          </div>)}
        </div>)}
        <p className="mt-3 text-xs">분석 버전: {e.patternVersion} · 진입 당시 저장 기록 · 수익성 미검증</p>
      </>}
    </div>
  </div>;
}
