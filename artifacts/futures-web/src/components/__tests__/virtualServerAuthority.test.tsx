// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualPaper400Provider, useVirtualPaper400, virtualSnapshotFresh, virtualSessionLabel, type VirtualPaper400Snapshot } from '@/lib/context/VirtualPaper400Context';
import { VirtualPaper400Card } from '@/components/dashboard/VirtualPaper400Card';
import { AiEngineProvider } from '@/lib/context/AiEngineContext';
const trade = vi.hoisted(() => ({ placeOrder: vi.fn(), clearAllPositions: vi.fn(), updatePositionRisk: vi.fn() }));
vi.mock('@/lib/context/TradingContext', () => ({ useTradingContext: () => ({ ...trade, closedTrades: [] }) }));
vi.mock('@/lib/context/StrategyContext', () => ({ useStrategyContext: () => ({ limits: {} }) }));
vi.mock('@/lib/context/WatchlistContext', () => ({ useWatchlistContext: () => ({ watchlist: [], streamStatus: 'offline' }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
const at = '2026-09-20T15:30:00.000Z';
function snapshot(): VirtualPaper400Snapshot {
 return { ok: true, mode: 'VIRTUAL_PAPER_400', realFundsUsed: false, session: { status: 'ACTIVE' }, runtimeFresh: true,
 runtime: { at, status: 'NO_TRADE', reason: 'NO_ELIGIBLE_CLOSED_CANDLE_SIGNAL', policy: { version: 'virtual400-active/v1', appliedAt: at, symbols: ['BTC','ETH','SOL'], riskPerTradePct: .5, maxLeverage: 2, cooldownMinutes: 15 },
 account: { equityUsd: 397, unrealizedNetPnlUsd: 0, ledger: { realizedEquityUsd: 397, realizedNetPnlUsd: -3, settlementCount: 2 }, held: [] } } };
}
function Badge() { const { status } = useVirtualPaper400(); return <div data-testid="badge">{status}</div>; }
function mount() { return render(<VirtualPaper400Provider><Badge /><VirtualPaper400Card /></VirtualPaper400Provider>); }
async function flush() { await act(async () => { await Promise.resolve(); }); }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(at)); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('server authority after retiring the browser trading engine', () => {
 it('persists a user-selected swing mode with auth and restores it on remount without START or trading writes', async()=>{
  const data=snapshot(); data.tradingModeSelection={version:'virtual-trading-mode/v1',mode:'INTRADAY',sessionId:'ui',updatedAt:at};
  data.tradingModeOptions={INTRADAY:{label:'단타',minTargetRoePct:5,maxTargetRoePct:10,targetRoePct:7.5,stopRoePct:3,maxHoldHours:12},SWING:{label:'중기 스윙',minTargetRoePct:10,maxTargetRoePct:20,targetRoePct:15,stopRoePct:5,maxHoldHours:72}};
  const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{if(init?.method==='PUT'){data.tradingModeSelection!.mode='SWING';return {ok:true,json:async()=>({ok:true})};}return {ok:true,json:async()=>data};});
  vi.stubGlobal('fetch',fetcher); const view=mount();await flush();
  fireEvent.click(screen.getByRole('button',{name:'매매 방식 선택'}));
  fireEvent.click(screen.getByRole('radio',{name:/중기 스윙/}));
  expect(fetcher.mock.calls.filter(([,i])=>i?.method)).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('서버 운영자 PIN'),{target:{value:'test-only-pin'}});
  fireEvent.click(screen.getByRole('button',{name:'다음 진입에 적용'}));await flush();
  const writes=fetcher.mock.calls.filter(([,i])=>i?.method);
  expect(writes).toHaveLength(1);expect(String(writes[0][0])).toContain('virtual-paper-400-trading-mode');
  expect(JSON.parse(String(writes[0][1]?.body))).toEqual({mode:'SWING',expectedUpdatedAt:at});
  view.unmount();mount();await flush();expect(screen.getByLabelText('가상 매매 방식').textContent).toContain('중기 스윙');
  expect(fetcher.mock.calls.filter(([,i])=>i?.method)).toHaveLength(1);
 });
 it('separates the unverified account goal from strategy price exits without browser trading writes', async () => {
  const data = snapshot(); data.tradingModeSelection = { version:'virtual-trading-mode/v1',mode:'INTRADAY',sessionId:'ui',updatedAt:at };
  const spec = { minTargetRoePct:5,maxTargetRoePct:10,targetRoePct:null,stopRoePct:10,exitBasis:'STRATEGY_PRICE_TARGET' };
  data.tradingModeOptions = { INTRADAY:{...spec,label:'단타',maxHoldHours:12},SWING:{...spec,label:'중기 스윙',maxHoldHours:72} };
  const fetcher = vi.fn(async () => ({ ok:true,json:async()=>data })); vi.stubGlobal('fetch',fetcher);
  mount(); await flush();
  expect(screen.getByLabelText('가상 매매 방식').textContent).toContain('전략 가격');
  fireEvent.click(screen.getByRole('button',{name:'매매 방식 선택'}));
  expect(screen.getByRole('dialog').textContent).toContain('미검증');
  expect(screen.getByRole('dialog').textContent).toContain('1.5');
  expect(fetcher.mock.calls.every((call:any)=>!call[1]?.method)).toBe(true);
 });
 it('labels daily experimental policy and actual short holding horizons without profit claims',async()=>{
  const data=snapshot();data.tradingModeSelection={version:'virtual-trading-mode/v1',mode:'INTRADAY',sessionId:'ui',updatedAt:at};
  data.runtime!.policy={...data.runtime!.policy!,version:'virtual400-daily/v3',riskPerTradePct:2,minLeverage:5,maxLeverage:10,cooldownMinutes:60};
  const spec={minTargetRoePct:5,maxTargetRoePct:10,targetRoePct:null,stopRoePct:10,exitBasis:'PAPER_EXPERIMENT_PRICE_TARGET'};
  data.tradingModeOptions={INTRADAY:{...spec,label:'단타',maxHoldHours:.5},SWING:{...spec,label:'스윙',maxHoldHours:4}};
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>data})));mount();await flush();
  expect(screen.getByTestId('virtual-active-policy').textContent).toContain('적극적 PAPER 시험');
  fireEvent.click(screen.getByRole('button',{name:'매매 방식 선택'}));
  expect(screen.getByRole('dialog').textContent).toContain('최대 30분');
  expect(screen.getByRole('dialog').textContent).toContain('최대 4시간');
  expect(screen.getByRole('dialog').textContent).toContain('수익 보장이 아닙니다');
 });
 it('restores the applied 5–10x range after remount without browser writes', async () => {
  const data = snapshot(); data.runtime!.policy = { ...data.runtime!.policy!, version: 'virtual400-active/v2', minLeverage: 5, maxLeverage: 10 };
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => data })); vi.stubGlobal('fetch', fetcher);
  const view = mount(); await flush(); expect(screen.getByTestId('virtual-active-policy').textContent).toContain('5–10x');
  view.unmount(); mount(); await flush();
  expect(screen.getByTestId('virtual-active-policy').textContent).toContain('적극적 가상 매매');
  expect(screen.getByTestId('virtual-active-policy').textContent).toContain('5–10x');
  expect(fetcher.mock.calls.every((call: any) => !call[1]?.method)).toBe(true);
 });
 it('restores server policy, losses and ACTIVE state after closing and reopening with GET only', async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => snapshot() })); vi.stubGlobal('fetch', fetcher);
  let view = mount(); await flush();
  expect(screen.getByTestId('badge').textContent).toContain('조건 대기');
  expect(screen.getByTestId('virtual-active-policy').textContent).toContain('0.5%');
  expect(screen.getByTestId('metric-비용 차감 실현 손익').textContent).toContain('-3.00');
  expect(screen.queryByRole('button', { name: '가상매매 시작' })).toBeNull();
  expect(screen.getByRole('button', { name: '신규 진입 중지' })).toBeTruthy();
  expect(screen.queryByText('Auto-executing')).toBeNull();
  view.unmount(); view = mount(); await flush();
  expect(screen.getByTestId('virtual-active-policy').textContent).toContain('최대 2x');
  expect(screen.getByTestId('metric-비용 차감 실현 손익').textContent).toContain('-3.00');
  expect(fetcher.mock.calls).toHaveLength(2);
  expect(fetcher.mock.calls.every((call: any) => !call[1]?.method)).toBe(true);
 });
 it('shares one poll and clears active display on failure, then recovers saved policy', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => snapshot() }).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true, json: async () => snapshot() });
  vi.stubGlobal('fetch', fetcher); mount(); await flush(); expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(screen.getByTestId('badge').textContent).toBe('서버 상태 미확인');
  expect(screen.queryByTestId('virtual-active-policy')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(screen.getByTestId('badge').textContent).toContain('조건 대기');
  expect(screen.getByTestId('virtual-active-policy')).toBeTruthy();
 });
 it('expires an old heartbeat despite runtimeFresh=true and never displays a stale AUTO state', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => snapshot() })));
  mount(); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(121_000); });
  expect(screen.getByTestId('badge').textContent).toBe('서버 실행 확인 대기');
  expect(screen.getByTestId('metric-가상 평가자산').textContent).toContain('미확인');
 });
 it('keeps STOP distinct from missing, blocked, future and malformed evidence', () => {
  const s = snapshot(); s.session.status = 'STOPPED'; expect(virtualSessionLabel(s, true)).toBe('신규 진입 중지');
  s.session.status = 'MISSING'; expect(virtualSessionLabel(s, false)).toBe('시작 전');
  s.session.status = 'ACTIVE'; s.runtime!.status = 'BLOCKED'; expect(virtualSessionLabel(s, true)).toContain('진입 차단');
  expect(virtualSnapshotFresh(s, Date.parse(at)-1)).toBe(false);
  s.runtime!.at = 'bad'; expect(virtualSnapshotFresh(s)).toBe(false);
 });
 it('never starts a session on load and retains explicit PIN-authenticated STOP', async () => {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => ({ ok: true, json: async () => init?.method === 'PUT' ? { ok: true } : snapshot() }));
  vi.stubGlobal('fetch', fetcher); mount(); await flush();
  fireEvent.click(screen.getByRole('button', { name: '신규 진입 중지' }));
  expect(fetcher.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('서버 운영자 PIN'), { target: { value: 'test-only-pin' } });
  fireEvent.click(screen.getByRole('button', { name: '중지 적용' })); await flush();
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT');
  expect(writes).toHaveLength(1); expect(writes[0][1]?.body).toBe(JSON.stringify({ action: 'STOP' }));
  expect(writes[0][1]?.headers).toEqual({ 'content-type': 'application/json', 'x-operator-pin': 'test-only-pin' });
 });
 it('does not calculate decisions, create approvals, place or close trades while the browser stays open', async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ decisions: [], approvals: [] }) }));
  vi.stubGlobal('fetch', fetcher);
  render(<AiEngineProvider><div>history UI</div></AiEngineProvider>); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
  expect(trade.placeOrder).not.toHaveBeenCalled(); expect(trade.clearAllPositions).not.toHaveBeenCalled(); expect(trade.updatePositionRisk).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.every((call: any) => !call[1]?.method)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
 });
});

it('shows immutable initial capital above current equity, and separates a contribution from profit', async () => {
 const data=snapshot();data.runtime!.account.equityUsd=497;
 Object.assign(data.runtime!.account.ledger,{initialEquityUsd:400,netContributionsUsd:100,fundedCapitalUsd:500,realizedEquityUsd:497});
 data.runtime!.policy={...data.runtime!.policy!,version:'virtual400-daily/v4',cooldownMinutes:45,maxDailyEntries:32};
 const fetcher=vi.fn(async()=>({ok:true,json:async()=>data}));vi.stubGlobal('fetch',fetcher);
 const view=mount();await flush();
 const initial=screen.getByTestId('metric-initial-capital');const current=screen.getByTestId('metric-가상 평가자산');
 expect(initial.textContent).toBe('400.00');expect(current.textContent).toContain('497.00');
 expect(initial.compareDocumentPosition(current)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(screen.getByText(/추가 입금.*100.00/).textContent).toContain('손익과 별도');
 expect(screen.getByTestId('metric-비용 차감 실현 손익').textContent).toContain('-3.00');
 expect(screen.getByTestId('virtual-active-policy').textContent).toContain('45분');
 expect(screen.getByText(/하루 최대 32회/)).toBeTruthy();
 view.unmount();mount();await flush();expect(screen.getByTestId('metric-initial-capital').textContent).toBe('400.00');
 expect(fetcher.mock.calls.every((c:any)=>!c[1]?.method)).toBe(true);
});

it('shows server-funded daily goals independently of current equity without funding or order writes', async () => {
 const data=snapshot();data.runtime!.account.equityUsd=1019.61;
 data.runtime!.account.dailyBudget={version:'funded-principal/v1',basis:'FUNDED_PRINCIPAL',referenceCapitalUsd:1000,
  profitTargetMinPct:5,profitCapPct:20,lossLimitPct:10,profitTargetMinUsd:50,profitCapUsd:200,lossLimitUsd:100,remainingLossBudgetUsd:43.08};
 const fetcher=vi.fn(async()=>({ok:true,json:async()=>data}));vi.stubGlobal('fetch',fetcher);
 mount();await flush();
 const text=screen.getByTestId('virtual-daily-budget').textContent;
 expect(text).toContain('투입 원금 1,000.00');expect(text).toContain('50.00–200.00');
 expect(text).toContain('10% (100.00');expect(text).toContain('43.08');
 expect(fetcher.mock.calls.every((c:any)=>!c[1]?.method)).toBe(true);
 expect(trade.placeOrder).not.toHaveBeenCalled();
});

it('renders measured v7/v8 entry diagnostics, missing evidence, next evaluation, and a non-executing idle alert', async () => {
 const data=snapshot();
 data.runtime!.policy={...data.runtime!.policy!,version:'virtual400-daily/v8',minLeverage:5,maxLeverage:10};
 data.runtime!.tradingDiagnostics={
  status:'OBSERVED',minutesWithoutNewEntry:4424,
  adaptiveEvaluations:{
   status:'OBSERVED',windowBasis:'UP_TO_24_UTC_HOURLY_BUCKETS',candidates:4,eligible:1,rejected:3,
   signal:{candidates:4,eligible:1,rejected:3,reasons:[{reason:'WEAK_MOMENTUM',count:2}]},
   safety:{candidates:4,eligible:4,rejected:0,reasons:[]},
   legacy:{candidates:4,eligible:0,rejected:4,reasons:[{reason:'WEAK_MOMENTUM',count:4}]},
    byPolicy:[
     {version:'virtual400-daily/v7',candidates:4,eligible:0,rejected:4},
     {version:'virtual400-daily/v8',candidates:4,eligible:1,rejected:3},
    ],
   rejectionReasons:[{reason:'NO_OBSERVED_STRUCTURE_TARGET',count:2}],
   conditions:[
    {name:'netRewardRisk',observed:3,missing:1,passed:1,failed:2,mean:.93,minimum:.71,maximum:1.1,meanThreshold:1.5},
    {name:'roundTripCostUsd',observed:0,missing:4,passed:0,failed:0,mean:null,minimum:null,maximum:null,meanThreshold:2},
   ],
   nextEvaluationAt:'2026-09-20T15:31:00.000Z',
  },
 };
 data.runtime!.comparison={version:'paper-paired-comparison/v1',status:'CAP_REACHED',candidates:2000,completedPairs:2000,
  baseline:{trades:2000,netPnlUsd:-2789.64,costUsd:2677.45},filtered:{trades:0,netPnlUsd:null,costUsd:0}};
  data.runtime!.continuousComparison={version:'paper-paired-comparison/v2',status:'COLLECTING',pages:1,candidates:17,
   accepted:{legacyV7:5,adaptiveV8:9},costEvidenceAvailable:{legacyV7:8,adaptiveV8:12},
   costEvidenceUnavailable:{legacyV7:9,adaptiveV8:5},pendingTimeWindow:12,outcomeUnknown:5,
   maxPotentialMaturityAt:'2026-09-20T16:15:00.000Z',
    outcomes:{status:'NOT_EVALUATED_NO_CLOSED_CANDLE_REPLAY',matured:0,pendingTimeWindow:12,
     outcomeUnknown:22,opportunityArms:34,netPnlUsd:null,expectancyUsd:null,winRate:null},
   automaticPromotion:false,outOfSampleStrategyValidated:false};
  data.runtime!.entryEvaluations=[{
   id:`BTC:${Date.parse(at)-15*60_000}`,symbol:'BTC',policyVersion:'virtual400-daily/v8',
   closedAt:Date.parse(at)-15*60_000,evaluatedAt:Date.parse(at),eligible:false,
   reason:'NO_OBSERVED_STRUCTURE_TARGET',kind:'SIGNAL',
   conditions:[{name:'netRewardRisk',value:.92,operator:'>=',threshold:1.5,passed:false},
    {name:'roundTripCostUsd',value:null,operator:'<=',threshold:2,passed:null}],
  }];
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>data})));mount();await flush();
  expect(screen.getByTestId('badge').textContent).toContain('24시간 이상 신규 진입 없음');
 expect(screen.getByTestId('paper-idle-alert').textContent).toContain('24시간 이상');
 expect(screen.getByTestId('paper-idle-alert').textContent).toContain('주문을 강제하지 않습니다');
 expect(screen.getByTestId('paper-evaluation-denominator').textContent).toBe('4');
 expect(screen.getByTestId('paper-safety-vs-signal').textContent).toContain('안전 제한은 신호 점수와 분리');
 expect(screen.getByTestId('paper-entry-diagnostics').textContent).toContain('임계값 평균');
  expect(screen.getByTestId('paper-rejection-samples').textContent).toContain('실측 0.92');
  expect(screen.getByTestId('paper-rejection-samples').textContent).toContain('>= 임계값 1.5');
  expect(screen.getByTestId('paper-rejection-samples').textContent).toContain('실측 미확인');
 expect(screen.getByTestId('paper-entry-diagnostics').textContent).toContain('0.93');
 expect(screen.getByTestId('paper-entry-diagnostics').textContent).toContain('미확인');
 expect(screen.getByTestId('paper-entry-diagnostics').textContent).toContain('다음 평가 예정 시각');
 expect(screen.getByTestId('paper-entry-diagnostics').textContent).toContain('2000 쌍 관측');
  expect(screen.getByTestId('paper-entry-diagnostics').textContent).toContain('진행 중 시간창 12');
  expect(screen.getByTestId('paper-entry-diagnostics').textContent).toContain('순손익·기대값·승률은 제공하지 않습니다');
 expect(trade.placeOrder).not.toHaveBeenCalled();
});

it('does not turn unavailable diagnostic evidence into a zero-valued normal state', async () => {
 const data=snapshot();
 data.runtime!.tradingDiagnostics={status:'UNAVAILABLE',reason:'DIAGNOSTICS_STATE_INVALID',historyReconstructed:false};
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>data})));mount();await flush();
 expect(screen.getByTestId('paper-entry-diagnostics').textContent).toContain('자료를 확인할 수 없습니다');
 expect(screen.getByTestId('paper-entry-diagnostics').textContent).toContain('DIAGNOSTICS_STATE_INVALID');
 expect(screen.queryByTestId('paper-idle-alert')).toBeNull();
 expect(trade.placeOrder).not.toHaveBeenCalled();
});
