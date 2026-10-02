/**
 * BlockerGroupSection — #142 Manual Canary 차단 그룹 렌더.
 *
 * 원칙:
 *  - 허용된 category(CODE/CONFIGURATION/OPERATOR_MANUAL_ACTION/GITHUB_CI)만 렌더.
 *  - 알 수 없는 category는 generic CODE blocker로 승격 (fail-closed).
 *  - GITHUB_CI unknown 상태는 차단(blocking=true)으로 처리.
 *  - message는 sanitizeBlockerMessage()를 통해서만 표시.
 *  - PIN/RPC URL/지갑 주소/서명/비밀 키 절대 표시 안 함.
 *  - 빈 그룹은 "차단 항목 없음" 안내 표시.
 */
import { AlertTriangle, CheckCircle2, Code2, Settings2, UserCog, GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  ALLOWED_BLOCKER_CATEGORIES,
  BLOCKER_CATEGORY_LABELS,
  groupBlockersByCategory,
  sanitizeBlockerMessage,
  type AllowedBlockerCategory,
  type CanaryBlocker,
} from '@/lib/manualCanary';

const CATEGORY_ICONS: Record<AllowedBlockerCategory, React.ReactNode> = {
  CODE: <Code2 className="w-3.5 h-3.5" />,
  CONFIGURATION: <Settings2 className="w-3.5 h-3.5" />,
  OPERATOR_MANUAL_ACTION: <UserCog className="w-3.5 h-3.5" />,
  GITHUB_CI: <GitBranch className="w-3.5 h-3.5" />,
};

function BlockerRow({ blocker }: { blocker: CanaryBlocker }) {
  const safe = sanitizeBlockerMessage(blocker.message);
  return (
    <div
      className="flex items-start gap-2 text-[11px] py-0.5"
      data-testid={`row-blocker-${blocker.id}`}
    >
      {blocker.blocking ? (
        <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-px" aria-label="차단 중" />
      ) : (
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-px" aria-label="비차단" />
      )}
      <span className="text-muted-foreground min-w-24 shrink-0 font-mono">{blocker.id}</span>
      <span className={cn('break-all', blocker.blocking ? 'text-amber-200' : 'text-foreground/70')}>
        {safe}
      </span>
    </div>
  );
}

function CategoryGroup({
  category,
  blockers,
}: {
  category: AllowedBlockerCategory;
  blockers: CanaryBlocker[];
}) {
  const hasBlocking = blockers.some(b => b.blocking);
  const label = BLOCKER_CATEGORY_LABELS[category];

  return (
    <div
      className={cn(
        'rounded-md border p-2 flex flex-col gap-1',
        hasBlocking
          ? 'border-amber-500/30 bg-amber-500/5'
          : 'border-emerald-500/20 bg-emerald-500/5',
      )}
      data-testid={`group-blocker-${category}`}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium mb-0.5">
        <span
          className={cn(hasBlocking ? 'text-amber-400' : 'text-emerald-400')}
          aria-hidden="true"
        >
          {CATEGORY_ICONS[category]}
        </span>
        <span
          className={cn(hasBlocking ? 'text-amber-300' : 'text-emerald-300')}
          data-testid={`label-blocker-category-${category}`}
        >
          {label}
        </span>
        <span className="text-muted-foreground ml-auto font-mono">
          {blockers.filter(b => b.blocking).length}/{blockers.length} 차단
        </span>
      </div>
      {blockers.map(b => (
        <BlockerRow key={b.id} blocker={b} />
      ))}
    </div>
  );
}

interface BlockerGroupSectionProps {
  /** 서버에서 받은 blockers 배열. null이면 미조회 상태를 표시한다. */
  blockers: CanaryBlocker[] | null;
}

/**
 * BlockerGroupSection — 4개 허용 category를 그룹으로 렌더.
 *
 * - blockers=null: 조회 전 상태 표시
 * - blockers=[]: 차단 항목 없음 표시
 * - blockers=[...]: 허용 category를 표시하고 unknown은 generic CODE blocker로 승격
 */
export function BlockerGroupSection({ blockers }: BlockerGroupSectionProps) {
  if (blockers === null) {
    return (
      <div
        className="text-[11px] text-muted-foreground px-1"
        data-testid="blocker-section-not-loaded"
      >
        차단 항목을 아직 조회하지 않았습니다.
      </div>
    );
  }

  const grouped = groupBlockersByCategory(blockers);

  if (grouped.size === 0) {
    return (
      <div
        className="text-[11px] text-emerald-300 px-1 flex items-center gap-1.5"
        data-testid="blocker-section-empty"
      >
        <CheckCircle2 className="w-3.5 h-3.5" />
        차단 항목 없음 — 모든 Preflight 게이트 통과
      </div>
    );
  }

  // 안정된 순서로 category 렌더 (ALLOWED_BLOCKER_CATEGORIES 순서 준수)
  return (
    <div className="flex flex-col gap-2" data-testid="blocker-section">
      {ALLOWED_BLOCKER_CATEGORIES.filter(cat => grouped.has(cat)).map(cat => (
        <CategoryGroup key={cat} category={cat} blockers={grouped.get(cat)!} />
      ))}
    </div>
  );
}
