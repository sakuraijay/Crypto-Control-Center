/**
 * #134 — Owner Approval 서명자 불일치 재발 방지: 클라이언트측 회귀 테스트.
 *
 *  - recheckActiveWallet: 서명 직전 eth_accounts/eth_chainId 재조회 결속
 *  - normalizeApprovalTypedData: 서버 echo(JSON, uint256 문자열) → viem 입력 정규화,
 *    EIP712Domain 누락 회귀 (누락 = 즉시 실패)
 *  - clientVerifyApprovalSignature: MetaMask 호환 골든 JSON으로 digest·recover,
 *    owner 불일치 시 제출 차단 사유 + recovered 주소
 *
 * 서명 키는 공개 fixture 전용. 실제 지갑·네트워크 호출 없음.
 */

import { describe, it, expect, vi } from 'vitest';
import { hashTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  recheckActiveWallet,
  normalizeApprovalTypedData,
  clientVerifyApprovalSignature,
  shortAddr,
  ARBITRUM_ONE_CHAIN_ID,
  type EthereumProviderLike,
} from '../subaccountApproval';

const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const ROUTER = '0xfD0596f708d9D950E0eF7b5d191e5F8e55b8a67f';

// 서버 prepare 응답과 동일 형태의 골든 JSON (uint256은 문자열 — bigint 직렬화 결과)
const GOLDEN_TYPED_DATA = {
  domain: { name: 'GmxBaseGelatoRelayRouter', version: '1', chainId: '42161', verifyingContract: ROUTER },
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    SubaccountApproval: [
      { name: 'subaccount', type: 'address' },
      { name: 'shouldAdd', type: 'bool' },
      { name: 'expiresAt', type: 'uint256' },
      { name: 'maxAllowedCount', type: 'uint256' },
      { name: 'actionType', type: 'bytes32' },
      { name: 'nonce', type: 'uint256' },
      { name: 'desChainId', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'integrationId', type: 'bytes32' },
    ],
  },
  primaryType: 'SubaccountApproval',
  message: {
    subaccount: '0xc56436F09039E15Aa2244659d0fC5b7f706DdbF6',
    shouldAdd: true,
    expiresAt: '1800003600',
    maxAllowedCount: '8',
    actionType: '0x2a0791687fd34f2095c484a9fa4e25057d3ef79a97fcd8c61436047a7bdf4cbe',
    nonce: '0',
    desChainId: '42161',
    deadline: '1800000600',
    integrationId: `0x${'00'.repeat(32)}`,
  },
} as const;

function provider(accounts: string[], chainIdHex: string): EthereumProviderLike {
  return {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_accounts') return accounts;
      if (method === 'eth_chainId') return chainIdHex;
      throw new Error(`unexpected ${method}`);
    }),
  };
}

describe('#134 recheckActiveWallet — 서명 직전 라이브 결속', () => {
  it('활성 계정=owner & chainId=42161 → ok + 활성 계정 반환 (대소문자 무시)', async () => {
    const r = await recheckActiveWallet(provider([owner.address.toUpperCase().replace('0X', '0x')], '0xa4b1'), owner.address.toLowerCase());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.activeAccount.toLowerCase()).toBe(owner.address.toLowerCase());
  });

  it('활성 계정 ≠ owner → 차단 + 두 주소 축약 표기', async () => {
    const r = await recheckActiveWallet(provider([other.address], '0xa4b1'), owner.address);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain(shortAddr(other.address));
      expect(r.reason).toContain(shortAddr(owner.address));
    }
  });

  it('체인 ≠ 42161 → 차단', async () => {
    const r = await recheckActiveWallet(provider([owner.address], '0x1'), owner.address);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(String(ARBITRUM_ONE_CHAIN_ID));
  });

  it('활성 계정 없음/조회 실패 → 차단 (fail-closed)', async () => {
    const empty = await recheckActiveWallet(provider([], '0xa4b1'), owner.address);
    expect(empty.ok).toBe(false);
    const failing: EthereumProviderLike = { request: vi.fn(async () => { throw new Error('rpc down'); }) };
    const err = await recheckActiveWallet(failing, owner.address);
    expect(err.ok).toBe(false);
    if (!err.ok) expect(err.reason).toContain('차단');
  });
});

describe('#134 normalizeApprovalTypedData — 서버 echo 정규화', () => {
  it('골든 JSON 정규화 → viem digest가 canonical과 동일', () => {
    const n = normalizeApprovalTypedData(GOLDEN_TYPED_DATA);
    expect(n.domain.chainId).toBe(42161n);
    expect(n.message.nonce).toBe(0n);
    expect(n.message.shouldAdd).toBe(true);
    // 필드 추가·삭제·재정렬 없음
    expect(Object.keys(n.message)).toEqual(GOLDEN_TYPED_DATA.types.SubaccountApproval.map((f) => f.name));
    expect(() => hashTypedData(n)).not.toThrow();
  });

  it('EIP712Domain 누락 → 즉시 실패 (회귀 락)', () => {
    const { EIP712Domain: _omit, ...rest } = GOLDEN_TYPED_DATA.types;
    expect(() => normalizeApprovalTypedData({ ...GOLDEN_TYPED_DATA, types: rest })).toThrow(/EIP712Domain/);
  });

  it('primaryType 불일치·message 필드 누락 → 실패', () => {
    expect(() => normalizeApprovalTypedData({ ...GOLDEN_TYPED_DATA, primaryType: 'CreateOrder' })).toThrow();
    const { nonce: _n, ...msg } = GOLDEN_TYPED_DATA.message;
    expect(() => normalizeApprovalTypedData({ ...GOLDEN_TYPED_DATA, message: msg })).toThrow(/nonce/);
  });
});

describe('#134 clientVerifyApprovalSignature — 제출 전 사전 recover', () => {
  it('owner 서명 → ok + digest·recovered 반환, digest는 서버 canonical과 동일', async () => {
    const normalized = normalizeApprovalTypedData(GOLDEN_TYPED_DATA);
    const signature = await owner.signTypedData(normalized);
    const r = await clientVerifyApprovalSignature({
      typedData: GOLDEN_TYPED_DATA, signature, expectedOwner: owner.address,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.recovered.toLowerCase()).toBe(owner.address.toLowerCase());
      expect(r.digest).toBe(hashTypedData(normalized));
    }
  });

  it('다른 계정 서명 → 제출 차단, recovered 축약 주소 포함, digest는 여전히 반환', async () => {
    const normalized = normalizeApprovalTypedData(GOLDEN_TYPED_DATA);
    const signature = await other.signTypedData(normalized);
    const r = await clientVerifyApprovalSignature({
      typedData: GOLDEN_TYPED_DATA, signature, expectedOwner: owner.address,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('제출하지 않습니다');
      expect(r.reason).toContain(shortAddr(other.address));
      expect(r.recovered?.toLowerCase()).toBe(other.address.toLowerCase());
      expect(r.digest).toBe(hashTypedData(normalized));
    }
  });

  it('v=0/1(yParity) 형식 서명도 동일 owner로 recover (정규화)', async () => {
    const normalized = normalizeApprovalTypedData(GOLDEN_TYPED_DATA);
    const sig = await owner.signTypedData(normalized);
    const vByte = parseInt(sig.slice(-2), 16);
    const sigYParity = (sig.slice(0, -2) + (vByte - 27).toString(16).padStart(2, '0')) as `0x${string}`;
    const r = await clientVerifyApprovalSignature({
      typedData: GOLDEN_TYPED_DATA, signature: sigYParity, expectedOwner: owner.address,
    });
    expect(r.ok).toBe(true);
  });

  it('typedData 훼손(EIP712Domain 제거) → 정규화 실패로 제출 차단', async () => {
    const { EIP712Domain: _omit, ...rest } = GOLDEN_TYPED_DATA.types;
    const r = await clientVerifyApprovalSignature({
      typedData: { ...GOLDEN_TYPED_DATA, types: rest },
      signature: `0x${'ab'.repeat(65)}`,
      expectedOwner: owner.address,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('정규화 실패');
  });
});
