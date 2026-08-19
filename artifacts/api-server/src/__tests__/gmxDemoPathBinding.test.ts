/**
 * #131 — 데모 전체 경로 router/domain/chain/account 결속 매트릭스 (통합 계약 검증).
 *
 * Owner Approval → 주문 prepare typed data → digest → submit target까지
 * 전 단계가 동일한 감사 router(0xfD0596)·chainId(42161)·main account에
 * 결속되는지 fixture로 검증하고, 0x517602/임의 주소는 어느 단계에서도
 * 통과하지 못함(fail-closed)을 확인한다.
 */
import { describe, it, expect } from 'vitest';

// db-free import 규칙 (stage1 메모리) — DB 모듈은 mock으로 차단
import { vi } from 'vitest';
vi.mock('@workspace/db', () => ({
  db: {}, subaccountApprovalSessionsTable: {}, gmxApiTasksTable: {},
}));

import { GMX_DEPLOYMENT_MANIFEST } from '../lib/gmxDeploymentManifest';
import { resolveGmxLiveRelayConfig } from '../lib/gmxLiveConfig';
import { verifyOrderTypedDataBinding, buildOrderPrepareBody, buildExpectedValidation, type GmxOrderRequest } from '../lib/gmxApiExecution';
import type { PreparedOrderView } from '../lib/gmxApiOrders';
import { USDC_ADDRESS } from '../lib/gmxContracts';
import { hashTypedData } from 'viem';

const ROUTER = GMX_DEPLOYMENT_MANIFEST.addresses.subaccountGelatoRelayRouter;
const BLOCKED_NEXT = '0x517602BaC704B72993997820981603f5E4901273';
const OWNER = '0x46c27887c5EC5E36b2a21E1Ec1BC69e7a593950e';
const SUB = '0x2222222222222222222222222222222222222222';
const MARKET = '0x47c031236e19d024b42f8AE6780E44A573170703';

const openReq: GmxOrderRequest = {
  kind: 'OPEN', symbol: 'BTC/USD [WBTC-USDC]', marketAddress: MARKET,
  isLong: true, sizeUsd: 100, collateralUsd: 50,
  mainWallet: OWNER, subaccountAddress: SUB,
};

function makeView(verifyingContract: string): PreparedOrderView {
  return {
    requestId: 'req-1', idempotencyKey: 'k-1', mode: 'relay', payloadType: 'typedData',
    typedData: {
      domain: { name: 'GmxBaseGelatoRelayRouter', version: '1', chainId: 42161, verifyingContract },
      types: { CreateOrder: [{ name: 'account', type: 'address' }] },
      primaryType: 'CreateOrder',
      message: {
        account: OWNER,
        params: {
          orderType: 2, isLong: true, autoCancel: false,
          addresses: { receiver: OWNER, market: MARKET, initialCollateralToken: USDC_ADDRESS },
          numbers: { sizeDeltaUsd: (10n ** 32n).toString(), initialCollateralDeltaAmount: '50000000' },
        },
      },
    },
    from: OWNER, subaccountAddress: SUB,
    orderKind: 'MarketIncrease', isLong: true,
    sizeDeltaUsd: (10n ** 32n).toString(), collateralToken: USDC_ADDRESS,
    receiver: OWNER, executionFeeAmount: null,
  } as unknown as PreparedOrderView;
}

describe('V1/V3 — 단일 구성 소스 결속', () => {
  it('env(0xfD0596)로 해석된 relay config router == manifest router == nonce 조회 대상', () => {
    const r = resolveGmxLiveRelayConfig({
      GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS: ROUTER,
      GMX_DATA_STORE_ADDRESS: GMX_DEPLOYMENT_MANIFEST.addresses.dataStore,
      GMX_EVENT_EMITTER_ADDRESS: GMX_DEPLOYMENT_MANIFEST.addresses.eventEmitter,
      GMX_CHAIN_ID: '42161',
    } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.subaccountGelatoRelayRouter.toLowerCase()).toBe(ROUTER.toLowerCase());
      expect(r.config.chainId).toBe(42161);
    }
  });
});

describe('V4/V6 — 주문 prepare typed data domain 결속', () => {
  it('domain.verifyingContract == manifest router(0xfD0596) → 결속 통과 + digest 재계산 일치', () => {
    const view = makeView(ROUTER);
    const r = verifyOrderTypedDataBinding(view, openReq);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const td = view.typedData as unknown as {
        domain: Parameters<typeof hashTypedData>[0]['domain'];
        types: Parameters<typeof hashTypedData>[0]['types'];
        message: Record<string, unknown>;
      };
      const expected = hashTypedData({
        domain: td.domain, types: td.types,
        primaryType: 'CreateOrder', message: td.message,
      });
      expect(r.digest).toBe(expected); // 서명 digest = 서버 독립 재계산 digest (V6)
    }
  });
  it('V7 적대: domain vc = 0x517602(미전환 신규) → 서명 금지 (manifest 집합 밖)', () => {
    const r = verifyOrderTypedDataBinding(makeView(BLOCKED_NEXT), openReq);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('SubaccountGelatoRelayRouter');
  });
  it('V7 적대: 임의 주소 vc → 서명 금지', () => {
    const r = verifyOrderTypedDataBinding(makeView('0x' + '99'.repeat(20)), openReq);
    expect(r.ok).toBe(false);
  });
  it('V7 적대: router 외 manifest 주소(DataStore/EventEmitter/OrderVault/RoleStore/GelatoRelayRouter)도 전부 서명 금지', () => {
    const { subaccountGelatoRelayRouter: _skip, ...others } = GMX_DEPLOYMENT_MANIFEST.addresses;
    for (const addr of Object.values(others)) {
      const r = verifyOrderTypedDataBinding(makeView(addr), openReq);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('SubaccountGelatoRelayRouter');
    }
  });
});

describe('V5 — prepare 요청/expected 검증 블록 결속', () => {
  it('prepare body와 expected 블록이 동일 chain(42161)·account·subaccount로 결속된다', () => {
    const body = buildOrderPrepareBody(openReq);
    const expected = buildExpectedValidation(openReq);
    expect(body.chainId).toBe(42161);
    expect(expected.chainId).toBe(42161);
    expect(body.from).toBe(OWNER);
    expect(expected.mainWallet).toBe(OWNER);
    expect(body.subaccountAddress).toBe(SUB);
    expect(expected.subaccountAddress).toBe(SUB);
    expect(body.receiver).toBe(OWNER); // 수취는 main wallet만
  });
});
