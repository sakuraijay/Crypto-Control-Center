/**
 * GMX 최신 delegated trading 1단계 테스트
 *  - 신규 relay 구성(fail-closed, legacy만으로 LIVE 불가)
 *  - EIP-712 SubaccountApproval / RelayParams 골든 fixture + 변조 거부
 *  - DataStore Keys 골든 + read-only reader (mock RPC 전용)
 *  - 인증 상태 모델 (UNVERIFIED/ERROR는 절대 AUTHORIZED 아님)
 *  - legacy 주문 경로 Production 차단 가드
 */

import { describe, expect, it } from 'vitest';
import { keccak256, toHex, encodeAbiParameters, hashTypedData, type Hex, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { resolveGmxLiveRelayConfig, isGmxLiveRelayConfigured, GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ARBITRUM_OFFICIAL_DOC, GMX_DATA_STORE_ARBITRUM_OFFICIAL_DOC } from '../lib/gmxLiveConfig';
import { GMX_EVENT_EMITTER_ARBITRUM_OFFICIAL_DOC } from '../lib/gmxOrderEvents';
import {
  SUBACCOUNT_APPROVAL_TYPE_STRING,
  buildSubaccountApprovalTypedData,
  hashSubaccountApproval,
  verifySubaccountApprovalSignature,
  buildMinimalRelayParams,
  computeRelayParamsHash,
  computeGmxRelayDomainSeparator,
  computeRelayDigest,
  verifyRelaySignature,
  RELAY_PARAMS_ABI_COMPONENTS,
  type SubaccountApprovalMessage,
} from '../lib/gmxEip712';
import {
  hashKeyString,
  SUBACCOUNT_ORDER_ACTION,
  subaccountListKey,
  subaccountExpiresAtKey,
  subaccountActionCountKey,
  maxAllowedSubaccountActionCountKey,
  subaccountIntegrationIdKey,
  readSubaccountAuthorization,
  type DataStoreClient,
} from '../lib/gmxDataStore';
import { deriveSubaccountAuthState, isAuthStateLiveEligible } from '../lib/subaccountAuthState';
// NOTE: liveTestExecutor는 여기서 import하지 않는다 — lib/db(DATABASE_URL 필수)를 끌어와
// CI(DB 없음)에서 스위트가 깨진다. assertLegacyOrderPathAllowed 테스트는
// executionSafety.test.ts(전체 mock 하네스)에 있다.

// ── 공통 fixture ─────────────────────────────────────────────────────────────

const RELAY_ROUTER = GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ARBITRUM_OFFICIAL_DOC as Address;
const DATA_STORE   = GMX_DATA_STORE_ARBITRUM_OFFICIAL_DOC as Address;
const EMITTER      = GMX_EVENT_EMITTER_ARBITRUM_OFFICIAL_DOC;

// 고정 테스트 키 (공개 fixture — 실제 자금 없음)
const OWNER_PK  = ('0x' + '11'.repeat(32)) as Hex;
const SIGNER_PK = ('0x' + '22'.repeat(32)) as Hex;
const owner  = privateKeyToAccount(OWNER_PK);
const signer = privateKeyToAccount(SIGNER_PK);

const ZERO32 = ('0x' + '00'.repeat(32)) as Hex;
const NOW = 1_800_000_000n;

function approvalFixture(overrides: Partial<SubaccountApprovalMessage> = {}): SubaccountApprovalMessage {
  return {
    subaccount: signer.address,
    shouldAdd: true,
    expiresAt: NOW + 7n * 86400n,
    maxAllowedCount: 100n,
    actionType: SUBACCOUNT_ORDER_ACTION,
    nonce: 0n,
    desChainId: 42161n,
    deadline: NOW + 3600n,
    integrationId: ZERO32,
    ...overrides,
  };
}

const fullEnv = {
  GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS: RELAY_ROUTER,
  GMX_DATA_STORE_ADDRESS: DATA_STORE,
  GMX_EVENT_EMITTER_ADDRESS: EMITTER,
} as unknown as NodeJS.ProcessEnv;

// ── 신규 relay 구성 ──────────────────────────────────────────────────────────

describe('gmxLiveConfig — 신규 relay 구성 (fail-closed)', () => {
  it('전체 미설정 → ok=false, 세 주소 모두 사유에 포함', () => {
    const r = resolveGmxLiveRelayConfig({} as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons.join(' ')).toMatch(/GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS/);
      expect(r.reasons.join(' ')).toMatch(/GMX_DATA_STORE_ADDRESS/);
      expect(r.reasons.join(' ')).toMatch(/GMX_EVENT_EMITTER_ADDRESS/);
    }
  });

  it('legacy GMX_SUBACCOUNT_ROUTER_ADDRESS만 설정 → ok=false (legacy로 LIVE 불가)', () => {
    const r = resolveGmxLiveRelayConfig({
      GMX_SUBACCOUNT_ROUTER_ADDRESS: '0x9c05880A2AaD7530c69e18e342eDC9E06cc757db',
    } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    expect(isGmxLiveRelayConfigured({ GMX_SUBACCOUNT_ROUTER_ADDRESS: '0x9c05880A2AaD7530c69e18e342eDC9E06cc757db' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('세 주소 완비 → ok=true, chainId 42161 고정', () => {
    const r = resolveGmxLiveRelayConfig(fullEnv);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.chainId).toBe(42161);
      expect(r.config.subaccountGelatoRelayRouter).toBe(RELAY_ROUTER);
      expect(r.config.dataStore).toBe(DATA_STORE);
      expect(r.config.eventEmitter).toBe(EMITTER);
    }
  });

  it('GMX_CHAIN_ID가 42161이 아니면 거부', () => {
    const r = resolveGmxLiveRelayConfig({ ...fullEnv, GMX_CHAIN_ID: '421614' } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
  });

  it('주소 형식 오류/타 체인 emitter → ok=false', () => {
    expect(resolveGmxLiveRelayConfig({ ...fullEnv, GMX_DATA_STORE_ADDRESS: 'nope' } as NodeJS.ProcessEnv).ok).toBe(false);
    expect(resolveGmxLiveRelayConfig({ ...fullEnv, GMX_EVENT_EMITTER_ADDRESS: '0xAf2E131d483cedE068e21a9228aD91E623a989C2' } as NodeJS.ProcessEnv).ok).toBe(false);
  });

  it('오류 사유에 env 원문 값이 포함되지 않음 (필드명·사유만)', () => {
    const secretish = '0x' + 'ab'.repeat(19); // 형식 오류 값
    const r = resolveGmxLiveRelayConfig({ ...fullEnv, GMX_DATA_STORE_ADDRESS: secretish } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(' ')).not.toContain(secretish);
  });
});

// ── EIP-712 SubaccountApproval ───────────────────────────────────────────────

describe('EIP-712 SubaccountApproval — 골든 fixture + 변조 거부', () => {
  it('typehash 원문이 공식 문자열과 일치 (필드 순서 포함)', () => {
    expect(SUBACCOUNT_APPROVAL_TYPE_STRING).toBe(
      'SubaccountApproval(address subaccount,bool shouldAdd,uint256 expiresAt,uint256 maxAllowedCount,bytes32 actionType,uint256 nonce,uint256 desChainId,uint256 deadline,bytes32 integrationId)',
    );
    // 공식 RelayUtils.sol의 SUBACCOUNT_APPROVAL_TYPEHASH와 동일한 keccak
    expect(keccak256(toHex(SUBACCOUNT_APPROVAL_TYPE_STRING))).toBe(
      keccak256(toHex('SubaccountApproval(address subaccount,bool shouldAdd,uint256 expiresAt,uint256 maxAllowedCount,bytes32 actionType,uint256 nonce,uint256 desChainId,uint256 deadline,bytes32 integrationId)')),
    );
  });

  it('owner 서명 → 검증 통과 (골든 왕복)', async () => {
    const approval = approvalFixture();
    const typed = buildSubaccountApprovalTypedData({ chainId: 42161, verifyingContract: RELAY_ROUTER, approval });
    const signature = await owner.signTypedData(typed);
    const r = await verifySubaccountApprovalSignature({
      chainId: 42161, verifyingContract: RELAY_ROUTER, approval, signature,
      expectedOwner: owner.address, expectedNonce: 0n, nowSec: NOW,
    });
    expect(r.ok).toBe(true);
    // hash 결정성
    expect(hashSubaccountApproval({ chainId: 42161, verifyingContract: RELAY_ROUTER, approval }))
      .toBe(hashTypedData(typed));
  });

  it('변조 거부: chainId / verifyingContract / nonce / deadline / 서명자', async () => {
    const approval = approvalFixture();
    const typed = buildSubaccountApprovalTypedData({ chainId: 42161, verifyingContract: RELAY_ROUTER, approval });
    const signature = await owner.signTypedData(typed);
    const base = { verifyingContract: RELAY_ROUTER, approval, signature, expectedOwner: owner.address, expectedNonce: 0n, nowSec: NOW };

    // 타 chainId
    expect((await verifySubaccountApprovalSignature({ ...base, chainId: 1 })).ok).toBe(false);
    // desChainId 변조
    expect((await verifySubaccountApprovalSignature({ ...base, chainId: 42161, approval: { ...approval, desChainId: 1n } })).ok).toBe(false);
    // 타 router로 검증 → 서명자 불일치로 거부
    const other = ('0x' + '99'.repeat(20)) as Address;
    expect((await verifySubaccountApprovalSignature({ ...base, chainId: 42161, verifyingContract: other })).ok).toBe(false);
    // nonce 불일치 (replay)
    expect((await verifySubaccountApprovalSignature({ ...base, chainId: 42161, expectedNonce: 1n })).ok).toBe(false);
    // deadline 경과
    expect((await verifySubaccountApprovalSignature({ ...base, chainId: 42161, nowSec: approval.deadline + 1n })).ok).toBe(false);
    // 메시지 필드 변조 (maxAllowedCount)
    expect((await verifySubaccountApprovalSignature({ ...base, chainId: 42161, approval: { ...approval, maxAllowedCount: 1000n } })).ok).toBe(false);
    // 다른 서명자(delegated signer가 owner 행세)
    const forged = await signer.signTypedData(typed);
    expect((await verifySubaccountApprovalSignature({ ...base, chainId: 42161, signature: forged })).ok).toBe(false);
  });
});

// ── EIP-712 RelayParams ──────────────────────────────────────────────────────

describe('EIP-712 RelayParams — 해시·digest·서명 검증', () => {
  const WNT = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' as Address; // Arbitrum WETH
  const relayParams = buildMinimalRelayParams({ feeToken: WNT, feeAmount: 10n ** 15n, userNonce: 7n, deadline: NOW + 600n });

  it('relayParams 해시 = keccak256(abi.encode(순서 고정, signature 제외)) — 독립 인코딩과 일치', () => {
    const independent = keccak256(encodeAbiParameters(RELAY_PARAMS_ABI_COMPONENTS, [
      { tokens: [], providers: [], data: [] },
      { sendTokens: [], sendAmounts: [], externalCallTargets: [], externalCallDataList: [], refundTokens: [], refundReceivers: [] },
      [],
      { feeToken: WNT, feeAmount: 10n ** 15n, feeSwapPath: [] },
      7n, NOW + 600n, 42161n,
    ]));
    expect(computeRelayParamsHash(relayParams)).toBe(independent);
    // 필드 변조 시 해시 변경
    expect(computeRelayParamsHash({ ...relayParams, userNonce: 8n })).not.toBe(independent);
    expect(computeRelayParamsHash({ ...relayParams, desChainId: 1n })).not.toBe(independent);
  });

  it('delegated signer 서명 → 검증 통과; 변조된 relayParams·타 signer·만료·타 체인·타 router 거부', async () => {
    const ds = computeGmxRelayDomainSeparator(42161, RELAY_ROUTER);
    const digest = computeRelayDigest(ds, computeRelayParamsHash(relayParams));
    const signature = await signer.sign({ hash: digest });
    const base = { relayParams, chainId: 42161, verifyingContract: RELAY_ROUTER, signature, expectedSigner: signer.address, nowSec: NOW };

    expect((await verifyRelaySignature(base)).ok).toBe(true);
    // 핵심: 유효 서명 + 변조된 relayParams → 기대 digest 재계산으로 결속 검증 → 거부
    expect((await verifyRelaySignature({ ...base, relayParams: { ...relayParams, userNonce: 8n } })).ok).toBe(false);
    expect((await verifyRelaySignature({ ...base, relayParams: { ...relayParams, fee: { ...relayParams.fee, feeAmount: 10n ** 18n } } })).ok).toBe(false);
    expect((await verifyRelaySignature({ ...base, relayParams: { ...relayParams, deadline: NOW + 999999n } })).ok).toBe(false);
    // 타 서명자
    expect((await verifyRelaySignature({ ...base, expectedSigner: owner.address })).ok).toBe(false);
    // 만료
    expect((await verifyRelaySignature({ ...base, nowSec: relayParams.deadline + 1n })).ok).toBe(false);
    // 타 체인 relayParams / 타 chainId 도메인
    expect((await verifyRelaySignature({ ...base, relayParams: { ...relayParams, desChainId: 1n } })).ok).toBe(false);
    expect((await verifyRelaySignature({ ...base, chainId: 1 })).ok).toBe(false);
    // 타 router 도메인 → 기대 digest 불일치 → 거부
    expect((await verifyRelaySignature({ ...base, verifyingContract: '0x9c05880A2AaD7530c69e18e342eDC9E06cc757db' as Address })).ok).toBe(false);
  });
});

// ── DataStore Keys + reader ──────────────────────────────────────────────────

describe('gmxDataStore — Keys 골든 + read-only reader (mock 전용)', () => {
  it('기본 키 = keccak256(abi.encode(string)) — 공식 Keys.sol 스킴과 일치', () => {
    expect(hashKeyString('SUBACCOUNT_LIST')).toBe(keccak256(encodeAbiParameters([{ type: 'string' }], ['SUBACCOUNT_LIST'])));
    expect(SUBACCOUNT_ORDER_ACTION).toBe(keccak256(encodeAbiParameters([{ type: 'string' }], ['SUBACCOUNT_ORDER_ACTION'])));
  });

  it('파생 키 골든 — 독립 인코딩과 일치, 파라미터 순서 민감', () => {
    const a = owner.address, s = signer.address;
    expect(subaccountListKey(a)).toBe(keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }], [hashKeyString('SUBACCOUNT_LIST'), a])));
    expect(subaccountExpiresAtKey(a, s)).toBe(keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }],
      [hashKeyString('SUBACCOUNT_EXPIRES_AT'), a, s, SUBACCOUNT_ORDER_ACTION])));
    expect(maxAllowedSubaccountActionCountKey(a, s)).toBe(keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }],
      [hashKeyString('MAX_ALLOWED_SUBACCOUNT_ACTION_COUNT'), a, s, SUBACCOUNT_ORDER_ACTION])));
    expect(subaccountActionCountKey(a, s)).toBe(keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }],
      [hashKeyString('SUBACCOUNT_ACTION_COUNT'), a, s, SUBACCOUNT_ORDER_ACTION])));
    expect(subaccountIntegrationIdKey(a, s)).toBe(keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }],
      [hashKeyString('SUBACCOUNT_INTEGRATION_ID'), a, s])));
    // account/subaccount 순서 바꾸면 다른 키
    expect(subaccountExpiresAtKey(a, s)).not.toBe(subaccountExpiresAtKey(s, a));
  });

  function mockClient(handler: (fn: string, args: readonly unknown[]) => unknown): DataStoreClient {
    return { readContract: async ({ functionName, args }) => handler(functionName, args) };
  }

  it('정상 조회 → used/remaining/nonce 포함 반환', async () => {
    const client = mockClient((fn, args) => {
      if (fn === 'containsAddress') return true;
      if (fn === 'subaccountApprovalNonces') return 3n;
      if (fn === 'getBytes32') return ZERO32;
      // getUint: expiresAt / maxAllowed / used를 키로 구분
      const key = args[0];
      if (key === subaccountExpiresAtKey(owner.address, signer.address)) return NOW + 1000n;
      if (key === maxAllowedSubaccountActionCountKey(owner.address, signer.address)) return 10n;
      if (key === subaccountActionCountKey(owner.address, signer.address)) return 4n;
      return 0n;
    });
    const r = await readSubaccountAuthorization({ client, dataStore: DATA_STORE, relayRouter: RELAY_ROUTER, account: owner.address, subaccount: signer.address });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toMatchObject({ isSubaccountListed: true, expiresAt: NOW + 1000n, maxAllowedCount: 10n, usedCount: 4n, remaining: 6n, approvalNonce: 3n });
    }
  });

  it('RPC 오류 → ok=false (fail-closed), 디코딩 이상 → ok=false', async () => {
    const failing = mockClient(() => { throw new Error('boom http://rpc.example/key123'); });
    const r1 = await readSubaccountAuthorization({ client: failing, dataStore: DATA_STORE, relayRouter: RELAY_ROUTER, account: owner.address, subaccount: signer.address });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).not.toContain('rpc.example'); // sanitize — URL 미노출

    const badType = mockClient((fn) => (fn === 'containsAddress' ? 'yes' : 0n));
    const r2 = await readSubaccountAuthorization({ client: badType, dataStore: DATA_STORE, relayRouter: RELAY_ROUTER, account: owner.address, subaccount: signer.address });
    expect(r2.ok).toBe(false);
  });
});

// ── 인증 상태 모델 ───────────────────────────────────────────────────────────

describe('subaccountAuthState — 상태 판정 (fail-closed)', () => {
  const oc = (over: Partial<Parameters<typeof deriveSubaccountAuthState>[0]['onchain'] & object> = {}) => ({
    isSubaccountListed: true, expiresAt: NOW + 1000n, maxAllowedCount: 10n,
    usedCount: 0n, remaining: 10n, integrationId: ZERO32 as Hex, approvalNonce: 0n, ...over,
  });
  const base = { relayConfigured: true, signerInitialized: true, delegatedSignerEnabled: true, onchain: oc(), onchainError: null, nowSec: NOW };

  it('각 상태 경계', () => {
    expect(deriveSubaccountAuthState({ ...base, relayConfigured: false })).toBe('NOT_CONFIGURED');
    expect(deriveSubaccountAuthState({ ...base, signerInitialized: false })).toBe('SIGNER_DISABLED');
    expect(deriveSubaccountAuthState({ ...base, delegatedSignerEnabled: false })).toBe('SIGNER_READY');
    expect(deriveSubaccountAuthState({ ...base, onchainError: 'rpc down' })).toBe('ERROR');
    expect(deriveSubaccountAuthState({ ...base, onchain: null })).toBe('UNVERIFIED');
    expect(deriveSubaccountAuthState({ ...base, onchain: oc({ isSubaccountListed: false }) })).toBe('OWNER_SIGNATURE_REQUIRED');
    expect(deriveSubaccountAuthState({ ...base, onchain: oc({ expiresAt: 0n, maxAllowedCount: 0n, remaining: 0n }) })).toBe('REVOKED');
    expect(deriveSubaccountAuthState({ ...base, onchain: oc({ expiresAt: NOW - 1n }) })).toBe('EXPIRED');
    expect(deriveSubaccountAuthState({ ...base, onchain: oc({ usedCount: 10n, remaining: 0n }) })).toBe('ACTION_LIMIT_REACHED');
    expect(deriveSubaccountAuthState(base)).toBe('AUTHORIZED');
  });

  it('AUTHORIZED 외 모든 상태는 LIVE 부적격', () => {
    expect(isAuthStateLiveEligible('AUTHORIZED')).toBe(true);
    for (const s of ['NOT_CONFIGURED', 'SIGNER_DISABLED', 'SIGNER_READY', 'OWNER_SIGNATURE_REQUIRED', 'EXPIRED', 'ACTION_LIMIT_REACHED', 'REVOKED', 'UNVERIFIED', 'ERROR'] as const) {
      expect(isAuthStateLiveEligible(s)).toBe(false);
    }
  });
});
