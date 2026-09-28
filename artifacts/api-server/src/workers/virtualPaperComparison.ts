import type { PriceLookup } from './serverPaperExecutor';
/** Prospective matched-candidate experiment. No order, balance, or model promotion authority. */
export interface PaperComparisonProposal {
  id:string;symbol:string;side:'LONG'|'SHORT';entry:number;stop:number;target:number;
  notional:number;cost:number;openedAt:number;expiresAt:number;accepted:boolean;
}
interface Outcome {gross:number;net:number;cost:number;reason:string;at:number}
interface Sample extends PaperComparisonProposal {baseline?:Outcome;filtered?:Outcome}
export interface PaperComparisonState {version:1;sessionId:string;startedAt:number;samples:Sample[]}
export function restorePaperComparison(raw:string|null,sessionId:string,now:number):PaperComparisonState {
  if(raw===null)return {version:1,sessionId,startedAt:now,samples:[]};
  const s=JSON.parse(raw) as PaperComparisonState;
  if(s.version!==1||s.sessionId!==sessionId||!Number.isFinite(s.startedAt)||s.startedAt>now||!Array.isArray(s.samples)||s.samples.length>2000
    ||new Set(s.samples.map(p=>p.id)).size!==s.samples.length
    ||s.samples.some(p=>!p.id||!['LONG','SHORT'].includes(p.side)||typeof p.accepted!=='boolean'
      ||![p.entry,p.stop,p.target,p.notional,p.openedAt,p.expiresAt].every(n=>Number.isFinite(n)&&n>0)
      ||!Number.isFinite(p.cost)||p.cost<0||p.openedAt>now||p.expiresAt<=p.openedAt
      ||[p.baseline,p.filtered].some(o=>o&&(![o.gross,o.net,o.cost,o.at].every(Number.isFinite)||o.cost<0||o.at>now||Math.abs(o.gross-o.cost-o.net)>1e-7))))throw Error('PAPER_COMPARISON_INVALID');
  return s;
}
export function addPaperComparison(s:PaperComparisonState,p:PaperComparisonProposal){
  if(s.samples.length>=2000||s.samples.some(x=>x.id===p.id))return;
  s.samples.push({...p});
}
export function advancePaperComparison(s:PaperComparisonState,quote:PriceLookup,now:number){
  for(const p of s.samples){
    if(p.baseline&&(!p.accepted||p.filtered))continue;
    const q=quote(p.symbol);if(!q||!Number.isFinite(q.priceUsd)||q.priceUsd<=0||!Number.isFinite(q.ageMs)||q.ageMs<0||q.ageMs>60_000||now<p.openedAt)continue;
    const direction=p.side==='LONG'?1:-1;
    const gross=p.notional*(q.priceUsd/p.entry-1)*direction;
    const net=gross-p.cost; // full-horizon cost reserve, identical for both arms; conservatively no early-exit refund
    const reason=(q.priceUsd-p.stop)*direction<=0?'STOP':(q.priceUsd-p.target)*direction>=0?'TARGET':now>=p.expiresAt?'TIME':null;
    if(!p.baseline&&reason)p.baseline={gross,net,cost:p.cost,reason,at:now};
    const filteredReason=reason??(now-p.openedAt>=(p.expiresAt-p.openedAt)/2&&net<=0?'NO_PROGRESS':null);
    if(p.accepted&&!p.filtered&&filteredReason)p.filtered={gross,net,cost:p.cost,reason:filteredReason,at:now};
  }
}
export function summarizePaperComparison(s:PaperComparisonState){
  // Only fully matured pairs, so early exits cannot bias the cohort with selectively available labels.
  const complete=s.samples.filter(p=>p.baseline&&(!p.accepted||p.filtered));
  const stats=(arm:'baseline'|'filtered')=>{
    const outcomes=complete.flatMap(p=>p[arm]?[p[arm]!]:[]).sort((a,b)=>a.at-b.at);
    let net=0,peak=0,drawdown=0;
    for(const o of outcomes){net+=o.net;peak=Math.max(peak,net);drawdown=Math.max(drawdown,peak-net);}
    const cost=outcomes.reduce((a,o)=>a+o.cost,0);
    return {trades:outcomes.length,netPnlUsd:net,costUsd:cost,twoXCostNetPnlUsd:net-cost,
      expectancyUsd:outcomes.length?net/outcomes.length:null,winRate:outcomes.length?outcomes.filter(o=>o.net>0).length/outcomes.length:null,
      cumulativeCandidateDrawdownUsd:drawdown};
  };
  return {version:'paper-paired-comparison/v1',status:s.samples.length>=2000?'CAP_REACHED':'COLLECTING',startedAt:new Date(s.startedAt).toISOString(),
    candidates:s.samples.length,completedPairs:complete.length,baseline:stats('baseline'),filtered:stats('filtered'),
    semantics:'MATCHED_OBSERVED_CANDIDATES_NOT_INDEPENDENT_PORTFOLIOS',costBasis:'FULL_HORIZON_ENTRY_ESTIMATE',
    selectionBias:'OBSERVED_WHEN_PRODUCTION_ENTRY_EVALUATES',outOfSampleStrategyValidated:false,automaticPromotion:false};
}
