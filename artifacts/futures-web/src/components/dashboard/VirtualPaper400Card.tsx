import { useState } from 'react';
import { Link } from 'wouter';
import { Activity, ArrowUpRight, ChevronDown, CircleDollarSign, Clock3, Layers3, Radar, RefreshCw, ShieldCheck, SlidersHorizontal, Wallet, WifiOff } from 'lucide-react';
import { useVirtualPaper400 } from '@/lib/context/VirtualPaper400Context';
import { useWatchlistContext } from '@/lib/context/WatchlistContext';
import { amount, explainReason, finite, timestamp, type VirtualRuntime } from '@/lib/virtual400Presentation';
import { VirtualSessionControls } from './VirtualSessionControls';
import { VirtualTradingModeControls } from './VirtualTradingModeControls';
import { VirtualPerformanceChart } from './VirtualPerformanceChart';
import { VirtualTradeJournal } from './VirtualTradeJournal';
import { AiAnalysisActivity } from './AiAnalysisActivity';
import { PatternEntryDiagnostics } from './PatternEntryDiagnostics';

function Metric({ label, value, unit = 'USDC', note, icon: Icon, tone = '', featured = false, initial }: {
  label: string; value: string; unit?: string; note: string; icon: typeof Wallet; tone?: string; featured?: boolean; initial?: string;
}) {
  return <div className={`ccc-metric ${featured ? 'ccc-metric-featured' : ''}`}><div className="ccc-metric-label"><span>{label}</span><Icon size={17} /></div>
    {initial !== undefined && <><p className="ccc-initial-capital">최초 시작금액 <strong data-testid="metric-initial-capital">{initial}</strong> USDC</p><p className="ccc-current-capital-label">현재 가상 평가자산</p></>}
    <div className={`ccc-metric-value ${tone}`} data-testid={`metric-${label}`}>{value}<small>{unit}</small></div><p>{note}</p></div>;
}

function PositionPanel({ runtime, fresh }: { runtime: VirtualRuntime | null; fresh: boolean }) {
  const rows = fresh ? runtime?.account.held ?? [] : [];
  return <section className="ccc-panel" aria-label="가상 보유 포지션"><div className="ccc-panel-heading"><div><p className="ccc-eyebrow">OPEN POSITIONS</p><h2>보유 포지션 <span className="ccc-count">{fresh ? rows.length : '—'}</span></h2></div><span className="ccc-caption"><ShieldCheck size={14} />서버 손절·익절 관리</span></div>
    {rows.length ? <div className="ccc-table-wrap"><table className="ccc-table"><thead><tr><th>종목 / 방향</th><th>진입 가격</th><th>포지션 규모</th><th>손절</th><th>목표</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}><td><strong>{row.symbol}</strong> <span className={`ccc-direction ${row.side==='LONG'?'ccc-positive':'ccc-negative'}`}>{row.side}</span></td><td>{amount(row.entryPrice)}</td><td>{amount(row.sizeUsd)} USD</td><td>{amount(row.stopPrice)}</td><td>{row.takeProfitPrice===null?'없음':amount(row.takeProfitPrice)}</td></tr>)}</tbody></table></div>
    : <div className="ccc-empty-row"><Layers3 size={23} /><div><strong>{fresh ? '열린 포지션이 없습니다' : '포지션 확인 대기'}</strong><p>{fresh ? '진입이 발생하면 규모와 손절·목표 가격을 표시합니다.' : '서버 연결이 복구되면 최신 포지션을 표시합니다.'}</p></div></div>}
  </section>;
}

function MarketDecisions({ runtime, fresh }: { runtime: VirtualRuntime | null; fresh: boolean }) {
  const { watchlist, streamStatus } = useWatchlistContext();
  const symbols = fresh ? [...new Set([...(runtime?.policy?.symbols??[]), ...(runtime?.analysis??[]).map(row=>row.symbol), ...(runtime?.diagnostics??[]).map(row=>row.symbol)])] : [];
  return <section className="ccc-panel ccc-markets" aria-label="종목별 진입 판단"><div className="ccc-panel-heading"><div><p className="ccc-eyebrow">MARKET RADAR</p><h2>시장과 진입 판단</h2></div><Link href="/watchlist" className="ccc-text-link">시장 보기 <ArrowUpRight size={14} /></Link></div>
    <div className="ccc-market-columns"><span>감시 종목</span><span>참고 시세 · USD</span><span>서버 판단</span></div>
    {symbols.map(symbol=>{
      const quote = watchlist.find(row=>row.symbol===symbol);
      const price = streamStatus==='connected' && (finite(quote?.price)??0)>0 ? quote!.price : null;
      const reasons = [...new Set([...(runtime?.diagnostics??[]).filter(row=>row.symbol===symbol).flatMap(row=>[row.reason,...(row.details??[])]),...(runtime?.analysis??[]).filter(row=>row.symbol===symbol).map(row=>row.reason)])];
      return <details className="ccc-market-row" key={symbol}><summary><div className="ccc-asset"><span className={`ccc-coin ccc-coin-${symbol.toLowerCase()}`}>{symbol==='BTC'?'₿':symbol==='ETH'?'Ξ':symbol.slice(0,1)}</span><span><strong>{symbol}</strong><small>{symbol==='BTC'?'Bitcoin':symbol==='ETH'?'Ethereum':symbol==='SOL'?'Solana':'GMX Market'}</small></span></div><strong className="ccc-quote">{amount(price)}</strong><span className="ccc-decision-text"><i />{explainReason(reasons[0])}</span><ChevronDown size={14} className="ccc-expand-icon" /></summary><div className="ccc-market-evidence"><span className="ccc-eyebrow">SERVER EVIDENCE</span>{reasons.length?reasons.map((reason,index)=><p key={index}>{reason}</p>):<p>종목별 근거 확인 대기</p>}</div></details>;
    })}
    {!symbols.length && <div className="ccc-empty-row"><Radar size={23} /><div><strong>감시 종목 확인 대기</strong><p>서버에서 확인된 종목과 판단만 표시합니다.</p></div></div>}
    <footer className="ccc-panel-footer"><span>행을 펼치면 판단 근거를 확인할 수 있습니다.</span><span>확정 캔들 기반</span></footer>
  </section>;
}

function PaperEvaluationDiagnostics({ runtime, fresh }: { runtime: VirtualRuntime | null; fresh: boolean }) {
  const diagnostics = fresh ? runtime?.tradingDiagnostics : null;
  const evaluation = diagnostics?.status === 'OBSERVED' ? diagnostics.adaptiveEvaluations : undefined;
  const idleMinutes = diagnostics?.status === 'OBSERVED' ? diagnostics.minutesWithoutNewEntry : undefined;
  const archive = fresh ? runtime?.comparison : null;
  const continuous = fresh ? runtime?.continuousComparison : null;
  const continuousAvailable = continuous?.status === 'COLLECTING' ? continuous : null;
  const entrySamples = fresh ? runtime?.entryEvaluations ?? [] : [];
  const conditionLabel: Record<string, string> = {
    atrFraction: '실현 ATR / 가격', symbolMedianTrueRangeFraction: '종목 중앙 TR / 가격',
    adaptiveVolatilityMin: '적응 변동성 하한', adaptiveVolatilityMax: '적응 변동성 상한',
    efficiency: '가격 이동 효율', momentumFraction: '완료봉 모멘텀', score: '신호 점수',
    scoreThreshold: '최소 신호 점수', stopFraction: '구조적 손절 거리',
    netRewardRisk: '비용 차감 손익비', roundTripCostUsd: '왕복 추정 비용',
    roundTripCost: '왕복 추정 비용', riskBudgetUsd: '손실 위험 예산',
  };
  const value = (number: number | null) => number === null || !Number.isFinite(number)
    ? '미확인' : number.toLocaleString('en-US', { maximumFractionDigits: 5 });
  const policyRows = evaluation?.byPolicy ?? [];
  const v7 = policyRows.find(row => row.version.includes('/v7') || row.version.includes('v7'));
  const adaptive = policyRows.find(row => row.version === runtime?.policy?.version)
    ?? policyRows.find(row => row.version.includes('/v9'))
    ?? policyRows.find(row => row.version.includes('/v8'));
  const adaptiveLabel = adaptive?.version.split('/').at(-1) ?? runtime?.policy?.version.split('/').at(-1) ?? '적응 정책';
  const comparisonLabel = continuousAvailable?.policyVersions?.adaptive.split('/').at(-1) ?? 'v8';
  const comparisonCount = (counts: { adaptiveV8?: number; adaptiveV9?: number }) =>
    (comparisonLabel === 'v9' ? counts.adaptiveV9 : counts.adaptiveV8) ?? '—';
  const rejectedSamples = entrySamples.filter(row => !row.eligible).slice(-8).reverse();
  return <section className="ccc-panel ccc-paper-diagnostics" aria-label="PAPER 진입 진단" data-testid="paper-entry-diagnostics">
    <div className="ccc-panel-heading"><div><p className="ccc-eyebrow">PAPER ENTRY EVIDENCE</p><h2>진입 정책 · 탈락 진단</h2></div>
      <span className="ccc-caption"><ShieldCheck size={14} />관측 증거 · 수익 예측 아님</span></div>
    {!fresh ? <div className="ccc-empty-row"><Radar size={23} /><div><strong>진입 진단 확인 대기</strong><p>신선한 서버 스냅샷이 없으므로 이전 수치로 채우지 않습니다.</p></div></div>
      : diagnostics?.status === 'UNAVAILABLE' || !diagnostics ? <div className="ccc-empty-row"><WifiOff size={20} /><div><strong>진입 진단 자료를 확인할 수 없습니다</strong><p>{diagnostics && 'reason' in diagnostics ? diagnostics.reason : '서버에서 진단 요약이 제공되지 않았습니다.'}</p></div></div>
      : <>
        {idleMinutes !== undefined && idleMinutes >= 1440 && <div className="ccc-diagnostics-alert" role="status" data-testid="paper-idle-alert">
          <Clock3 size={17} /><span><strong>24시간 이상 새 진입이 없습니다.</strong> 마지막 신규 진입 이후 {Math.floor(idleMinutes / 60)}시간 {idleMinutes % 60}분. 이 알림은 PAPER 관측용이며 주문을 강제하지 않습니다.</span>
        </div>}
        <div className="ccc-diagnostics-summary">
          <div><span>최근 24시간 · {adaptiveLabel} 확정봉 후보</span><strong data-testid="paper-evaluation-denominator">{adaptive?.candidates ?? '—'}</strong></div>
          <div><span>{adaptiveLabel} 조건 통과</span><strong className="ccc-positive">{adaptive?.eligible ?? '—'}</strong></div>
          <div><span>{adaptiveLabel} 조건 탈락</span><strong className="ccc-negative">{adaptive?.rejected ?? '—'}</strong></div>
          <div><span>v7 기존 신호 게이트</span><strong>{v7 ? `${v7.eligible}/${v7.candidates}` : '미수집'}</strong></div>
        </div>
        {evaluation?.status === 'OBSERVED' && <>
          <p className="ccc-diagnostics-note" data-testid="paper-safety-vs-signal">
            신호·시장 점수: {evaluation.signal.rejected}/{evaluation.signal.candidates} 탈락 ·
            안전·계좌 조건: {evaluation.safety.rejected}/{evaluation.safety.candidates} 탈락.
            안전 제한은 신호 점수와 분리해 유지합니다.
          </p>
          {v7 && adaptive && <p className="ccc-diagnostics-note">
            동일 확정봉 신호 게이트 비교: v7 {v7.eligible}/{v7.candidates} 통과 · {v7.rejected} 탈락,
            {adaptiveLabel} {adaptive.eligible}/{adaptive.candidates} 통과 · {adaptive.rejected} 탈락. 포트폴리오 수익·승률 비교가 아닙니다.
          </p>}
          {!!evaluation.conditions.length && <div className="ccc-diagnostics-table-wrap">
            <table className="ccc-diagnostics-table"><thead><tr><th>측정 조건</th><th>평균 실측</th><th>임계값 평균</th><th>실측 범위</th><th>미충족 / 미측정</th></tr></thead>
              <tbody>{evaluation.conditions.map(condition=><tr key={condition.name}>
                <td>{conditionLabel[condition.name] ?? condition.name}</td>
                <td>{value(condition.mean)}</td><td>{value(condition.meanThreshold)}</td>
                <td>{condition.minimum === null || condition.maximum === null ? '미확인' : `${value(condition.minimum)} – ${value(condition.maximum)}`}</td>
                <td>{condition.failed} / {condition.missing} ({condition.observed} 관측)</td>
              </tr>)}</tbody>
            </table>
          </div>}
          {!!evaluation.rejectionReasons.length && <div className="ccc-diagnostics-reasons"><strong>최근 24시간 탈락 사유</strong>
            {evaluation.rejectionReasons.map(row=><span key={row.reason}><code>{row.reason}</code><b>{row.count}회 · 양 정책 평가 합산</b></span>)}
          </div>}
          {!!rejectedSamples.length && <div className="ccc-diagnostics-reasons" data-testid="paper-rejection-samples">
            <strong>최근 후보별 실제 탈락 측정값 · 이번 주기</strong>
            {rejectedSamples.map(row=><span key={`${row.id}:${row.policyVersion}`}>
              <code>{row.symbol} · {row.policyVersion} · {row.reason}</code>
              {row.evidence && <b data-testid="paper-price-evidence">
                {row.evidence.direction} · 기준가 {value(row.evidence.referencePrice)} · 현재 호가 {value(row.evidence.currentEntryPrice)}
                {' · '}실행 진입가 {value(row.evidence.executionEntryPrice)} · 관측 손절 {value(row.evidence.observedStopPrice)}
                {' · '}관측 목표 {value(row.evidence.observedTargetPrice)} · 실제 손절 거리 {value(row.evidence.actualStopDistanceFraction)}
                {' · '}허용 범위 {value(row.evidence.stopBounds.minimum)}–{value(row.evidence.stopBounds.maximum)}
                {' · '}신호 {row.evidence.selectedSetup ?? '없음'} · {row.evidence.candidateReason}
                {' · '}손절 판정 {row.evidence.stopFailure ?? '유효'}
                {' · '}확정봉 {timestamp(new Date(row.closedAt).toISOString())} PHT
              </b>}
              <b>{row.conditions.filter(condition=>condition.passed===false||condition.value===null).map(condition=>
                `${condition.name}: 실측 ${value(condition.value)}, ${condition.operator} 임계값 ${value(condition.threshold)}`
              ).join(' · ') || '개별 조건 측정값 없음'}
                {' · '}{Number.isFinite(row.evaluatedAt) ? timestamp(new Date(row.evaluatedAt).toISOString()) : '미확인'} PHT</b>
            </span>)}
          </div>}
          <p className="ccc-diagnostics-note">{evaluation.nextEvaluationAt
            ? `다음 평가 예정 시각 ${timestamp(evaluation.nextEvaluationAt)} PHT (주기 예정값이며 실행 보장은 아님).`
            : '다음 평가 시각 미확인. 실행 주기나 주문을 추정하지 않습니다.'}
            {' '}집계는 {evaluation.windowBasis} 기준입니다.</p>
        </>}
        <div className="ccc-diagnostics-comparisons">
          <div><strong>기존 비교 보관본 · {archive?.version ?? '미확인'}</strong>
            <span>{archive ? `${archive.completedPairs ?? '—'}/${archive.candidates ?? '—'} 쌍 관측 · ${archive.status}` : '기존 비교 결과 없음'}</span>
            {archive?.baseline && <small>기준군 {archive.baseline.trades ?? '—'}건 · 순손익 {amount(archive.baseline.netPnlUsd, true)} · 비용 {amount(archive.baseline.costUsd)}</small>}
            {archive?.filtered && <small>비용 필터군 {archive.filtered.trades ?? '—'}건 · 순손익 {amount(archive.filtered.netPnlUsd, true)} · 비용 {amount(archive.filtered.costUsd)}</small>}
          </div>
          <div><strong>지속 비교 관측 · {continuousAvailable?.version ?? (continuous ? '미확인' : '새 표본 대기')}</strong>
            <span>{continuousAvailable ? `${continuousAvailable.candidates}개 동일 확정봉 후보 · ${continuousAvailable.pages}개 일별 페이지 · ${continuousAvailable.status}`
              : continuous?.status === 'UNAVAILABLE' ? `자료를 확인할 수 없습니다 · ${continuous.reason}` : '연속 수집 요약 미제공'}</span>
            {continuousAvailable && <small>후보 게이트 통과: v7 {continuousAvailable.accepted.legacyV7}/{continuousAvailable.candidates} · {comparisonLabel} {comparisonCount(continuousAvailable.accepted)}/{continuousAvailable.candidates}. 포트폴리오 성과가 아닙니다.</small>}
            {continuousAvailable && <small>비용 증거 확인: v7 {continuousAvailable.costEvidenceAvailable.legacyV7}/{continuousAvailable.candidates} · {comparisonLabel} {comparisonCount(continuousAvailable.costEvidenceAvailable)}/{continuousAvailable.candidates}.</small>}
            {continuousAvailable && <small>비용 증거 미확인: v7 {continuousAvailable.costEvidenceUnavailable.legacyV7}/{continuousAvailable.candidates} · {comparisonLabel} {comparisonCount(continuousAvailable.costEvidenceUnavailable)}/{continuousAvailable.candidates}. 이를 비용이 0인 것으로 간주하지 않습니다.</small>}
            {continuousAvailable && <small>
              결과 미평가 · 진행 중 시간창 {continuousAvailable.pendingTimeWindow} · 만기 후 결과 미확인 {continuousAvailable.outcomeUnknown}
              {continuousAvailable.maxPotentialMaturityAt ? ` · 잠재적 최대 만기 ${timestamp(continuousAvailable.maxPotentialMaturityAt)} PHT` : ''}
            </small>}
            {continuousAvailable?.outcomes && <small>실현 결과: 가격경로는 미평가 상태입니다. 순손익·기대값·승률은 제공하지 않습니다.</small>}
          </div>
        </div>
        <p className="ccc-diagnostics-note">표본 신호 적격성과 실제 포지션 성과는 별개입니다. 비용·미성숙 결과는 0 또는 승리로 간주하지 않으며, 비교만으로 정책을 자동 승격하지 않습니다.</p>
      </>}
  </section>;
}

export function VirtualPaper400Card() {
  const { data, error, fresh, status, refresh } = useVirtualPaper400();
  const [refreshing, setRefreshing] = useState(false);
  const runtime = fresh ? data?.runtime ?? null : null;
  const account = runtime?.account;
  const policy = runtime?.policy;
  const active = data?.session.status === 'ACTIVE' && fresh;
  const blocked = runtime?.status === 'BLOCKED';
  const stopped = data?.session.status === 'STOPPED';
  const pnlTone = (value: unknown) => finite(value)===null?'':Number(value)>0?'ccc-positive':Number(value)<0?'ccc-negative':'';
  const headline = !fresh ? '서버 상태를 확인하고 있습니다' : stopped ? '신규 진입이 중지되어 있습니다'
    : blocked ? '진입 조건을 다시 확인하고 있습니다' : runtime?.status==='NO_TRADE' ? '기준에 맞는 기회를 기다립니다'
    : (account?.held.length??0)>0 ? '포지션을 관리하고 있습니다' : '서버가 전략을 실행하고 있습니다';
  async function reload() { setRefreshing(true); try { await refresh(); } finally { setRefreshing(false); } }
  return <div className="ccc-overview" aria-label="Virtual 400 paper account">
    <div className="ccc-page-heading"><div><div className="ccc-heading-meta"><span className="ccc-eyebrow">YOUR TRADING, AT A GLANCE</span><span className="ccc-paper-tag">PAPER ACCOUNT</span></div><h1>자동매매 오버뷰<span className="ccc-title-dot">.</span></h1><p>복잡한 시장 속에서도, 내 자산과 다음 판단은 명확하게.</p></div>
      <div className="ccc-page-actions"><button className="ccc-icon-button" aria-label="서버 상태 새로고침" disabled={refreshing} onClick={()=>void reload()}><RefreshCw size={17} className={refreshing?'animate-spin':''} /></button><VirtualSessionControls /></div>
    </div>
    <div className="ccc-session-strip"><span className={`ccc-status-pill ${active&&!blocked?'is-active':blocked?'is-warning':''}`}><i />{status}</span><span>가상 계좌 <span className="ccc-strip-divider">/</span> 실자금 사용 없음</span><span className="ccc-session-time"><Clock3 size={13} />{fresh ? `${timestamp(runtime?.at)} PHT 기준` : '최신 상태 확인 대기'}</span></div>
    {error && <div role="alert" className="ccc-inline-alert"><WifiOff size={17} />{error}</div>}
    <div className="ccc-metric-grid">
      <Metric label="가상 평가자산" value={amount(account?.equityUsd)} initial={amount(account?.ledger.initialEquityUsd)} note={account ? `추가 입금 ${amount(account.ledger.netContributionsUsd ?? 0, true)} USDC · 손익과 별도` : '시작금액·추가 입금 확인 대기'} icon={Wallet} featured />
      <Metric label="비용 차감 실현 손익" value={amount(account?.ledger.realizedNetPnlUsd,true)} note={account?`${account.ledger.settlementCount}건 정산 · 추정 비용 반영`:'정산 기록 확인 대기'} icon={CircleDollarSign} tone={pnlTone(account?.ledger.realizedNetPnlUsd)} />
      <Metric label="미실현 순손익 추정" value={amount(account?.unrealizedNetPnlUsd,true)} note="현재 보유 포지션의 평가 손익" icon={Activity} tone={pnlTone(account?.unrealizedNetPnlUsd)} />
      <Metric label="보유 포지션" value={account?String(account.held.length):'—'} unit="개" note="진입과 보호는 서버에서 실행" icon={Layers3} />
    </div>
    <AiAnalysisActivity />
    <div className="ccc-overview-grid"><VirtualPerformanceChart runtime={runtime} fresh={fresh} />
      <section className="ccc-panel ccc-strategy-panel" aria-label="자동매매 상태와 설정"><div className="ccc-panel-heading"><div><p className="ccc-eyebrow">AUTOMATION</p><h2>자동매매 상태</h2></div><span className={`ccc-radar-icon ${active&&!blocked?'is-active':''}`}><Radar size={20} /></span></div>
        <div className="ccc-strategy-message"><h3>{headline}</h3><p>{stopped?'기존 포지션의 손절·익절 보호는 계속됩니다.':explainReason(runtime?.reason)}</p></div>
         {policy ? <div className="ccc-policy" data-testid="virtual-active-policy">
           <div className="ccc-policy-name"><SlidersHorizontal size={15} /><strong>{policy.version==='virtual400-daily/v10'?'38개 패턴 주도 PAPER 시험':policy.version==='virtual400-daily/v9'?'완화형 PAPER 시험':policy.version==='virtual400-daily/v7'?'비용 선별 PAPER 시험':['virtual400-daily/v3','virtual400-daily/v4','virtual400-daily/v5','virtual400-daily/v6','virtual400-daily/v7','virtual400-daily/v8'].includes(policy.version)?'적극적 PAPER 시험':['virtual400-active/v1','virtual400-active/v2'].includes(policy.version)?'적극적 가상 매매':'저장된 운용 설정'}</strong><span>서버 적용</span></div>
           <dl><div><dt>1회 위험 예산</dt><dd>{policy.riskPerTradePct}%</dd></div><div><dt>레버리지 {policy.minLeverage ? '범위' : '상한'}</dt><dd>{policy.minLeverage ? `${policy.minLeverage}–${policy.maxLeverage}x` : `최대 ${policy.maxLeverage}x`}</dd></div><div><dt>{policy.version==='virtual400-daily/v10'?'주문 중복 방지':'진입 간격'}</dt><dd>{policy.version==='virtual400-daily/v10'?'패턴 사건별 1회':`${policy.cooldownMinutes}분`}</dd></div></dl>
           <p className="ccc-policy-symbols">{policy.symbols.join(' · ')}</p>
           <p className="ccc-diagnostics-note">{policy.version} · 적용 {timestamp(policy.appliedAt)} PHT{policy.version!=='virtual400-daily/v10' && typeof policy.minimumNetRewardRisk==='number' ? ` · 최소 비용 차감 손익비 ${policy.minimumNetRewardRisk}` : ''}</p>
           {['virtual400-daily/v9','virtual400-daily/v10'].includes(policy.version) && <p className="ccc-diagnostics-note">연속 손실만으로 장시간 진입을 중단하지 않습니다. 비용·남은 손실 예산과 손절을 다시 확인합니다.</p>}
           {policy.version==='virtual400-daily/v10' && <p className="ccc-callout">38개 패턴이 독립 후보를 생성합니다. 중립은 후속 완료봉 돌파까지 대기합니다. 기존 점수·국면·모멘텀·비용 후 손익비는 보조 정보이며 문턱 미충족만으로 진입을 거부하지 않습니다. 손실 한도·손절·위험 예산·시세·비용 증거·단일 포지션 보호는 유지합니다.</p>}
         </div>
        : <div className="ccc-callout">적용된 설정을 확인하고 있습니다. 기본값으로 대체하지 않습니다.</div>}
         {policy && ['virtual400-daily/v3','virtual400-daily/v4','virtual400-daily/v5','virtual400-daily/v6','virtual400-daily/v7','virtual400-daily/v8','virtual400-daily/v9'].includes(policy.version) && <p className="ccc-callout">미검증 PAPER 전략 · 하루 최대 {policy.maxDailyEntries ?? 24}회 · 일손실 {account?.dailyBudget?.lossLimitPct ?? 5}% 제한{policy.dailyProfitCapPct ? ` · 일일 실현 순수익 ${policy.dailyProfitCapPct}% 도달 시 신규 진입 중지 (PHT)` : ''}. 일반 전략 성과와 구분하며 손실도 그대로 기록합니다.</p>}
        {account?.dailyBudget && <p className="ccc-callout" data-testid="virtual-daily-budget">
          투입 원금 {amount(account.dailyBudget.referenceCapitalUsd)} USDC 기준 · 일일 수익 {policy?.version==='virtual400-daily/v10'?'참고 KPI':'목표'} {account.dailyBudget.profitTargetMinPct}–{account.dailyBudget.profitCapPct}% ({amount(account.dailyBudget.profitTargetMinUsd)}–{amount(account.dailyBudget.profitCapUsd)} USDC) · 일일 손실 한도 {account.dailyBudget.lossLimitPct}% ({amount(account.dailyBudget.lossLimitUsd)} USDC) · 남은 손실 예산 {amount(account.dailyBudget.remainingLossBudgetUsd)} USDC.
          {' '}목표는 수익 보장이 아니며, 입금은 손익에서 제외합니다. {policy?.version==='virtual400-daily/v10'?'수익 KPI만으로 새 진입을 막지 않습니다. 손실 한도 도달 시 진입을 중지합니다.':'한도 도달 시 진입을 중지합니다.'} 손절 체결 오차로 실제 손실은 한도를 넘을 수 있습니다.
        </p>}
        <VirtualTradingModeControls /><p className="ccc-caption">가상 기록은 AI 학습·검증 후보 자료입니다. 모델 학습 완료나 실자금 적용 승인을 뜻하지 않습니다.</p>
        <div className="ccc-automation-note"><ShieldCheck size={15} /><span>활성 세션은 웹페이지를 닫아도 서버에서 계속 실행됩니다.</span></div>
      </section>
    </div>
    <MarketDecisions runtime={runtime} fresh={fresh} />
    <PatternEntryDiagnostics snapshot={runtime?.patternEntries} fresh={fresh} />
    <PaperEvaluationDiagnostics runtime={runtime} fresh={fresh} />
    <PositionPanel runtime={runtime} fresh={fresh} />
    <VirtualTradeJournal />
    <details className="ccc-session-details"><summary>운용 세부 정보 <ChevronDown size={14} /></summary><div><p>가상 정산 잔액: {amount(account?.ledger.realizedEquityUsd)} USDC · 화면 갱신 10초</p><p>설정: {policy?.version??'미확인'} · 적용 {timestamp(policy?.appliedAt,true)} PHT</p><p>비용과 체결은 SIMULATED / ESTIMATED입니다. 시작·중지·재접속으로 손익 기록이 초기화되지 않습니다.</p><Link href="/system">시스템 진단 보기 →</Link></div></details>
  </div>;
}
