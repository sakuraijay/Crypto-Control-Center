# Production 초기화 계획 — 6H-1 ($1,000 최종 운용 정책)

> **⚠️ 계획 문서 — 실행 금지.** 이 문서의 SQL은 운영자 명시 승인 후에만,
> Production DB에 수동으로 실행한다. Agent는 이 SQL을 실행하지 않는다.

## 6H-2 갱신 사항 (2026-08-18)

- **trades 정산 컬럼 추가** (마이그레이션 0021, embedded — 배포 시 자동 적용):
  `gross_pnl_usd`, `position_fee_usd`, `execution_fee_usd`, `price_impact_usd`,
  `funding_fee_usd`, `borrowing_fee_usd`, `net_pnl_usd`,
  `settlement_status`(기본 `'UNSETTLED'`), `settled_at`, `evidence_tx_hash`(unique partial index).
  기존 행은 `'PAPER_ZERO_FEE'`로 backfill — 초기화 시 별도 조치 불필요.
- **초기화 사전 확인에 추가**: 미정산 LIVE 거래가 없어야 한다.
  ```sql
  SELECT count(*) FROM trades WHERE settlement_status = 'UNSETTLED' AND test_mode = true;
  ```
  → 0이 아니면 정산(evidence tx 확인) 완료 전 초기화 **중단**.
- **worker_state 초기화 키 추가**: `stopCoverage` (stop-loss coverage 상태머신).
  COVERED가 아닌 기록이 있으면 신규 OPEN이 차단되므로, 포지션 0 확인 후에만
  롤백 캡처에 포함하고 정리한다.
  ```sql
  SELECT * FROM worker_state WHERE key = 'stopCoverage';
  ```
- **PnL 산정 의미 변경**: RiskEngine 목표(+5%/+10%) 산정에서 UNSETTLED 이익은
  제외되고 손실은 즉시 반영된다(보수적 비대칭). 초기화 직후 목표 대비 수치가
  과거 화면과 다르게 보일 수 있으나 이는 의도된 동작이다.

## 목적

Production을 $1,000 최종 운용 정책 기준으로 초기화:
- `tradingCapital = 1000`
- `equityHwm = 1000`
- Manila 기준점(startOfDay/startOfWeek equity) = 1000
- 일일/주간 카운터·잠금 = 0/해제 (단, 초기화 시점에 hard stop/UNRESOLVED가 존재하면
  **원인 조사 완료 전 초기화 금지**)

## 사전 조건 (전부 충족해야 진행)

1. 최신 6H-1 빌드가 Production에 배포되어 있고 `/api/risk/policy`가 정책값을 반환.
2. Worker가 정지 상태이거나 저활동 시간대(Manila 새벽)에 실행.
3. 열린 포지션 0개, PENDING 승인 0건 확인:
   ```sql
   SELECT count(*) FROM trades WHERE action='OPEN' AND (close_time IS NULL OR close_time = 0);
   SELECT count(*) FROM live_approvals WHERE status='PENDING';
   ```
   → 둘 다 0이 아니면 **중단**.
4. 롤백용 원본 캡처 (실행 전 필수):
   ```sql
   SELECT * FROM strategy_config;
   SELECT * FROM worker_state WHERE key IN
     ('equityHwm','riskEngineStateV1','equityBaselineDaily','equityBaselineWeekly');
   ```
   결과를 안전한 위치에 저장.

## 검증 SELECT (실행 전 상태 확인)

```sql
SELECT id, limits->>'tradingCapital' AS capital, limits->>'maxLeverage' AS lev FROM strategy_config;
SELECT key, value FROM worker_state ORDER BY key;
```

## 초기화 (단일 트랜잭션)

```sql
BEGIN;

-- 1) strategy_config limits를 정책값으로 (1행만 존재해야 함)
UPDATE strategy_config SET
  limits = jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(limits::jsonb,
    '{tradingCapital}','1000'),
    '{maxLeverage}','3'),
    '{dailyLossLimitUSDT}','30'),
    '{weeklyLossLimitUSDT}','80'),
    '{maxSimultaneousPositions}','1'),
  updated_at = now();
-- 검증: UPDATE 1 이어야 함. 0 또는 2+ 이면 ROLLBACK.

-- 2) equity HWM = 1000
INSERT INTO worker_state (key, value) VALUES ('equityHwm','1000')
  ON CONFLICT (key) DO UPDATE SET value='1000', updated_at=now();

-- 3) RiskEngine 상태 제거 → 다음 사이클에 equity 기준으로 재수립
--    (재수립 시 startOfDay/startOfWeek = 현재 equity, 카운터 0, 잠금 없음)
DELETE FROM worker_state WHERE key = 'riskEngineStateV1';

-- 4) UTC 기간 PnL 기준점 제거 → 다음 사이클에 재수립 (dailyPnl 왜곡 -9975.5 해소)
DELETE FROM worker_state WHERE key IN ('equityBaselineDaily','equityBaselineWeekly');

COMMIT;
```

### ROLLBACK 조건

- 어떤 UPDATE/DELETE의 row count가 예상과 다르면 `ROLLBACK;`
  - strategy_config UPDATE ≠ 1
  - worker_state 키가 예상외로 다수 매칭
- 트랜잭션 중 오류 발생 시 자동 ROLLBACK 확인 후 원인 조사.

## 실행 후 검증

```sql
SELECT limits->>'tradingCapital', limits->>'maxLeverage' FROM strategy_config;  -- 1000, 3
SELECT key, value FROM worker_state WHERE key='equityHwm';                      -- 1000
SELECT count(*) FROM worker_state WHERE key='riskEngineStateV1';                -- 0
```

## Worker 재시작 필요 여부

**필요.** WorkerManager는 HWM·RiskEngine 상태를 메모리에 캐시하므로,
DB 초기화 후 반드시 Reserved VM 재시작(또는 재배포)으로 워커를 재기동해
새 값으로 재수립하게 한다. 재시작 없이 두면 메모리의 구 HWM이 다시 저장될 수 있다.

## 롤백 절차

사전 조건 4에서 캡처한 원본 값을 동일한 `INSERT … ON CONFLICT DO UPDATE` /
`UPDATE` 패턴으로 복원한 뒤 Worker 재시작.

## 하지 않는 것

- trades / ai_decisions / live_approvals 이력 삭제 (감사 기록 보존)
- execution_intents / relay_* 테이블 접촉 (전부 0행, 접촉 불필요)
- Secrets / env 변경

## 6H-2A 추가 — 비용/정산 사전 조회 (읽기 전용, 실행 금지)

reset 실행 전, 아래 읽기 전용 조회로 legacy·미정산 상태를 확인한다.
**이 섹션의 어떤 항목도 자동 실행하지 않는다 — 문서상 계획일 뿐이다.**

```sql
-- 1) legacy PAPER_ZERO_FEE 행 존재 여부 사전 조회 (신규 기록 경로는 폐지됨)
SELECT count(*) FROM trades WHERE settlement_status = 'PAPER_ZERO_FEE';

-- 2) settlementStatus별 row count
SELECT settlement_status, count(*) FROM trades GROUP BY settlement_status;

-- 3) UNSETTLED row 0 확인 — LIVE 미정산 거래가 남아 있으면 canary 부적격
SELECT count(*) FROM trades
 WHERE test_mode = true AND settlement_status = 'UNSETTLED';

-- 4) stopCoverage 잔존 PENDING/ACTIVE 확인 (worker_state 'stopCoverageV1')
SELECT value FROM worker_state WHERE key = 'stopCoverageV1';
--   → JSON에서 status가 PENDING/FAILED_CLOSING/UNRESOLVED인 항목이 있으면 미해결

-- 5) close-all pending 확인 — /api/executor/status의 closeAllSummary에서
--   lockRequired=true 또는 pending>0이면 reset 전 운영자 확인 필수
```

### 비용/정산 데이터가 없을 때의 초기 상태

- trades에 비용 컬럼(cost_source, est_*)이 비어 있는 것은 reset 직후의 정상 상태다.
- settlementStatus가 전무한(전부 NULL/legacy) 상태에서는 이익이 목표 산정에
  반영되지 않는다 — 이는 fail-closed 설계이며 오류가 아니다.

### reset 이후 NO_TRADE가 정상임을 명시

reset 직후 Worker는 PAPER 진입 전 `PAPER_GMX_ESTIMATE` 비용 스냅샷 확보를
요구한다. 비용 조회 경로가 아직 데이터를 확보하지 못한 동안 모든 사이클이
`NO_TRADE (COST_DATA_UNAVAILABLE)`로 끝나는 것은 **정상 동작**이다.
비용 확보 전에 0/추정 비용으로 진입을 허용하는 우회는 금지된다.
