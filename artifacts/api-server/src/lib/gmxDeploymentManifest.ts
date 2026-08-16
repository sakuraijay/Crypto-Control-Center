/**
 * gmxDeploymentManifest — 6C 단계: 감사된 GMX Arbitrum 배포 주소 manifest.
 *
 * 목적:
 *  - Production env 주소가 "감사된 공식 주소"와 일치하는지 검증하는 단일 기준.
 *  - 하드코딩 fallback으로 **자동 사용되지 않는다** — env는 계속 필수이며,
 *    이 manifest는 env 값을 대조·차단하는 용도로만 쓰인다.
 *  - env 주소가 manifest와 다르면 LIVE 활성화 fail-closed.
 *  - 주소 변경은 코드 리뷰 + manifest version 갱신 없이는 불가능하다.
 *
 * 감사 근거 (2026-08-17 KST 확인):
 *  - gmx-synthetics main `deployments/arbitrum/*.json`
 *    commit 95bd0c97385737b3227e314fafb04371991bdf1b (2025-11-17, "add deployments")
 *  - Arbiscan verified (Exact Match, Contract Name=SubaccountGelatoRelayRouter,
 *    compiler v0.8.29) — 신규 0x517602… / 구 0xfD0596… 둘 다 verified.
 *  - 공식 docs(https://docs.gmx.io/docs/api/contracts/addresses/)는 CDN(엣지)별로
 *    다른 내용을 반환하는 것이 관찰됨: 운영자 독립 확인(2026-08-17)에서는 Arbitrum
 *    SubaccountGelatoRelayRouter=0x517602…(artifact와 일치)를 표시했으나, 본 환경
 *    (Cloudflare POP BOM, cache-busting 포함 2회 fetch, 응답 본문 sha256
 *    5e0a3d7dc9843f38fd8f8d46842eb33dc513b5a9fb5ea8251eaafede31d45b43,
 *    date 2026-08-16T21:35Z)에서는 여전히 구주소 0xfD0596…을 반환.
 *    "docs 전체가 구주소"가 아니라 "CDN 응답 불일치 관찰"이 정확한 상태이며,
 *    docsDiscrepancy 필드로 명시 기록한다. 주소 pin 근거는 docs가 아니라
 *    deployment artifact + Arbiscan verified이므로 pin은 영향 없음.
 *
 * DataStore/EventEmitter/OrderVault는 docs·artifact 양쪽에서 동일 (docs 명시:
 * "DataStore and RoleStore addresses are permanent").
 */

export const GMX_DEPLOYMENT_MANIFEST = {
  manifestVersion: 1,
  chainId: 42161,
  checkedAt: '2026-08-17',
  sourceRepo: 'gmx-io/gmx-synthetics',
  sourceCommit: '95bd0c97385737b3227e314fafb04371991bdf1b',
  artifactPath: 'deployments/arbitrum/SubaccountGelatoRelayRouter.json',
  docsDiscrepancy:
    'CDN 응답 불일치 관찰: 운영자 독립 확인(2026-08-17)에서는 공식 docs가 0x517602…(artifact 일치)를 ' +
    '표시했으나, 본 환경(Cloudflare POP BOM, 2026-08-16T21:35Z, body sha256 5e0a3d7d…d45b43)에서는 ' +
    '구주소 0xfD0596…을 반환. 주소 pin 근거는 artifact+Arbiscan이며 구주소는 차단 목록 유지. ' +
    '모든 엣지에서 0x517602… 일관 확인 전 Production env 설정 금지.',
  addresses: {
    subaccountGelatoRelayRouter: '0x517602BaC704B72993997820981603f5E4901273',
    dataStore: '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8',
    eventEmitter: '0xC8ee91A54287DB53897056e12D9819156D3822Fb',
    orderVault: '0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5',
    gelatoRelayRouter: '0xa9090E2fd6cD8Ee397cF3106189A7E1CFAE6C59C',
  },
} as const;

/**
 * 차단 목록 — LIVE runtime이 stale/타 체인 주소를 사용할 가능성 0.
 * (형식이 유효해도 여기 있으면 즉시 fail-closed)
 */
export const GMX_BLOCKED_ADDRESSES: ReadonlyMap<string, string> = new Map(
  (
    [
      // 이전 개발 기준 Arbitrum SubaccountGelatoRelayRouter — 일부 docs CDN 엣지의
      // 응답에서 관찰된 구주소(docsDiscrepancy 참조), artifact 배포 계보에는 없음
      ['0xfD0596f708d9D950E0eF7b5d191e5F8e55b8a67f', '구 Arbitrum SubaccountGelatoRelayRouter (docs-legacy, 교체됨)'],
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

/**
 * Production env 주소를 감사된 manifest와 대조한다.
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
  const chainRaw = (env.GMX_CHAIN_ID ?? '').trim();
  if (chainRaw !== '' && chainRaw !== String(GMX_DEPLOYMENT_MANIFEST.chainId)) {
    mismatches.push(`GMX_CHAIN_ID ≠ ${GMX_DEPLOYMENT_MANIFEST.chainId} — manifest 불일치 (fail-closed)`);
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** 주소가 차단 목록에 있으면 사유 반환, 아니면 null */
export function getBlockedAddressReason(address: string | undefined | null): string | null {
  const v = norm(address);
  return v === null ? null : GMX_BLOCKED_ADDRESSES.get(v) ?? null;
}
