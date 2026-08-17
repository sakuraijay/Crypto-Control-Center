/**
 * 6G-2 리뷰 반영 — typed data 의미 결속(adversarial) + 자기 intent 게이트 제외.
 *
 * Critical: 허용된 주소만 사용한 "다른 주문"(방향 반전·사이즈 변조·다른 시장·
 * 스왑 경유)의 digest에 서명하는 경로가 없어야 한다.
 * High: 실행 흐름이 방금 생성한 자기 intent가 blocking count에 포함되어
 * 자기 gate를 영구 차단하지 않아야 한다 (타 intent는 여전히 차단).
 */
import { vi, describe, it, expect } from 'vitest';

// DB 미접속 격리 mock
vi.mock('@workspace/db', () => {
  const rowsRef: { rows: Array<{ id: string }> } = { rows: [] };
  function chain(getResult: () => unknown) {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'offset', 'orderBy', 'set', 'values',
                     'onConflictDoNothing', 'onConflictDoUpdate', 'returning']) {
      c[m] = () => c;
    }
    (c as { then(r: (v: unknown) => unknown): Promise<unknown> }).then =
      (resolve) => Promise.resolve(getResult()).then(resolve);
    return c;
  }
  return {
    __rowsRef: rowsRef,
    db: {
      select: () => chain(() => rowsRef.rows),
      insert: () => chain(() => []),
      update: () => chain(() => []),
      delete: () => chain(() => []),
    },
    tradesTable: {}, strategyConfigTable: {}, aiDecisionsTable: {},
    liveApprovalsTable: {}, workerStateTable: {}, relayTasksTable: {},
    subaccountApprovalSessionsTable: {},
    executionIntentsTable: { id: 'id', status: 'status' },
    runMigrations: vi.fn(async () => {}),
  };
});

import {
  verifyOrderSemanticBinding, verifyOrderTypedDataBinding,
  sizeDeltaUsdString, collateralAmountString,
  type GmxOrderRequest,
} from '../lib/gmxApiExecution';
import { countBlockingIntentsOrNull } from '../lib/executionIntents';
import type { PreparedOrderView } from '../lib/gmxApiOrders';

const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const MARKET = '0x47c031236e19d024b42f8AE6780E44A573170703';

const req: GmxOrderRequest = {
  kind: 'OPEN', symbol: 'BTC', marketAddress: MARKET, isLong: true,
  sizeUsd: 100, collateralUsd: 20,
  mainWallet: '0x1111111111111111111111111111111111111111',
  subaccountAddress: '0x2222222222222222222222222222222222222222',
};

function goodMessage(): Record<string, unknown> {
  return {
    params: {
      addresses: { market: MARKET, initialCollateralToken: USDC, receiver: req.mainWallet },
      numbers: { sizeDeltaUsd: sizeDeltaUsdString(100), initialCollateralDeltaAmount: collateralAmountString(20) },
      orderType: 2,
      isLong: true,
      swapPath: [],
    },
  };
}

describe('verifyOrderSemanticBinding — adversarial (Critical)', () => {
  it('정상 message → ok', () => {
    expect(verifyOrderSemanticBinding(goodMessage(), req).ok).toBe(true);
  });

  it('sizeDeltaUsd 변조 → 서명 금지', () => {
    const m = goodMessage();
    (m.params as Record<string, Record<string, unknown>>).numbers.sizeDeltaUsd = sizeDeltaUsdString(100000);
    const r = verifyOrderSemanticBinding(m, req);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/sizeDeltaUsd/);
  });

  it('isLong 반전 → 서명 금지', () => {
    const m = goodMessage();
    (m.params as Record<string, unknown>).isLong = false;
    expect(verifyOrderSemanticBinding(m, req).ok).toBe(false);
  });

  it('다른 시장 주소 → 서명 금지', () => {
    const m = goodMessage();
    (m.params as Record<string, Record<string, unknown>>).addresses.market =
      '0x3333333333333333333333333333333333333333';
    expect(verifyOrderSemanticBinding(m, req).ok).toBe(false);
  });

  it('orderType 불일치(OPEN인데 MarketDecrease=4) → 서명 금지', () => {
    const m = goodMessage();
    (m.params as Record<string, unknown>).orderType = 4;
    expect(verifyOrderSemanticBinding(m, req).ok).toBe(false);
  });

  it('collateral token이 USDC가 아님 → 서명 금지', () => {
    const m = goodMessage();
    (m.params as Record<string, Record<string, unknown>>).addresses.initialCollateralToken =
      '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
    expect(verifyOrderSemanticBinding(m, req).ok).toBe(false);
  });

  it('OPEN 담보 수량 변조 → 서명 금지', () => {
    const m = goodMessage();
    (m.params as Record<string, Record<string, unknown>>).numbers.initialCollateralDeltaAmount =
      collateralAmountString(20000);
    expect(verifyOrderSemanticBinding(m, req).ok).toBe(false);
  });

  it('swapPath 비어있지 않음 → 서명 금지', () => {
    const m = goodMessage();
    (m.params as Record<string, unknown>).swapPath = [USDC];
    expect(verifyOrderSemanticBinding(m, req).ok).toBe(false);
  });

  it('의미 필드 전부 부재(빈 message) → 서명 금지 (부재=통과 아님)', () => {
    const r = verifyOrderSemanticBinding({ foo: 'bar' }, req);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/부재/);
  });

  it('CLOSE 요청은 MarketDecrease(4)만 허용', () => {
    const closeReq: GmxOrderRequest = { ...req, kind: 'CLOSE', collateralUsd: 0 };
    const m = goodMessage();
    (m.params as Record<string, unknown>).orderType = 4;
    delete (m.params as Record<string, Record<string, unknown>>).numbers.initialCollateralDeltaAmount;
    expect(verifyOrderSemanticBinding(m, closeReq).ok).toBe(true);
    (m.params as Record<string, unknown>).orderType = 2;
    expect(verifyOrderSemanticBinding(m, closeReq).ok).toBe(false);
  });
});

describe('verifyOrderTypedDataBinding — primaryType 명시 필수', () => {
  it('primaryType 부재 → 추론 서명 금지', async () => {
    const { GMX_DEPLOYMENT_MANIFEST } = await import('../lib/gmxDeploymentManifest');
    const vc = (Object.values(GMX_DEPLOYMENT_MANIFEST.addresses) as string[])
      .find((v) => typeof v === 'string' && v.startsWith('0x'));
    const view = {
      requestId: 'r1', idempotencyKey: 'k1', mode: 'relay', payloadType: 'typedData',
      typedData: {
        domain: { chainId: 42161, verifyingContract: vc },
        types: { CreateOrder: [{ name: 'x', type: 'uint256' }] },
        message: goodMessage(),
        // primaryType 의도적 부재
      },
      from: req.mainWallet, subaccountAddress: req.subaccountAddress,
      orderKind: 'MarketIncrease', isLong: true,
      sizeDeltaUsd: sizeDeltaUsdString(100), collateralToken: USDC,
      receiver: req.mainWallet, executionFeeAmount: null,
    } as unknown as PreparedOrderView;
    const r = verifyOrderTypedDataBinding(view, req);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/primaryType/);
  });
});

describe('countBlockingIntentsOrNull — 자기 intent 제외 (High)', () => {
  it('자기 intent만 존재 → 0; 타 intent 존재 → 계속 차단', async () => {
    const dbMod = await import('@workspace/db') as unknown as { __rowsRef: { rows: Array<{ id: string }> } };
    dbMod.__rowsRef.rows = [{ id: 'intent-self' }];
    expect(await countBlockingIntentsOrNull('intent-self')).toBe(0);
    expect(await countBlockingIntentsOrNull()).toBe(1);
    dbMod.__rowsRef.rows = [{ id: 'intent-self' }, { id: 'intent-other' }];
    expect(await countBlockingIntentsOrNull('intent-self')).toBe(1);
  });
});
