import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PatternEntryDiagnostics } from '../dashboard/PatternEntryDiagnostics';
import { TradeEntryEvidence } from '../dashboard/TradeEntryEvidence';
import { entryPatternSummary, type TradeEntryEvidence as Evidence } from '@/lib/virtualTradeEvidencePresentation';
import type { PatternEntryEvidence, PatternEntrySnapshot } from '@/lib/patternEntryEvidence';

const at = Date.parse('2026-10-02T14:00:00Z');
const leading: PatternEntryEvidence = {
  eventId: 'BTC:15m:HAMMER:observed', durableFormationId: 'BTC:15m:HAMMER:observed',
  symbol: 'BTC', patternId: 'HAMMER', timeframe: '15m', direction: 'LONG',
  formationAt: at - 900_000, confirmedAt: at, triggerPrice: 100, referencePrice: 100,
  stopPrice: 99.6, targetPrice: null, targetBasis: null, expiresAt: at + 900_000,
  maxHoldMs: 3_600_000, supportingPatternIds: ['HAMMER'], conflictingPatternIds: [],
  auxiliary: { formation: 'Observed', confirmation: 'Completed close', entry: 'Observed trigger',
    invalidation: 'Observed low', exit: 'Stop or maximum hold', observedTarget: null },
};
const evidence: Evidence = {
  source: 'gmx-official-api', evaluatedAt: at + 2_000, closedAt: at, momentumPct: -0.1,
  quality: { regime: 'RANGE', eligible: false, reason: 'AUXILIARY', efficiency: 0.1, atrPct: 0.4 },
  patternStatus: 'RECORDED', patternVersion: 'paper-chart-reference/v1',
  patternAdjustment: 0, frames: [],
};
describe('stored pattern-led evidence presentation', () => {
  it('shows leading pattern, timeframe, confirmed bar, trigger, stop and auxiliary failure without inventing target/profit', () => {
    const data: Evidence = { ...evidence, policyVersion: 'virtual400-daily/v10', patternEntry: leading,
      auxiliaryConditions: [{ name: 'netRewardRisk', value: null, operator: '>=', threshold: 1.5,
        passed: null, role: 'AUXILIARY' }] };
    const html = renderToStaticMarkup(createElement(TradeEntryEvidence, { evidence: data }));
    expect(html).toContain('진입 주도 패턴: 망치형');
    expect(html).toContain('15분봉');
    expect(html).toContain('확정 완료봉');
    expect(html).toContain('진입 트리거');
    expect(html).toContain('관측 목표 없음');
    expect(html).toContain('진입 거부 조건 아님');
    expect(html).not.toContain('패턴 하나만으로 진입한 거래라는 의미는 아닙니다');
    expect(entryPatternSummary(data)).toBe('진입 주도: 15분봉 망치형');
  });
  it('retains reference-only meaning and missing-history meaning for older trades', () => {
    const html = renderToStaticMarkup(createElement(TradeEntryEvidence, { evidence }));
    expect(html).toContain('패턴 하나만으로 진입한 거래라는 의미는 아닙니다');
    expect(html).not.toContain('진입 주도 패턴');
    expect(entryPatternSummary(null)).toBe('패턴 기록 없음');
    expect(renderToStaticMarkup(createElement(TradeEntryEvidence, {}))).toContain('현재 차트로 과거 진입 근거를 추정하지 않습니다');
  });
  it('shows neutral confirmation waiting and conflicts, never a fabricated order or direction', () => {
    const snapshot: PatternEntrySnapshot = { version: 'paper-pattern-entry/v10', evaluatedAt: at, candidates: [],
      waiting: [{ symbol: 'BTC', eventId: 'neutral', patternId: 'DOJI', timeframe: '15m',
        formationAt: at, reason: '후속 완료봉 확인 대기', upperTrigger: 101, lowerTrigger: 99 }],
      conflicts: [{ symbol: 'BTC', eventId: 'conflict', timeframe: '1h', formationAt: at,
        reason: '방향 충돌로 진입 보류', longPatternIds: ['HAMMER'], shortPatternIds: ['SHOOTING_STAR'] }] };
    const html = renderToStaticMarkup(createElement(PatternEntryDiagnostics, { snapshot, fresh: true, now: at }));
    expect(html).toContain('도지 · 확인 대기');
    expect(html).toContain('확인 전 방향·주문 없음');
    expect(html).toContain('방향 충돌');
    expect(html).toContain('후보 수는 주문 수가 아닙니다');
    expect(html).not.toContain('진입 주도 패턴:');
  });
  it('does not display stale pattern data or replace unavailable evidence with zero counts', () => {
    const snapshot: PatternEntrySnapshot = { version: 'paper-pattern-entry/v10', evaluatedAt: at, candidates: [leading],
      waiting: [], conflicts: [] };
    const html = renderToStaticMarkup(createElement(PatternEntryDiagnostics, { snapshot, fresh: false }));
    expect(html).toContain('패턴 진입 자료 확인 대기');
    expect(html).toContain('virtual400-daily/v10');
    expect(html).toContain('paper-pattern-entry/v10');
    expect(html).toContain('이전 정책의 패턴 기록은 순위 참고 자료');
    expect(html).toContain('정책 적용·진입 여부도 확인 대기');
    expect(html).not.toContain('진입 주도 패턴');
    expect(html).not.toContain('이번 평가 · 확인된 패턴 후보');
    const cached = renderToStaticMarkup(createElement(PatternEntryDiagnostics, {
      snapshot, fresh: true, now: at + 120_001,
    }));
    expect(cached).toContain('패턴 진입 자료 확인 대기');
    expect(cached).not.toContain('진입 주도 패턴');
  });
});