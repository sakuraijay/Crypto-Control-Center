import { VirtualTradeJournal } from '@/components/dashboard/VirtualTradeJournal';
import { Link } from 'wouter';
export default function ActivityPage() {
  return <div className="space-y-6"><div className="ccc-page-heading"><div><p className="ccc-eyebrow">VIRTUAL 400 · ACTIVITY</p><h1>거래 기록</h1><p>수익과 손실, 그 결과를 만든 비용과 판단까지.</p></div><Link href="/history" className="ccc-text-link">Standard 기록 →</Link></div><VirtualTradeJournal /></div>;
}
