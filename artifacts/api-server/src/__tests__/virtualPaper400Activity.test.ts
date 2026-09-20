import { describe, expect, it } from 'vitest';
import { VirtualActivityTracker } from '../workers/virtualPaper400Activity';

describe('observational virtual activity', () => {
  it('expires stale/future activity and never leaks another session or invents work after restart', () => {
    let now = Date.parse('2026-09-21T00:00:00Z');
    const tracker = new VirtualActivityTracker(() => now);
    expect(tracker.read('one').activity).toBeNull();
    const run = tracker.begin('one', 1);
    tracker.stage(run, 'ANALYZING_MARKETS', ['BTC','ETH','SOL']);
    expect(tracker.read('one').activityFresh).toBe(true);
    expect(tracker.read('two').activity).toBeNull();
    expect(tracker.read(null).activity).toBeNull();
    expect(tracker.read('one', now - 1).activityFresh).toBe(false);
    now += 120_001;
    expect(tracker.read('one').activityFresh).toBe(false);
    expect(new VirtualActivityTracker(() => now).read('one').activity).toBeNull();
  });
  it('keeps only observed stages, rejects old writers, and returns isolated snapshots', () => {
    const tracker = new VirtualActivityTracker(() => Date.parse('2026-09-21T00:00:00Z'));
    const old = tracker.begin('one', 1); const run = tracker.begin('one', 2);
    tracker.stage(old, 'EXECUTING_PAPER', ['BTC']); tracker.finish(old, 'ERROR');
    expect(tracker.read('one').activity!.phase).toBe('CHECKING_ACCOUNT');
    tracker.stage(run, 'CHECKING_COSTS', ['BTC','BTC','UNSUPPORTED']);
    const snapshot = tracker.read('one').activity!; snapshot.symbols.push('ETH');
    expect(tracker.read('one').activity!.symbols).toEqual(['BTC']);
    tracker.finish(run, 'BLOCKED', 'EXECUTOR_RECOVERY_PENDING');
    const result = tracker.read('one').activity!;
    expect(result.events.map(e => e.phase)).toEqual(['CHECKING_ACCOUNT','CHECKING_COSTS','BLOCKED']);
    expect(result.analysisCompletedAt).toBeNull(); expect(result.symbols).toEqual([]);
  });
  it('does not call a not-evaluated scan complete and bounds diagnostic history', () => {
    const tracker = new VirtualActivityTracker(); const run = tracker.begin('one', 3);
    tracker.analyzed(run, [{ symbol: 'BTC', reason: 'COST_UNAVAILABLE', evaluated: false }]);
    expect(tracker.read('one').activity!.analysisCompletedAt).toBeNull();
    tracker.analyzed(run, [{ symbol: 'BTC', reason: 'NO_TRADE', evaluated: true }]);
    expect(tracker.read('one').activity!.analysisCompletedAt).not.toBeNull();
    const completedAt = tracker.read('one').activity!.analysisCompletedAt;
    tracker.decisions(run, [{ symbol: 'BTC', reason: 'COST_INVALID_OR_OVER_CAP' }]);
    for (let i = 0; i < 20; i++) tracker.stage(run, 'CHECKING_ENTRY', ['BTC']);
    tracker.finish(run, 'NO_TRADE', 'NO_ELIGIBLE_CLOSED_CANDLE_SIGNAL');
    const result = tracker.read('one').activity!;
    expect(result.events).toHaveLength(12); expect(result.phase).toBe('WAITING');
    expect(result.results[0].reason).toBe('COST_INVALID_OR_OVER_CAP');
    expect(result.analysisCompletedAt).toBe(completedAt);
  });
});
