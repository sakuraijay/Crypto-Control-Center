/** Observational, process-local telemetry. Never grants trading permission and
 * never writes to the financial ledger. Restart intentionally clears live work. */
export type VirtualActivityPhase = 'CHECKING_ACCOUNT' | 'CHECKING_COSTS' | 'ANALYZING_MARKETS'
  | 'CHECKING_ENTRY' | 'EXECUTING_PAPER' | 'RECONCILING' | 'WAITING' | 'BLOCKED' | 'STOPPED' | 'ERROR';
export interface VirtualActivityResult { symbol: string; reason: string; evaluated: boolean }
export interface VirtualActivityEvent { phase: VirtualActivityPhase; at: string; symbols: string[] }
export interface VirtualActivitySnapshot {
  schemaVersion: 'virtual-activity/v1'; source: 'SERVER_STRATEGY_ENGINE';
  sessionId: string; cycleNumber: number; startedAt: string; updatedAt: string;
  phase: VirtualActivityPhase; symbols: string[]; outcome: string | null; reason: string | null;
  analysisCompletedAt: string | null; results: VirtualActivityResult[]; events: VirtualActivityEvent[];
}
export const VIRTUAL_ACTIVITY_MAX_AGE_MS = 120_000;
export class VirtualActivityTracker {
  private current: VirtualActivitySnapshot | null = null;
  private generation = 0;
  constructor(private readonly clock: () => number = Date.now) {}
  begin(sessionId: string, cycleNumber: number): number {
    const at = new Date(this.clock()).toISOString();
    this.current = { schemaVersion: 'virtual-activity/v1', source: 'SERVER_STRATEGY_ENGINE',
      sessionId, cycleNumber, startedAt: at, updatedAt: at, phase: 'CHECKING_ACCOUNT', symbols: [],
      outcome: null, reason: null, analysisCompletedAt: null, results: [],
      events: [{ phase: 'CHECKING_ACCOUNT', at, symbols: [] }] };
    return ++this.generation;
  }
  stage(generation: number, phase: VirtualActivityPhase, symbols: readonly string[] = []): void {
    if (!this.current || generation !== this.generation) return;
    const at = new Date(this.clock()).toISOString();
    const active = [...new Set(symbols)].filter(s => ['BTC', 'ETH', 'SOL'].includes(s));
    this.current = { ...this.current, phase, symbols: active, updatedAt: at,
      events: [...this.current.events, { phase, at, symbols: active }].slice(-12) };
  }
  analyzed(generation: number, results: VirtualActivityResult[]): void {
    if (!this.current || generation !== this.generation) return;
    const at = new Date(this.clock()).toISOString();
    this.current = { ...this.current, updatedAt: at,
      analysisCompletedAt: results.some(r => r.evaluated) ? at : null,
      results: results.slice(0, 3).map(r => ({ symbol: r.symbol, evaluated: r.evaluated,
        reason: r.reason.slice(0, 1200) })) };
  }
  decisions(generation: number, diagnostics: { symbol: string; reason: string }[]): void {
    if (!this.current || generation !== this.generation) return;
    this.current = { ...this.current, results: this.current.results.map(row => ({ ...row,
      reason: diagnostics.find(d => d.symbol === row.symbol)?.reason ?? row.reason })) };
  }
  finish(generation: number, outcome: string, reason: string | null = null): void {
    if (!this.current || generation !== this.generation) return;
    this.stage(generation, outcome === 'ERROR' ? 'ERROR' : outcome === 'STOPPED' ? 'STOPPED'
      : outcome === 'BLOCKED' ? 'BLOCKED' : 'WAITING');
    this.current = { ...this.current, outcome, reason };
  }
  read(sessionId: string | null, now = this.clock()): { activity: VirtualActivitySnapshot | null; activityFresh: boolean } {
    if (!this.current || !sessionId || this.current.sessionId !== sessionId) return { activity: null, activityFresh: false };
    const age = now - Date.parse(this.current.updatedAt);
    return { activity: structuredClone(this.current), activityFresh: Number.isFinite(age)
      && age >= 0 && age <= VIRTUAL_ACTIVITY_MAX_AGE_MS };
  }
}
export const virtualPaper400Activity = new VirtualActivityTracker();
