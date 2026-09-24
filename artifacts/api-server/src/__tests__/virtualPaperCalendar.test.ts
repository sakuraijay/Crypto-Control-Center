import {describe,it,expect} from 'vitest';
import type {DbTrade} from '@workspace/db';
import {buildVirtualPaperCalendar} from '../workers/virtualPaperCalendar';
import {buildVirtualPaper400Session} from '../workers/virtualPaper400Ledger';
const session=buildVirtualPaper400Session('calendar',new Date('2026-09-01T00:00:00Z'));
const now=new Date('2026-10-01T00:00:00Z');
const row=(id:string,at:string,action:string,extra={})=>({id,timestamp:new Date(at),action,strategy:session.strategyTag,settlementStatus:'PAPER_ESTIMATED',costSource:'PAPER_GMX_ESTIMATE',closeKind:'FULL',pnl:'12',netPnlEstimatedUsd:'10',...extra}) as DbTrade;
describe('whole-session PHT calendar',()=>{
 it('places opens and partial/full settlements on their own PHT dates without counting partial closes as completed trades',()=>{
  const r=buildVirtualPaperCalendar(session,[row('o','2026-09-29T15:59:59Z','OPEN'),row('p','2026-09-29T16:00:00Z','CLOSE',{closeKind:'REDUCE70'}),row('c','2026-09-30T16:00:00Z','CLOSE',{pnl:'-3',netPnlEstimatedUsd:'-5'}),row('foreign','2026-09-30T16:00:00Z','CLOSE',{strategy:'standard'})],now);
  expect(r.status).toBe('AVAILABLE');
  expect(r.days).toEqual([
   {date:'2026-09-29',netPnlUsd:0,grossPnlUsd:0,costUsd:0,entries:1,completedTrades:0,settlements:0},
   {date:'2026-09-30',netPnlUsd:10,grossPnlUsd:12,costUsd:2,entries:0,completedTrades:0,settlements:1},
   {date:'2026-10-01',netPnlUsd:-5,grossPnlUsd:-3,costUsd:2,entries:0,completedTrades:1,settlements:1}]);
 });
 it('includes all settlements beyond the recent ten journal rows and retains losses',()=>{
  const rows=Array.from({length:40},(_,i)=>row(String(i),'2026-09-20T05:00:00Z','CLOSE',{pnl:i%2?'1':'-1',netPnlEstimatedUsd:i%2?'0.5':'-1.5'}));
  const r=buildVirtualPaperCalendar(session,rows,now);
  expect(r.days[0]).toMatchObject({settlements:40,completedTrades:40,netPnlUsd:-20,grossPnlUsd:0,costUsd:20});
 });
 it('distinguishes empty coverage from malformed evidence without mutating rows',()=>{
  expect(buildVirtualPaperCalendar(session,[],now)).toMatchObject({status:'AVAILABLE',coverageStart:'2026-09-01',days:[]});
  const a=row('a','2026-09-20T05:00:00Z','CLOSE');const before=JSON.stringify(a);
  expect(buildVirtualPaperCalendar(session,[a,a],now).status).toBe('UNAVAILABLE');
  expect(buildVirtualPaperCalendar(session,[{...a,netPnlEstimatedUsd:'NaN'}],now).status).toBe('UNAVAILABLE');
  expect(buildVirtualPaperCalendar(session,[{...a,timestamp:new Date('2027-01-01')}],now).status).toBe('UNAVAILABLE');
  expect(JSON.stringify(a)).toBe(before);
 });
});
