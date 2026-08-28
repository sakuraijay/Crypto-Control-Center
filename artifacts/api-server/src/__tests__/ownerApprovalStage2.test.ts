/**
 * GMX delegated trading 2단계 테스트 — DB-free (@workspace/db 전체 mock).
 *
 * 커버리지:
 *  - ownerApprovalSession: prepare 클램프·저장, 서명 제출 검증(변조·nonce·deadline·
 *    owner 불일치·저장 실패), READY 세션 무효화 규칙, 서명·암호문 비노출
 *  - 암호화 회귀 (encryptSensitiveHex/decryptSensitiveHex)
 *  - subaccountAuthState: feature/integration disabled → REVOKED, block timestamp 만료
 *  - gmxCreateOrder: 공식 typehash 골든, struct hash 결정성, receiver 강제,
 *    externalCalls 거부, calldata round-trip, Gelato/네트워크 0회 (순수 함수)
 *  - operatorAuthGuard: PIN 미설정 fail-closed, 오인증 401, content-type 415
 *
 * 서명 키는 공개 fixture 전용. 실제 RPC·MetaMask·Gelato 호출 없음.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { keccak256, encodeAbiParameters, decodeFunctionData, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ── in-memory subaccount_approval_sessions store ─────────────────────────────

interface FakeRow { [k: string]: unknown }
const store: { rows: FakeRow[]; failInsert: boolean; failUpdate: boolean; txCalls: number } = {
  rows: [], failInsert: false, failUpdate: false, txCalls: 0,
};

vi.mock('@workspace/db', () => {
  // drizzle 호출 체인의 최소 시뮬레이션 — where 조건은 콜백 매처로 캡처하지 않고
  // 테스트 시나리오에 필요한 의미(id/status 매칭)만 재현한다.
  const table = { __name: 'subaccount_approval_sessions' };
  const db = {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          const matched = filterRows(cond);
          const chain = {
            limit: async (_n: number) => matched.slice(0, _n),
            orderBy: () => ({ limit: async (_n: number) => matched.slice(0, _n) }),
          };
          return chain;
        },
      }),
    }),
    insert: () => ({
      values: async (v: FakeRow) => {
        if (store.failInsert) throw new Error('insert fail');
        store.rows.push({ createdAt: new Date(), updatedAt: new Date(), ...v });
      },
    }),
    update: () => ({
      set: (patch: FakeRow) => ({
        where: (cond: unknown) => {
          const run = () => {
            if (store.failUpdate) throw new Error('update fail');
            const matched = filterRows(cond);
            for (const r of matched) Object.assign(r, patch);
            return matched;
          };
          return {
            returning: async () => run().map((r) => ({ id: r.id })),
            then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
              try { resolve(run()); } catch (e) { reject(e); }
            },
          };
        },
      }),
    }),
  };
  // 트랜잭션 mock: 콜백에 동일한 db 체인을 전달 (원자성은 실 DB의
  // partial unique index(0015)가 보장 — 여기서는 호출 경로만 검증).
  (db as { transaction?: unknown }).transaction = async (cb: (tx: typeof db) => Promise<void>) => {
    store.txCalls += 1;
    return cb(db);
  };
  return {
    db,
    subaccountApprovalSessionsTable: new Proxy(table, {
      get: (t, prop) => (prop in t ? (t as never)[prop] : { __col: prop }),
    }),
  };
});

// drizzle-orm 연산자 mock — 조건을 검사 가능한 형태로 반환
vi.mock('drizzle-orm', () => ({
  eq: (col: { __col?: string }, v: unknown) => ({ op: 'eq', col: col.__col, v }),
  and: (...cs: unknown[]) => ({ op: 'and', cs }),
  inArray: (col: { __col?: string }, vs: unknown[]) => ({ op: 'in', col: col.__col, vs }),
  desc: (col: unknown) => ({ op: 'desc', col }),
}));

function filterRows(cond: unknown): FakeRow[] {
  const test = (row: FakeRow, c: unknown): boolean => {
    const cc = c as { op: string; col?: string; v?: unknown; vs?: unknown[]; cs?: unknown[] };
    if (cc.op === 'eq') return row[cc.col!] === cc.v;
    if (cc.op === 'in') return cc.vs!.includes(row[cc.col!]);
    if (cc.op === 'and') return cc.cs!.every((x) => test(row, x));
    return true;
  };
  return store.rows.filter((r) => test(r, cond));
}

// ── 대상 모듈 (mock 이후 import) ─────────────────────────────────────────────

import {
  prepareApprovalSession, submitApprovalSignature, getActiveReadySession,
  getConfiguredMainAccount, APPROVAL_LIMITS, SESSION_STATUS, DEFAULT_INTEGRATION_ID,
} from '../lib/ownerApprovalSession';
import { encryptSensitiveHex, decryptSensitiveHex } from '../lib/delegatedSigner';
import { deriveSubaccountAuthState } from '../lib/subaccountAuthState';
import { SUBACCOUNT_ORDER_ACTION } from '../lib/gmxDataStore';
import { buildSubaccountApprovalTypedData } from '../lib/gmxEip712';
import {
  CREATE_ORDER_ADDRESSES_TYPEHASH, CREATE_ORDER_NUMBERS_TYPEHASH, CREATE_ORDER_TYPEHASH,
  ORDER_TYPE, buildOpenOrderParams, buildCloseOrderParams, getCreateOrderStructHash,
  computeCreateOrderDigest, encodeSubaccountCreateOrderCalldata, SUBACCOUNT_CREATE_ORDER_ABI,
  hashSubaccountApprovalStruct, SUBACCOUNT_APPROVAL_STRUCT_ABI, type SubaccountApprovalStruct,
} from '../lib/gmxCreateOrder';
import { requireOperatorAuth, isOperatorPinConfigured } from '../lib/operatorAuthGuard';
import { buildMinimalRelayParams } from '../lib/gmxEip712';

// ── fixtures (공개 테스트 키만) ──────────────────────────────────────────────

const owner  = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const other  = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const signer = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const ROUTER = '0xfD0596f708d9D950E0eF7b5d191e5F8e55b8a67f' as Address;
const MARKET = '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336' as Address;
const USDC   = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as Address;
const NOW    = 1_800_000_000n;

const ENV_SAVE: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ['SESSION_SECRET', 'GMX_WALLET_ADDRESS', 'OPERATOR_MASTER_PIN']) ENV_SAVE[k] = process.env[k];
  process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef-XYZ';
  process.env.GMX_WALLET_ADDRESS = owner.address;
});
afterAll(() => {
  for (const [k, v] of Object.entries(ENV_SAVE)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
beforeEach(() => { store.rows = []; store.failInsert = false; store.failUpdate = false; });

async function prepare(nonce = 5n) {
  return prepareApprovalSession({
    mainAccount: owner.address, subaccount: signer.address,
    verifyingContract: ROUTER, canonicalNonce: nonce, nowSec: NOW,
  });
}

async function signPrepared(p: Awaited<ReturnType<typeof prepare>>, account = owner) {
  if (!p.ok) throw new Error('prepare failed');
  const s = p.prepared.summary;
  return account.signTypedData(buildSubaccountApprovalTypedData({
    chainId: s.chainId, verifyingContract: s.verifyingContract,
    approval: {
      subaccount: s.subaccount, shouldAdd: s.shouldAdd,
      expiresAt: BigInt(s.expiresAt), maxAllowedCount: BigInt(s.maxAllowedCount),
      actionType: s.actionType, nonce: BigInt(s.nonce), desChainId: BigInt(s.desChainId),
      deadline: BigInt(s.deadline), integrationId: s.integrationId,
    },
  }));
}

// ── 암호화 회귀 ──────────────────────────────────────────────────────────────

describe('encryptSensitiveHex — capability 암호화 회귀', () => {
  it('round-trip, 무작위 salt/iv, 평문 미포함', () => {
    const sig = `0x${'ab'.repeat(65)}`;
    const e1 = encryptSensitiveHex(sig);
    const e2 = encryptSensitiveHex(sig);
    expect(e1).not.toBe(e2);                       // salt/iv 무작위
    expect(e1).not.toContain('ab'.repeat(65));     // 평문 미포함
    expect(decryptSensitiveHex(e1)).toBe(sig);
    expect(decryptSensitiveHex(e2)).toBe(sig);
  });
});

// ── prepare ──────────────────────────────────────────────────────────────────

describe('prepareApprovalSession', () => {
  it('기본값: expiry 1h, maxAllowedCount canonical 8, deadline 10분, 서버 고정 필드', async () => {
    const r = await prepare();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.prepared.summary;
    expect(BigInt(s.expiresAt)).toBe(NOW + 3600n);
    expect(s.maxAllowedCount).toBe('8');
    expect(BigInt(s.deadline)).toBe(NOW + 600n);
    expect(s.actionType).toBe(SUBACCOUNT_ORDER_ACTION);
    expect(s.chainId).toBe(42161);
    expect(s.desChainId).toBe('42161');
    expect(s.integrationId).toBe(DEFAULT_INTEGRATION_ID);
    expect(s.nonce).toBe('5');
    // 저장 확인 + 서명 필드 없음
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].status).toBe(SESSION_STATUS.PREPARED);
    expect(store.rows[0].encryptedSignature).toBeNull();
    expect(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('encryptedSignature');
  });

  it('invalidate+insert는 db.transaction 안에서 실행 (경합 시 DB unique index가 최종 방어)', async () => {
    const before = store.txCalls;
    const r = await prepare();
    expect(r.ok).toBe(true);
    expect(store.txCalls).toBe(before + 1);
  });

  it('트랜잭션 내 insert 실패(활성 세션 unique 충돌 등) → prepare 전체 fail-closed', async () => {
    store.failInsert = true;
    const r = await prepare();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('fail-closed');
    expect(store.rows.filter((x) => x.status === SESSION_STATUS.PREPARED)).toHaveLength(0);
  });

  it('허용 범위 밖 요청: expiry는 클램프(≤1h), count는 클라이언트 무시 → canonical 8', async () => {
    const r = await prepareApprovalSession({
      mainAccount: owner.address, subaccount: signer.address, verifyingContract: ROUTER,
      canonicalNonce: 0n, nowSec: NOW,
      requestedExpirySeconds: 86400, requestedMaxAllowedCount: 999,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(BigInt(r.prepared.summary.expiresAt)).toBe(NOW + BigInt(APPROVAL_LIMITS.MAX_EXPIRY_SECONDS));
    // 클라이언트 요청값(999)은 신뢰하지 않는다 — 항상 canonical 8
    expect(r.prepared.summary.maxAllowedCount).toBe(APPROVAL_LIMITS.CANONICAL_MAX_ALLOWED_COUNT.toString());
  });

  it('클라이언트가 2/6/9를 요청해도 서버는 canonical 8 생성 (임의값 불신)', async () => {
    for (const req of [2, 6, 9]) {
      const r = await prepareApprovalSession({
        mainAccount: owner.address, subaccount: signer.address, verifyingContract: ROUTER,
        canonicalNonce: 0n, nowSec: NOW, requestedMaxAllowedCount: req,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.prepared.summary.maxAllowedCount).toBe('8');
    }
  });

  it('새 prepare는 기존 PREPARED/READY 세션을 INVALIDATED로 대체', async () => {
    await prepare();
    await prepare();
    const statuses = store.rows.map((r) => r.status);
    expect(statuses.filter((s) => s === SESSION_STATUS.PREPARED)).toHaveLength(1);
    expect(statuses.filter((s) => s === SESSION_STATUS.INVALIDATED)).toHaveLength(1);
  });

  it('DB 저장 실패 → ok:false (fail-closed)', async () => {
    store.failInsert = true;
    const r = await prepare();
    expect(r.ok).toBe(false);
  });

  it('GMX_WALLET_ADDRESS 형식 검증', () => {
    expect(getConfiguredMainAccount()).toBe(owner.address);
    process.env.GMX_WALLET_ADDRESS = 'not-an-address';
    expect(getConfiguredMainAccount()).toBeNull();
    process.env.GMX_WALLET_ADDRESS = owner.address;
  });
});

// ── 서명 제출 ────────────────────────────────────────────────────────────────

describe('submitApprovalSignature', () => {
  it('정상: owner 서명 → OWNER_SIGNATURE_READY, 서명은 암호문으로만 저장', async () => {
    const p = await prepare();
    const sig = await signPrepared(p);
    if (!p.ok) return;
    const r = await submitApprovalSignature({
      sessionId: p.prepared.sessionId, signature: sig as Hex,
      canonicalNonce: 5n, expectedOwner: owner.address, nowSec: NOW,
    });
    expect(r).toMatchObject({ ok: true, status: SESSION_STATUS.OWNER_SIGNATURE_READY });
    const row = store.rows[0];
    expect(row.status).toBe(SESSION_STATUS.OWNER_SIGNATURE_READY);
    expect(row.encryptedSignature).toBeTruthy();
    expect(row.encryptedSignature).not.toBe(sig);                        // 평문 저장 금지
    expect(String(row.encryptedSignature)).not.toContain(sig.slice(2, 40)); // 평문 조각 미포함
    expect(decryptSensitiveHex(String(row.encryptedSignature))).toBe(sig);
    // 응답에 서명·암호문 없음
    expect(JSON.stringify(r)).not.toContain(sig.slice(2, 20));
  });

  it('다른 계정 서명 → 거부, 상태 PREPARED 유지', async () => {
    const p = await prepare();
    const sig = await signPrepared(p, other);
    if (!p.ok) return;
    const r = await submitApprovalSignature({
      sessionId: p.prepared.sessionId, signature: sig as Hex,
      canonicalNonce: 5n, expectedOwner: owner.address, nowSec: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('서명');
    // #134 — 검증 실패 세션은 재사용 금지: INVALIDATED로 전환, 서명은 저장되지 않음
    expect(store.rows[0].status).toBe(SESSION_STATUS.INVALIDATED);
    expect(store.rows[0].encryptedSignature).toBeNull();
  });

  it('레거시 세션(maxAllowedCount=2) → 서명 저장 거부 + INVALIDATED (canonical 8 불변식)', async () => {
    const p = await prepare();
    const sig = await signPrepared(p);
    if (!p.ok) return;
    store.rows[0].maxAllowedCount = '2';   // 정책 변경(2→8) 이전 생성 세션 시뮬레이션
    const r = await submitApprovalSignature({
      sessionId: p.prepared.sessionId, signature: sig as Hex,
      canonicalNonce: 5n, expectedOwner: owner.address, nowSec: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('canonical');
    expect(store.rows[0].status).toBe(SESSION_STATUS.INVALIDATED);
    expect(store.rows[0].encryptedSignature).toBeNull();
  });

  it('레거시 READY 세션(maxAllowedCount=2) → getActiveReadySession이 즉시 무효화 후 null', async () => {
    const p = await prepare();
    const sig = await signPrepared(p);
    if (!p.ok) return;
    const ok = await submitApprovalSignature({
      sessionId: p.prepared.sessionId, signature: sig as Hex,
      canonicalNonce: 5n, expectedOwner: owner.address, nowSec: NOW,
    });
    expect(ok.ok).toBe(true);
    store.rows[0].maxAllowedCount = '2';   // READY 상태의 레거시 값 시뮬레이션
    const active = await getActiveReadySession({
      expectedOwner: owner.address, expectedSubaccount: signer.address, canonicalNonce: 5n,
    });
    expect(active).toBeNull();
    expect(store.rows[0].status).toBe(SESSION_STATUS.INVALIDATED);
  });

  it('canonical nonce 변경 → 세션 INVALIDATED, 저장 거부', async () => {
    const p = await prepare(5n);
    const sig = await signPrepared(p);
    if (!p.ok) return;
    const r = await submitApprovalSignature({
      sessionId: p.prepared.sessionId, signature: sig as Hex,
      canonicalNonce: 6n, expectedOwner: owner.address, nowSec: NOW,
    });
    expect(r.ok).toBe(false);
    expect(store.rows[0].status).toBe(SESSION_STATUS.INVALIDATED);
  });

  it('deadline 경과 → 거부 + 무효화', async () => {
    const p = await prepare();
    const sig = await signPrepared(p);
    if (!p.ok) return;
    const r = await submitApprovalSignature({
      sessionId: p.prepared.sessionId, signature: sig as Hex,
      canonicalNonce: 5n, expectedOwner: owner.address, nowSec: NOW + 601n,
    });
    expect(r.ok).toBe(false);
    expect(store.rows[0].status).toBe(SESSION_STATUS.INVALIDATED);
  });

  it('#134 durable claim-first: 검증 실패 세션은 재제출해도 절대 READY가 될 수 없다', async () => {
    const p = await prepare();
    if (!p.ok) return;
    const bad = await signPrepared(p, other);
    const r1 = await submitApprovalSignature({
      sessionId: p.prepared.sessionId, signature: bad as Hex,
      canonicalNonce: 5n, expectedOwner: owner.address, nowSec: NOW,
    });
    expect(r1.ok).toBe(false);
    expect(store.rows[0].status).toBe(SESSION_STATUS.INVALIDATED);
    // 올바른 owner 서명으로 재제출해도 거부 (세션 터미널)
    const good = await signPrepared(p, owner);
    const r2 = await submitApprovalSignature({
      sessionId: p.prepared.sessionId, signature: good as Hex,
      canonicalNonce: 5n, expectedOwner: owner.address, nowSec: NOW,
    });
    expect(r2.ok).toBe(false);
    expect(store.rows[0].status).toBe(SESSION_STATUS.INVALIDATED);
    expect(store.rows[0].encryptedSignature).toBeNull();
  });

  it('#134 claim 저장 실패(DB 불능) → 서명 검증 자체를 시도하지 않고 fail-closed', async () => {
    const p = await prepare();
    const sig = await signPrepared(p);
    if (!p.ok) return;
    store.failUpdate = true;
    const r = await submitApprovalSignature({
      sessionId: p.prepared.sessionId, signature: sig as Hex,
      canonicalNonce: 5n, expectedOwner: owner.address, nowSec: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('클레임');
    expect(store.rows[0].encryptedSignature).toBeNull();
    // DB 복구 후 정상 owner 서명 제출은 여전히 가능 (검증 실패가 아니었으므로)
    store.failUpdate = false;
    const r2 = await submitApprovalSignature({
      sessionId: p.prepared.sessionId, signature: sig as Hex,
      canonicalNonce: 5n, expectedOwner: owner.address, nowSec: NOW,
    });
    expect(r2.ok).toBe(true);
    expect(store.rows[0].status).toBe(SESSION_STATUS.OWNER_SIGNATURE_READY);
  });

  it('#134 정상 제출 후 세션은 READY이며 invalidReason은 비어 있다', async () => {
    const p = await prepare();
    const sig = await signPrepared(p);
    if (!p.ok) return;
    const r = await submitApprovalSignature({
      sessionId: p.prepared.sessionId, signature: sig as Hex,
      canonicalNonce: 5n, expectedOwner: owner.address, nowSec: NOW,
    });
    expect(r.ok).toBe(true);
    expect(store.rows[0].status).toBe(SESSION_STATUS.OWNER_SIGNATURE_READY);
    expect(store.rows[0].invalidReason).toBeNull();
  });

  it('#134 레거시 digest 스킴(v1 재래핑) 세션 → 명확한 사유로 INVALIDATED, 재사용 불가', async () => {
    const p = await prepare();
    const sig = await signPrepared(p);
    if (!p.ok) return;
    // v1 스킴 시뮬레이션: canonical digest를 0x1901 재래핑한 값으로 교체
    const { computeGmxRelayDomainSeparator, computeRelayDigest } = await import('../lib/gmxEip712');
    const ds = computeGmxRelayDomainSeparator(42161, ROUTER);
    store.rows[0].typedDataDigest = computeRelayDigest(ds, String(store.rows[0].typedDataDigest) as Hex);
    const r = await submitApprovalSignature({
      sessionId: p.prepared.sessionId, signature: sig as Hex,
      canonicalNonce: 5n, expectedOwner: owner.address, nowSec: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('구버전');
    expect(store.rows[0].status).toBe(SESSION_STATUS.INVALIDATED);
    expect(String(store.rows[0].invalidReason)).toContain('레거시');
  });

  it('#134 clientDigest 제공 시 불일치 오류에 client/server digest 일치 여부 포함', async () => {
    const p = await prepare();
    const sig = await signPrepared(p, other);   // 잘못된 계정 서명
    if (!p.ok) return;
    const r = await submitApprovalSignature({
      sessionId: p.prepared.sessionId, signature: sig as Hex,
      canonicalNonce: 5n, expectedOwner: owner.address, nowSec: NOW,
      clientDigest: p.prepared.digest,   // 브라우저가 같은 typedData를 해싱한 경우
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('client/server digest 일치');
      expect(r.reason).toContain('세션 무효화됨');
      expect(r.reason).toContain(other.address.toLowerCase());   // recovered 공개주소
    }
    // 다른 digest를 보낸 경우 → 불일치 표기
    const p2 = await prepare();
    const sig2 = await signPrepared(p2, other);
    if (!p2.ok) return;
    const r2 = await submitApprovalSignature({
      sessionId: p2.prepared.sessionId, signature: sig2 as Hex,
      canonicalNonce: 5n, expectedOwner: owner.address, nowSec: NOW,
      clientDigest: `0x${'ff'.repeat(32)}` as Hex,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain('digest 불일치');
  });

  it('#134 prepare가 저장하는 typedDataDigest = canonical hashTypedData 원형', async () => {
    const p = await prepare();
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const { hashSubaccountApproval } = await import('../lib/gmxEip712');
    const s = p.prepared.summary;
    const canonical = hashSubaccountApproval({
      chainId: s.chainId, verifyingContract: s.verifyingContract,
      approval: {
        subaccount: s.subaccount, shouldAdd: s.shouldAdd,
        expiresAt: BigInt(s.expiresAt), maxAllowedCount: BigInt(s.maxAllowedCount),
        actionType: s.actionType, nonce: BigInt(s.nonce), desChainId: BigInt(s.desChainId),
        deadline: BigInt(s.deadline), integrationId: s.integrationId,
      },
    });
    expect(store.rows[0].typedDataDigest).toBe(canonical);
    expect(p.prepared.digest).toBe(canonical);
  });

  it('세션 필드 변조(expiresAt) → digest 불일치 거부', async () => {
    const p = await prepare();
    const sig = await signPrepared(p);
    if (!p.ok) return;
    store.rows[0].expiresAt = (NOW + 999999n).toString();   // 변조
    const r = await submitApprovalSignature({
      sessionId: p.prepared.sessionId, signature: sig as Hex,
      canonicalNonce: 5n, expectedOwner: owner.address, nowSec: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('무결성');
  });

  it('저장(UPDATE) 실패 → READY 전환 실패 반환 (fail-closed)', async () => {
    const p = await prepare();
    const sig = await signPrepared(p);
    if (!p.ok) return;
    store.failUpdate = true;
    const r = await submitApprovalSignature({
      sessionId: p.prepared.sessionId, signature: sig as Hex,
      canonicalNonce: 5n, expectedOwner: owner.address, nowSec: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('저장');
  });

  it('PREPARED가 아닌 세션에는 제출 불가', async () => {
    const p = await prepare();
    if (!p.ok) return;
    store.rows[0].status = SESSION_STATUS.INVALIDATED;
    const sig = await signPrepared(p);
    const r = await submitApprovalSignature({
      sessionId: p.prepared.sessionId, signature: sig as Hex,
      canonicalNonce: 5n, expectedOwner: owner.address, nowSec: NOW,
    });
    expect(r.ok).toBe(false);
  });
});

// ── READY 세션 무효화 규칙 ───────────────────────────────────────────────────

describe('getActiveReadySession — account/signer/nonce 변경 시 무효', () => {
  async function makeReady() {
    const p = await prepare();
    const sig = await signPrepared(p);
    if (!p.ok) throw new Error('unreachable');
    await submitApprovalSignature({
      sessionId: p.prepared.sessionId, signature: sig as Hex,
      canonicalNonce: 5n, expectedOwner: owner.address, nowSec: NOW,
    });
  }

  it('일치 → 요약 반환 (서명·암호문 미포함)', async () => {
    await makeReady();
    const s = await getActiveReadySession({
      expectedOwner: owner.address, expectedSubaccount: signer.address, canonicalNonce: 5n,
    });
    expect(s).toMatchObject({ status: SESSION_STATUS.OWNER_SIGNATURE_READY, approvalNonce: '5' });
    expect(JSON.stringify(s)).not.toContain('ignature');   // signature/encryptedSignature 키 없음
  });

  it('nonce 변경 → null + INVALIDATED', async () => {
    await makeReady();
    expect(await getActiveReadySession({
      expectedOwner: owner.address, expectedSubaccount: signer.address, canonicalNonce: 6n,
    })).toBeNull();
    expect(store.rows[0].status).toBe(SESSION_STATUS.INVALIDATED);
  });

  it('main account 변경 → null + INVALIDATED', async () => {
    await makeReady();
    expect(await getActiveReadySession({
      expectedOwner: other.address, expectedSubaccount: signer.address, canonicalNonce: 5n,
    })).toBeNull();
    expect(store.rows[0].status).toBe(SESSION_STATUS.INVALIDATED);
  });

  it('signer 변경 → null + INVALIDATED', async () => {
    await makeReady();
    expect(await getActiveReadySession({
      expectedOwner: owner.address, expectedSubaccount: other.address, canonicalNonce: 5n,
    })).toBeNull();
    expect(store.rows[0].status).toBe(SESSION_STATUS.INVALIDATED);
  });

  it('canonical 미확인(null nonce) → 무효화하지 않고 요약 반환', async () => {
    await makeReady();
    const s = await getActiveReadySession({
      expectedOwner: owner.address, expectedSubaccount: signer.address, canonicalNonce: null,
    });
    expect(s).not.toBeNull();
    expect(store.rows[0].status).toBe(SESSION_STATUS.OWNER_SIGNATURE_READY);
  });

  it('만료 READY → null이지만 DB 상태는 변경하지 않음', async () => {
    await makeReady();
    store.rows[0].expiresAt = '1';
    const s = await getActiveReadySession({
      expectedOwner: owner.address,
      expectedSubaccount: signer.address,
      canonicalNonce: 5n,
      persistInvalidation: false,
    });
    expect(s).toBeNull();
    expect(store.rows[0].status).toBe(SESSION_STATUS.OWNER_SIGNATURE_READY);
    expect(store.rows[0].invalidReason).toBeNull();
  });

  it('read-only 상태 조회 옵션은 불일치도 null 처리하되 DB를 변경하지 않음', async () => {
    await makeReady();
    const s = await getActiveReadySession({
      expectedOwner: other.address,
      expectedSubaccount: signer.address,
      canonicalNonce: 5n,
      persistInvalidation: false,
    });
    expect(s).toBeNull();
    expect(store.rows[0].status).toBe(SESSION_STATUS.OWNER_SIGNATURE_READY);
    expect(store.rows[0].invalidReason).toBeNull();
  });
});

// ── 상태 판정: disabled 플래그·블록 timestamp ────────────────────────────────

describe('subaccountAuthState — 2단계 확장', () => {
  const oc = (over: object = {}) => ({
    isSubaccountListed: true, expiresAt: NOW + 1000n, maxAllowedCount: 10n,
    usedCount: 0n, remaining: 10n, integrationId: DEFAULT_INTEGRATION_ID as Hex,
    approvalNonce: 0n, featureDisabled: false, integrationDisabled: false,
    blockTimestamp: null as bigint | null, ...over,
  });
  const base = {
    relayConfigured: true, signerInitialized: true, delegatedSignerEnabled: true,
    onchain: oc(), onchainError: null, nowSec: NOW,
  };

  it('featureDisabled/integrationDisabled → REVOKED (AUTHORIZED 금지)', () => {
    expect(deriveSubaccountAuthState({ ...base, onchain: oc({ featureDisabled: true }) })).toBe('REVOKED');
    expect(deriveSubaccountAuthState({ ...base, onchain: oc({ integrationDisabled: true }) })).toBe('REVOKED');
  });

  it('만료 판정은 block timestamp 우선', () => {
    // 서버 시각으로는 미만료지만 블록 timestamp 기준 만료 → EXPIRED
    expect(deriveSubaccountAuthState({
      ...base, nowSec: NOW,
      onchain: oc({ expiresAt: NOW + 500n, blockTimestamp: NOW + 501n }),
    })).toBe('EXPIRED');
    // 블록 timestamp 기준 미만료 → AUTHORIZED
    expect(deriveSubaccountAuthState({
      ...base, nowSec: NOW + 99999n,
      onchain: oc({ expiresAt: NOW + 500n, blockTimestamp: NOW + 499n }),
    })).toBe('AUTHORIZED');
  });

  it('canonical 활성(등록·미만료·잔여) → AUTHORIZED', () => {
    expect(deriveSubaccountAuthState(base)).toBe('AUTHORIZED');
  });
});

// ── CreateOrder 빌더 ─────────────────────────────────────────────────────────

describe('gmxCreateOrder — 공식 RelayUtils 골든 대조', () => {
  it('typehash 골든 (공식 문자열 keccak — 2026-08-17 gmx-synthetics main 확인)', () => {
    expect(CREATE_ORDER_ADDRESSES_TYPEHASH).toBe('0xde704835c57129426155af0162e85abf288035e1b0a3852c3fce9a24af66508d');
    expect(CREATE_ORDER_NUMBERS_TYPEHASH).toBe('0xeb86c2c0ab6cd8ca4087c84503a7b3ce29a1bcd4c762b59237fc7f4fa529c36b');
    expect(CREATE_ORDER_TYPEHASH).toBe('0x781a77007b52cd3aa5b96051a970c8802ab8933799563988b2d2b90d285a6b13');
  });

  function approvalStruct(): SubaccountApprovalStruct {
    return {
      subaccount: signer.address, shouldAdd: true, expiresAt: NOW + 3600n,
      maxAllowedCount: 2n, actionType: SUBACCOUNT_ORDER_ACTION, nonce: 5n,
      desChainId: 42161n, deadline: NOW + 600n, integrationId: DEFAULT_INTEGRATION_ID,
      signature: `0x${'ab'.repeat(65)}` as Hex,
    };
  }
  const relayParams = buildMinimalRelayParams({
    feeToken: USDC, feeAmount: 1000n, userNonce: 7n, deadline: NOW + 300n,
  });
  const openInput = {
    mainAccount: owner.address, market: MARKET, collateralToken: USDC,
    sizeDeltaUsd: 10n ** 31n, initialCollateralDeltaAmount: 100_000_000n,
    acceptablePrice: 5n * 10n ** 30n, executionFee: 10n ** 15n, isLong: true,
  };

  it('OPEN=MarketIncrease, CLOSE=MarketDecrease, receiver=main account 강제', () => {
    const open = buildOpenOrderParams(openInput);
    expect(open.orderType).toBe(ORDER_TYPE.MarketIncrease);
    expect(open.addresses.receiver).toBe(owner.address);
    expect(open.addresses.cancellationReceiver).toBe(owner.address);
    const close = buildCloseOrderParams({ ...openInput, initialCollateralDeltaAmount: 0n });
    expect(close.orderType).toBe(ORDER_TYPE.MarketDecrease);
    expect(close.addresses.receiver).toBe(owner.address);
  });

  it('subaccountApprovalHash = keccak(abi.encode(struct — signature 포함))', () => {
    const a = approvalStruct();
    const expected = keccak256(encodeAbiParameters(SUBACCOUNT_APPROVAL_STRUCT_ABI, [a]));
    expect(hashSubaccountApprovalStruct(a)).toBe(expected);
    // signature가 다르면 해시도 달라진다 (공식 abi.encode에는 signature 포함)
    expect(hashSubaccountApprovalStruct({ ...a, signature: `0x${'cd'.repeat(65)}` as Hex }))
      .not.toBe(expected);
  });

  it('struct hash·digest 결정적이며 모든 입력 필드에 민감', () => {
    const order = buildOpenOrderParams(openInput);
    const args = { relayParams, subaccountApproval: approvalStruct(), account: owner.address, order };
    const h1 = getCreateOrderStructHash(args);
    expect(getCreateOrderStructHash(args)).toBe(h1);
    expect(getCreateOrderStructHash({ ...args, account: other.address })).not.toBe(h1);
    expect(getCreateOrderStructHash({ ...args, order: { ...order, isLong: false } })).not.toBe(h1);
    expect(getCreateOrderStructHash({
      ...args, relayParams: { ...relayParams, userNonce: 8n },
    })).not.toBe(h1);

    const d = computeCreateOrderDigest({ chainId: 42161, verifyingContract: ROUTER, ...args });
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
    expect(computeCreateOrderDigest({ chainId: 42161, verifyingContract: ROUTER, ...args })).toBe(d);
    expect(computeCreateOrderDigest({ chainId: 1, verifyingContract: ROUTER, ...args })).not.toBe(d);
  });

  it('calldata round-trip — decodeFunctionData로 원복', () => {
    const order = buildOpenOrderParams(openInput);
    const data = encodeSubaccountCreateOrderCalldata({
      relayParams, relaySignature: `0x${'ef'.repeat(65)}` as Hex,
      subaccountApproval: approvalStruct(), account: owner.address,
      subaccount: signer.address, order,
    });
    const decoded = decodeFunctionData({ abi: SUBACCOUNT_CREATE_ORDER_ABI, data });
    expect(decoded.functionName).toBe('createOrder');
    const [rp, sa, account, subaccount, params] = decoded.args as unknown as [
      { userNonce: bigint }, { nonce: bigint }, Address, Address, { orderType: number },
    ];
    expect(rp.userNonce).toBe(7n);
    expect(sa.nonce).toBe(5n);
    expect(account.toLowerCase()).toBe(owner.address.toLowerCase());
    expect(subaccount.toLowerCase()).toBe(signer.address.toLowerCase());
    expect(params.orderType).toBe(2);   // MarketIncrease
  });

  it('receiver ≠ main account → throw (fail-closed)', () => {
    const order = buildOpenOrderParams(openInput);
    order.addresses.receiver = other.address;
    expect(() => encodeSubaccountCreateOrderCalldata({
      relayParams, relaySignature: `0x${'ef'.repeat(65)}` as Hex,
      subaccountApproval: approvalStruct(), account: owner.address,
      subaccount: signer.address, order,
    })).toThrow(/receiver/);
  });

  it('externalCalls 비어 있지 않으면 → throw (fail-closed)', () => {
    const order = buildOpenOrderParams(openInput);
    const rp = {
      ...relayParams,
      externalCalls: { ...relayParams.externalCalls, externalCallTargets: [other.address] },
    };
    expect(() => encodeSubaccountCreateOrderCalldata({
      relayParams: rp, relaySignature: `0x${'ef'.repeat(65)}` as Hex,
      subaccountApproval: approvalStruct(), account: owner.address,
      subaccount: signer.address, order,
    })).toThrow(/externalCalls/);
  });
});

// ── 운영자 인증 가드 ─────────────────────────────────────────────────────────

describe('canonical RPC 오류 비밀 비노출 회귀', () => {
  it('sanitizeRpcError — viem 스타일 예외의 endpoint URL·GMX_RPC_URL 값 마스킹', async () => {
    const { sanitizeRpcError } = await import('../lib/rpcErrorSanitize');
    const prev = process.env.GMX_RPC_URL;
    process.env.GMX_RPC_URL = 'https://arb.example.com/v2/super-secret-token';
    try {
      const e = new Error('HTTP request failed. URL: https://arb.example.com/v2/super-secret-token Details: timeout');
      const out = sanitizeRpcError(e);
      expect(out).not.toContain('super-secret-token');
      expect(out).not.toContain('https://');
      expect(out).toContain('[URL 제거됨]');
    } finally {
      process.env.GMX_RPC_URL = prev;
    }
  });

  it('livetest route의 canonical nonce 실패 응답은 sanitizeRpcError를 경유 (raw message 반환 금지)', async () => {
    // 소스 가드 회귀 테스트: prepare/signature 핸들러의 nonce 조회 catch가
    // raw (e as Error).message를 응답에 넣는 회귀를 차단한다.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(path.resolve(__dirname, '../routes/livetest.ts'), 'utf8');
    const nonceCatches = src.match(/canonical nonce 조회 실패[^`]*\$\{([^}]+)\}/g) ?? [];
    expect(nonceCatches.length).toBeGreaterThanOrEqual(2);
    for (const m of nonceCatches) expect(m).toContain('sanitizeRpcError');
    expect(src).not.toMatch(/canonical nonce 조회 실패[^`]*\$\{\(e as Error\)\.message\}/);
  });
});

describe('operatorAuthGuard', () => {
  function run(headers: Record<string, string>, method = 'POST') {
    const res = { statusCode: 0, body: null as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    let nexted = false;
    requireOperatorAuth(
      { headers, method } as never,
      res as never,
      () => { nexted = true; },
    );
    return { res, nexted };
  }

  it('PIN 미설정 → 503 fail-closed (열림 금지)', () => {
    delete process.env.OPERATOR_MASTER_PIN;
    expect(isOperatorPinConfigured()).toBe(false);
    const { res, nexted } = run({ 'content-type': 'application/json', 'x-operator-pin': 'anything' });
    expect(res.statusCode).toBe(503);
    expect(nexted).toBe(false);
  });

  it('오인증 → 401, 올바른 PIN → next()', () => {
    process.env.OPERATOR_MASTER_PIN = 'correct-horse-battery';
    const bad = run({ 'content-type': 'application/json', 'x-operator-pin': 'wrong-pin-value' });
    expect(bad.res.statusCode).toBe(401);
    expect(bad.nexted).toBe(false);
    const good = run({ 'content-type': 'application/json', 'x-operator-pin': 'correct-horse-battery' });
    expect(good.nexted).toBe(true);
    delete process.env.OPERATOR_MASTER_PIN;
  });

  it('JSON 아닌 content-type → 415 (CSRF 방어), 헤더 누락 → 401', () => {
    process.env.OPERATOR_MASTER_PIN = 'correct-horse-battery';
    const form = run({ 'content-type': 'application/x-www-form-urlencoded', 'x-operator-pin': 'correct-horse-battery' });
    expect(form.res.statusCode).toBe(415);
    const missing = run({ 'content-type': 'application/json' });
    expect(missing.res.statusCode).toBe(401);
    delete process.env.OPERATOR_MASTER_PIN;
  });
});
