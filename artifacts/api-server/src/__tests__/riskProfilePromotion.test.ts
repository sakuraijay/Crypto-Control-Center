import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  return {
    query,
    release: vi.fn(),
    connect: vi.fn(async () => ({ query, release: vi.fn() })),
  };
});

vi.mock("@workspace/db", () => ({
  pool: { connect: mocks.connect },
  db: {},
  executionIntentsTable: {},
  liveApprovalsTable: {},
  protectionOrdersTable: {},
  relayTasksTable: {},
  tradesTable: {},
  workerStateTable: {},
}));

import {
  promoteRiskProfileAtSafeBoundary,
  profileBaseLimits,
  RISK_PROFILE_VERSION,
} from "../lib/riskProfiles";

const base = profileBaseLimits({
  tradingCapital: 1_000,
  reserveCashPct: 20,
  maxMarginPerTrade: 334,
  maxTotalExposureUSDT: 3_000,
  maxLeverage: 3,
  maxSimultaneousPositions: 1,
  cooldownMinutes: 30,
});

function installDatabaseState(
  initial: Record<string, string>,
  boundary: Partial<Record<
    "open_trade" | "pending_approval" | "unfinished_intent"
    | "unfinished_relay" | "pending_protection" | "pending_close",
    boolean
  >> = {},
) {
  const state = new Map(Object.entries(initial));
  mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT key, value FROM worker_state")) {
      return { rows: [...state].map(([key, value]) => ({ key, value })) };
    }
    if (sql.includes("AS open_trade")) {
      return {
        rows: [{
          open_trade: false,
          pending_approval: false,
          unfinished_intent: false,
          unfinished_relay: false,
          pending_protection: false,
          pending_close: false,
          ...boundary,
        }],
      };
    }
    if (sql.includes("INSERT INTO worker_state")) {
      state.set(String(params?.[0]), String(params?.[1]));
      return { rows: [] };
    }
    return { rows: [] };
  });
  return state;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
});

describe("atomic risk-profile promotion", () => {
  it("locks every execution-state table before reading and promoting desired", async () => {
    const state = installDatabaseState({
      riskProfileDesiredV1: JSON.stringify({
        name: "aggressive", version: RISK_PROFILE_VERSION,
        requestedAt: "2026-08-21T00:00:00.000Z",
      }),
      riskProfileAppliedV1: JSON.stringify({
        name: "conservative", version: RISK_PROFILE_VERSION,
        appliedAt: "2026-08-20T00:00:00.000Z",
      }),
    });
    const result = await promoteRiskProfileAtSafeBoundary(base);
    expect(result.applied.name).toBe("aggressive");
    expect(result.pending).toBe(false);
    expect(JSON.parse(state.get("riskProfileAppliedV1") ?? "{}")).toMatchObject({
      name: "aggressive",
      version: RISK_PROFILE_VERSION,
    });

    const calls = mocks.query.mock.calls.map(call => String(call[0]));
    const lock = calls.findIndex(sql => sql.includes("LOCK TABLE worker_state"));
    const stateRead = calls.findIndex(sql => sql.includes("SELECT key, value FROM worker_state"));
    const boundaryRead = calls.findIndex(sql => sql.includes("AS open_trade"));
    const promotionWrite = calls.findIndex(sql => sql.includes("INSERT INTO worker_state"));
    expect(calls.some(sql => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(lock).toBeLessThan(stateRead);
    expect(stateRead).toBeLessThan(boundaryRead);
    expect(boundaryRead).toBeLessThan(promotionWrite);
    expect(calls.at(-1)).toBe("COMMIT");
  });

  it("keeps the request pending when activity exists under the same lock", async () => {
    const state = installDatabaseState({
      riskProfileDesiredV1: JSON.stringify({
        name: "aggressive", version: RISK_PROFILE_VERSION,
        requestedAt: "2026-08-21T00:00:00.000Z",
      }),
      riskProfileAppliedV1: JSON.stringify({
        name: "conservative", version: RISK_PROFILE_VERSION,
        appliedAt: "2026-08-20T00:00:00.000Z",
      }),
    }, { unfinished_intent: true });
    const result = await promoteRiskProfileAtSafeBoundary(base);
    expect(result.applied.name).toBe("conservative");
    expect(result.pending).toBe(true);
    expect(result.reason).toContain("unfinished execution intents");
    expect(JSON.parse(state.get("riskProfileAppliedV1") ?? "{}").name).toBe("conservative");
  });

  it("repairs any corrupt persisted side to conservative without promoting", async () => {
    const state = installDatabaseState({
      riskProfileDesiredV1: JSON.stringify({
        name: "aggressive", version: RISK_PROFILE_VERSION,
        requestedAt: "2026-08-21T00:00:00.000Z",
      }),
      riskProfileAppliedV1: JSON.stringify({
        name: "aggressive", version: RISK_PROFILE_VERSION,
        appliedAt: "not-a-date",
      }),
    });
    const result = await promoteRiskProfileAtSafeBoundary(base);
    expect(result.applied.name).toBe("conservative");
    expect(result.desired.name).toBe("conservative");
    expect(result.reason).toContain("repaired to conservative");
    expect(JSON.parse(state.get("riskProfileAppliedV1") ?? "{}").name).toBe("conservative");
    expect(JSON.parse(state.get("riskProfileDesiredV1") ?? "{}").name).toBe("conservative");
    expect(mocks.query.mock.calls.some(call => String(call[0]).includes("AS open_trade"))).toBe(false);
  });
});
