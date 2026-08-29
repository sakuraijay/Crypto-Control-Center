/**
 * gmxDeploymentManifest — 감사된 GMX Arbitrum 배포 주소 manifest (v3).
 *
 * 목적:
 *  - Production env 주소가 "감사된 공식 주소"와 일치하는지 검증하는 단일 기준.
 *  - 하드코딩 fallback으로 **자동 사용되지 않는다** — env는 계속 필수이며,
 *    이 manifest는 env 값을 대조·차단하는 용도로만 쓰인다.
 *  - env 주소가 manifest와 다르면 LIVE 활성화 fail-closed.
 *  - 주소 변경은 코드 리뷰 + manifest version 갱신 없이는 불가능하다.
 *
 * v2 감사 근거 (#131 교차감사, 2026-08-19 UTC 확정):
 *  Arbitrum 단일체인 Owner Approval·주문 prepare/submit의 유효
 *  SubaccountGelatoRelayRouter = 0xfD0596f708d9D950E0eF7b5d191e5F8e55b8a67f (구 배포).
 *  1) GMX 공식 API v2 실측: POST /v1/subaccounts/approval/prepare echo의
 *     domain.verifyingContract = 0xfD0596… (arbitrum.gmxapi.io, 2026-08-19).
 *  2) gmx-interface master c233f850007c5 (2026-08-16):
 *     sdk/src/configs/contracts.ts ARBITRUM = 0xfD0596…; 0x517602…는 저장소 전체 0회.
 *     validateTypedData.ts는 contracts.ts 유래 허용집합만 수락 — 공식 클라이언트도
 *     0x517602…를 거부하는 상태.
 *  3) @gmx-io/sdk 1.7.0 (본 프로젝트 pin): configs/contracts [ARBITRUM]
 *     SubaccountGelatoRelayRouter = 0xfD0596… (런타임 대조: verifySdkRouterPin).
 *  4) 온체인 (Arbitrum RPC, 읽기 전용): 두 주소 모두 코드 존재
 *     (구 22,738 / 신규 21,181 bytes), dataStore·eventEmitter·orderVault·router
 *     결속 동일, RoleStore(0x3c3d99FD…)에서 CONTROLLER·ROUTER_PLUGIN 둘 다 true,
 *     subaccountApprovalNonces(main)=0 동일.
 *  5) gmx-synthetics main a85ea3491c19 (2026-07-31) deployments/arbitrum artifact는
 *     0x517602… — 즉 "배포·권한 부여 완료, 공식 클라이언트 미전환" 세대 혼합 상태.
 *     deployments repo 존재 ≠ 유효 경로. 유효 router 확정은 (a) API echo
 *     (b) interface/SDK pin (c) 온체인 role 3중 일치로만 한다.
 *
 * v3 추가 감사 근거 (2026-08-29 UTC):
 *  - GMX 공식 Contract addresses 문서의 Arbitrum(42161) SubaccountRouter
 *    = 0x9c05880A2AaD7530c69e18e342eDC9E06cc757db.
 *  - 이 주소는 canonical on-chain subaccount/delegation 경로 전용이며
 *    SubaccountGelatoRelayRouter와 의미를 혼합하지 않는다.
 *  - GMX_SUBACCOUNT_ROUTER_ADDRESS는 자동 보정하지 않고 별도 validator에서
 *    공식 주소와 대조하여 누락/형식 오류/불일치를 fail-closed로 분류한다.
 *
 *  전환 감지·재감사 경보: 공식 interface/SDK가 0x517602…로 전환하면
 *  verifySdkRouterPin이 불일치를 감지해 LIVE preflight를 차단하고 명시적
 *  재감사(ROUTER_REAUDIT_REQUIRED)를 요구한다 — 자동 수용 금지.
 *
 * DataStore/EventEmitter/OrderVault는 docs·artifact 양쪽에서 동일 (docs 명시:
 * "DataStore and RoleStore addresses are permanent").
 */

export const GMX_DEPLOYMENT_MANIFEST = {
  manifestVersion: 3,
  chainId: 42161,
  checkedAt: '2026-08-29',
  sourceRepo: 'GMX Docs Contract addresses + gmx-io/gmx-interface (c233f850) + @gmx-io/sdk 1.7.0 + GMX API 실측 + 온체인 RoleStore',
  sourceCommit: 'canonical SubaccountRouter docs checked 2026-08-29; relay source c233f850007c5 (interface master, 2026-08-16)',
  artifactPath: 'GMX Docs /api/contracts/addresses + sdk/src/configs/contracts.ts [ARBITRUM].SubaccountGelatoRelayRouter',
  docsDiscrepancy:
    '#131 교차감사(2026-08-19)로 해소: docs/deployments의 0x517602…는 배포·권한 부여까지 끝난 ' +
    '신규 router지만 공식 API·interface·SDK 어느 클라이언트도 아직 사용하지 않는다(세대 혼합). ' +
    '유효 relay 경로는 구 0xfD0596… — API echo·interface c233f850·sdk 1.7.0·온체인 role 일치. ' +
    'canonical SubaccountRouter는 별도 공식 주소 0x9c0588…이며 두 router 역할을 혼합하지 않는다. ' +
    '공식 클라이언트 전환 확인 전 0x517602… 사용 금지(차단 목록 소속, 재감사 필요).',
  addresses: {
    /** canonical on-chain subaccount/delegation router — GMX official Arbitrum contract-address table */
    subaccountRouter: '0x9c05880A2AaD7530c69e18e342eDC9E06cc757db',
    subaccountGelatoRelayRouter: '0xfD0596f708d9D950E0eF7b5d191e5F8e55b8a67f',
    dataStore: '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8',
    eventEmitter: '0xC8ee91A54287DB53897056e12D9819156D3822Fb',
    orderVault: '0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5',
    gelatoRelayRouter: '0xa9090E2fd6cD8Ee397cF3106189A7E1CFAE6C59C',
    /** preflight 전용 (env 대조 대상 아님) — gmx-synthetics deployments/arbitrum/RoleStore.json, docs 'permanent' */
    roleStore: '0x3c3d99FD298f679DBC2CEcd132b4eC4d0F5e6e72',
  },
} as const;

/**
 * 차단 목록 — LIVE runtime이 stale/타 체인 주소를 사용할 가능성 0.
 * (형식이 유효해도 여기 있으면 즉시 fail-closed)
 */
export const GMX_BLOCKED_ADDRESSES: ReadonlyMap<string, string> = new Map(
  (
    [
      // #131 — 신규 배포 router: gmx-synthetics a85ea349 deployments에 존재하고
      // 온체인 권한(CONTROLLER·ROUTER_PLUGIN)도 부여됐지만, 공식 API·interface·SDK가
      // 아직 사용하지 않는다. 공식 클라이언트 전환 확인(재감사) 전 사용 금지.
      ['0x517602BaC704B72993997820981603f5E4901273', '신규 SubaccountGelatoRelayRouter — 공식 클라이언트 미전환 (ROUTER_REAUDIT_REQUIRED)'],
      // gmx-synthetics main artifact 히스토리의 과거 Arbitrum router 배포들
      ['0xdd78aA661e4e3BD1eCAb7E0D5E25AbBbcb71464F', '과거 artifact router (2025-11-05)'],
      ['0xA1D94802EcD642051B677dBF37c8E78ce6dd3784', '과거 artifact router (v2.2, 2025-08-13)'],
      ['0x56Bd17a72cDBb15D9eb3600D7E8F22B0e8220C82', '과거 artifact router (v2.2, 2025-08-12)'],
      ['0xeb1f997F95D970701B72F4f66DdD8E360c34C762', '과거 artifact router (v2.2, 2025-07-24)'],
      ['0x74A15F3297DC5774117E7bC5c0D6A0c01B229579', '과거 artifact router (v2.2, 2025-07-23)'],
      ['0x49f84d799B62696CfA737aEd4b8de437AFC2C8d1', '과거 artifact router (v2.2, 2025-07-07)'],
      ['0x5F345B765d5856bC0843cEE8bE234b575eC77DBC', '과거 artifact router (gasless, 2025-04-21)'],
      ['0x8964c82e1878d35bEd66d377f97e4F518b7A024F', '과거 artifact router (gasless, 2025-03-10)'],
      ['0x2FB22eab0f84557dac6fc9D800CAe11602662F78', '과거 artifact router (gasless, 2025-03-06)'],
      // 타 체인 SubaccountGelatoRelayRouter (gmx-interface configs 기준)
      ['0xa62BD1cFE2066c5bF4180b4125BBb5116eEA26c9', '타 체인 router (Avalanche)'],
      ['0x603B3D3aB077CA433b888c05fa59c777d5b6dCAD', '타 체인 router (비-Arbitrum)'],
      ['0x9022ADce7c964852475aB0de801932BaDEB0C765', '타 체인 router (비-Arbitrum)'],
      ['0xaa174e2fbE98C1EE42009B81ec8b8D9C0Ed075cf', '타 체인 router (비-Arbitrum)'],
      // 타 체인 EventEmitter (기존 gmxOrderEvents 거부 대상과 일치)
      ['0xAf2E131d483cedE068e21a9228aD91E623a989C2', '타 체인 EventEmitter (Avalanche)'],
    ] as const
  ).map(([a, why]) => [a.toLowerCase(), why]),
);

export interface ManifestValidationResult {
  ok: boolean;
  /** manifest와 불일치한 env 키 + 사유 (주소 원문은 blocked 사유 외 포함하지 않음) */
  mismatches: string[];
}

function norm(v: string | undefined | null): string | null {
  const t = (v ?? '').trim();
  return /^0x[0-9a-fA-F]{40}$/.test(t) ? t.toLowerCase() : null;
}

/** env 주소 하나를 manifest 기대값과 대조 (blocked 우선 판정) */
function checkOne(envKey: string, envValue: string | undefined, expected: string, out: string[]): void {
  const v = norm(envValue);
  if (v === null) {
    out.push(`${envKey} 미설정/형식 오류 — manifest 대조 불가 (fail-closed)`);
    return;
  }
  const blocked = GMX_BLOCKED_ADDRESSES.get(v);
  if (blocked) {
    out.push(`${envKey} 차단 주소 사용 — ${blocked}`);
    return;
  }
  if (v !== expected.toLowerCase()) {
    out.push(`${envKey} 값이 manifest v${GMX_DEPLOYMENT_MANIFEST.manifestVersion} 감사 주소와 불일치 (fail-closed)`);
  }
}

function checkChain(env: NodeJS.ProcessEnv, out: string[]): void {
  const chainRaw = (env.GMX_CHAIN_ID ?? '').trim();
  if (chainRaw !== '' && chainRaw !== String(GMX_DEPLOYMENT_MANIFEST.chainId)) {
    out.push(`GMX_CHAIN_ID ≠ ${GMX_DEPLOYMENT_MANIFEST.chainId} — manifest 불일치 (fail-closed)`);
  }
}

/**
 * Production relay env 주소를 감사된 manifest와 대조한다.
 * - env는 계속 필수 (manifest 값 자동 대입 금지 — 이 함수는 검증만 한다)
 * - 불일치·차단·미설정 전부 fail-closed
 * - OrderVault env는 설정된 경우에만 대조 (LIVE relay 필수 3종은 항상 대조)
 */
export function validateEnvAgainstManifest(env: NodeJS.ProcessEnv): ManifestValidationResult {
  const m = GMX_DEPLOYMENT_MANIFEST.addresses;
  const mismatches: string[] = [];
  checkOne('GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS', env.GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS, m.subaccountGelatoRelayRouter, mismatches);
  checkOne('GMX_DATA_STORE_ADDRESS', env.GMX_DATA_STORE_ADDRESS, m.dataStore, mismatches);
  checkOne('GMX_EVENT_EMITTER_ADDRESS', env.GMX_EVENT_EMITTER_ADDRESS, m.eventEmitter, mismatches);
  if ((env.GMX_ORDER_VAULT_ADDRESS ?? '').trim() !== '') {
    checkOne('GMX_ORDER_VAULT_ADDRESS', env.GMX_ORDER_VAULT_ADDRESS, m.orderVault, mismatches);
  }
  checkChain(env, mismatches);
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Canonical on-chain subaccount/delegation router 전용 검증.
 * Relay router validator와 분리해 두 주소의 역할 혼용을 방지한다.
 * 값 누락/형식 오류/공식 Arbitrum 주소 불일치/체인 불일치는 모두 fail-closed.
 */
export function validateCanonicalSubaccountRouterEnv(env: NodeJS.ProcessEnv): ManifestValidationResult {
  const mismatches: string[] = [];
  checkOne(
    'GMX_SUBACCOUNT_ROUTER_ADDRESS',
    env.GMX_SUBACCOUNT_ROUTER_ADDRESS,
    GMX_DEPLOYMENT_MANIFEST.addresses.subaccountRouter,
    mismatches,
  );
  checkChain(env, mismatches);
  return { ok: mismatches.length === 0, mismatches };
}

/** 주소가 차단 목록에 있으면 사유 반환, 아니면 null */
export function getBlockedAddressReason(address: string | undefined | null): string | null {
  const v = norm(address);
  return v === null ? null : GMX_BLOCKED_ADDRESSES.get(v) ?? null;
}
