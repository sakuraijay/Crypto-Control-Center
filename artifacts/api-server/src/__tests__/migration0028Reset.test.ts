import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 0028_paper_reset_1000 guarded migration — 정적 계약 검사.
 * 실제 PG 실행 없이 migration SQL의 안전 가드가 구조적으로 존재함을 강제한다.
 * (dev 환경 실동작: 지문 불일치 → SKIPPED no-op — 워크플로 재기동으로 별도 확인)
 */
describe('0028_paper_reset_1000 guarded migration 계약', () => {
  let sql: string;
  beforeAll(() => {
    const src = readFileSync(resolve(__dirname, '../../../../lib/db/src/index.ts'), 'utf8');
    const start = src.indexOf('"0028_paper_reset_1000"');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('// Add future migrations here', start);
    sql = src.slice(start, end);
  });

  it('동시 기동 직렬화 — advisory xact lock을 모든 가드 평가 전에 획득', () => {
    const lockIdx = sql.indexOf(`pg_advisory_xact_lock(hashtext('paper_reset_1000'))`);
    const guardIdx = sql.indexOf(`key = 'paperReset1000Audit'`);
    expect(lockIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(lockIdx); // lock 획득 후 가드 평가 (TOCTOU 제거)
  });

  it('terminal 가드 — 정확한 JSON outcome=APPLIED만 영구 no-op (SKIP은 terminal 아님)', () => {
    expect(sql).toMatch(/\(v_audit::json->>'outcome'\) = 'APPLIED' THEN RETURN; END IF;/);
    // skip 로그는 별도 키 — 감사 키를 오염시켜 적용 기회를 차단하지 않음
    expect(sql).toContain(`'paperReset1000SkipLog'`);
  });

  it('외부 writer TOCTOU 차단 — 관련 테이블 전부 write-conflict lock 후 count', () => {
    const lockIdx = sql.indexOf('LOCK TABLE');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(sql).toMatch(/LOCK TABLE trades, live_approvals, execution_intents, relay_tasks, protection_orders,\s*worker_state, strategy_config IN SHARE ROW EXCLUSIVE MODE;/);
    // lock이 모든 count/지문 조회보다 앞서야 함
    expect(lockIdx).toBeLessThan(sql.indexOf('INTO v_sc_rows'));
  });

  it('legacy 지문 전항목 일치 시에만 적용 — Production 관측값과 정확히 결속', () => {
    for (const lit of [`v_capital = '24.5'`, `v_lev = '10'`, `v_daily = '500'`,
      `v_weekly = '1500'`, `v_maxpos = '5'`, `v_hwm = '10000'`,
      `"equity":24.5`, `"equity":10000`, `"riskOperatingState":"HARD_STOPPED"`,
      'v_sc_rows = 1']) {
      expect(sql).toContain(lit);
    }
    // NULL 3치 논리 방어 — 키 부재 시 조건 NULL이 skip 분기를 우회하지 못하도록 coalesce 필수
    expect(sql).toMatch(/IF NOT coalesce\(\(v_sc_rows = 1/);
    expect(sql).toContain(`), false) THEN`);
  });

  it('지문 불일치 = 안전한 no-op + skip 로그 upsert (예외 아님 — dev/정상화 환경 보호)', () => {
    expect(sql).toContain(`'SKIPPED_FINGERPRINT_MISMATCH'`);
    // 관찰 로그는 매 기동 갱신 (DO NOTHING이 아니라 DO UPDATE — 최신 관측 유지)
    expect(sql).toMatch(/paperReset1000SkipLog'[\s\S]*?ON CONFLICT \(key\) DO UPDATE/);
  });

  it('stopCoverage fail-closed — 미해결(PENDING/FAILED_CLOSING/UNRESOLVED) 잔존 시 예외', () => {
    // canonical key는 liveTestExecutor의 STOP_COVERAGE_KEY = 'stopCoverage' (V1 아님)
    expect(sql).toContain(`key = 'stopCoverage'`);
    expect(sql).not.toContain(`'stopCoverageV1'`);
    for (const s of ['%PENDING%', '%FAILED_CLOSING%', '%UNRESOLVED%']) expect(sql).toContain(`'${s}'`);
    expect(sql).toMatch(/RAISE EXCEPTION 'paper_reset_1000 사전 조건 위반: stopCoverage/);
  });

  it('활동 흔적 0건 사전 조건 — 위반 시 RAISE EXCEPTION (전체 롤백 + readiness 차단)', () => {
    for (const t of ['live_approvals', 'execution_intents', 'relay_tasks', 'protection_orders']) {
      expect(sql).toContain(t);
    }
    expect(sql).toContain(`settlement_status = 'UNSETTLED'`);
    expect(sql).toMatch(/RAISE EXCEPTION 'paper_reset_1000 사전 조건 위반/);
  });

  it('각 mutation은 행 수 검증 — 예상(1/1/1/2) 불일치 시 예외로 전체 롤백', () => {
    const diag = sql.match(/GET DIAGNOSTICS v_rc = ROW_COUNT;/g) ?? [];
    expect(diag.length).toBe(4);
    expect(sql).toContain(`'strategy_config UPDATE rows=% (expected 1)'`);
    expect(sql).toContain(`'equityHwm UPDATE rows=% (expected 1)'`);
    expect(sql).toContain(`'riskEngineStateV1 DELETE rows=% (expected 1)'`);
    expect(sql).toContain(`'baseline DELETE rows=% (expected 2)'`);
  });

  it('적용 값 = 승인된 $1,000 정책 (1000/3/30/80/1)', () => {
    for (const pair of [`'{tradingCapital}', '1000'`, `'{maxLeverage}', '3'`,
      `'{dailyLossLimitUSDT}', '30'`, `'{weeklyLossLimitUSDT}', '80'`,
      `'{maxSimultaneousPositions}', '1'`]) {
      expect(sql).toContain(pair);
    }
  });

  it('durable audit backup — APPLIED 기록에 변경 전 원본 값 전부 보존', () => {
    expect(sql).toContain(`'APPLIED'`);
    for (const f of ['equityBaselineDaily', 'equityBaselineWeekly', 'riskEngineStateV1', 'stopCoverage']) {
      expect(sql).toContain(`'${f}', v_`);
    }
  });

  it('이력·표본 보존 — trades/ai_decisions/shadow/intel 테이블에 파괴적 접촉 없음', () => {
    expect(sql).not.toMatch(/DELETE FROM trades/);
    expect(sql).not.toMatch(/DELETE FROM ai_decisions/);
    expect(sql).not.toMatch(/DELETE FROM live_approvals/);
    expect(sql).not.toMatch(/shadow_outcomes|opportunity_candidates|market_intelligence/);
    expect(sql).not.toMatch(/UPDATE trades|TRUNCATE|DROP TABLE/);
    // worker_state DELETE는 리스크 상태 키 3종만
    const deletes = sql.match(/DELETE FROM worker_state WHERE key[^;]+;/g) ?? [];
    expect(deletes.length).toBe(2);
    expect(deletes.join(' ')).toContain('riskEngineStateV1');
    expect(deletes.join(' ')).toContain('equityBaselineDaily');
  });

  it('단일 트랜잭션 경계 — 전체가 하나의 DO 블록', () => {
    expect((sql.match(/DO \$reset1000\$/g) ?? []).length).toBe(1);
    expect((sql.match(/\$reset1000\$;/g) ?? []).length).toBe(1);
  });
});
