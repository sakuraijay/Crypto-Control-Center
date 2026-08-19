/**
 * LIVE TEST Gate — 모든 하드캡 게이트 검증
 *
 * 하드캡 (변경 불가):
 *   maxCapitalUsd    = $15    — 총 테스트 자본 상한
 *   maxLossUsd       = $3     — 누적 실현+미실현 손실 상한
 *   maxPositions     = 1      — 동시 포지션 수 상한
 *   maxLeverage      = 2x     — 최대 레버리지
 *   allowedCollateral = USDC  — USDC 담보만 허용 (ARB 사용 금지)
 *   maxActions       = 10     — 온체인 delegated action 상한 (SubaccountRouter 기반)
 *   validHours       = 24     — 위임 만료 시간
 *   noArbCollateral  = true   — ARB 담보 금지
 *
 * 이 게이트는 매 주문 시도 직전에 호출됩니다.
 * 하나라도 실패하면 fail-closed (주문 차단).
 */

import { USDC_ADDRESS, ARB_ADDRESS } from './gmxContracts';
import type { DelegationStatus } from './gmxSubaccount';

// ── LIVE TEST 하드캡 상수 ──────────────────────────────────────────────────────
export const LIVE_TEST_CAPS = {
  maxCapitalUsd:   15,   // 총 테스트 자본 $15
  maxLossUsd:      3,    // 누적 손실 $3
  maxPositions:    1,    // 동시 포지션 1개
  maxLeverage:     2,    // 최대 2배
  maxActions:      10,   // SubaccountRouter 기준 최대 10회
  validHours:      24,   // 위임 유효 24시간
} as const;

// ── LIVE_TEST_EXECUTION_LOCKED 플래그 ──────────────────────────────────────────
// 기본값: 잠금 (true). LIVE_TEST_EXECUTION_LOCKED=false 로만 해제.
// LIVE_EXECUTION_LOCKED=true as const 는 무제한 LIVE를 영구 차단.
export function isLiveTestExecutionLocked(): boolean {
  return process.env.LIVE_TEST_EXECUTION_LOCKED !== 'false';
}

// ── 중앙 실행 게이트 (writeContract 직전 최종 검증) ────────────────────────────

export interface CentralGateInput {
  /** process.env.WORKER_ENGINE_MODE — 정확히 'LIVE'만 허용 */
  workerEngineMode:        string | undefined;
  /** Manual Canary만 PAPER를 허용하는 좁은 예외. 자동 Worker에는 절대 true로 전달하지 않는다. */
  manualCanary?:           boolean;
  /** 운영자 설정 liveTestMode 플래그 */
  liveTestMode:            boolean;
  /** DELEGATED_SIGNER_ENABLED === 'true' 여부 */
  delegatedSignerEnabled:  boolean;
  /** Emergency Stop 활성 여부 */
  emergencyStop:           boolean;
  /** delegated signer 초기화 완료 여부 */
  signerInitialized:       boolean;
  /** DB 정상 여부 */
  dbOk:                    boolean;
  /** RPC 설정/정상 여부 */
  rpcOk:                   boolean;
  /** 재시작 reconciliation 정상 완료 여부 (UNRESOLVED 주문 없음) */
  reconciled:              boolean;
  /** durable execution intent 중 차단 상태(PREPARED/SUBMITTED/UNRESOLVED) 부재 여부 */
  noBlockingIntents:       boolean;
  /** GMX EventEmitter 주소 설정 유효 여부 (resolveGmxEventEmitterAddress().ok) */
  eventEmitterConfigured:  boolean;
  /**
   * 최신 delegated trading relay 구성 완비 여부 (resolveGmxLiveRelayConfig().ok).
   * legacy GMX_SUBACCOUNT_ROUTER_ADDRESS만 설정된 상태로는 절대 true가 되지 않는다.
   */
  relayConfigured:         boolean;
}

/**
 * 실제 트랜잭션 서명(writeContract) 직전에 반드시 통과해야 하는 중앙 게이트.
 * 모든 조건이 명시적으로 충족되지 않으면 fail-closed (차단).
 * 기본값(미설정 환경)에서는 항상 차단된다:
 *   WORKER_ENGINE_MODE 미설정 → 차단, LIVE_TEST_EXECUTION_LOCKED 미설정 → 잠금,
 *   DELEGATED_SIGNER_ENABLED 미설정 → 차단.
 */
export function checkCentralExecutionGate(input: CentralGateInput): GateResult {
  const checks: Record<string, boolean> = {};

  checks.engineModeLive = input.workerEngineMode === 'LIVE';
  checks.manualCanaryPaper =
    input.manualCanary === true &&
    input.workerEngineMode === 'PAPER' &&
    process.env.AUTO_WORKER_LIVE_ENABLED !== 'true';
  if (!checks.engineModeLive && !checks.manualCanaryPaper) {
    return { allowed: false, reason: '[CENTRAL GATE] WORKER_ENGINE_MODE가 LIVE가 아니며 PAPER Manual Canary 조건도 아님 — 실제 실행 차단', checks };
  }

  checks.liveTestMode = input.liveTestMode === true;
  if (!checks.liveTestMode) {
    return { allowed: false, reason: '[CENTRAL GATE] liveTestMode 비활성 — 실제 실행 차단', checks };
  }

  checks.executionUnlocked = !isLiveTestExecutionLocked();
  if (!checks.executionUnlocked) {
    return { allowed: false, reason: '[CENTRAL GATE] LIVE_TEST_EXECUTION_LOCKED 해제되지 않음 — 실제 실행 차단', checks };
  }

  checks.delegatedSignerEnabled = input.delegatedSignerEnabled === true;
  if (!checks.delegatedSignerEnabled) {
    return { allowed: false, reason: '[CENTRAL GATE] DELEGATED_SIGNER_ENABLED가 true가 아님 — 실제 실행 차단', checks };
  }

  checks.noEmergencyStop = !input.emergencyStop;
  if (!checks.noEmergencyStop) {
    return { allowed: false, reason: '[CENTRAL GATE] Emergency Stop 활성 — 실제 실행 차단', checks };
  }

  checks.signerInitialized = input.signerInitialized === true;
  if (!checks.signerInitialized) {
    return { allowed: false, reason: '[CENTRAL GATE] delegated signer 미초기화 — 실제 실행 차단', checks };
  }

  checks.dbOk = input.dbOk === true;
  if (!checks.dbOk) {
    return { allowed: false, reason: '[CENTRAL GATE] DB 비정상 — 실제 실행 차단 (fail-closed)', checks };
  }

  checks.rpcOk = input.rpcOk === true;
  if (!checks.rpcOk) {
    return { allowed: false, reason: '[CENTRAL GATE] RPC 미설정/비정상 — 실제 실행 차단 (fail-closed)', checks };
  }

  // EventEmitter 설정이 유효하지 않으면 온체인 판정(reconciliation)이 불가능하므로
  // 어떤 LIVE 실행도 허용하지 않는다 (fail-closed).
  checks.eventEmitterConfigured = input.eventEmitterConfigured === true;
  if (!checks.eventEmitterConfigured) {
    return { allowed: false, reason: '[CENTRAL GATE] GMX EventEmitter 주소 설정 없음/형식 오류 — 실제 실행 차단 (fail-closed)', checks };
  }

  // 최신 delegated trading relay 구성(SubaccountGelatoRelayRouter/DataStore/EventEmitter,
  // chainId 42161)이 완비되지 않으면 LIVE 실행 금지. legacy 라우터 설정만으로는 열리지 않는다.
  checks.relayConfigured = input.manualCanary === true || input.relayConfigured === true;
  if (!checks.relayConfigured) {
    return { allowed: false, reason: '[CENTRAL GATE] 최신 GMX relay 구성 미완비 (SubaccountGelatoRelayRouter/DataStore/EventEmitter/chainId) — 실제 실행 차단 (fail-closed)', checks };
  }

  checks.reconciled = input.reconciled === true;
  if (!checks.reconciled) {
    return { allowed: false, reason: '[CENTRAL GATE] 재시작 reconciliation 미완료 또는 상태불명 주문 존재 — 실제 실행 차단', checks };
  }

  // 최종 조건: durable execution intent 중 차단 상태가 하나라도 있으면 실행 금지
  checks.noBlockingIntents = input.noBlockingIntents === true;
  if (!checks.noBlockingIntents) {
    return { allowed: false, reason: '[CENTRAL GATE] 미해소 execution intent 존재 (PREPARED/SUBMITTED/UNRESOLVED) — 실제 실행 차단', checks };
  }

  return { allowed: true, reason: null, checks };
}

// ── 게이트 입력/출력 타입 ──────────────────────────────────────────────────────

export interface GateInput {
  /** 주문 액션 타입 */
  orderType:           'open' | 'close' | 'cancel';
  /** 새 포지션 collateral 토큰 주소 (USDC 여야 함) */
  collateralToken:     string;
  /** 요청 포지션 크기 (USD) */
  sizeUsd:             number;
  /** 담보 금액 (USD) */
  collateralUsd:       number;
  /** 요청 레버리지 */
  leverage:            number;
  /** 온체인에서 조회한 서브계정 위임 상태 */
  delegation:          DelegationStatus;
  /** 현재 서버 지갑 ETH 잔고 (wei) */
  signerEthWei:        bigint;
  /**
   * 주문 제출 경로 (#124-A):
   *  - 'gmx_api_v2'      — 공식 GMX API v2 HTTP 제출. delegated signer는 EIP-712 digest
   *                        로컬 서명만 하고 온체인 broadcast를 하지 않으므로 signer ETH 불필요 (0 ETH).
   *  - 'legacy_broadcast' — 과거 직접 writeContract 경로. signer가 가스를 지불하므로 MIN_ETH 요구 유지.
   * 미지정 시 fail-closed 기본값 'legacy_broadcast' (ETH 요구 유지).
   */
  submitPath?:         'gmx_api_v2' | 'legacy_broadcast';
  /** 현재 열린 포지션 수 (온체인 기준) */
  openPositionCount:   number;
  /** 누적 실현 손실 (USD, DB 기준) */
  accumLossUsd:        number;
  /** DB 쿼리 성공 여부 (false → fail-closed) */
  dbOk:                boolean;
  /** GMX RPC 상태 (false → fail-closed) */
  rpcOk:               boolean;
  /** Worker 재시작 reconciliation 완료 여부 */
  reconciled:          boolean;
  /** 거래 심볼 (ARB는 collatral 제한 추가 검사) */
  symbol?:             string;
}

export interface GateResult {
  allowed:   boolean;
  reason:    string | null;
  /** 각 게이트 개별 결과 (디버깅용) */
  checks:    Record<string, boolean>;
}

// ── 게이트 검증 로직 ──────────────────────────────────────────────────────────

/**
 * 모든 LIVE TEST 하드캡 게이트를 순서대로 검증.
 * 하나라도 실패하면 즉시 fail-closed 반환.
 */
export function checkLiveTestGate(input: GateInput): GateResult {
  const checks: Record<string, boolean> = {};

  // 1. 코드 수준 잠금 확인
  checks.executionLock = !isLiveTestExecutionLocked();
  if (!checks.executionLock) {
    return { allowed: false, reason: '[LIVE TEST] LIVE_TEST_EXECUTION_LOCKED=true — 코드 수준 잠금 해제 필요', checks };
  }

  // 2. DB 쿼리 성공 여부 (fail-closed)
  checks.dbOk = input.dbOk;
  if (!checks.dbOk) {
    return { allowed: false, reason: '[LIVE TEST] DB 쿼리 실패 — 손실 추적 불가, fail-closed', checks };
  }

  // 3. RPC 연결 (fail-closed)
  checks.rpcOk = input.rpcOk;
  if (!checks.rpcOk) {
    return { allowed: false, reason: '[LIVE TEST] GMX RPC 연결 실패 — fail-closed', checks };
  }

  // 4. Worker reconciliation 완료 (재시작 후 중복 체결 방지)
  checks.reconciled = input.reconciled;
  if (!checks.reconciled) {
    return { allowed: false, reason: '[LIVE TEST] 재시작 reconciliation 미완료 — 중복 체결 방지', checks };
  }

  // 5. 온체인 위임 상태 (remainingActions > 0, 만료 아님)
  checks.delegationActive = input.delegation.queryOk && input.delegation.isAuthorized;
  if (!checks.delegationActive) {
    const reason = !input.delegation.queryOk
      ? `[LIVE TEST] 위임 상태 조회 실패 (${input.delegation.queryError ?? 'RPC error'})`
      : input.delegation.isExpired
        ? '[LIVE TEST] 서브계정 위임 만료됨 — MetaMask로 재승인 필요'
        : `[LIVE TEST] 서브계정 위임 없음 또는 허용 횟수 소진 (remaining=${input.delegation.remainingActions})`;
    return { allowed: false, reason, checks };
  }

  // 6. 남은 액션 수 (하드캡 10회)
  checks.actionsRemaining = input.delegation.remainingActions > 0;
  if (!checks.actionsRemaining) {
    return { allowed: false, reason: `[LIVE TEST] 허용 액션 소진 (remaining=${input.delegation.remainingActions}/${LIVE_TEST_CAPS.maxActions})`, checks };
  }

  // 7. 서버 지갑 ETH 잔고 — 제출 경로별 분기 (#124-A)
  //    GMX API v2: signer는 digest 서명만, broadcast는 GMX API relay가 수행 → signer gas 0 ETH.
  //    legacy broadcast: signer가 직접 가스 지불 → 최소 0.003 ETH (execution fee 2회분) 유지.
  if ((input.submitPath ?? 'legacy_broadcast') === 'gmx_api_v2') {
    checks.signerHasGas = true; // 구조적으로 불필요 — GMX API v2 signer gas: 0 ETH
  } else {
    const MIN_ETH = 3_000_000_000_000_000n; // 0.003 ETH
    checks.signerHasGas = input.signerEthWei >= MIN_ETH;
    if (!checks.signerHasGas) {
      return { allowed: false, reason: `[LIVE TEST] (legacy broadcast 경로) 사이너 지갑 ETH 부족 (${input.signerEthWei}wei < ${MIN_ETH}wei) — 0.005 ETH 이상 충전 필요`, checks };
    }
  }

  // 8. 동시 포지션 수 상한 (open 주문에만 적용)
  if (input.orderType === 'open') {
    checks.positionCount = input.openPositionCount < LIVE_TEST_CAPS.maxPositions;
    if (!checks.positionCount) {
      return { allowed: false, reason: `[LIVE TEST] 동시 포지션 ${input.openPositionCount}개 — 최대 ${LIVE_TEST_CAPS.maxPositions}개 초과`, checks };
    }
  } else {
    checks.positionCount = true;
  }

  // 9. 누적 손실 상한 ($3)
  checks.accumLoss = input.accumLossUsd < LIVE_TEST_CAPS.maxLossUsd;
  if (!checks.accumLoss) {
    return { allowed: false, reason: `[LIVE TEST] 누적 손실 $${input.accumLossUsd.toFixed(2)} ≥ $${LIVE_TEST_CAPS.maxLossUsd} 하드캡 초과`, checks };
  }

  // 10. 담보 토큰 (USDC만 허용)
  if (input.orderType === 'open') {
    checks.collateralIsUsdc = input.collateralToken.toLowerCase() === USDC_ADDRESS.toLowerCase();
    if (!checks.collateralIsUsdc) {
      return { allowed: false, reason: `[LIVE TEST] USDC 담보만 허용 — 전달된 담보: ${input.collateralToken}`, checks };
    }

    // 11. ARB 심볼 금지 (ARB 인덱스 토큰 = ARB/USD 마켓 — 레버리지 ARB 금지)
    if (input.symbol) {
      checks.noArbSymbol = input.symbol.toUpperCase() !== 'ARB';
      if (!checks.noArbSymbol) {
        return { allowed: false, reason: '[LIVE TEST] ARB/USD 마켓 거래 금지 (ARB 담보 사용 차단)', checks };
      }
    } else {
      checks.noArbSymbol = true;
    }

    // 12. 레버리지 상한 (2x)
    checks.leverageOk = input.leverage <= LIVE_TEST_CAPS.maxLeverage;
    if (!checks.leverageOk) {
      return { allowed: false, reason: `[LIVE TEST] 레버리지 ${input.leverage}x > ${LIVE_TEST_CAPS.maxLeverage}x 하드캡`, checks };
    }

    // 13. 포지션 크기 상한 ($15)
    checks.sizeOk = input.sizeUsd <= LIVE_TEST_CAPS.maxCapitalUsd;
    if (!checks.sizeOk) {
      return { allowed: false, reason: `[LIVE TEST] 포지션 크기 $${input.sizeUsd} > $${LIVE_TEST_CAPS.maxCapitalUsd} 하드캡`, checks };
    }

    // 14. 담보 상한 ($15)
    checks.collateralOk = input.collateralUsd <= LIVE_TEST_CAPS.maxCapitalUsd;
    if (!checks.collateralOk) {
      return { allowed: false, reason: `[LIVE TEST] 담보 $${input.collateralUsd} > $${LIVE_TEST_CAPS.maxCapitalUsd} 하드캡`, checks };
    }
  } else {
    checks.collateralIsUsdc = true;
    checks.noArbSymbol = true;
    checks.leverageOk = true;
    checks.sizeOk = true;
    checks.collateralOk = true;
  }

  return { allowed: true, reason: null, checks };
}

/** 위임 만료까지 남은 시간 (초). 음수면 이미 만료. */
export function delegationTimeRemainingSeconds(status: DelegationStatus): number {
  if (!status.isAuthorized || status.expiresAtUnix === 0) return 0;
  return status.expiresAtUnix - Math.floor(Date.now() / 1000);
}
