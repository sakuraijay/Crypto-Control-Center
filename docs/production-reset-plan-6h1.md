# Production 초기화 계획 — 6H-1 ($1,000 최종 운용 정책)

> **⚠️ 계획 문서 — 실행 금지.** 이 문서의 SQL은 운영자 명시 승인 후에만,
> Production DB에 수동으로 실행한다. Agent는 이 SQL을 실행하지 않는다.

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
