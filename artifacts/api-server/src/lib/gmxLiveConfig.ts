/**
 * gmxLiveConfig — 최신 GMX delegated trading(Gelato relay) 실행 경로에 필요한
 * 온체인 구성의 단일 소스.
 *
 * 원칙 (fail-closed):
 *  - 하드코딩 기본값 없음. 모든 주소는 환경변수로 명시 설정해야 한다.
 *  - 하나라도 누락/형식 오류면 LIVE 실행 경로 전체가 차단된다 (relayConfigured=false).
 *  - PAPER 모드는 이 구성을 사용하지 않으므로 무영향.
 *  - 오류 메시지에 env 원문 값을 포함하지 않는다 (필드명·사유만).
 *
 * 감사된 공식 Arbitrum One(42161) 주소의 단일 기준은 gmxDeploymentManifest.ts
 * (6C 단계). 이 모듈은 env 필수·형식 검증 + 차단 목록 거부만 담당하고,
 * manifest 일치 강제는 activation gate/submit transport에서 수행된다.
 */

import { isValidEvmAddress, resolveGmxEventEmitterAddress, ARBITRUM_ONE_CHAIN_ID } from './gmxOrderEvents';
import { GMX_DEPLOYMENT_MANIFEST, getBlockedAddressReason } from './gmxDeploymentManifest';

// 문서화 전용 상수 (기본값으로 자동 사용 금지) — 6C부터 manifest가 단일 기준
export const GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ARBITRUM_OFFICIAL_DOC =
  GMX_DEPLOYMENT_MANIFEST.addresses.subaccountGelatoRelayRouter;
export const GMX_DATA_STORE_ARBITRUM_OFFICIAL_DOC = GMX_DEPLOYMENT_MANIFEST.addresses.dataStore;
/** 신규 배포 router — 차단 목록 소속 (#131: 공식 클라이언트 미전환, 재감사 전 사용 금지) */
export const GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ARBITRUM_NEXT_BLOCKED =
  '0x517602BaC704B72993997820981603f5E4901273';

export { ARBITRUM_ONE_CHAIN_ID };

export interface GmxLiveRelayConfig {
  chainId: number;                       // 항상 42161
  subaccountGelatoRelayRouter: string;   // GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS
  eventEmitter: string;                  // GMX_EVENT_EMITTER_ADDRESS
  dataStore: string;                     // GMX_DATA_STORE_ADDRESS
}

export type GmxLiveRelayConfigResult =
  | { ok: true; config: GmxLiveRelayConfig }
  | { ok: false; reasons: string[] };

function checkAddressEnv(env: NodeJS.ProcessEnv, key: string, reasons: string[]): string | null {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    reasons.push(`${key} 미설정 — 최신 relay 실행 경로 차단 (fail-closed)`);
    return null;
  }
  const trimmed = raw.trim();
  if (!isValidEvmAddress(trimmed)) {
    reasons.push(`${key} 형식 오류 (0x + 40 hex 필요) — 차단 (fail-closed)`);
    return null;
  }
  // 6C — stale/타 체인 차단 목록: 형식이 유효해도 즉시 거부
  const blocked = getBlockedAddressReason(trimmed);
  if (blocked) {
    reasons.push(`${key} 차단 주소 — ${blocked} (fail-closed)`);
    return null;
  }
  return trimmed;
}

/**
 * 최신 delegated trading 실행에 필요한 구성 전체를 검증·해석한다.
 *  - GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS (필수)
 *  - GMX_EVENT_EMITTER_ADDRESS (필수, 타 체인 주소 거부 — gmxOrderEvents 위임)
 *  - GMX_DATA_STORE_ADDRESS (필수)
 *  - GMX_CHAIN_ID 설정 시 반드시 '42161' (그 외 값 거부; 미설정 시 42161 고정)
 * legacy GMX_SUBACCOUNT_ROUTER_ADDRESS는 이 구성에 포함되지 않으며,
 * legacy만 설정된 상태로는 relayConfigured가 절대 true가 되지 않는다.
 */
export function resolveGmxLiveRelayConfig(
  env: NodeJS.ProcessEnv = process.env,
): GmxLiveRelayConfigResult {
  const reasons: string[] = [];

  const chainRaw = env.GMX_CHAIN_ID;
  if (chainRaw !== undefined && chainRaw.trim() !== '' && chainRaw.trim() !== String(ARBITRUM_ONE_CHAIN_ID)) {
    reasons.push(`GMX_CHAIN_ID가 ${ARBITRUM_ONE_CHAIN_ID}(Arbitrum One)이 아님 — 차단 (fail-closed)`);
  }

  const relayRouter = checkAddressEnv(env, 'GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS', reasons);
  const dataStore   = checkAddressEnv(env, 'GMX_DATA_STORE_ADDRESS', reasons);

  const emitter = resolveGmxEventEmitterAddress(env);
  if (!emitter.ok) reasons.push(emitter.reason);

  if (reasons.length > 0 || !relayRouter || !dataStore || !emitter.ok) {
    return { ok: false, reasons };
  }
  return {
    ok: true,
    config: {
      chainId: ARBITRUM_ONE_CHAIN_ID,
      subaccountGelatoRelayRouter: relayRouter,
      eventEmitter: emitter.address,
      dataStore,
    },
  };
}

/** 중앙 실행 게이트용 요약 — 최신 relay 구성 완비 여부 */
export function isGmxLiveRelayConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveGmxLiveRelayConfig(env).ok;
}
