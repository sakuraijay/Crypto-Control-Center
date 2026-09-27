/**
 * #134 — Owner Approval 서명자 불일치 재발 방지 회귀 테스트 (DB-free).
 *
 * 배경: Production에서 단일 MetaMask Account 1(owner)로 두 번 서명했지만
 * "서명자 불일치" 422로 거부됨. 근본 원인 후보 = prepare 응답 typedData.types에
 * EIP712Domain 누락 → 지갑 구현에 따라 domain 해싱이 분기 → recovered ≠ owner.
 *
 * 커버리지:
 *  1. EIP712Domain 명시 회귀 (누락 = 즉시 실패)
 *  2. MetaMask 호환 골든 JSON round-trip — 직렬화(bigint→string) 후 다시
 *     파싱한 typedData의 digest가 서버 canonical digest와 동일
 *  3. 변조 거부 — domain name/version·router·chainId·nonce·deadline·desChainId·필드값
 *  4. 잘못된 계정 서명 → 오류에 expected/recovered 공개주소 포함
 *  5. signature v 정규화 — v=27/28 ↔ yParity 0/1 모두 동일 recovered
 *  6. 클라이언트 사전 recover와 서버 recover 일치 (동일 canonical digest 기반)
 *  7. 세션 digest = canonical hashTypedData (재래핑 스킴 아님)
 *
 * 서명 키는 공개 fixture 전용. 실제 RPC·MetaMask·Gelato 호출 없음.
 */

import { describe, it, expect } from 'vitest';
import { hashTypedData, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  buildSubaccountApprovalTypedData,
  hashSubaccountApproval,
  verifySubaccountApprovalSignature,
  computeGmxRelayDomainSeparator,
  computeRelayDigest,
  GMX_RELAY_EIP712_DOMAIN_FIELDS,
  GMX_RELAY_DOMAIN_NAME,
  GMX_RELAY_DOMAIN_VERSION,
  type SubaccountApprovalMessage,
} from '../lib/gmxEip712';

const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const ROUTER = '0xfD0596f708d9D950E0eF7b5d191e5F8e55b8a67f' as Address;
const SUBACCOUNT = '0xc56436F09039E15Aa2244659d0fC5b7f706DdbF6' as Address;
const NOW = 1_800_000_000n;
const CHAIN = 42161;

const MSG: SubaccountApprovalMessage = {
  subaccount: SUBACCOUNT,
  shouldAdd: true,
  expiresAt: NOW + 3600n,
  maxAllowedCount: 8n,
  actionType: '0x2a0791687fd34f2095c484a9fa4e25057d3ef79a97fcd8c61436047a7bdf4cbe' as Hex,
  nonce: 0n,
  desChainId: 42161n,
  deadline: NOW + 600n,
  integrationId: `0x${'00'.repeat(32)}` as Hex,
};

function build(msg: SubaccountApprovalMessage = MSG) {
  return buildSubaccountApprovalTypedData({ chainId: CHAIN, verifyingContract: ROUTER, approval: msg });
}

async function signAs(account: typeof owner, msg: SubaccountApprovalMessage = MSG): Promise<Hex> {
  return account.signTypedData(build(msg));
}

async function verify(signature: Hex, overrides?: Partial<Parameters<typeof verifySubaccountApprovalSignature>[0]>) {
  return verifySubaccountApprovalSignature({
    chainId: CHAIN, verifyingContract: ROUTER, approval: MSG,
    signature, expectedOwner: owner.address, expectedNonce: 0n, nowSec: NOW,
    ...overrides,
  });
}

// ── 1. EIP712Domain 명시 회귀 ────────────────────────────────────────────────

describe('#134 EIP712Domain 명시 (v4 스키마)', () => {
  it('typedData.types에 EIP712Domain 4필드가 정확한 순서로 포함된다', () => {
    const td = build();
    expect(td.types.EIP712Domain).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ]);
    expect(td.types.SubaccountApproval.map((f) => f.name)).toEqual([
      'subaccount', 'shouldAdd', 'expiresAt', 'maxAllowedCount',
      'actionType', 'nonce', 'desChainId', 'deadline', 'integrationId',
    ]);
    expect(td.primaryType).toBe('SubaccountApproval');
    expect(td.domain).toEqual({
      name: GMX_RELAY_DOMAIN_NAME, version: GMX_RELAY_DOMAIN_VERSION,
      chainId: 42161n, verifyingContract: ROUTER,
    });
  });

  it('EIP712Domain 명시 추가는 digest를 바꾸지 않는다 (viem 유추와 동일)', () => {
    const withExplicit = hashTypedData(build());
    const inferred = hashTypedData({
      domain: build().domain,
      types: { SubaccountApproval: build().types.SubaccountApproval },
      primaryType: 'SubaccountApproval',
      message: MSG,
    });
    expect(withExplicit).toBe(inferred);
  });

  it('상수 필드 정의는 4개·불변 (회귀 락)', () => {
    expect(GMX_RELAY_EIP712_DOMAIN_FIELDS).toHaveLength(4);
  });
});

// ── 2. MetaMask 호환 골든 JSON round-trip ────────────────────────────────────

describe('#134 골든 JSON round-trip (서버 echo = 지갑이 서명하는 실제 JSON)', () => {
  it('bigint→string 직렬화 후 파싱한 typedData의 digest = 서버 canonical digest', async () => {
    const serverDigest = hashSubaccountApproval({ chainId: CHAIN, verifyingContract: ROUTER, approval: MSG });
    // livetest.ts prepare 응답과 동일한 직렬화
    const wireJson = JSON.stringify(build(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    const parsed = JSON.parse(wireJson) as {
      domain: { name: string; version: string; chainId: string; verifyingContract: Address };
      types: Record<string, { name: string; type: string }[]>;
      primaryType: 'SubaccountApproval';
      message: Record<string, string | boolean>;
    };
    // 지갑측 해싱 시뮬레이션 — 문자열 uint256을 BigInt로 정규화해 hashTypedData
    const clientDigest = hashTypedData({
      domain: { ...parsed.domain, chainId: BigInt(parsed.domain.chainId) },
      types: parsed.types,
      primaryType: parsed.primaryType,
      message: {
        ...parsed.message,
        expiresAt: BigInt(parsed.message.expiresAt as string),
        maxAllowedCount: BigInt(parsed.message.maxAllowedCount as string),
        nonce: BigInt(parsed.message.nonce as string),
        desChainId: BigInt(parsed.message.desChainId as string),
        deadline: BigInt(parsed.message.deadline as string),
      },
    });
    expect(clientDigest).toBe(serverDigest);
    // wire JSON에 EIP712Domain이 실제 포함 (MetaMask v4 스키마 요구)
    expect(wireJson).toContain('"EIP712Domain"');
    // 서명 → recover까지 동일 digest로 owner 복구
    const sig = await owner.signTypedData(build());
    const v = await verify(sig);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.recovered.toLowerCase()).toBe(owner.address.toLowerCase());
  });
});

// ── 3. 변조 거부 ─────────────────────────────────────────────────────────────

describe('#134 변조 거부 (owner가 서명한 원본과 다른 어떤 값도 거부)', () => {
  it('router(verifyingContract) 변조 → 서명자 불일치', async () => {
    const sig = await signAs(owner);
    const r = await verify(sig, { verifyingContract: '0x5173029c58715b34af6e449802ba0d20dd7570f5' as Address });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('불일치');
  });

  it('chainId 변조 → 42161 강제 거부', async () => {
    const sig = await signAs(owner);
    const r = await verify(sig, { chainId: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('42161');
  });

  it('desChainId 변조 → 거부', async () => {
    const sig = await signAs(owner);
    const r = await verify(sig, { approval: { ...MSG, desChainId: 1n } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('desChainId');
  });

  it('nonce 불일치 → 거부', async () => {
    const sig = await signAs(owner);
    const r = await verify(sig, { expectedNonce: 1n });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('nonce');
  });

  it('deadline 경과 → 거부', async () => {
    const sig = await signAs(owner);
    const r = await verify(sig, { nowSec: MSG.deadline + 1n });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('deadline');
  });

  it('message 필드 변조(expiresAt/maxAllowedCount/subaccount) → 서명자 불일치', async () => {
    const sig = await signAs(owner);
    for (const tampered of [
      { ...MSG, expiresAt: MSG.expiresAt + 1n },
      { ...MSG, maxAllowedCount: 9n },
      { ...MSG, subaccount: other.address },
    ]) {
      const r = await verify(sig, { approval: tampered });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('불일치');
    }
  });

  it('domain name/version이 다르면 digest 자체가 달라진다 (필드 순서·domain 결속)', () => {
    const base = hashSubaccountApproval({ chainId: CHAIN, verifyingContract: ROUTER, approval: MSG });
    const altName = hashTypedData({
      ...build(), domain: { ...build().domain, name: 'WrongRouter' },
    });
    const altVer = hashTypedData({
      ...build(), domain: { ...build().domain, version: '2' },
    });
    expect(altName).not.toBe(base);
    expect(altVer).not.toBe(base);
  });
});

// ── 4. 잘못된 계정 서명 → expected/recovered 공개 주소 노출 ──────────────────

describe('#134 잘못된 계정 서명 진단', () => {
  it('other 계정 서명 → 오류에 expected(owner)와 recovered(other) 소문자 주소 포함', async () => {
    const sig = await signAs(other);
    const r = await verify(sig);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('불일치');
    expect(r.reason).toContain(owner.address.toLowerCase());
    expect(r.reason).toContain(other.address.toLowerCase());
    // 서명 원문은 미포함
    expect(r.reason).not.toContain(sig.slice(2, 20));
  });
});

// ── 5. signature v 정규화 ────────────────────────────────────────────────────

describe('#134 signature v 정규화 (27/28 ↔ 0/1)', () => {
  it('v=27/28 서명과 v=0/1 변환본 모두 동일 owner로 recover된다', async () => {
    const sig = await signAs(owner);
    const vByte = parseInt(sig.slice(-2), 16);
    expect([27, 28]).toContain(vByte);
    // yParity(0/1) 형식으로 변환
    const yParity = vByte - 27;
    const sigYParity = (sig.slice(0, -2) + yParity.toString(16).padStart(2, '0')) as Hex;
    const td = build();
    const r27 = await recoverTypedDataAddress({ ...td, signature: sig });
    const r01 = await recoverTypedDataAddress({ ...td, signature: sigYParity });
    expect(r27.toLowerCase()).toBe(owner.address.toLowerCase());
    expect(r01.toLowerCase()).toBe(owner.address.toLowerCase());
    // 서버 검증기도 양쪽 모두 수용
    const v1 = await verify(sig);
    const v2 = await verify(sigYParity);
    expect(v1.ok).toBe(true);
    expect(v2.ok).toBe(true);
  });
});

// ── 6+7. 클라이언트 사전 recover = 서버 recover, canonical digest 스킴 ────────

describe('#134 client/server recover 일치 + canonical digest 스킴', () => {
  it('클라이언트(브라우저)와 서버가 동일 typedData로 동일 digest·recovered 도출', async () => {
    const sig = await signAs(owner);
    // 클라이언트측 시뮬레이션 (futures-web clientVerifyApprovalSignature와 동일 원리)
    const clientDigest = hashTypedData(build());
    const clientRecovered = await recoverTypedDataAddress({ ...build(), signature: sig });
    // 서버측
    const serverDigest = hashSubaccountApproval({ chainId: CHAIN, verifyingContract: ROUTER, approval: MSG });
    const serverVerify = await verify(sig);
    expect(clientDigest).toBe(serverDigest);
    expect(serverVerify.ok).toBe(true);
    if (serverVerify.ok) expect(clientRecovered.toLowerCase()).toBe(serverVerify.recovered.toLowerCase());
  });

  it('canonical digest는 hashTypedData 원형 — 0x1901 재래핑 스킴과 다르다 (스킴 전환 락)', () => {
    const canonical = hashSubaccountApproval({ chainId: CHAIN, verifyingContract: ROUTER, approval: MSG });
    const ds = computeGmxRelayDomainSeparator(CHAIN, ROUTER);
    const legacyRewrap = computeRelayDigest(ds, canonical);
    expect(canonical).not.toBe(legacyRewrap);
    expect(canonical).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
