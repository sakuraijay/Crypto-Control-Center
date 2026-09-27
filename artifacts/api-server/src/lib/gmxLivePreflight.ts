/**
 * gmxLivePreflight — #131: 실제 주문 경로 사전 read-only preflight (fail-closed).
 *
 * 목적:
 *  - 실제(LIVE) 주문 제출 전에 감사된 router 결속을 온체인·구성·SDK pin으로
 *    전수 재확인한다. 하나라도 실패하면 실제 주문 0회 차단.
 *  - 검사 항목 (전부 읽기 전용):
 *      P1 env/manifest 대조 (validateEnvAgainstManifest)
 *      P2 @gmx-io/sdk pin 대조 (verifySdkRouterPin — 불일치=ROUTER_REAUDIT_REQUIRED)
 *      P3 eth_getCode(router) ≠ empty
 *      P4 RoleStore.hasRole(router, CONTROLLER) && hasRole(router, ROUTER_PLUGIN)
 *      P5 router.subaccountApprovalNonces(mainAccount) 호출 성공 (nonce 원장 응답)
 *  - 결과는 모듈 메모리에 저장 (TTL 10분). GET은 저장 스냅샷만 노출하고
 *    외부 호출 0회 (readiness-snapshot 패턴).
 *  - 전환 감지: 공식 SDK가 다른 주소(예: 0x517602…)로 전환해도 자동 수용하지
 *    않는다 — P2가 실패하며 명시적 재감사(코드 리뷰 + manifest 갱신) 필요.
 *
 * 보안: RPC URL·개인키·서명 미노출. 오류 메시지는 sanitize된 사유만.
 */

import { createPublicClient, http, keccak256, encodeAbiParameters, getAddress, type Address, type PublicClient } from 'viem';
import { arbitrum } from 'viem/chains';
import { createRequire } from 'node:module';
import { GMX_DEPLOYMENT_MANIFEST, validateEnvAgainstManifest } from './gmxDeploymentManifest';
import { resolveGmxLiveRelayConfig } from './gmxLiveConfig';

export const PREFLIGHT_TTL_MS = 10 * 60 * 1000;

const ROLE_STORE_ABI = [
  { name: 'hasRole', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'bytes32' }], outputs: [{ type: 'bool' }] },
] as const;
const NONCE_ABI = [
  { name: 'subaccountApprovalNonces', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

function roleKey(role: string): `0x${string}` {
  return keccak256(encodeAbiParameters([{ type: 'string' }], [role]));
}

export interface PreflightCheck { name: string; ok: boolean; detail: string }
export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
  /** SDK pin 불일치 시 true — 자동 수용 금지, 명시적 재감사 필요 */
  reauditRequired: boolean;
  checkedAtMs: number;
}

// ── P2: @gmx-io/sdk pin 대조 (6H-2C 패턴 — SDK configs는 CJS require) ─────────
export interface SdkRouterPinResult { ok: boolean; reason: string | null }

export function verifySdkRouterPin(): SdkRouterPinResult {
  try {
    // 6H-2C 패턴 — SDK configs는 CJS require (공식 exports 서브패스)
    const _require = createRequire(import.meta.url ?? __filename);
    const contracts = _require('@gmx-io/sdk/configs/contracts') as typeof import('@gmx-io/sdk/configs/contracts');
    const sdkAddr = contracts.getContract(GMX_DEPLOYMENT_MANIFEST.chainId as 42161, 'SubaccountGelatoRelayRouter');
    if (typeof sdkAddr !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(sdkAddr)) {
      return { ok: false, reason: 'SDK contracts config에서 SubaccountGelatoRelayRouter를 읽지 못함 (fail-closed)' };
    }
    const expected = GMX_DEPLOYMENT_MANIFEST.addresses.subaccountGelatoRelayRouter;
    if (getAddress(sdkAddr) !== getAddress(expected)) {
      return {
        ok: false,
        reason: `ROUTER_REAUDIT_REQUIRED — 공식 SDK pin(${getAddress(sdkAddr)})이 manifest v${GMX_DEPLOYMENT_MANIFEST.manifestVersion}(${getAddress(expected)})와 불일치. ` +
          '공식 클라이언트가 router를 전환한 것으로 보임 — 자동 수용 금지, #131 절차(3중 교차감사 + manifest 갱신 + 코드 리뷰)로만 반영할 것.',
      };
    }
    return { ok: true, reason: null };
  } catch {
    return { ok: false, reason: 'SDK contracts config 로드 실패 — pin 대조 불가 (fail-closed)' };
  }
}

// ── RPC 클라이언트 (테스트 주입 가능) ────────────────────────────────────────
type MinimalClient = Pick<PublicClient, 'getBytecode' | 'readContract'>;
let _clientFactory: (() => MinimalClient) | null = null;
export function __setPreflightClientFactoryForTests(f: (() => MinimalClient) | null): void {
  _clientFactory = f;
}
function makeClient(): MinimalClient {
  if (_clientFactory) return _clientFactory();
  const url = (process.env.GMX_RPC_URL ?? '').trim();
  if (!url) throw new Error('GMX_RPC_URL 미설정 — preflight 불가 (fail-closed)');
  return createPublicClient({ chain: arbitrum, transport: http(url, { timeout: 8_000 }) });
}

// ── 저장 스냅샷 (GET은 이것만 노출 — 외부 호출 0회) ──────────────────────────
let _last: PreflightResult | null = null;
export function getLastPreflight(): PreflightResult | null { return _last; }
export function __resetPreflightForTests(): void { _last = null; }

/** 중앙 실행 경로용 — 최신 preflight가 신선(TTL 이내)하고 전 항목 통과했는가 */
export function isPreflightPassedFresh(nowMs: number = Date.now()): boolean {
  // #131 리뷰 — 미래 시각 스냅샷(시계 롤백/주입) 방지: 경과시간 0 미만도 stale 처리
  if (_last === null || !_last.ok) return false;
  const elapsed = nowMs - _last.checkedAtMs;
  return elapsed >= 0 && elapsed <= PREFLIGHT_TTL_MS;
}

/**
 * read-only preflight 실행. 어떤 검사도 상태를 변경하지 않는다
 * (eth_getCode / eth_call만). 실패 사유는 sanitize된 문자열만.
 */
export async function runGmxLivePreflight(nowMs: number = Date.now()): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  let reauditRequired = false;

  // P1 — env/manifest
  const envRes = validateEnvAgainstManifest(process.env);
  checks.push({
    name: 'P1_env_manifest',
    ok: envRes.ok,
    detail: envRes.ok ? `manifest v${GMX_DEPLOYMENT_MANIFEST.manifestVersion} 일치` : envRes.mismatches.join('; '),
  });

  // P2 — SDK pin
  const pin = verifySdkRouterPin();
  if (!pin.ok && (pin.reason ?? '').includes('ROUTER_REAUDIT_REQUIRED')) reauditRequired = true;
  checks.push({ name: 'P2_sdk_pin', ok: pin.ok, detail: pin.ok ? '@gmx-io/sdk pin 일치' : (pin.reason ?? '불일치') });

  // P3~P5 — 온체인 (구성이 유효할 때만 시도; 무효면 각 항목 fail-closed)
  const relay = resolveGmxLiveRelayConfig();
  const mainAccount = (process.env.GMX_WALLET_ADDRESS ?? '').trim();
  if (!relay.ok || !relay.config || !/^0x[0-9a-fA-F]{40}$/.test(mainAccount)) {
    checks.push({ name: 'P3_router_code', ok: false, detail: 'relay 구성/main wallet 미완비 — 온체인 검사 불가 (fail-closed)' });
    checks.push({ name: 'P4_role_store', ok: false, detail: '상동' });
    checks.push({ name: 'P5_nonce_readback', ok: false, detail: '상동' });
  } else {
    const router = relay.config.subaccountGelatoRelayRouter as Address;
    const roleStore = GMX_DEPLOYMENT_MANIFEST.addresses.roleStore as Address;
    try {
      const client = makeClient();
      // P3
      try {
        const code = await client.getBytecode({ address: router });
        const has = typeof code === 'string' && code.length > 2;
        checks.push({ name: 'P3_router_code', ok: has, detail: has ? `router 코드 존재 (${(code!.length - 2) / 2} bytes)` : 'router 주소에 코드 없음 (fail-closed)' });
      } catch { checks.push({ name: 'P3_router_code', ok: false, detail: 'eth_getCode 실패 (fail-closed)' }); }
      // P4
      try {
        const [controller, plugin] = await Promise.all([
          client.readContract({ address: roleStore, abi: ROLE_STORE_ABI, functionName: 'hasRole', args: [router, roleKey('CONTROLLER')] }),
          client.readContract({ address: roleStore, abi: ROLE_STORE_ABI, functionName: 'hasRole', args: [router, roleKey('ROUTER_PLUGIN')] }),
        ]);
        const ok = controller === true && plugin === true;
        checks.push({ name: 'P4_role_store', ok, detail: ok ? 'CONTROLLER·ROUTER_PLUGIN 권한 확인' : `RoleStore 권한 미충족 (CONTROLLER=${String(controller)}, ROUTER_PLUGIN=${String(plugin)}) — 차단` });
      } catch { checks.push({ name: 'P4_role_store', ok: false, detail: 'RoleStore 조회 실패 (fail-closed)' }); }
      // P5
      try {
        const nonce = await client.readContract({ address: router, abi: NONCE_ABI, functionName: 'subaccountApprovalNonces', args: [mainAccount as Address] });
        const ok = typeof nonce === 'bigint';
        checks.push({ name: 'P5_nonce_readback', ok, detail: ok ? `nonce readback 성공 (=${(nonce as bigint).toString()})` : 'nonce 디코딩 실패 (fail-closed)' });
      } catch { checks.push({ name: 'P5_nonce_readback', ok: false, detail: 'nonce 호출 실패 (fail-closed)' }); }
    } catch (e: unknown) {
      const why = e instanceof Error && e.message.includes('GMX_RPC_URL') ? e.message : 'RPC 클라이언트 생성 실패 (fail-closed)';
      checks.push({ name: 'P3_router_code', ok: false, detail: why });
      checks.push({ name: 'P4_role_store', ok: false, detail: why });
      checks.push({ name: 'P5_nonce_readback', ok: false, detail: why });
    }
  }

  const result: PreflightResult = {
    ok: checks.every((c) => c.ok),
    checks,
    reauditRequired,
    checkedAtMs: nowMs,
  };
  _last = result;
  return result;
}
