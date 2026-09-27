/**
 * Task #111 — migration 0029_server_paper_executor 정적 SQL 검증 (0028 선례 패턴).
 * additive-only + idempotent 실행 + 중복 OPEN/CLOSE 차단 unique index 3개를 보증한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(
  path.resolve(__dirname, '../../../../lib/db/src/index.ts'), 'utf8');

function migrationBlock(name: string): string {
  const start = src.indexOf(`name: "${name}"`);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf('name: "', start + 10);
  return next === -1 ? src.slice(start) : src.slice(start, next);
}

describe('migration 0029_server_paper_executor — 정적 SQL', () => {
  const block = migrationBlock('0029_server_paper_executor');

  it('컬럼 추가는 전부 ADD COLUMN IF NOT EXISTS (additive + idempotent)', () => {
    for (const col of ['managed_by', 'open_decision_id', 'closes_trade_id',
      'close_kind', 'close_reason', 'stop_price_usd', 'take_profit_price_usd']) {
      const re = new RegExp(`ADD COLUMN IF NOT EXISTS ${col}`, 'i');
      expect(block).toMatch(re);
    }
    expect(block).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(block).not.toMatch(/ALTER COLUMN/i);
  });

  it('중복 방지 unique index 3개 — 결정당 OPEN 1회 / 서버 미청산 1개 / 전량 청산 1회', () => {
    expect(block).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS trades_open_decision_uq/);
    expect(block).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS trades_server_single_open_uq/);
    expect(block).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS trades_full_close_uq/);
    // partial index 조건 — 서버 관리·미청산·FULL만 제약
    expect(block).toMatch(/WHERE\s+open_decision_id IS NOT NULL/i);
    expect(block).toMatch(/managed_by\s*=\s*'SERVER'/);
    expect(block).toMatch(/close_kind\s*=\s*'FULL'/);
  });
});
