import { useState } from 'react';
import { ArrowUpRight, Download, History, X } from 'lucide-react';
import { useVirtualPaper400 } from '@/lib/context/VirtualPaper400Context';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { amount, finite, settlementCosts, settlementCsv, timestamp, type VirtualSettlement } from '@/lib/virtual400Presentation';

export function VirtualTradeJournal() {
  const { data, fresh } = useVirtualPaper400();
  const [symbol, setSymbol] = useState('ALL');
  const [selected, setSelected] = useState<VirtualSettlement | null>(null);
  const rows = fresh ? data?.runtime?.journal ?? [] : [];
  const symbols = [...new Set(rows.map(row => row.symbol))];
  const filtered = rows.filter(row => symbol === 'ALL' || row.symbol === symbol);
  function download() {
    const url = URL.createObjectURL(new Blob([settlementCsv(filtered)], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a'); link.href = url; link.download = 'ccc-virtual400-settlements.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
  return <section className="ccc-panel" aria-label="가상 거래 기록">
    <div className="ccc-panel-heading"><div><p className="ccc-eyebrow">TRADE JOURNAL</p><h2>최근 거래 기록 <span className="ccc-count">{fresh ? rows.length : '—'}</span></h2></div>
      <div className="flex items-center gap-2"><label className="sr-only" htmlFor="journal-symbol">거래 종목 필터</label>
        <select id="journal-symbol" value={symbol} onChange={event => setSymbol(event.target.value)} className="ccc-select"><option value="ALL">전체 종목</option>{symbols.map(value => <option key={value} value={value}>{value}</option>)}</select>
        <Button variant="ghost" size="sm" disabled={!filtered.length} onClick={download}><Download size={15} /> CSV</Button></div>
    </div>
    <div className="ccc-table-wrap"><table className="ccc-table"><thead><tr><th>종목 / 방향</th><th>정산 시각 <span>PHT</span></th><th>총손익</th><th>추정 비용</th><th>순손익</th><th>청산 사유</th><th><span className="sr-only">거래 상세</span></th></tr></thead>
      <tbody>{filtered.map(row => <tr key={row.id}><td><strong>{row.symbol}</strong> <span className={`ccc-direction ${row.side==='LONG'?'ccc-positive':'ccc-negative'}`}>{row.side}</span></td><td>{timestamp(row.closedAt, true)}</td><td>{amount(row.grossPnlUsd, true)}</td><td>{amount(settlementCosts(row))}</td><td className={finite(row.netPnlUsd)! < 0 ? 'ccc-negative' : finite(row.netPnlUsd)! > 0 ? 'ccc-positive' : ''}><strong>{amount(row.netPnlUsd, true)}</strong></td><td><span className="ccc-muted">{row.closeReason || '미확인'}</span></td><td><button className="ccc-icon-button" aria-label={`${row.symbol} 거래 상세 ${row.id}`} onClick={() => setSelected(row)}><ArrowUpRight size={16} /></button></td></tr>)}</tbody>
    </table></div>
    {!filtered.length && <div className="ccc-empty-row"><History size={22} /><div><strong>{!fresh ? '거래 기록 확인 대기' : rows.length ? '선택한 종목의 기록이 없습니다' : '아직 정산된 거래가 없습니다'}</strong><p>거래가 끝나면 진입 근거, 비용과 순손익을 이곳에서 확인할 수 있습니다.</p></div>{symbol!=='ALL' && <button className="ccc-icon-button" aria-label="필터 초기화" onClick={() => setSymbol('ALL')}><X size={15} /></button>}</div>}
    <footer className="ccc-panel-footer"><span>Virtual 400 전용 · 최근 최대 10건</span><span>SIMULATED / ESTIMATED · USDC</span></footer>
    <Dialog open={!!selected} onOpenChange={open => { if (!open) setSelected(null); }}><DialogContent className="ccc-dialog"><DialogHeader><DialogTitle>{selected?.symbol} {selected?.side} 거래 상세</DialogTitle><DialogDescription>가상 체결 · 비용은 추정치입니다. 모든 시각은 필리핀 시간(PHT)입니다.</DialogDescription></DialogHeader>
      {selected && <><div className="ccc-detail-profit"><span>비용 차감 순손익</span><strong className={(finite(selected.netPnlUsd)??0)<0?'ccc-negative':'ccc-positive'}>{amount(selected.netPnlUsd,true)} <small>USDC</small></strong></div>
        <dl className="ccc-detail-grid">{[['전략',selected.strategy??'미확인'],['사전 위험액',amount(selected.plannedRiskUsd)],['진입 시각',timestamp(selected.openedAt,true)],['청산 시각',timestamp(selected.closedAt,true)],['진입 가격',amount(selected.entryPrice)],['청산 가격',amount(selected.exitPrice)],['손절 가격',amount(selected.stopPrice)],['목표 가격',amount(selected.targetPrice)],['진입 비용',amount(selected.entryCostUsd)],['청산 비용',amount(selected.exitCostUsd)],['보유 비용',amount(selected.holdingCostUsd)],['위험 대비 손익',finite(selected.netR)===null?'미확인':`${amount(selected.netR)} R`]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <div className="ccc-callout"><strong>진입 근거</strong><p>{selected.reasons.join(' · ')||'기록된 근거가 없습니다.'}</p><p className="mt-2">청산: {selected.closeReason} · {selected.closeKind}</p></div></>}
    </DialogContent></Dialog>
  </section>;
}
