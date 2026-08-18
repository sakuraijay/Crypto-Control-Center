# Beta Release Candidate — Checklist · Runbook · Go/No-Go

절대 마감: **Asia/Manila 2026-08-19 13:00**. 이후 2026-08-20부터 Controlled Canary(실자금) 예정.
현 시점 기능 동결 — P0/P1 결함 수정만 허용.

---

## 1. Beta Release Checklist

### 1.1 실행 안전 (전 항목 필수 — 하나라도 미충족 = No-Go)
- [x] `engineMode=PAPER` (WORKER_ENGINE_MODE), `liveExecutionLocked=true`
- [x] Delegated signer 비활성 (`DELEGATED_SIGNER_ENABLED` 미설정 = 차단, `delegatedSigner.ts` 정확 `true` 문자열만 활성)
- [x] GMX order submission 비활성 (`GMX_API_ORDER_SUBMISSION_ENABLED` 미설정 = `gmxApiSubmitFlow.ts` 차단)
- [x] Relay LIVE 구조적 비활성 (`relayActivationStatus.ts` 정확 `true` 요구)
- [x] `autoPromotionAllowed=false` (`riskPolicy.ts` 타입 수준 false)
- [x] Canary 기본 비활성 + 수동 승인 필수 (`riskPolicy.ts`)
- [x] LIVE gate: delegated signer 부재 시 거부 (`liveTestGate.ts`)

### 1.2 데이터 무결성 (P0)
- [x] #120 가격 캐시: tokenAddress→SDK registry decimals 결속, 미등재/불일치/범위 밖 tick 폐기(집계), 추측/클램프/0 대체 없음 (`routes/gmx.ts`, `priceCacheBinding.test.ts`)
- [x] 가격 신선도: 진입 ≤60s, 관리 ≤90s, stale = 진입/청산 보류 (합성가 금지)
- [x] 비용 결속: PAPER_GMX_ESTIMATE 스냅샷+rate 필수, 부재 = NO_TRADE
- [x] Intel freshness: 구성요소 관측시각 min-결속, stale 표기
- [x] 오류의 0/정상 위장 금지: 정산 실패=net null, 폐기=카운터 집계, UNRESOLVED 자동 해소 없음

### 1.3 RiskEngine $1,000 정책 (서버 권위)
- [x] 자본 $1,000 기준, 레버리지 ≤3x, 동시 포지션 ≤1, Manila 일일 진입 ≤3 (`riskPolicy.ts` + `serverPaperExecutor.ts` 이중 게이트)
- [x] 모든 OPEN에 stop 계약 선확보 (stop 산출 실패 = OPEN 금지)
- [x] pendingClose durable 영속·재시작 복원·persist/load 실패 = fail-closed (unresolved, 신규 진입 차단)

### 1.4 중복·재시작 내구성
- [x] unique index 3종: open_decision / SERVER 단일 미청산 / FULL close claim (임베디드 migration, IF NOT EXISTS 멱등)
- [x] 클라이언트 overwrite 가드: SERVER 관리 행 POST/close 거부 (`routes/data.ts`)
- [x] 재시작 reconcile: intents·close intent·paper open 행 DB 재파생; UNRESOLVED → FAILED 자동 전환 없음
- [x] E2E 수명주기 테스트: OPEN→SL/TP/CASH/RISK close→net settlement→재시작 복구→중복 0건 (`serverPaperE2eLifecycle.test.ts`)

### 1.5 서비스 상태
- [x] `/healthz` JSON 전용 (readiness 전 503, 후 200) — SPA HTML 반환 금지
- [x] readiness gate: 마이그레이션 완료 전 /api 503 (`/api/healthz`·`/healthz` 제외)
- [x] Settings/Dashboard Beta RC 상태 카드 (읽기 전용): serverPaperExec·Intel calibration·freshness·차단 사유

### 1.6 검증 파이프라인
- [ ] api-server + futures-web 전체 테스트 통과
- [ ] typecheck-ci 통과
- [ ] build:deploy 성공
- [ ] Architect 최종 P0 리뷰 (심각 결함 별도 커밋 수정)
- [ ] github/main push + GitHub Actions success
- [ ] Production Publish는 하지 않음 (운영자 수동)

---

## 2. 운영 Runbook

### 2.1 배포 (운영자 수동)
1. Replit Publish (Reserved VM) — HEAD가 CI success인지 확인.
2. 기동 확인: `GET https://currencycalc.org/healthz` → `{"status":"ok","ready":true}` (503이면 마이그레이션 진행 중 — 수 분 대기).
3. `GET /api/executor/status` → `engineMode:"PAPER"`, `liveExecutionLocked:true`, `serverPaperExec` non-null 확인.

### 2.2 일상 관제 (Beta 기간)
- Settings → System Status → **Beta RC 상태** 카드:
  - `UNRESOLVED` 표기 시: DB 영속 실패/durable 상태 불명 — 신규 진입 자동 차단됨. 서버 로그 확인 후 지속 시 재기동.
  - `틱 stale`: GMX 시세 나이 >90s — 청산/관리 자동 보류. GMX API 장애 여부 확인.
  - `전량 청산 대기`: CASH/RISK 전환 진행 중 — 정상 (완료 시 자동 해제).
  - Intel `STALE`/차단 사유: SHADOW 전용이므로 실행 영향 없음. 관찰만.
- 가격 이상 의심 시: `/api/gmx/prices`에서 심볼 확인 — 결속 실패 tick은 응답에서 제외됨(가짜 가격 없음). 특정 심볼 부재 = SDK registry 미등재 또는 범위 밖 폐기.

### 2.3 장애 대응
| 증상 | 판단 | 조치 |
|---|---|---|
| `/healthz` 503 지속(>10분) | 마이그레이션 실패 가능 | 배포 로그 확인, 마이그레이션 오류 시 롤백 |
| executor `UNRESOLVED` 지속 | durable 저장 실패 | DB 상태 확인 후 재기동 (재시작 reconcile이 복구) |
| 포지션이 청산 안 됨 | 시세 stale 가능성 큼 | Beta RC 카드 틱 상태 확인, GMX API 복구 대기 (합성가 청산은 설계상 금지) |
| CLOSE 중복 의심 | — | `trades_full_close_uq`가 차단함. DB에서 `closes_trade_id` 중복 조회로 검증 |
| 재기동 필요 시 | — | 그냥 재기동 안전: durable-intent-first 설계, OPEN 행·pendingClose는 DB에서 복원 |

### 2.4 긴급 정지
- LIVE는 이미 잠금 상태(실행 0회 구조 보장). PAPER 워커 정지가 필요하면 Reserved VM 재기동 또는 `WORKER_ENGINE_MODE` 변경 후 재배포 (Production Secret 변경은 운영자 수동).

---

## 3. Go/No-Go 판정 항목 (2026-08-19 13:00 Manila)

| # | 항목 | 기준 | 판정 |
|---|---|---|---|
| G1 | 실행 안전 잠금 | §1.1 전 항목 충족 (prod `/api/executor/status`로 확인) | Go 조건 |
| G2 | 가격 무결성 | prod `/api/gmx/prices`에 스케일 오염 심볼 0건, 폐기 카운터 정상 동작 | Go 조건 |
| G3 | PAPER 상태 머신 | E2E 테스트 전체 통과 + prod에서 worker 사이클 정상 (오류 사이클 0) | Go 조건 |
| G4 | 재시작 내구성 | 배포 재기동 후 UNRESOLVED 잔존 0건, 중복 행 0건 | Go 조건 |
| G5 | CI | github/main Actions success, 테스트/typecheck/build 전부 green | Go 조건 |
| G6 | 관제 가시성 | Beta RC 카드가 prod에서 실데이터 표시 | Go 조건 |
| G7 | 미해결 P0 | 0건 | Go 조건 |
| — | P1 잔존 | 문서화되고 회피책 있으면 Go 허용 | 조건부 |
| — | P2 잔존 | Go 영향 없음 (Canary 전 정리 권장) | 정보 |

**No-Go 시**: 결함 수정 → 별도 커밋 → CI → 재판정. Canary(08-20)는 Beta Go 판정 없이는 진입 금지.

### Canary(08-20) 전 운영자 수동 작업
1. Production Publish (HEAD 최신 커밋).
2. `/healthz`·`/api/executor/status` 확인 (§2.1).
3. Go/No-Go 표 기준 최종 판정 및 승인.
4. (Canary 진입 결정 시에만) LIVE 관련 env 활성화는 별도 지시서로 — Beta 범위 밖.
