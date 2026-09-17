import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("risk profile API and worker boundary contract", () => {
  const dataRoute = readFileSync(resolve(__dirname, "../routes/data.ts"), "utf8");
  const operatorAuth = readFileSync(resolve(__dirname, "../lib/operatorAuthGuard.ts"), "utf8");
  const worker = readFileSync(resolve(__dirname, "../workers/aiWorker.ts"), "utf8");
  const migration = readFileSync(resolve(__dirname, "../../../../lib/db/src/index.ts"), "utf8");

  it("protects new profile mutation while preserving legacy strategy autosave compatibility", () => {
    expect(dataRoute).toMatch(
      /router\.put\("\/data\/risk-profile",\s*requireOperatorAuth,\s*async/,
    );
    expect(dataRoute).toMatch(/router\.put\("\/data\/strategy",\s*async/);
    const strategy = dataRoute.slice(dataRoute.indexOf('router.put("/data/strategy"'), dataRoute.indexOf('router.put("/data/worker-policy-context"'));
    expect(strategy).toContain('containsReservedAccountingFields(req.body)');
    expect(strategy.indexOf('containsReservedAccountingFields(req.body)')).toBeLessThan(strategy.indexOf('db.select'));
    expect(operatorAuth).toContain("x-operator-pin");
  });

  it("requires operator authentication for the explicit accounting-domain selector", () => {
    expect(dataRoute).toMatch(
      /router\.put\("\/data\/worker-policy-context",\s*requireOperatorAuth,\s*async/,
    );
    expect(dataRoute).toContain("policyContext must be STANDARD_ACTIVE or FIXED_BETA_400");
  });

  it("rejects reserved alpha provenance on both generic trade writer routes", () => {
    const batch = dataRoute.slice(dataRoute.indexOf('router.post("/data/trades/batch"'), dataRoute.indexOf('router.post("/data/trades",'));
    const single = dataRoute.slice(dataRoute.indexOf('router.post("/data/trades",'), dataRoute.indexOf('router.get("/data/strategy"'));
    for (const route of [batch, single]) {
      expect(route).toContain('strategy === FIXED_BETA_TRADE_STRATEGY');
      expect(route).toContain("code: 'RESERVED_ACCOUNTING_SCOPE'");
      const insertAt = route.indexOf('.insert(');
      expect(insertAt).toBeGreaterThan(-1);
      expect(route.indexOf("code: 'RESERVED_ACCOUNTING_SCOPE'")).toBeLessThan(insertAt);
      expect(route).toContain('existing[0]?.strategy === FIXED_BETA_TRADE_STRATEGY');
    }
    const deletion = dataRoute.slice(dataRoute.indexOf('router.delete("/data/trades"'), dataRoute.indexOf('router.get("/data/strategy"'));
    expect(deletion).toContain('or(eq(tradesTable.managedBy, "SERVER"), eq(tradesTable.strategy, FIXED_BETA_TRADE_STRATEGY))');
    expect(deletion.indexOf('FIXED_BETA_TRADE_STRATEGY')).toBeLessThan(deletion.indexOf('db.delete'));
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
