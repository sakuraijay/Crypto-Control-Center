import { VirtualPaper400Card } from '@/components/dashboard/VirtualPaper400Card';
import { LiveApprovalBanner } from '@/components/dashboard/LiveApprovalBanner';
import { LiveApprovalCard } from '@/components/dashboard/LiveApprovalCard';
export default function Dashboard() {
  return <><LiveApprovalBanner /><LiveApprovalCard /><VirtualPaper400Card /></>;
}
