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
        {policy ? <div className="ccc-policy" data-testid="virtual-active-policy"><div className="ccc-policy-name"><SlidersHorizontal size={15} /><strong>{['virtual400-daily/v3','virtual400-daily/v4','virtual400-daily/v5','virtual400-daily/v6'].includes(policy.version)?'적극적 PAPER 시험':['virtual400-active/v1','virtual400-active/v2'].includes(policy.version)?'적극적 가상 매매':'저장된 운용 설정'}</strong><span>서버 적용</span></div><dl><div><dt>1회 위험 예산</dt><dd>{policy.riskPerTradePct}%</dd></div><div><dt>레버리지 {policy.minLeverage ? '범위' : '상한'}</dt><dd>{policy.minLeverage ? `${policy.minLeverage}–${policy.maxLeverage}x` : `최대 ${policy.maxLeverage}x`}</dd></div><div><dt>진입 간격</dt><dd>{policy.cooldownMinutes}분</dd></div></dl><p className="ccc-policy-symbols">{policy.symbols.join(' · ')}</p></div>
        : <div className="ccc-callout">적용된 설정을 확인하고 있습니다. 기본값으로 대체하지 않습니다.</div>}
        {policy && ['virtual400-daily/v3','virtual400-daily/v4','virtual400-daily/v5','virtual400-daily/v6'].includes(policy.version) && <p className="ccc-callout">미검증 모멘텀 시험 · 하루 최대 {policy.maxDailyEntries ?? 24}회 · 일손실 10% 제한{policy.dailyProfitCapPct ? ` · 일일 실현 순수익 ${policy.dailyProfitCapPct}% 도달 시 신규 진입 중지 (PHT)` : ''}. 일반 전략 성과와 구분하며 손실도 그대로 기록합니다.</p>}
        {account?.dailyBudget && <p className="ccc-callout" data-testid="virtual-daily-budget">투입 원금 {amount(account.dailyBudget.referenceCapitalUsd)} USDC 기준 · 일일 수익 목표 {account.dailyBudget.profitTargetMinPct}–{account.dailyBudget.profitCapPct}% ({amount(account.dailyBudget.profitTargetMinUsd)}–{amount(account.dailyBudget.profitCapUsd)} USDC) · 일일 손실 한도 {account.dailyBudget.lossLimitPct}% ({amount(account.dailyBudget.lossLimitUsd)} USDC) · 남은 손실 예산 {amount(account.dailyBudget.remainingLossBudgetUsd)} USDC. 목표는 수익 보장이 아니며, 입금은 손익에서 제외합니다. 한도 도달 시 진입을 중지하며 손절 체결 오차로 실제 손실은 한도를 넘을 수 있습니다.</p>}
        <VirtualTradingModeControls /><p className="ccc-caption">가상 기록은 AI 학습·검증 후보 자료입니다. 모델 학습 완료나 실자금 적용 승인을 뜻하지 않습니다.</p>
        <div className="ccc-automation-note"><ShieldCheck size={15} /><span>활성 세션은 웹페이지를 닫아도 서버에서 계속 실행됩니다.</span></div>
      </section>
    </div>
    <MarketDecisions runtime={runtime} fresh={fresh} />
    <PositionPanel runtime={runtime} fresh={fresh} />
    <VirtualTradeJournal />
    <details className="ccc-session-details"><summary>운용 세부 정보 <ChevronDown size={14} /></summary><div><p>가상 정산 잔액: {amount(account?.ledger.realizedEquityUsd)} USDC · 화면 갱신 10초</p><p>설정: {policy?.version??'미확인'} · 적용 {timestamp(policy?.appliedAt,true)} PHT</p><p>비용과 체결은 SIMULATED / ESTIMATED입니다. 시작·중지·재접속으로 손익 기록이 초기화되지 않습니다.</p><Link href="/system">시스템 진단 보기 →</Link></div></details>
  </div>;
}
