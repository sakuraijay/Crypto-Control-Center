/**
 * Internal Monitor — Replit 내부 실행 상태 모니터
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * 보안 아키텍처 원칙 (변경 금지)
 * ──────────────────────────────────────────────────────────────────────────────
 * Replit 실행기는 【모니터링·AI 의사결정·오퍼레이터 승인 게이트·리스크 제어】를 담당합니다.
 * 실제 GMX V2 주문 서명 및 온체인 전송은 GMX One-Click 서브계정 설정 후 수행됩니다 (task #32).
 *
 *   ❌ Replit 실행환경에 절대 저장 금지:
 *      - GMX 메인 지갑 개인키 / 시드 문구
 *      - GMX One-Click/위임 서브계정 signer private key
 *      - 어떠한 형태의 서명 자격증명
 *
 *   ✅ Replit이 담당하는 역할:
 *      - 가격 데이터 수집 (GMX oracle)
 *      - AI 5-State 엔진 의사결정 (60 s 사이클)
 *      - 오퍼레이터 승인 게이트 (LIVE 주문은 오퍼레이터 확인 필수)
 *      - 포지션·PnL·리스크 모니터링
 *      - 비상정지·일시정지·리스크 잠금 제어
 *
 * DEPLOYMENT MODES
 *   - reserved_vm   — Replit Reserved VM (항상 실행); 모니터링 지속
 *   - development   — Replit 개발 컨테이너 (유휴 시 슬립); 테스트 전용
 *
 * 환경 변수 (Replit Secrets — 공개 주소만, 키 절대 금지)
 *   GMX_RPC_URL            — Arbitrum One RPC 엔드포인트 (Alchemy/Infura)
 *   GMX_WALLET_ADDRESS     — 메인 지갑 주소 (공개, 정보 제공 전용)
 *   GMX_SUBACCOUNT_ADDRESS — 위임 One-Click 서브계정 주소 (공개, 정보 제공 전용)
 */

import { workerManager } from './aiWorker';

/**
 * LIVE_EXECUTION_LOCKED — 코드 수준 LIVE 실행 잠금 상수
 *
 * 이 상수가 true인 한, executeOrder()는 항상 페이퍼 시뮬레이션(dry-run)을 반환합니다.
 * 실제 GMX V2 트랜잭션을 서명하거나 온체인 전송하지 않습니다.
 *
 * ── 향후 LIVE 실행 활성화 경로 (이 상수가 false로 변경될 때만) ────────────────
 *
 * 전제 조건 (모두 충족 필요):
 *   1. Settings에서 서브계정 권한 설정 완료 (maxActions, expiresInDays)
 *   2. GMX SubaccountRouter.addSubaccount() 온체인 트랜잭션 완료:
 *        - params: { subaccountAddress, maxAllowedActions, expiresAt }
 *        - 메인 지갑으로 MetaMask 서명 (브라우저 지갑에서만)
 *        - Arbitrum One 트랜잭션 확인
 *   3. 서브계정 공개 주소를 GMX_SUBACCOUNT_ADDRESS 환경 변수에 저장
 *   4. 별도 보안 검토 완료
 *   5. 이 상수를 false로 변경 + GMX SDK 실행 코드 구현
 *
 * ❌ 절대 금지 (이 상수가 false가 되어도 변경 불가):
 *   - 서명 키, 개인키, 시드문구를 이 파일 또는 환경 변수에 저장
 *   - Replit 환경에서 eth_sendTransaction 직접 호출
 */
export const LIVE_EXECUTION_LOCKED = true as const;

export type DeploymentMode = 'reserved_vm' | 'development';

export interface ExecutorStatus {
  mode: 'internal';
  /** 모니터링 준비 여부 (RPC 연결 + 응답 확인) */
  ready: boolean;
  /** True when GMX_RPC_URL env var is set */
  rpcConfigured: boolean;
  /** True when Arbitrum One RPC responds within 5 s (canonical field) */
  gmxConnected: boolean;
  /** Alias for gmxConnected — kept for backwards compatibility */
  gmxRpcHealthy: boolean;
  /** Arbitrum One chain ID = 42161 */
  networkChainId: 42161;
  /** Reserved VM = 항상 실행; development = 슬립 가능 */
  deploymentMode: DeploymentMode;
  /** 공개 지갑 주소 — 개인키 절대 미반환 */
  walletAddress: string | null;
  subaccountAddress: string | null;
  /** Uptime in seconds (for UI display) */
  uptimeSeconds: number;
  uptimeMs: number;
  startedAt: string;
  lastRpcCheckAt: string | null;
  // ── AI Worker status ───────────────────────────────────────────────────────
  /** true when an AI cycle is actively executing */
  workerRunning: boolean;
  /** ISO timestamp of the last completed AI cycle */
  lastCycleAt: string | null;
  /** Summary of the last AI cycle result */
  lastCycleResult: import('./aiWorker').WorkerCycleResult | null;
  /** Total number of AI cycles completed since startup */
  cycleCount: number;
}

export interface ExecuteOrderParams {
  decisionId: string;
  operatingState: string;
  symbol: string | null;
  executionType: string;
  sizeUsd?: number | null;
  leverage?: number | null;
  tpPrice?: number | null;
  slPrice?: number | null;
  trailingStopPct?: number | null;
  cycleNumber?: number;
}

export interface ExecuteOrderResult {
  ok: boolean;
  executedAt: string;
  txHash?: string | null;
  error?: string;
  code?: string;
  simulated: true;
  note: string;
}

// ── 시작 시각 ──────────────────────────────────────────────────────────────────
const START_TIME = Date.now();
const STARTED_AT = new Date().toISOString();

// ── RPC 헬스 캐시 ─────────────────────────────────────────────────────────────
let gmxRpcHealthy = false;
let lastRpcCheckAt: string | null = null;
const RPC_CHECK_INTERVAL_MS = 60_000;

/** Replit 배포 모드 감지 */
function detectDeploymentMode(): DeploymentMode {
  if (process.env.REPLIT_DEPLOYMENT) return 'reserved_vm';
  return 'development';
}

/** Arbitrum One RPC 헬스 체크 — RPC URL 값은 클라이언트에 미노출 */
async function checkRpcHealth(): Promise<boolean> {
  const rpcUrl = process.env.GMX_RPC_URL;
  if (!rpcUrl?.trim()) return false;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return false;
    const json = await res.json() as { result?: string };
    // Arbitrum One chainId = 0xa4b1 = 42161
    return json.result === '0xa4b1';
  } catch {
    return false;
  }
}

/** 주기적 RPC 헬스 체크 시작 */
export function startRpcHealthMonitor(): void {
  const check = async () => {
    gmxRpcHealthy = await checkRpcHealth();
    lastRpcCheckAt = new Date().toISOString();
  };
  void check(); // 즉시 첫 번째 체크
  setInterval(check, RPC_CHECK_INTERVAL_MS);
}

/** 현재 모니터 상태 반환 — 비밀값 절대 미포함 */
export function getExecutorStatus(): ExecutorStatus {
  const rpcConfigured = Boolean(process.env.GMX_RPC_URL?.trim());
  const uptimeMs = Date.now() - START_TIME;

  const workerStatus = workerManager.getStatus();

  return {
    mode:              'internal',
    ready:             rpcConfigured && gmxRpcHealthy,
    rpcConfigured,
    gmxConnected:      gmxRpcHealthy,
    gmxRpcHealthy,
    networkChainId:    42161 as const,
    deploymentMode:    detectDeploymentMode(),
    walletAddress:     process.env.GMX_WALLET_ADDRESS ?? null,
    subaccountAddress: process.env.GMX_SUBACCOUNT_ADDRESS ?? null,
    uptimeSeconds:     Math.floor(uptimeMs / 1000),
    uptimeMs,
    startedAt:         STARTED_AT,
    lastRpcCheckAt,
    // AI Worker
    workerRunning:    workerStatus.workerRunning,
    lastCycleAt:      workerStatus.lastCycleAt,
    lastCycleResult:  workerStatus.lastCycleResult,
    cycleCount:       workerStatus.cycleCount,
  };
}

/**
 * 실행 처리기 — 현재 페이퍼 시뮬레이션 반환
 *
 * 【중요 보안 원칙】
 * Replit 실행환경에는 GMX 개인키가 없으므로 실제 온체인 트랜잭션을 서명하지 않습니다.
 * 실제 GMX 주문 실행은 GMX One-Click 서브계정 구성 완료 및 LIVE_EXECUTION_LOCKED 해제 후 구현 예정입니다.
 * 이 함수는 페이퍼 트레이딩 시뮬레이션 및 의사결정 로그 기록에 사용됩니다.
 */
export async function executeOrder(params: ExecuteOrderParams): Promise<ExecuteOrderResult> {
  const ts = new Date().toISOString();

  // ── LIVE 실행 잠금 어설션 ──────────────────────────────────────────────────────
  // LIVE_EXECUTION_LOCKED = true인 동안 이 함수는 항상 dry-run을 반환합니다.
  // 이 어설션은 코드 수준에서 실제 GMX 트랜잭션 호출을 방어합니다.
  //
  // 이 if 블록을 제거하거나 false로 변경하려면:
  //   → LIVE_EXECUTION_LOCKED 상수의 향후 활성화 경로 주석을 먼저 확인하세요.
  if (LIVE_EXECUTION_LOCKED) {
    console.info(
      `[Executor] LIVE_EXECUTION_LOCKED=true — dry-run 반환 ` +
      `(decisionId=${params.decisionId} symbol=${params.symbol ?? 'MULTI'})`,
    );
    return {
      ok:          true,
      executedAt:  ts,
      txHash:      null,
      simulated:   true,
      note:        'LIVE_EXECUTION_LOCKED=true — GMX One-Click 서브계정 설정 및 코드 수준 잠금 해제 후 실제 실행 가능.',
    };
  }

  // 페이퍼 시뮬레이션 — GMX 키 미보유, 실제 온체인 전송 불가
  // (이 코드는 LIVE_EXECUTION_LOCKED = false가 된 이후 도달 가능)
  console.info(
    `[Executor] 페이퍼 시뮬레이션 — ` +
    `decisionId=${params.decisionId} type=${params.executionType} symbol=${params.symbol ?? 'MULTI'}`,
  );

  return {
    ok:          true,
    executedAt:  ts,
    txHash:      null,
    simulated:   true,
    note:        'GMX One-Click 서브계정 설정 후 실제 실행 활성화 예정 (task #32).',
  };
}
