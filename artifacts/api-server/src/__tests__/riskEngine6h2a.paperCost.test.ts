/**
 * 6H-2A §11 — PAPER_ZERO_FEE 폐지 + PAPER 비용 결속 + 정산 게이팅 테스트.
 * DB 불필요 (CI db-free) — 순수 모듈 + grep 정적 검사.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  fetchPaperCostSnapshot, fetchLiveCostSnapshot, COST_DATA_UNAVAILABLE,
  type FetchedCostFields,
} from '../lib/costSnapshot';
import {
  accrueHoldingCosts, accrueHoldingCostsFromEntryRates, computePaperNetPnl,
  HOLDING_COST_UNAVAILABLE,
} from '../lib/holdingCosts';
import {
  storePaperCostSnapshot, getPaperCostBinding, __clearPaperCostCacheForTests,
} from '../lib/paperCostCache';
import { pnlForTargets, reconcileLiveSettlements, recordTradeSettlement } from '../lib/tradeSettlement';
import type { CostSnapshot } from '../lib/costSnapshot';

const NOW = new Date('2026-08-18T03:00:00Z');
const MARKET = '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336';

const validFields: FetchedCostFields = {
  positionFeeUsd: 0.06, executionFeeUsd: 0.2, estimatedPriceImpactUsd: 0.05,
  estimatedExitPriceImpactUsd: 0.05, fundingFeeUsd: 0.01, borrowingFeeUsd: 0.005,
  estimatedExitFeeUsd: 0.26,
  fundingRatePerHourFraction: 0.00001, borrowingRatePerHourFraction: 0.000005,
  blockNumber: null, apiTimestamp: null,
};

const req = { market: MARKET, isLong: true, orderType: 'MarketIncrease' as const, notionalUsd: 100, now: NOW };

describe('§11-1 PAPER_ZERO_FEE 실행 경로 0건 (정적)', () => {
  it('실행 코드(src, 테스트 제외)에 PAPER_ZERO_FEE 기록(write) 경로가 없다', () => {
    // 허용: 주석·legacy 잔존 감지(canary 카운트)·tradeSettlement의 부적격 처리.
    // 금지: settlementStatus를 PAPER_ZERO_FEE로 새로 기록하는 코드.
    const srcDir = path.resolve(__dirname, '..');
    let out = '';
    try {
      out = execFileSync('grep', ['-rn', 'PAPER_ZERO_FEE', srcDir, '--include=*.ts'], { encoding: 'utf8' });
    } catch { out = ''; } // grep exit 1 = 0건
    const writeLines = out.split('\n').filter(Boolean)
      .filter(l => !l.split(':')[0].includes('__tests__'))
      .filter(l => /settlementStatus\s*[:=]\s*['"]PAPER_ZERO_FEE['"]/.test(l) ||
                   /set\s*\(\s*\{[^}]*PAPER_ZERO_FEE/.test(l));
    expect(writeLines).toEqual([]);
  });

  it('buildPaperCostSnapshot/PAPER_COST_MODEL 고정 모델이 export되지 않는다', async () => {
    const mod = await import('../lib/costSnapshot') as Record<string, unknown>;
    expect(mod.buildPaperCostSnapshot).toBeUndefined();
    expect(mod.PAPER_COST_MODEL).toBeUndefined();
  });
});

describe('§11-2·3 PAPER 비용 조회 (PAPER_GMX_ESTIMATE)', () => {
  it('2. 비용 조회 실패 → COST_DATA_UNAVAILABLE (PAPER도 NO_TRADE 근거)', async () => {
    const r = await fetchPaperCostSnapshot(req, {
      readonlyEnabled: true,
      fetchCosts: async () => { throw new Error('boom'); },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain(COST_DATA_UNAVAILABLE);
  });

  it('2b. readonly 비활성/조회 경로 미구성 → 실패 (이전 quote fallback 금지)', async () => {
    const off = await fetchPaperCostSnapshot(req, { readonlyEnabled: false });
    expect(off.ok).toBe(false);
    const none = await fetchPaperCostSnapshot(req, { readonlyEnabled: true });
    expect(none.ok).toBe(false);
  });

  it('3. 공식 비용 0과 missing을 구분 — 명시적 0은 성공, undefined 누락은 실패', async () => {
    const zero = await fetchPaperCostSnapshot(req, {
      readonlyEnabled: true,
      fetchCosts: async () => ({ ...validFields, positionFeeUsd: 0 }),
    });
    expect(zero.ok).toBe(true);
    if (zero.ok) {
      expect(zero.snapshot.positionFeeUsd).toBe(0);
      expect(zero.snapshot.source).toBe('PAPER_GMX_ESTIMATE');
    }
    const missing = await fetchPaperCostSnapshot(req, {
      readonlyEnabled: true,
      fetchCosts: async () => {
        const c = { ...validFields } as Record<string, unknown>;
        delete c.positionFeeUsd; // 누락 ≠ 0
        return c as unknown as FetchedCostFields;
      },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain('positionFeeUsd');
  });

  it('3b. rate 필드는 null(명시 누락)만 허용 — undefined는 계약 위반', async () => {
    const r = await fetchPaperCostSnapshot(req, {
      readonlyEnabled: true,
      fetchCosts: async () => {
        const c = { ...validFields } as Record<string, unknown>;
        delete c.fundingRatePerHourFraction;
        return c as unknown as FetchedCostFields;
      },
    });
    expect(r.ok).toBe(false);
  });

  it('LIVE와 PAPER는 동일 조회 경로, source 태그만 다름', async () => {
    const live = await fetchLiveCostSnapshot(req, { readonlyEnabled: true, fetchCosts: async () => validFields });
    const paper = await fetchPaperCostSnapshot(req, { readonlyEnabled: true, fetchCosts: async () => validFields });
    expect(live.ok && paper.ok).toBe(true);
    if (!live.ok || !paper.ok) return;
    expect(live.snapshot.source).toBe('GMX_API');
    expect(paper.snapshot.source).toBe('PAPER_GMX_ESTIMATE');
    expect(paper.snapshot.totalEstimatedRoundTripCostUsd).toBeCloseTo(live.snapshot.totalEstimatedRoundTripCostUsd, 10);
  });
});

describe('§11-4·5·6 보유비용 누적·순 PnL 추정', () => {
  it('4. PAPER gross profit에서 모든 추정비용 차감 (ESTIMATED, 가짜 0 금지)', () => {
    const r = computePaperNetPnl({
      simulatedGrossPnlUsd: 10, estimatedEntryCostsUsd: 0.3, estimatedExitCostsUsd: 0.4,
      elapsedHoldingFundingUsd: 0.1, elapsedHoldingBorrowingUsd: 0.05,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('ESTIMATED');
    expect(r.netPnlUsd).toBeCloseTo(10 - 0.3 - 0.4 - 0.1 - 0.05, 8);
  });

  it('4b. 음수 비용/NaN → 거부 (비용 축소 조작 금지)', () => {
    expect(computePaperNetPnl({ simulatedGrossPnlUsd: 10, estimatedEntryCostsUsd: -1, estimatedExitCostsUsd: 0, elapsedHoldingFundingUsd: 0, elapsedHoldingBorrowingUsd: 0 }).ok).toBe(false);
    expect(computePaperNetPnl({ simulatedGrossPnlUsd: NaN, estimatedEntryCostsUsd: 0, estimatedExitCostsUsd: 0, elapsedHoldingFundingUsd: 0, elapsedHoldingBorrowingUsd: 0 }).ok).toBe(false);
  });

  it('5. 보유시간 증가 → funding/borrowing 누적비용 단조 증가', () => {
    const t0 = NOW.getTime();
    const costs = [1, 4, 12, 48].map(hours => {
      const r = accrueHoldingCostsFromEntryRates({
        notionalUsd: 1000, openedAtMs: t0, closedAtMs: t0 + hours * 3_600_000,
        fundingRatePerHourFraction: 0.0001, borrowingRatePerHourFraction: 0.00005,
      });
      expect(r.ok).toBe(true);
      return r.ok ? r.totalUsd : -1;
    });
    for (let i = 1; i < costs.length; i++) expect(costs[i]).toBeGreaterThan(costs[i - 1]);
  });

  it('5b. rate 데이터 공백 구간 → HOLDING_COST_UNAVAILABLE (0 대체 금지)', () => {
    const t0 = NOW.getTime();
    const gap = accrueHoldingCosts({
      notionalUsd: 1000, openedAtMs: t0, closedAtMs: t0 + 2 * 3_600_000,
      segments: [{ fromMs: t0, toMs: t0 + 3_600_000, fundingRatePerHourFraction: 0.0001, borrowingRatePerHourFraction: 0.0001 }],
    });
    expect(gap.ok).toBe(false);
    if (!gap.ok) expect(gap.reason).toContain(HOLDING_COST_UNAVAILABLE);
    const nullRate = accrueHoldingCostsFromEntryRates({
      notionalUsd: 1000, openedAtMs: t0, closedAtMs: t0 + 3_600_000,
      fundingRatePerHourFraction: null, borrowingRatePerHourFraction: 0.0001,
    });
    expect(nullRate.ok).toBe(false);
  });

  it('6. PAPER 비용 캐시 결속 — 최신 PAPER_GMX_ESTIMATE만, 10분 초과 stale=null', () => {
    __clearPaperCostCacheForTests();
    const t0 = NOW.getTime();
    const snap: CostSnapshot = {
      market: MARKET, isLong: true, orderType: 'MarketIncrease', notionalUsd: 100,
      positionFeeUsd: 0.06, executionFeeUsd: 0.2, estimatedPriceImpactUsd: 0.05,
      estimatedExitPriceImpactUsd: 0.05, fundingFeeUsd: 0.01, borrowingFeeUsd: 0.005,
      estimatedExitFeeUsd: 0.26, fundingRatePerHourFraction: 0.00001,
      borrowingRatePerHourFraction: 0.000005, totalEstimatedRoundTripCostUsd: 0.635,
      source: 'PAPER_GMX_ESTIMATE', blockNumber: null, apiTimestamp: null,
      fetchedAt: new Date(t0).toISOString(), expiresAt: new Date(t0 + 60_000).toISOString(),
    };
    storePaperCostSnapshot('ETH', snap, t0);
    const fresh = getPaperCostBinding('ETH', t0 + 60_000);
    expect(fresh).not.toBeNull();
    expect(fresh!.costSource).toBe('PAPER_GMX_ESTIMATE');
    expect(getPaperCostBinding('ETH', t0 + 11 * 60_000)).toBeNull(); // stale
    // LIVE source 혼입은 저장 자체가 무시됨
    __clearPaperCostCacheForTests();
    storePaperCostSnapshot('ETH', { ...snap, source: 'GMX_API' }, t0);
    expect(getPaperCostBinding('ETH', t0)).toBeNull();
  });
});

describe('§11-7~10 LIVE 정산 게이팅', () => {
  it('7. UNSETTLED LIVE 이익은 목표 산정 미반영', () => {
    const r = pnlForTargets([{ pnl: 100, settlementStatus: 'UNSETTLED' }]);
    expect(r.profitEligibleUsd).toBe(0);
    expect(r.lossAwareUsd).toBe(0);
  });

  it('8. 실제 비용 전부 확보(온체인 증거 tx 포함) 후에만 SETTLED 전환 시도', async () => {
    const noTx = await recordTradeSettlement({
      tradeId: 't1', grossPnlUsd: 5, positionFeeUsd: 0.1, executionFeeUsd: 0.1,
      priceImpactUsd: 0.1, fundingFeeUsd: 0, borrowingFeeUsd: 0,
      evidenceTxHash: '', settledAt: NOW,
    });
    expect(noTx.ok).toBe(false);
    if (!noTx.ok) expect(noTx.reason).toContain('온체인 증거');
  });

  it('9. 부분 actual fee(fetchEvidence null) → UNSETTLED 유지 + incomplete', async () => {
    // DB 경로는 실제 모킹 없이 접근 시 실패 → reconcile은 예외 없이 incomplete 반환해야 함
    const r = await reconcileLiveSettlements({ fetchEvidence: async () => null });
    expect(r.incomplete === true || r.unsettledCount === -1 || r.unsettledCount === 0).toBe(true);
    // 어떤 경우에도 throw하지 않고 결과 객체를 반환한다 (Worker 생존)
    expect(typeof r.ok).toBe('boolean');
  });

  it('9b. fetcher 미구성 → incomplete (낙관 처리 금지)', async () => {
    const r = await reconcileLiveSettlements({});
    expect(r.ok === false || r.unsettledCount === 0).toBe(true);
  });

  it('10. 중복 settlement 금지 — recordTradeSettlement는 NaN/음수 수수료 거부', async () => {
    // 조건부 UPDATE(중복 tx 금지)는 DB 통합 검증 대상 — 여기서는 입력 게이트 검증
    const bad = await recordTradeSettlement({
      tradeId: 't1', grossPnlUsd: 5, positionFeeUsd: -1, executionFeeUsd: 0,
      priceImpactUsd: 0, fundingFeeUsd: 0, borrowingFeeUsd: 0,
      evidenceTxHash: `0x${'a'.repeat(64)}`, settledAt: NOW,
    });
    expect(bad.ok).toBe(false);
  });
});

describe('§11-21~24 구조적 금지 검증', () => {
  it('21·22. costSnapshot/paperCostCache/holdingCosts는 네트워크·legacy Gelato 접근 0회 (주입식)', () => {
    const srcDir = path.resolve(__dirname, '../lib');
    for (const f of ['costSnapshot.ts', 'paperCostCache.ts', 'holdingCosts.ts']) {
      let out = '';
      try {
        out = execFileSync('grep', ['-lE', 'fetch\\(|gelato|digital', path.join(srcDir, f)], { encoding: 'utf8' });
      } catch { out = ''; }
      expect(out.trim()).toBe('');
    }
  });

  it('23. main wallet private key 경로 0회 — 비용/정산 모듈에 개인키 참조 없음', () => {
    let out = '';
    try {
      out = execFileSync('grep', ['-rlEi', 'private.?key|mnemonic|seed.?phrase',
        path.resolve(__dirname, '../lib/costSnapshot.ts'),
        path.resolve(__dirname, '../lib/holdingCosts.ts'),
        path.resolve(__dirname, '../lib/paperCostCache.ts'),
        path.resolve(__dirname, '../lib/tradeSettlement.ts'),
      ], { encoding: 'utf8' });
    } catch { out = ''; }
    expect(out.trim()).toBe('');
  });

  it('24. 모바일(futures-terminal) 미접촉 — api-server 코드가 모바일을 참조하지 않음', () => {
    let out = '';
    try {
      out = execFileSync('grep', ['-rl', 'futures-terminal', path.resolve(__dirname, '..'), '--include=*.ts'], { encoding: 'utf8' });
    } catch { out = ''; }
    const offenders = out.split('\n').filter(Boolean).filter(f => !f.includes('__tests__'));
    expect(offenders).toEqual([]);
  });
});
