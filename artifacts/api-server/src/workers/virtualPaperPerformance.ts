import type {DbTrade} from '@workspace/db';
/** Called only after strict full-ledger accounting validation. Partial settlements are grouped by position. */
export function paperPerformance(rows:readonly DbTrade[]){
  const positions=rows.filter(r=>r.action==='OPEN'&&r.closeTime>0).map(open=>{
    const closes=rows.filter(c=>c.action==='CLOSE'&&c.closesTradeId===open.id);
    const total=(key:keyof DbTrade)=>closes.reduce((n,c)=>n+Number(c[key]),0);
    return {symbol:open.symbol,side:open.side,reason:closes.find(c=>c.closeKind==='FULL')?.closeReason??'UNKNOWN',
      gross:total('pnl'),net:total('netPnlEstimatedUsd'),cost:total('estEntryCostUsd')+total('estExitCostUsd')+total('estHoldingCostUsd')};
  });
  const summarize=(p:typeof positions)=>{
    const wins=p.filter(x=>x.net>0),losses=p.filter(x=>x.net<0);
    const sum=(a:typeof p,k:'net'|'gross'|'cost')=>a.reduce((n,r)=>n+r[k],0);
    return {completedPositions:p.length,winRate:p.length?wins.length/p.length:null,
      grossPnlUsd:sum(p,'gross'),netPnlUsd:sum(p,'net'),costUsd:sum(p,'cost'),
      averageWinUsd:wins.length?sum(wins,'net')/wins.length:null,averageLossUsd:losses.length?sum(losses,'net')/losses.length:null,
      netProfitFactor:losses.length?sum(wins,'net')/-sum(losses,'net'):null};
  };
  const by=(key:'symbol'|'side'|'reason')=>Object.fromEntries([...new Set(positions.map(p=>p[key]))].sort().map(k=>[k,summarize(positions.filter(p=>p[key]===k))]));
  return {basis:'FULL_SESSION_COMPLETED_POSITIONS',total:summarize(positions),bySymbol:by('symbol'),bySide:by('side'),byCloseReason:by('reason')};
}
