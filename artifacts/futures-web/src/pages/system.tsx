import { ExecutorStatusWidget } from '@/components/dashboard/ExecutorStatusWidget';
import { GmxOnchainCard } from '@/components/dashboard/GmxOnchainCard';
import { BetaRcStatusCard } from '@/components/dashboard/BetaRcStatusCard';
import { RiskPolicyCard } from '@/components/RiskPolicyCard';
import { MarketIntelligenceCard } from '@/components/MarketIntelligenceCard';
import { OpportunityRankingCard } from '@/components/OpportunityRankingCard';
import { ShadowReviewCard } from '@/components/ShadowReviewCard';
import { RiskExecutionStatusCard } from '@/components/RiskExecutionStatusCard';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
export default function SystemPage() {
  return <div className="space-y-6"><div className="ccc-page-heading"><div><p className="ccc-eyebrow">SYSTEM HEALTH</p><h1>시스템 진단</h1><p>연결 상태, 실행 안전장치와 전략 검증 근거를 확인합니다.</p></div></div>
    <Tabs defaultValue="health"><TabsList aria-label="시스템 진단 분류"><TabsTrigger value="health">연결 및 배포</TabsTrigger><TabsTrigger value="risk">실행·위험 정책</TabsTrigger><TabsTrigger value="research">전략 연구</TabsTrigger></TabsList>
      <TabsContent value="health" className="space-y-5 mt-5"><div className="grid xl:grid-cols-2 gap-5"><ExecutorStatusWidget /><GmxOnchainCard /></div><BetaRcStatusCard /></TabsContent>
      <TabsContent value="risk" className="space-y-5 mt-5"><p className="ccc-callout">Standard·실행 경로의 정책 진단입니다. Virtual 400 전용 설정은 오버뷰에서 확인하세요.</p><RiskPolicyCard /><RiskExecutionStatusCard /></TabsContent>
      <TabsContent value="research" className="space-y-5 mt-5"><p className="ccc-callout">SHADOW 연구 결과이며 Virtual 400의 실제 체결이나 수익을 뜻하지 않습니다.</p><MarketIntelligenceCard /><OpportunityRankingCard /><ShadowReviewCard /></TabsContent>
    </Tabs></div>;
}
