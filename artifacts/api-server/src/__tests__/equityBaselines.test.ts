/**
 * equityBaselines 테스트 — 기간 시작 equity 기준점 기반 Daily/Weekly PnL.
 *
 * 필수 시나리오:
 *  - 전날부터 보유한 포지션의 기존 미실현이 오늘 PnL에 중복 포함되지 않음
 *  - 자정(UTC) 이후 equity 변화만 Daily PnL 반영
 *  - 주 시작 이전 포지션도 이번 주 equity 변화만 반영
 *  - 재시작 후 기준점 유지 (파싱 왕복)
 *  - 기준점 누락 시 가짜 0 대신 null(N/A)
 *  - trades 0 · positions 0 초기 상태 → PnL 정확히 $0
 */
import { describe, expect, it } from 'vitest';
import {
  dailyPeriodStartUtc, weeklyPeriodStartUtc,
  parseBaseline, rollBaseline, computePeriodPnl,
  type EquityBaseline,
} from '../lib/equityBaselines';

const at = (iso: string) => new Date(iso);

describe('기간 시작 시각 (UTC 고정)', () => {
  it('daily = 당일 00:00 UTC', () => {
    expect(dailyPeriodStartUtc(at('2026-08-17T15:30:00Z'))).toBe('2026-08-17T00:00:00.000Z');
    expect(dailyPeriodStartUtc(at('2026-08-17T00:00:00Z'))).toBe('2026-08-17T00:00:00.000Z');
  });

  it('weekly = 월요일 00:00 UTC (일요일도 이전 월요일로)', () => {
    expect(weeklyPeriodStartUtc(at('2026-08-17T10:00:00Z'))).toBe('2026-08-17T00:00:00.000Z'); // 월
    expect(weeklyPeriodStartUtc(at('2026-08-19T10:00:00Z'))).toBe('2026-08-17T00:00:00.000Z'); // 수
    expect(weeklyPeriodStartUtc(at('2026-08-23T23:59:59Z'))).toBe('2026-08-17T00:00:00.000Z'); // 일
    expect(weeklyPeriodStartUtc(at('2026-08-24T00:00:00Z'))).toBe('2026-08-24T00:00:00.000Z'); // 다음 월
  });
});

describe('rollBaseline — 기준점 수립·롤오버', () => {
  it('기준점 없음 → 현재 equity로 신규 수립 (changed=true)', () => {
    const now = at('2026-08-17T00:01:00Z');
    const r = rollBaseline(null, dailyPeriodStartUtc(now), 10_500, now);
    expect(r.changed).toBe(true);
    expect(r.baseline).toEqual({ periodStart: '2026-08-17T00:00:00.000Z', equity: 10_500, recordedAt: now.toISOString() });
  });

  it('같은 기간 → 기존 기준점 유지 (changed=false, equity 덮어쓰기 금지)', () => {
    const base: EquityBaseline = { periodStart: '2026-08-17T00:00:00.000Z', equity: 10_000, recordedAt: '2026-08-17T00:01:00.000Z' };
    const now = at('2026-08-17T18:00:00Z');
    const r = rollBaseline(base, dailyPeriodStartUtc(now), 12_345, now);
    expect(r.changed).toBe(false);
    expect(r.baseline.equity).toBe(10_000);
  });

  it('자정 경과(기간 변경) → 새 기준점으로 롤오버', () => {
    const base: EquityBaseline = { periodStart: '2026-08-16T00:00:00.000Z', equity: 10_000, recordedAt: '2026-08-16T00:00:30.000Z' };
    const now = at('2026-08-17T00:00:45Z');
    const r = rollBaseline(base, dailyPeriodStartUtc(now), 10_800, now);
    expect(r.changed).toBe(true);
    expect(r.baseline.periodStart).toBe('2026-08-17T00:00:00.000Z');
    expect(r.baseline.equity).toBe(10_800);
  });
});

describe('computePeriodPnl — 중복 계산 방지·N/A 규칙', () => {
  it('전날부터 보유한 포지션의 기존 미실현이 오늘 PnL에 중복되지 않음', () => {
    // 어제: 진입 후 미실현 +$800 → 어제 자정 equity 기준점 = 10,800
    // 오늘: 가격 소폭 상승, 미실현 +$850 (오늘 변화분은 +$50뿐)
    const baseline: EquityBaseline = { periodStart: '2026-08-17T00:00:00.000Z', equity: 10_800, recordedAt: '2026-08-17T00:00:30.000Z' };
    const equityNow = 10_000 + 850; // capital + 전체 미실현
    expect(computePeriodPnl(equityNow, baseline)).toBeCloseTo(50);
    // (구 공식 realized 0 + 전체 미실현 850 = $850로 부풀렸을 값)
  });

  it('자정 이후 실현+미실현 변화 합계만 Daily에 반영 (breakdown 합계 일치)', () => {
    const baseline: EquityBaseline = { periodStart: '2026-08-17T00:00:00.000Z', equity: 10_800, recordedAt: '2026-08-17T00:00:30.000Z' };
    // 오늘 실현 +$120, 미실현은 800 → 700으로 −$100
    const equityNow = 10_000 + 120 + 700;
    const daily = computePeriodPnl(equityNow, baseline)!;
    expect(daily).toBeCloseTo(20);
    const dailyRealized = 120;
    const unrealizedDelta = daily - dailyRealized; // 파생 breakdown
    expect(dailyRealized + unrealizedDelta).toBeCloseTo(daily); // 합계 = equity 변화
    expect(unrealizedDelta).toBeCloseTo(-100);
  });

  it('주 시작 이전 포지션도 이번 주 equity 변화만 반영', () => {
    // 지난주 누적 +$2,000 포함해 월요일 00:00 UTC equity = 12,000
    const weekly: EquityBaseline = { periodStart: '2026-08-17T00:00:00.000Z', equity: 12_000, recordedAt: '2026-08-17T00:00:10.000Z' };
    expect(computePeriodPnl(12_300, weekly)).toBeCloseTo(300); // 지난주 2,000은 미포함
  });

  it('기준점 누락 → null (가짜 0·전체 미실현 대체 금지)', () => {
    expect(computePeriodPnl(10_850, null)).toBeNull();
  });

  it('trades 0 · positions 0 초기 상태 → 정확히 $0', () => {
    const now = at('2026-08-17T00:01:00Z');
    const capital = 10_000; // equity = capital (실현·미실현 없음)
    const { baseline } = rollBaseline(null, dailyPeriodStartUtc(now), capital, now);
    expect(computePeriodPnl(capital, baseline)).toBe(0);
  });

  it('비정상 equity(NaN/Infinity) → null', () => {
    const b: EquityBaseline = { periodStart: 'x', equity: 1, recordedAt: 'x' };
    expect(computePeriodPnl(NaN, b)).toBeNull();
    expect(computePeriodPnl(Infinity, b)).toBeNull();
  });
});

describe('parseBaseline — 재시작 복구 (worker_state 왕복)', () => {
  it('JSON 왕복 후 동일 기준점 복구 (재시작 유지)', () => {
    const b: EquityBaseline = { periodStart: '2026-08-17T00:00:00.000Z', equity: 10_800.55, recordedAt: '2026-08-17T00:00:30.000Z' };
    expect(parseBaseline(JSON.stringify(b))).toEqual(b);
  });

  it('손상·누락 데이터 → null (가짜 기준점 생성 금지)', () => {
    expect(parseBaseline(null)).toBeNull();
    expect(parseBaseline('')).toBeNull();
    expect(parseBaseline('not-json')).toBeNull();
    expect(parseBaseline(JSON.stringify({ periodStart: 'x' }))).toBeNull();
    expect(parseBaseline(JSON.stringify({ periodStart: 'x', equity: 'oops' }))).toBeNull();
    expect(parseBaseline(JSON.stringify({ periodStart: 'x', equity: NaN }))).toBeNull();
  });

  it('recordedAt 누락 시 periodStart로 보정 (구버전 호환)', () => {
    const parsed = parseBaseline(JSON.stringify({ periodStart: '2026-08-17T00:00:00.000Z', equity: 5 }));
    expect(parsed).toEqual({ periodStart: '2026-08-17T00:00:00.000Z', equity: 5, recordedAt: '2026-08-17T00:00:00.000Z' });
  });
});
