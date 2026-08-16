/**
 * subaccountAuthState — 최신 GMX delegated trading 인증 상태 모델 (순수 함수).
 *
 * UI·relay 제출과 무관한 상태 판정만 담당한다. 온체인 데이터는 gmxDataStore
 * reader 결과를 입력으로 받으며, 조회 미수행/실패 시 절대 AUTHORIZED로
 * 판정하지 않는다 (fail-closed → UNVERIFIED/ERROR).
 */

import type { SubaccountAuthOnchain } from './gmxDataStore';

export const SUBACCOUNT_AUTH_STATES = [
  'NOT_CONFIGURED',            // relay 구성(라우터/DataStore/EventEmitter/chainId) 미완비
  'SIGNER_DISABLED',           // delegated signer 미초기화 (또는 키 미설정)
  'SIGNER_READY',              // signer 초기화됨 but DELEGATED_SIGNER_ENABLED=false (실행 게이트 꺼짐)
  'OWNER_SIGNATURE_REQUIRED',  // 온체인 미등록 — main account의 SubaccountApproval 서명 필요
  'AUTHORIZED',                // 온체인 승인 유효 (만료 전, 잔여 count 있음)
  'EXPIRED',                   // expiresAt 경과
  'ACTION_LIMIT_REACHED',      // maxAllowedCount 소진
  'REVOKED',                   // 등록돼 있으나 승인값이 해지 상태(expiresAt=0, maxAllowedCount=0)
  'UNVERIFIED',                // 온체인 조회 미수행 — 인증 상태 불명 (LIVE 차단 유지)
  'ERROR',                     // 온체인 조회 실패 — LIVE 차단 유지
] as const;

export type SubaccountAuthState = (typeof SUBACCOUNT_AUTH_STATES)[number];

export interface SubaccountAuthDeriveInput {
  relayConfigured: boolean;
  signerInitialized: boolean;
  delegatedSignerEnabled: boolean;
  /** null = 온체인 조회 미수행(UNVERIFIED) */
  onchain: SubaccountAuthOnchain | null;
  /** 온체인 조회를 시도했으나 실패한 경우의 사유 (fail-closed → ERROR) */
  onchainError?: string | null;
  nowSec: bigint;
}

/** LIVE 실행이 허용될 수 있는 유일한 상태 (그 외 전부 차단 사유) */
export function isAuthStateLiveEligible(state: SubaccountAuthState): boolean {
  return state === 'AUTHORIZED';
}

export function deriveSubaccountAuthState(input: SubaccountAuthDeriveInput): SubaccountAuthState {
  if (!input.relayConfigured) return 'NOT_CONFIGURED';
  if (!input.signerInitialized) return 'SIGNER_DISABLED';
  if (!input.delegatedSignerEnabled) return 'SIGNER_READY';
  if (input.onchainError) return 'ERROR';
  if (input.onchain === null) return 'UNVERIFIED';

  const oc = input.onchain;
  if (!oc.isSubaccountListed) return 'OWNER_SIGNATURE_REQUIRED';
  if (oc.expiresAt === 0n && oc.maxAllowedCount === 0n) return 'REVOKED';
  if (oc.expiresAt <= input.nowSec) return 'EXPIRED';
  if (oc.remaining <= 0n) return 'ACTION_LIMIT_REACHED';
  return 'AUTHORIZED';
}
