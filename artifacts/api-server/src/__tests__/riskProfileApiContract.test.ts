import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("risk profile API and worker boundary contract", () => {
  const dataRoute = readFileSync(resolve(__dirname, "../routes/data.ts"), "utf8");
  const operatorAuth = readFileSync(resolve(__dirname, "../lib/operatorAuthGuard.ts"), "utf8");
  const worker = readFileSync(resolve(__dirname, "../workers/aiWorker.ts"), "utf8");
  const migration = readFileSync(resolve(__dirname, "../../../../lib/db/src/index.ts"), "utf8");

  it("protects profile mutation with operator auth without changing strategy PUT auth", () => {
    expect(dataRoute).toMatch(
      /router\.put\("\/data\/risk-profile",\s*requireOperatorAuth,\s*async/,
    );
    expect(dataRoute).toMatch(/router\.put\("\/data\/strategy",\s*async/);
    expect(operatorAuth).toContain("x-operator-pin");
  });

  it("promotes at cycle start and attaches the immutable snapshot before persistence/execution", () => {
    const promote = worker.indexOf("promoteRiskProfileAtSafeBoundary(baseLimits)");
    const engine = worker.indexOf("const engineResult = runAiEngine");
    const persist = worker.indexOf("this.persistDecision(decision)");
    const execute = worker.indexOf("this.runServerPaperExecution(decision");
    expect(promote).toBeGreaterThan(-1);
    expect(promote).toBeLessThan(engine);
    expect(worker).toContain("riskProfile,");
    expect(persist).toBeLessThan(execute);
  });

  it("migration stores audit snapshots and replaces the one-position index with two slots", () => {
    const start = migration.indexOf('"0031_risk_profiles"');
    const sql = migration.slice(start, migration.indexOf("// Add future migrations here", start));
    expect(sql).toContain("risk_profile_snapshot jsonb");
    expect(sql).toContain("DROP INDEX IF EXISTS trades_server_single_open_uq");
    expect(sql).toContain("trades_server_open_slot_uq");
    expect(sql).toContain("trades_server_open_symbol_uq");
    expect(sql).toContain("trades_paper_position_slot_check");
    expect(sql).toContain("paper_position_slot IN (1, 2)");
  });
});
