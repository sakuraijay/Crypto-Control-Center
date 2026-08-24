import { describe, expect, it, vi } from "vitest";

// The profile derivation/validation contract must remain usable in CI without DATABASE_URL.
vi.mock("@workspace/db", () => {
  throw new Error("risk profile pure-path test must not load @workspace/db");
});
import {
  RISK_PROFILE_VERSION,
  applyRiskProfileToLimits,
  deriveRiskProfileLimits,
  parseRiskProfileName,
  parsePersistedAppliedRiskProfile,
  parsePersistedDesiredRiskProfile,
  isAppliedRiskProfileSnapshot,
  profileBaseLimits,
} from "../lib/riskProfiles";
import { computePositionSize } from "../lib/riskSizing";

describe("versioned risk profiles", () => {
  const base = profileBaseLimits({
    tradingCapital: 1_000,
    reserveCashPct: 20,
    maxMarginPerTrade: 334,
    maxTotalExposureUSDT: 3_000,
    maxLeverage: 3,
    maxSimultaneousPositions: 1,
    cooldownMinutes: 30,
  });

  it("conservative is an identity-like application of the existing limits", () => {
    const derived = deriveRiskProfileLimits("conservative", base);
    expect(derived).toMatchObject({
      immediateEntryThreshold: 80,
      maxRiskPerTradePct: 0.75,
      reserveCashPct: 20,
      maxMarginPerTradeUsd: 334,
      maxConcurrentPositions: 1,
      cooldownMinutes: 30,
      maxLeverage: 3,
      maxTotalExposureUsd: 3_000,
      allocatedTradingCapitalUsd: 1_000,
      maxRiskPerTradeUsd: 7.5,
    });
  });

  it("aggressive applies the confirmed preset while intersecting absolute caps", () => {
    const derived = deriveRiskProfileLimits("aggressive", base);
    expect(derived).toEqual({
      immediateEntryThreshold: 70,
      maxRiskPerTradePct: 1,
      reserveCashPct: 10,
      maxMarginPerTradeUsd: 500,
      maxConcurrentPositions: 2,
      cooldownMinutes: 10,
      maxLeverage: 3,
      maxTotalExposureUsd: 3_000,
      allocatedTradingCapitalUsd: 1_000,
      maxRiskPerTradeUsd: 10,
    });
  });

  it("uses only allocated tradingCapital for small accounts", () => {
    const derived = deriveRiskProfileLimits(
      "aggressive",
      profileBaseLimits({ ...base, tradingCapital: 24.5 }),
    );
    expect(derived.allocatedTradingCapitalUsd).toBe(24.5);
    expect(derived.maxRiskPerTradeUsd).toBeCloseTo(0.245);
    expect(derived.maxMarginPerTradeUsd).toBeCloseTo(22.05);
    expect(derived.maxTotalExposureUsd).toBeCloseTo(73.5);
  });

  it("unknown profile names are rejected so callers can fail closed", () => {
    expect(parseRiskProfileName("aggressive")).toBe("aggressive");
    expect(parseRiskProfileName("future-v2")).toBeNull();
    expect(parseRiskProfileName(null)).toBeNull();
  });

  it("strictly rejects corrupt or non-canonical persisted state", () => {
    expect(parsePersistedDesiredRiskProfile(JSON.stringify({
      name: "aggressive",
      version: RISK_PROFILE_VERSION,
      requestedAt: "2026-08-21T00:00:00.000Z",
    }))?.name).toBe("aggressive");
    expect(parsePersistedDesiredRiskProfile(JSON.stringify({
      name: "aggressive",
      version: RISK_PROFILE_VERSION,
      requestedAt: "not-a-date",
    }))).toBeNull();
    expect(parsePersistedAppliedRiskProfile(JSON.stringify({
      name: "aggressive",
      version: RISK_PROFILE_VERSION,
      appliedAt: "2026-08-21T00:00:00.000Z",
      derivedLimits: {},
    }))).toBeNull();
    expect(parsePersistedAppliedRiskProfile("{broken")).toBeNull();
  });

  it("validates complete immutable decision/order audit snapshots", () => {
    const snapshot = {
      name: "aggressive" as const,
      version: RISK_PROFILE_VERSION,
      appliedAt: "2026-08-21T00:00:00.000Z",
      derivedLimits: deriveRiskProfileLimits("aggressive", base),
    };
    expect(isAppliedRiskProfileSnapshot(snapshot)).toBe(true);
    expect(isAppliedRiskProfileSnapshot({
      ...snapshot,
      derivedLimits: { ...snapshot.derivedLimits, maxConcurrentPositions: 3 },
    })).toBe(false);
    expect(isAppliedRiskProfileSnapshot({
      ...snapshot,
      derivedLimits: { ...snapshot.derivedLimits, maxRiskPerTradeUsd: 999 },
    })).toBe(false);
  });

  it("applies only execution/risk fields and preserves absolute loss settings", () => {
    const derived = deriveRiskProfileLimits("aggressive", base);
    const applied = applyRiskProfileToLimits(base, {
      name: "aggressive",
      version: RISK_PROFILE_VERSION,
      appliedAt: "2026-08-21T00:00:00.000Z",
      derivedLimits: derived,
    });
    expect(applied.dailyLossLimitUSDT).toBe(base.dailyLossLimitUSDT);
    expect(applied.maxDrawdownPercent).toBe(base.maxDrawdownPercent);
    expect(applied.consecutiveLossLimit).toBe(base.consecutiveLossLimit);
    expect(applied.maxSimultaneousPositions).toBe(2);
    expect(applied.reserveCashPct).toBe(10);
  });

  it("risk sizing honors bounded profile input without exceeding the existing 1% maximum", () => {
    const sizingBase = {
      positionSizingCapitalUsd: 1_000,
      stopDistanceFraction: 0.01,
      roundTripFeesFraction: 0,
      adverseImpactBufferFraction: 0,
      fundingBorrowingBufferFraction: 0,
      requestedLeverage: 3,
      liquidityCapUsd: 10_000,
      tierNotionalCapUsd: 10_000,
    };
    const conservative = computePositionSize({ ...sizingBase, riskBudgetPct: 0.75 });
    const aggressive = computePositionSize({ ...sizingBase, riskBudgetPct: 1 });
    const corrupt = computePositionSize({ ...sizingBase, riskBudgetPct: 99 });
    expect(conservative.ok && conservative.allowedRiskUsd).toBe(7.5);
    expect(aggressive.ok && aggressive.allowedRiskUsd).toBe(10);
    expect(corrupt.ok && corrupt.allowedRiskUsd).toBe(10);
  });
});
