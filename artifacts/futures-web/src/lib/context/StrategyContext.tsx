import { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from 'react';
import { apiUrl, postApiJson, readApiJson } from '@/lib/apiUrl';

// 6E-2 §4 — 구형 SubaccountConfig(브라우저 localStorage 기반 "위임 준비 완료")는 제거됨.
// 승인 파라미터(maxAllowedCount·expiry·deadline)는 서버가 canonical 값으로 고정하며,
// UI는 Owner Approval prepare 반환값을 검토·표시만 한다.
const LEGACY_SUBACCOUNT_STORAGE_KEY = 'futures_subaccount_config';

export interface IndicatorConfig {
  id: string;
  name: string;
  enabled: boolean;
  params: Record<string, string | number>;
}

export interface RiskLimits {
  // ── Capital settings ─────────────────────────────────────────────────────
  /**
   * Current risk-sizing capital (USDT), bounded by the approved Active stage.
   * This is not Planned Seed Capital and may be smaller than the approved stage.
   * Must not exceed actual wallet USDC equity — validated on the Strategy page.
   * Basis for drawdown %, max-risk-per-symbol, and profit-lock calculations.
   */
  tradingCapital: number;
  /**
   * Reserve cash held back from active trading (0–50 %).
   * Effective deployable capital = tradingCapital × (1 − reserveCashPct / 100).
   */
  reserveCashPct: number;
  /**
   * Daily PnL soft KPI (USDT) — monitoring display only.
   * NEVER drives AI entry decisions, leverage increases, or risk escalation.
   * The Risk Engine is fully independent of this value.
   */
  dailyTargetUSDT: number;
  // ── Hard risk controls (enforced by Risk Engine · veto authority over AI) ──
  maxTotalExposureUSDT: number;
  maxMarginPerTrade: number;
  maxLeverage: number;
  maxSimultaneousPositions: number;
  dailyLossLimitUSDT: number;
  weeklyLossLimitUSDT: number;
  maxDrawdownPercent: number;
  consecutiveLossLimit: number;
  cooldownMinutes: number;
  maxTradesPerHour: number;
  /**
   * Max risk per symbol as % of tradingCapital (0.5–10 %).
   * Hard cap on margin committed to any single index symbol.
   */
  maxRiskPerSymbolPct: number;
  /**
   * When daily realized PnL ≥ tradingCapital × profitLockThresholdPct,
   * Profit-lock Lv.1 activates (exposure stepped down, trailing tightened).
   * Each additional threshold × N advances to Lv.N (max Lv.3).
   */
  profitLockThresholdPct: number;
  /**
   * Rolling 24-hour loss limit (USDT). 0 = disabled.
   * When exceeded the AI engine immediately returns CASH regardless of signal.
   */
  rolling24hLossLimitUSDT: number;
  // ── LIVE TEST MODE ────────────────────────────────────────────────────────
  /** LIVE TEST 모드 활성화 여부 (기본: false) */
  liveTestMode: boolean;
  /** 테스트 예산 (USD). 기본 $100. */
  testBudgetUsd: number;
  /** 최대 누적 테스트 손실 (USD). 초과 시 즉시 비상정지. 기본 $50 */
  testMaxLossUsd: number;
  /** 테스트 최대 레버리지 (기본 2x; 절대 일반 maxLeverage 미만) */
  testMaxLeverage: number;
}

const DEFAULT_INDICATORS: IndicatorConfig[] = [
  { id: 'ema',      name: 'EMA',                 enabled: true,  params: { fast: 9, slow: 21 } },
  { id: 'rsi',      name: 'RSI',                 enabled: true,  params: { period: 14, OB: 70, OS: 30 } },
  { id: 'macd',     name: 'MACD',                enabled: false, params: { fast: 12, slow: 26, signal: 9 } },
  { id: 'bb',       name: 'Bollinger Bands',      enabled: false, params: { period: 20, deviation: 2.0 } },
  { id: 'vol',      name: 'Volume Breakout',      enabled: true,  params: { multiplier: 2.0 } },
  { id: 'price',    name: 'Price Breakout',       enabled: false, params: { lookback: 20 } },
  { id: 'mtf',      name: 'Multi-TF Trend',       enabled: true,  params: {} },
  { id: 'funding',  name: 'Funding Rate Filter',  enabled: true,  params: { maxRate: 0.05 } },
  { id: 'btc_dir',  name: 'BTC Direction Filter', enabled: true,  params: {} },
  { id: 'combined', name: 'Combined Scoring',     enabled: true,  params: { minScore: 60 } },
];

// 현재 승인된 Active $1,000 운용 정책 기본값 — Planned Seed $10,000과 분리.
// 구형 $10,000/$500/$1,500/10x 기본값은 제거됨.
const DEFAULT_LIMITS: RiskLimits = {
  // Capital
  tradingCapital:            1_000,   // 최종 운용 자본 $1,000 (초과분은 위험 산정 제외)
  reserveCashPct:               20,   // keep 20 % as reserve — deploys 80 %
  dailyTargetUSDT:              50,   // +5% 일일 목표 (soft KPI — RiskEngine이 별도 강제)
  // Hard risk controls
  maxTotalExposureUSDT:      3_000,   // $1,000 × 3x
  maxMarginPerTrade:           334,   // ≈ capital/3 — 1포지션 담보 상한
  maxLeverage:                   3,   // 기본 3x — 조건부 5x 비활성
  maxSimultaneousPositions:      1,   // 동시 포지션 1개
  dailyLossLimitUSDT:           10,   // -1% 일일 손실 한도
  weeklyLossLimitUSDT:          80,   // -8% 주간 손실 한도
  maxDrawdownPercent:            8,   // hard stop equity $920 (-8%)
  consecutiveLossLimit:          3,   // 연속 손실 3회 중단
  cooldownMinutes:              30,
  maxTradesPerHour:              6,
  maxRiskPerSymbolPct:           2,   // 2 % of tradingCapital per symbol
  profitLockThresholdPct:        1,   // Lv.1 activates at +1 % daily PnL
  rolling24hLossLimitUSDT:       0,   // 0 = disabled by default
  // LIVE TEST MODE defaults (off / conservative)
  liveTestMode:    false,
  testBudgetUsd:   100,
  testMaxLossUsd:   50,
  testMaxLeverage:   2,
};

// ── 정책 파생 soft KPI 결속 (서버 riskPolicy.ts와 정합) ──────────────────────
/** 정책 파생 일일 1차 목표 — $1,000 기준 +5% = $50 */
export const POLICY_DAILY_TARGET_USD = 50;
/** 정책 파생 일일 절대 수익 상한 — $1,000 기준 +10% = $100 */
export const POLICY_DAILY_TARGET_CAP_USD = 100;

/**
 * clampDailyTargetWeb — dailyTargetUSDT를 정책 범위 [0, $100]로 강제.
 * legacy 저장값(예: 구형 $500)·비정상 값은 정책 기본값/상한으로 교정되어
 * localStorage·서버 응답 어느 경로로도 정책 초과값이 상태에 남지 않는다.
 */
export function clampDailyTargetWeb(value: unknown): number {
  if (value === null || value === undefined || typeof value === 'boolean') return POLICY_DAILY_TARGET_USD;
  const n = typeof value === 'string' ? parseFloat(value) : Number(value);
  if (!Number.isFinite(n)) return POLICY_DAILY_TARGET_USD;
  return Math.min(POLICY_DAILY_TARGET_CAP_USD, Math.max(0, n));
}

/** Server sync state for the debounced PUT /api/data/strategy call. */
export type ProfileName = 'conservative' | 'aggressive';

export interface DesiredRiskProfileStatus {
  name: ProfileName;
  version: 'risk-profile/v1';
  requestedAt: string;
}

export interface AppliedRiskProfileStatus {
  name: ProfileName;
  version: 'risk-profile/v1';
  appliedAt: string;
  derivedLimits: Record<string, unknown>;
}

export interface RiskProfileResponse {
  desired: DesiredRiskProfileStatus;
  applied: AppliedRiskProfileStatus;
  pending: boolean;
  safeBoundary: boolean;
  reason: string | null;
}

export type StrategySyncStatus = 'idle' | 'saving' | 'saved' | 'error';

interface StrategyContextType {
  indicators: IndicatorConfig[];
  limits: RiskLimits;
  /** 서버 동기화 상태: idle=대기, saving=저장 중, saved=저장 완료, error=저장 실패 */
  syncStatus: StrategySyncStatus;
  /** 동기화 실패 시 오류 메시지 */
  syncError: string | null;

  riskProfile: RiskProfileResponse | null;
  fetchRiskProfile: () => Promise<void>;
  requestRiskProfile: (profile: ProfileName, pin: string) => Promise<void>;

  updateIndicator: (id: string, updates: Partial<IndicatorConfig>) => void;
  updateLimit: (key: keyof RiskLimits, value: number) => void;
  /** Toggle LIVE TEST MODE on/off (saves all liveTest fields together) */
  updateLiveTestConfig: (config: Partial<Pick<RiskLimits, 'liveTestMode' | 'testBudgetUsd' | 'testMaxLossUsd' | 'testMaxLeverage'>>) => void;
  resetToDefaults: () => void;
}

const StrategyContext = createContext<StrategyContextType | undefined>(undefined);

const SERVER_SYNC_DELAY_MS = 2000; // debounce server writes

export function StrategyProvider({ children }: { children: ReactNode }) {
  const [indicators, setIndicators] = useState<IndicatorConfig[]>(() => {
    const saved = localStorage.getItem('futures_indicators');
    return saved ? JSON.parse(saved) : DEFAULT_INDICATORS;
  });

  const [limits, setLimits] = useState<RiskLimits>(() => {
    const saved = localStorage.getItem('futures_limits');
    if (!saved) return DEFAULT_LIMITS;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = JSON.parse(saved) as Record<string, any>;
    // ── Backward-compat migration: startingCapital → tradingCapital ──────────
    // Older saves used `startingCapital`. Promote to `tradingCapital` on first
    // load, then fall through to the normal merge so all new fields get defaults.
    if ('startingCapital' in raw && !('tradingCapital' in raw)) {
      raw.tradingCapital = raw.startingCapital;
    }
    const merged = { ...DEFAULT_LIMITS, ...raw };
    merged.dailyTargetUSDT = clampDailyTargetWeb(merged.dailyTargetUSDT);
    return merged;
  });

  // 구형 localStorage 위임 설정 정리 (일회성 — 남아 있으면 잘못된 "위임 준비 완료" 복원 위험)
  useEffect(() => {
    try { localStorage.removeItem(LEGACY_SUBACCOUNT_STORAGE_KEY); } catch { /* noop */ }
  }, []);

  const [syncStatus, setSyncStatus] = useState<StrategySyncStatus>('idle');
  const [syncError, setSyncError]   = useState<string | null>(null);
  const serverSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initializedFromServer = useRef(false);

  const [riskProfile, setRiskProfile] = useState<RiskProfileResponse | null>(null);

  const fetchRiskProfile = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('data/risk-profile'), { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        const body = await readApiJson(res);
        if (body.kind === 'json') {
          setRiskProfile(body.json as RiskProfileResponse);
        }
      }
    } catch (e) {
      // ignore
    }
  }, []);

  const requestRiskProfile = useCallback(async (profile: ProfileName, pin: string) => {
    const res = await postApiJson('data/risk-profile', {
      method: 'PUT',
      headers: { 'x-operator-pin': pin },
      body: { profile }
    });
    const body = await readApiJson(res);
    if (!res.ok) {
      const err = (body.kind === 'json' && (body.json as any).error) ? (body.json as any).error : `HTTP ${res.status}`;
      throw new Error(err);
    }
    if (body.kind === 'json') {
      setRiskProfile(body.json as RiskProfileResponse);
    }
  }, []);

  useEffect(() => {
    fetchRiskProfile();
  }, [fetchRiskProfile]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    if (riskProfile?.pending) {
      timer = setTimeout(() => {
        fetchRiskProfile();
      }, 3000);
    }
    return () => clearTimeout(timer);
  }, [riskProfile?.pending, fetchRiskProfile]);

  // Always-current snapshot used by the debounced callback (avoids stale closures)
  const latestDataRef = useRef({ indicators, limits });
  latestDataRef.current = { indicators, limits };

  // ── Load from server on mount (server overrides localStorage if found) ───
  useEffect(() => {
    fetch('/api/data/strategy', { signal: AbortSignal.timeout(5_000) })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        if (data.indicators && Array.isArray(data.indicators) && data.indicators.length > 0) {
          setIndicators(data.indicators as IndicatorConfig[]);
          localStorage.setItem('futures_indicators', JSON.stringify(data.indicators));
        }
        if (data.limits && typeof data.limits === 'object') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const raw = data.limits as Record<string, any>;
          // Backward-compat migration: startingCapital → tradingCapital
          if ('startingCapital' in raw && !('tradingCapital' in raw)) {
            raw.tradingCapital = raw.startingCapital;
          }
          // Merge with defaults in case server row pre-dates new fields
          const merged = { ...DEFAULT_LIMITS, ...raw };
          // stale strategy_config(legacy $500 등)은 정책 상한으로 클램프 — 무시
          merged.dailyTargetUSDT = clampDailyTargetWeb(merged.dailyTargetUSDT);
          setLimits(merged);
          localStorage.setItem('futures_limits', JSON.stringify(merged));
        }
        initializedFromServer.current = true;
      })
      .catch(() => { /* server unavailable — use localStorage */ });
  }, []);

  // ── Shared debounced PUT helper ───────────────────────────────────────────
  const scheduleSave = useCallback(() => {
    setSyncStatus('saving');
    setSyncError(null);
    if (serverSyncTimer.current) clearTimeout(serverSyncTimer.current);
    serverSyncTimer.current = setTimeout(() => {
      const { indicators: ind, limits: lim } = latestDataRef.current;
      fetch('/api/data/strategy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ indicators: ind, limits: lim }),
        signal: AbortSignal.timeout(5_000),
      })
        .then(r => {
          if (r.ok) {
            setSyncStatus('saved');
            setTimeout(() => setSyncStatus('idle'), 3_000);
          } else {
            setSyncStatus('error');
            setSyncError(`서버 오류 HTTP ${r.status}`);
          }
        })
        .catch(e => {
          setSyncStatus('error');
          setSyncError((e as Error).message ?? '서버 연결 실패');
        });
    }, SERVER_SYNC_DELAY_MS);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Persist to localStorage immediately, server with debounce ────────────
  useEffect(() => {
    localStorage.setItem('futures_indicators', JSON.stringify(indicators));
    if (!initializedFromServer.current) return; // don't push until we've pulled
    scheduleSave();
  }, [indicators]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    localStorage.setItem('futures_limits', JSON.stringify(limits));
    if (!initializedFromServer.current) return;
    scheduleSave();
  }, [limits]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateIndicator = useCallback((id: string, updates: Partial<IndicatorConfig>) => {
    setIndicators(prev => prev.map(ind => ind.id === id ? { ...ind, ...updates } : ind));
    initializedFromServer.current = true; // allow server writes after any user change
  }, []);

  const updateLimit = useCallback((key: keyof RiskLimits, value: number) => {
    setLimits(prev => ({ ...prev, [key]: value }));
    initializedFromServer.current = true;
  }, []);

  /**
   * updateLiveTestConfig — LIVE TEST MODE 설정 일괄 업데이트.
   * 불리언 포함 필드를 일괄 적용하기 위해 별도 메서드로 분리.
   */
  const updateLiveTestConfig = useCallback(
    (config: Partial<Pick<RiskLimits, 'liveTestMode' | 'testBudgetUsd' | 'testMaxLossUsd' | 'testMaxLeverage'>>) => {
      setLimits(prev => ({ ...prev, ...config }));
      initializedFromServer.current = true;
    },
    [],
  );

  const resetToDefaults = useCallback(() => {
    setIndicators(DEFAULT_INDICATORS);
    setLimits(DEFAULT_LIMITS);
  }, []);

  return (
    <StrategyContext.Provider value={{
      indicators, limits,
      syncStatus, syncError,
      riskProfile, fetchRiskProfile, requestRiskProfile,
      updateIndicator, updateLimit, updateLiveTestConfig, resetToDefaults,
    }}>
      {children}
    </StrategyContext.Provider>
  );
}

export function useStrategyContext() {
  const ctx = useContext(StrategyContext);
  if (!ctx) throw new Error('useStrategyContext must be used within StrategyProvider');
  return ctx;
}
