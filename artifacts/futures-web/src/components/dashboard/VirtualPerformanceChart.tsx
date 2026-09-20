import { useId, useState } from 'react';
import { ChartNoAxesCombined, CircleDashed } from 'lucide-react';
import { amount, settlementSeries, type VirtualRuntime } from '@/lib/virtual400Presentation';

export function VirtualPerformanceChart({ runtime, fresh }: { runtime: VirtualRuntime | null; fresh: boolean }) {
  const [metric, setMetric] = useState<'balance' | 'net'>('balance');
  const [selected, setSelected] = useState<number | null>(null);
  const gradient = useId().replaceAll(':', '');
  const series = fresh ? settlementSeries(runtime) : [];
  const points = metric === 'net' ? series.slice(1) : series;
  const values = points.map(point => point[metric]);
  const lower = Math.min(...values), upper = Math.max(...values);
  const padding = Math.max((upper - lower) * .2, 1);
  const min = lower - padding, max = upper + padding;
  const x = (i: number) => 28 + i / Math.max(1, points.length - 1) * 604;
  const y = (value: number) => 28 + (max - value) / (max - min) * 148;
  const line = points.map((point, i) => `${i ? 'L' : 'M'}${x(i)},${y(point[metric])}`).join(' ');
  const focus = selected !== null && points[selected] ? selected : points.length - 1;
  return <section className="ccc-panel ccc-performance" aria-label="가상 계정 성과">
    <div className="ccc-panel-heading"><div><p className="ccc-eyebrow">PERFORMANCE</p><h2>가상 계정 성과</h2></div>
      <div className="ccc-segment" aria-label="차트 표시 기준">
        <button aria-pressed={metric === 'balance'} onClick={() => { setMetric('balance'); setSelected(null); }}>정산 잔액</button>
        <button aria-pressed={metric === 'net'} onClick={() => { setMetric('net'); setSelected(null); }}>거래별 손익</button>
      </div>
    </div>
    {points.length ? <>
      <div className="ccc-chart-readout"><strong>{amount(points[focus]?.[metric], metric === 'net')} <small>USDC</small></strong>
        <span>{points[focus]?.label} · 표시된 정산 구간</span></div>
      <svg viewBox="0 0 680 214" role="img" aria-label={`최근 ${series.length - 1}건 ${metric === 'balance' ? '정산 잔액' : '거래별 순손익'} 차트`} className="ccc-chart">
        <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#8be0b4" stopOpacity=".16" /><stop offset="100%" stopColor="#8be0b4" stopOpacity="0" /></linearGradient></defs>
        {[0,1,2,3].map(i => <g key={i}><line x1="28" y1={28+i*49} x2="632" y2={28+i*49} stroke="currentColor" className="ccc-gridline" /><text x="642" y={32+i*49} className="ccc-axis">{amount(max-(max-min)*i/3, false, 0)}</text></g>)}
        {metric === 'balance' && <path d={`${line} L632,180 L28,180 Z`} fill={`url(#${gradient})`} />}
        <path d={line} fill="none" stroke="#8be0b4" strokeWidth="2.5" strokeLinejoin="round" />
        {points.map((point, i) => <g key={point.id}>
          <circle cx={x(i)} cy={y(point[metric])} r={focus===i ? 5 : 3} fill="#8be0b4" />
          <circle cx={x(i)} cy={y(point[metric])} r="13" fill="transparent" tabIndex={0} role="button"
            aria-label={`${point.label}, ${amount(point[metric])} USDC`} onMouseEnter={() => setSelected(i)} onFocus={() => setSelected(i)} onClick={() => setSelected(i)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(i); } }}><title>{point.label}: {amount(point[metric])} USDC</title></circle>
        </g>)}
        <text x="28" y="207" className="ccc-axis">{metric === 'balance' ? '직전 잔액' : '첫 표시 정산'}</text><text x="632" y="207" textAnchor="end" className="ccc-axis">최근 정산</text>
      </svg>
    </> : <div className="ccc-chart-empty">
      <div className="ccc-chart-grid" aria-hidden="true" />
      <span className="ccc-empty-icon"><ChartNoAxesCombined size={25} /></span>
      <strong>{!fresh ? '서버 데이터를 확인하고 있습니다' : (runtime?.account.ledger.settlementCount ?? 0) > 0 ? '정산 차트 증거를 확인하고 있습니다' : '첫 정산을 기다리고 있어요'}</strong>
      <p>{!fresh ? '최신 상태가 확인되면 성과를 표시합니다.' : '거래가 정산되면 실제 가상 손익으로 차트가 만들어집니다.'}</p>
      <span className="ccc-subtle-tag"><CircleDashed size={12} /> {fresh ? `${runtime?.account.ledger.settlementCount ?? 0}건 정산 완료` : '상태 미확인'}</span>
    </div>}
    <footer className="ccc-panel-footer"><span><i className="ccc-legend" />비용 차감 후 정산 기록</span><span>최근 최대 10건 · 추정 비용 반영</span></footer>
  </section>;
}
