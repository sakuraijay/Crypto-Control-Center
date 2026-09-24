import { useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useVirtualPaper400 } from '@/lib/context/VirtualPaper400Context';
import { amount, timestamp } from '@/lib/virtual400Presentation';
import { calendarMonthCells, shiftCalendarMonth } from '@/lib/paperCalendar';

export default function CalendarPage() {
  const { data, fresh, error } = useVirtualPaper400();
  const calendar = fresh && data?.runtime?.calendar?.status === 'AVAILABLE' ? data.runtime.calendar : null;
  const currentMonth = calendar?.throughDate?.slice(0,7) ?? '';
  const firstMonth = calendar?.coverageStart?.slice(0,7) ?? '';
  const [requestedMonth, setMonth] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const month = currentMonth ? (requestedMonth >= firstMonth && requestedMonth <= currentMonth ? requestedMonth : currentMonth) : '';
  const cells = calendarMonthCells(month);
  const byDate = new Map(calendar?.days.map(day => [day.date,day]) ?? []);
  const summary = (calendar?.days ?? []).filter(day => day.date.startsWith(month)).reduce((a,d) => ({net:a.net+d.netPnlUsd,entries:a.entries+d.entries,completed:a.completed+d.completedTrades}),{net:0,entries:0,completed:0});
  const selectedDay = selected ? byDate.get(selected) : undefined;
  const tone = (n: number) => n > 0 ? 'is-profit' : n < 0 ? 'is-loss' : 'is-flat';
  function move(delta: number) { setMonth(shiftCalendarMonth(month,delta)); setSelected(null); }
  return <div className="space-y-6">
    <div className="ccc-page-heading"><div><p className="ccc-eyebrow">PAPER · PNL CALENDAR</p><h1>수익 달력</h1><p>하루의 결과를 한눈에. 비용 차감 실현 손익과 거래 횟수를 확인하세요.</p></div><span className="ccc-paper-tag">필리핀 시간 · PHT</span></div>
    {!calendar ? <section className="ccc-panel"><div className="ccc-empty-row" role="status"><CalendarDays size={24}/><div><strong>수익 달력 확인 대기</strong><p>{error || '서버의 전체 가상 거래 기록을 확인하고 있습니다. 미확인 값을 0으로 표시하지 않습니다.'}</p></div></div></section> : <section className="ccc-panel ccc-calendar" aria-label="월별 가상 수익 달력">
      <header className="ccc-panel-heading"><div><p className="ccc-eyebrow">MONTHLY PERFORMANCE</p><h2 aria-live="polite">{month.slice(0,4)}년 {Number(month.slice(5))}월</h2></div><div className="ccc-calendar-controls"><button className="ccc-icon-button" aria-label="이전 달" disabled={month <= firstMonth} onClick={()=>move(-1)}><ChevronLeft size={18}/></button><button className="ccc-select" disabled={month === currentMonth} onClick={()=>{setMonth(currentMonth);setSelected(null);}}>이번 달</button><button className="ccc-icon-button" aria-label="다음 달" disabled={month >= currentMonth} onClick={()=>move(1)}><ChevronRight size={18}/></button></div></header>
      <div className="ccc-calendar-summary"><div><span>월 실현 순손익</span><strong className={summary.net<0?'ccc-negative':summary.net>0?'ccc-positive':''}>{amount(summary.net,true)} <small>USDC</small></strong></div><div><span>진입 횟수</span><strong>{summary.entries}<small>회</small></strong></div><div><span>청산 완료</span><strong>{summary.completed}<small>건</small></strong></div></div>
      <div className="ccc-calendar-scroll"><table className="ccc-calendar-table"><caption className="sr-only">{month} 일별 비용 차감 순손익, 진입 횟수와 청산 완료 횟수</caption><thead><tr>{['일','월','화','수','목','금','토'].map(d=><th scope="col" key={d}>{d}</th>)}</tr></thead><tbody>{Array.from({length:cells.length/7},(_,week)=><tr key={week}>{cells.slice(week*7,week*7+7).map((date,i)=>{
        if(!date)return <td key={`blank-${i}`} className="ccc-calendar-blank"/>;
        const covered=date >= calendar.coverageStart! && date <= calendar.throughDate!;
        const day=byDate.get(date);const net=day?.netPnlUsd??0;const entries=day?.entries??0;const completed=day?.completedTrades??0;
        return <td key={date}><button disabled={!covered} aria-pressed={selected===date} aria-label={`${date} ${covered?`순손익 ${amount(net,true)} USDC, 진입 ${entries}회, 청산 완료 ${completed}건`:date>calendar.throughDate!?'예정':'기록 시작 전'}`} onClick={()=>setSelected(date)} className={`ccc-calendar-day ${covered?tone(net):'is-unavailable'} ${date===calendar.throughDate?'is-today':''}`}><span className="ccc-calendar-date">{Number(date.slice(8))}{date===calendar.throughDate&&<small>오늘 · 진행 중</small>}</span>{covered?<><strong>{amount(net,true)}<small>USDC</small></strong><span>진입 {entries} · 완료 {completed}</span>{!day&&<small>거래 없음</small>}</>:<><strong>—</strong><small>{date>calendar.throughDate!?'예정':'기록 시작 전'}</small></>}</button></td>;
      })}</tr>)}</tbody></table></div>
      {selected && <div className="ccc-calendar-detail" aria-live="polite"><strong>{selected} 상세</strong><span>총손익 {amount(selectedDay?.grossPnlUsd??0,true)} USDC</span><span>추정 비용 {amount(selectedDay?.costUsd??0)} USDC</span><span>순손익 {amount(selectedDay?.netPnlUsd??0,true)} USDC</span><span>정산 {selectedDay?.settlements??0}건 · 부분청산 포함</span></div>}
      <footer className="ccc-panel-footer"><span>수익 + / 손실 − · 날짜를 선택하면 상세 표시</span><span>{timestamp(calendar.observedAt,true)} PHT 기준</span></footer>
      <p className="ccc-calendar-note">{calendar.coverageStart}부터 현재 가상 세션의 전체 원장을 집계합니다. 진입은 포지션 개설, 완료는 최종 청산 기준입니다. 부분청산 손익은 정산된 날짜에 반영하며, 추가 입금과 미실현 손익은 제외합니다. 체결·비용은 추정치입니다.</p>
    </section>}
  </div>;
}
