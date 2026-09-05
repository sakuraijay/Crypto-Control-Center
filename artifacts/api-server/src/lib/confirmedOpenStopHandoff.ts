import type {
  ConfirmedOpenHandoffInput,
  ConfirmedOpenHandoffResult,
} from './gmxApiStatusReconciler';

export interface HandoffIntent {
  id: string;
  orderType: string;
  symbol: string;
  isLong: boolean;
}

export interface HandoffPosition {
  positionKey?: string;
  marketAddress: string;
  collateralToken?: string;
  isLong: boolean;
  sizeUsd: number;
}

export interface HandoffStopPlan {
  status: string;
  triggerPriceUsd: number | null;
  acceptablePriceUsd?: number | null;
  marketAddress?: string;
  symbol?: string;
  isLong?: boolean;
}

export interface HandoffOpenConfirmation {
  parentOpenIntentId: string;
  /** finality 검증을 통과한 source OPEN relay task. 보호 flow에서 이 한 건만 self-exclude한다. */
  sourceOpenTaskId: string;
  evidence: string;
  positionKey: string;
  symbol: string;
  marketAddress: string;
  isLong: boolean;
  confirmedSizeUsd: number;
  /** 결정적 Manual Canary intent에서만 true. 일반 OPEN은 생략한다. */
  manualCanary?: true;
}

export interface HandoffStopInput {
  open: HandoffOpenConfirmation;
  triggerPriceUsd: number;
  acceptablePriceUsd: number;
  now: Date;
}

export type HandoffStopResult =
  | { ok: true; protectionId: string; finalStatus: string }
  | {
      ok: false;
      protectionId: string | null;
      reason: string;
      emergencyCloseRequired: boolean;
      currentStatus?: string;
    };

export interface HandoffEmergencyResult {
  ok: boolean;
  protectionId: string | null;
}

export interface ConfirmedOpenStopHandoffDeps {
  now(): Date;
  finalityDepth: number;
  expectedCollateralToken: string;
  loadIntent(id: string): Promise<HandoffIntent | null>;
  marketAddressForSymbol(symbol: string): string | null;
  fetchPositions(): Promise<HandoffPosition[] | null>;
  loadStopPlan(intentId: string): Promise<{ ok: boolean; plan: HandoffStopPlan | null }>;
  decimalsReady(marketAddress: string): Promise<boolean>;
  executionCostReady(marketAddress: string, isLong: boolean, nowMs: number): boolean;
  actionBudgetReady(nowMs: number): Promise<boolean>;
  signerBindingReady(): Promise<boolean>;
  createInitialStop(input: HandoffStopInput): Promise<HandoffStopResult>;
  recordStopFailure(input: HandoffStopInput, reason: string): Promise<HandoffStopResult>;
  runEmergencyClose(open: HandoffOpenConfirmation, reason: string, now: Date): Promise<HandoffEmergencyResult>;
}

function hasBytes32(v: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(v);
}

function hasAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

async function convergeFailure(
  deps: ConfirmedOpenStopHandoffDeps,
  input: HandoffStopInput,
  reason: string,
): Promise<ConfirmedOpenHandoffResult> {
  const stop = await deps.recordStopFailure(input, reason);
  if (stop.ok) {
    return { handled: true, basis: `INITIAL_STOP ${stop.finalStatus} (${stop.protectionId})` };
  }
  if (stop.currentStatus === 'PREPARED' || stop.currentStatus === 'SUBMITTING') {
    return { handled: false, reason: `INITIAL_STOP ${stop.currentStatus} — claimant 완료 전 OPEN terminal 전환 금지` };
  }
  if (!stop.emergencyCloseRequired && stop.protectionId) {
    // 다른 reconciliation pass가 이미 PREPARED/SUBMITTING/SUBMITTED/ACTIVE를
    // 소유한다. 이 pass는 emergency close를 시작하면 안 된다.
    return { handled: true, basis: `INITIAL_STOP already durable/in-flight (${stop.protectionId})` };
  }
  const emergency = await deps.runEmergencyClose(
    input.open,
    `INITIAL_STOP handoff 실패 — ${reason}`,
    input.now,
  );
  return stop.protectionId !== null || emergency.protectionId !== null
    ? { handled: true, basis: `INITIAL_STOP UNRESOLVED + EMERGENCY_CLOSE convergence (${reason})` }
    : { handled: false, reason: 'stop/emergency durable 저장 모두 실패 — OPEN terminal 전환 금지' };
}

/**
 * finalized OPEN을 initial Stop으로 넘기는 순수 orchestration.
 * 모든 I/O는 deps로 주입되며, 어떤 prerequisite도 "성공 가정"하지 않는다.
 */
export async function runConfirmedOpenStopHandoff(
  evidence: ConfirmedOpenHandoffInput,
  deps: ConfirmedOpenStopHandoffDeps,
): Promise<ConfirmedOpenHandoffResult> {
  if (evidence.confirmations < deps.finalityDepth
      || !hasBytes32(evidence.orderKey)
      || !hasBytes32(evidence.executionTxHash)
      || !hasAddress(evidence.emitterAddress)) {
    return { handled: false, reason: 'finalized allowed-emitter OrderExecuted 증거 불충분' };
  }

  const intent = await deps.loadIntent(evidence.intentId);
  if (!intent || intent.orderType !== 'open' || intent.id !== evidence.intentId) {
    return { handled: false, reason: 'OPEN intent 권위 행 조회/결속 실패' };
  }
  const marketAddress = deps.marketAddressForSymbol(intent.symbol);
  if (!marketAddress) return { handled: false, reason: 'intent symbol의 SDK market 결속 실패' };

  const positions = await deps.fetchPositions();
  if (positions === null) return { handled: false, reason: 'authoritative position readback 실패' };
  const matches = positions.filter((p) =>
    p.marketAddress.toLowerCase() === marketAddress.toLowerCase()
    && p.isLong === intent.isLong,
  );
  if (matches.length !== 1) {
    return { handled: false, reason: `authoritative exact position match ${matches.length}건 — handoff 보류` };
  }
  const pos = matches[0];
  if (!pos.positionKey || !hasBytes32(pos.positionKey)
      || !Number.isFinite(pos.sizeUsd) || pos.sizeUsd <= 0) {
    return { handled: false, reason: 'authoritative position key/size 불충분' };
  }
  if (!pos.collateralToken
      || pos.collateralToken.toLowerCase() !== deps.expectedCollateralToken.toLowerCase()) {
    return { handled: false, reason: 'authoritative position collateral token 불일치' };
  }

  const manualCanary = evidence.intentId.startsWith('intent:open:manual-canary:');
  const open: HandoffOpenConfirmation = {
    parentOpenIntentId: evidence.intentId,
    sourceOpenTaskId: evidence.taskId,
    evidence:
      `OrderExecuted tx=${evidence.executionTxHash} orderKey=${evidence.orderKey} ` +
      `emitter=${evidence.emitterAddress} block=${evidence.resolutionBlock} confirmations=${evidence.confirmations}`,
    positionKey: pos.positionKey,
    symbol: intent.symbol,
    marketAddress: pos.marketAddress,
    isLong: pos.isLong,
    confirmedSizeUsd: pos.sizeUsd,
    ...(manualCanary ? { manualCanary: true as const } : {}),
  };

  const loadedPlan = await deps.loadStopPlan(evidence.intentId);
  const planned = loadedPlan.plan;
  if (!loadedPlan.ok || !planned || planned.status !== 'PENDING'
      || planned.marketAddress?.toLowerCase() !== pos.marketAddress.toLowerCase()
      || planned.isLong !== pos.isLong
      || planned.symbol !== intent.symbol
      || !Number.isFinite(planned.triggerPriceUsd) || Number(planned.triggerPriceUsd) <= 0
      || !Number.isFinite(planned.acceptablePriceUsd) || Number(planned.acceptablePriceUsd) <= 0) {
    const reason = 'pre-OPEN durable stop plan 누락/불일치';
    const emergency = await deps.runEmergencyClose(open, `INITIAL_STOP handoff 실패 — ${reason}`, deps.now());
    return emergency.protectionId !== null
      ? { handled: true, basis: `INITIAL_STOP plan invalid + EMERGENCY_CLOSE convergence (${reason})` }
      : { handled: false, reason: `${reason}; emergency durable 저장 실패 — OPEN terminal 전환 금지` };
  }

  const now = deps.now();
  const input: HandoffStopInput = {
    open,
    triggerPriceUsd: Number(planned.triggerPriceUsd),
    acceptablePriceUsd: Number(planned.acceptablePriceUsd),
    now,
  };

  if (!(await deps.decimalsReady(pos.marketAddress))) {
    return convergeFailure(deps, input, 'SDK+온체인 decimals 재검증 실패');
  }
  if (!deps.executionCostReady(pos.marketAddress, pos.isLong, now.getTime())) {
    return convergeFailure(deps, input, '30초 execution cost evidence 누락/결속 실패');
  }
  if (!(await deps.actionBudgetReady(now.getTime()))) {
    return convergeFailure(deps, input, 'Owner Approval canonical/action budget 불충분');
  }
  if (!(await deps.signerBindingReady())) {
    return convergeFailure(deps, input, 'Owner Approval stored signer binding 실패');
  }

  const result = await deps.createInitialStop(input);
  if (result.ok) {
    return { handled: true, basis: `INITIAL_STOP ${result.finalStatus ?? 'SUBMITTED'} (${result.protectionId})` };
  }
  if (!result.emergencyCloseRequired && result.protectionId) {
    if (result.currentStatus === 'PREPARED' || result.currentStatus === 'SUBMITTING') {
      return { handled: false, reason: `INITIAL_STOP ${result.currentStatus} — claimant 완료 대기` };
    }
    return { handled: true, basis: `INITIAL_STOP already durable (${result.protectionId})` };
  }
  const emergency = await deps.runEmergencyClose(
    open,
    `INITIAL_STOP 실패/불명 — ${result.reason}`,
    now,
  );
  return result.protectionId || emergency.protectionId
    ? { handled: true, basis: `INITIAL_STOP ${result.protectionId ?? 'persist-failed'} + EMERGENCY_CLOSE convergence` }
    : { handled: false, reason: 'INITIAL_STOP 및 EMERGENCY_CLOSE durable 저장 실패' };
}