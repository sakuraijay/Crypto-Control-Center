# Manual Controlled Canary (#135) — 설계·실패 가능성 표

목적: 자동 Worker(LIVE 자동매매)를 활성화하지 않고, 운영자 인증(PIN) 하에
**단 1회**의 $10 Controlled Canary(OPEN → stop ACTIVE → 운영자 Close → 온체인
CONFIRMED → readback)를 수행하는 전용 경로.

## 하드캡 (서버 강제 — UI 입력으로 확대 불가)

| 항목 | 값 |
|---|---|
| 담보(collateral) | ≤ **10 USDC** |
| 레버리지 | ≤ **2x** (고정 상한) |
| 명목(notional) | ≤ 20 USD (담보×레버리지 파생) |
| 동시 포지션 | **1** |
| 누적 손실 | **3 USDC** 도달 시 신규 OPEN 금지 |
| 일일 주문 | **1회** (durable claim 후 제출) |
| 허용 시장 | BTC, ETH만 |
| 방향 | LONG/SHORT만 |
| 왕복 비용 상한 | ≤ 0.40 USD (RiskEngine보다 엄격) |
| 가격 추격 방지 | preflight 대비 실행 시 가격 드리프트 ≤ 0.5% |

## 구조적 분리 (자동 Worker와)

- 자동 Worker의 LIVE 실행은 `AUTO_WORKER_LIVE_ENABLED === 'true'`일 때만 수행
  (신규 fail-closed 게이트, 기본 미설정=차단). Canary를 위해
  `WORKER_ENGINE_MODE=LIVE` 등으로 전환해도 자동 Worker는 PAPER 동작을 유지한다.
- Canary decisionId 네임스페이스: `manual-canary:<dayKey>[...:close]` —
  aiWorker는 이 네임스페이스를 절대 생성하지 않는다.
- Canary 경로는 어떤 env/플래그도 변경하지 않으며 worker를 시작/전환하지 않는다.

## 2단계 실행 흐름

1. **Preflight (read-only)** — `GET /api/executor/canary/preflight?symbol&direction`
   (PIN 필요). 모든 항목 평가·실패 전체 표시. 통과 시 `preflightId`(120초 TTL) 발급.
   주문·서명·설정 변경·키 복호화 0회.
2. **Execute** — `POST /api/executor/canary/execute` (PIN + preflightId +
   `confirm:"EXECUTE-CANARY-OPEN"`). 실행 직전 **전 조건 서버 재평가** →
   일일예산 durable claim(CAS) → deterministic intent(중복=차단) → 단일 submit 1회.
   timeout/모호 응답 = UNRESOLVED, 자동 재제출 금지 (기존 intent/relay 계층 재사용).
3. **Stop 확인** — OPEN 온체인 CONFIRMED 후 INITIAL_STOP이 온체인 orderKey 증거로
   ACTIVE일 때만 성공 표시. 미확정이면 신규 주문 금지 + emergency close 경로만.
4. **Close** — `POST /api/executor/canary/close` (PIN + `confirm:"EXECUTE-CANARY-CLOSE"`).
   stop ACTIVE 전에는 `mode:"emergency"`만 허용(단일 emergency close, 재제출 금지).
5. **Readback** — close intent 온체인 CONFIRMED + 포지션 0 + PnL/잔고 readback까지
   완료해야 단계 완료. API 응답 수락만으로 성공 처리 금지.

## 실패 가능성 표 (fault injection 테스트 대상)

| # | 실패 모드 | 기대 동작 | 테스트 |
|---|---|---|---|
| F1 | 배포/manifest/router pin 불일치 | preflight FAIL, 실행 거부 | ✔ |
| F2 | signer 암호문/공개주소 결속 실패(부재·주소 불일치) | FAIL (복호화 시도 0회) | ✔ |
| F3 | Owner Approval 없음/만료/count≠8 | FAIL + "새 Prepare+서명 필요" | ✔ |
| F4 | allowance 15 USDC 미확인 | FAIL | ✔ |
| F5 | RPC/GMX API read-only 불가 | FAIL | ✔ |
| F6 | reconciliation 미완료/blocking intent·task·protection > 0 | FAIL | ✔ |
| F7 | 열린 포지션 > 0 | FAIL (동시 1개 캡) | ✔ |
| F8 | cost snapshot 미확보/왕복비용 > $0.40 | FAIL | ✔ |
| F9 | decimals 미검증 | FAIL | ✔ |
| F10 | stop capability 불가 | FAIL (OPEN 자체 금지) | ✔ |
| F11 | 누적 손실 ≥ 3 USDC | FAIL | ✔ |
| F12 | 일일 1회 소진 | FAIL + durable claim 중복 차단 | ✔ |
| F13 | preflightId 만료/불일치/confirm 문구 오류 | 실행 거부 | ✔ |
| F14 | 허용 외 시장/방향 | 거부 | ✔ |
| F15 | 실행 직전 재평가 실패(preflight 이후 상태 악화) | 거부 (제출 0회) | ✔ |
| F16 | 가격 드리프트 > 0.5% | 거부 (시장가 추격 방지) | ✔ |
| F17 | 담보/레버리지 확대 시도(UI 변조) | 서버 clamp/거부 | ✔ |
| F18 | submit timeout/모호 응답 | UNRESOLVED, 자동 재제출 0회 | ✔ (기존 계층 + 상태 표시) |
| F19 | stop 미ACTIVE 상태에서 일반 close 요청 | 거부, emergency 경로만 안내 | ✔ |
| F20 | LIVE 잠금/submission=false (현재 prod) | simulated/차단 — 실제 주문 0건 | ✔ |
| F21 | daily claim CAS 경합 | 한쪽만 성공, 다른 쪽 fail-closed | ✔ |
| F22 | 자동 Worker가 LIVE env에서 자동 진입 시도 | AUTO_WORKER_LIVE_ENABLED 미설정 시 차단 | ✔ |

## 민감정보

PIN·서명·암호문·개인키·RPC URL은 응답/로그/DB 평문에 절대 미포함.
오류는 `sanitizeRpcError`로 새니타이즈.

## 실제 실행 전 필요한 것 (이 작업에서는 변경하지 않음)

Production은 PAPER + LIVE_TEST_EXECUTION_LOCKED=true +
GMX_API_ORDER_SUBMISSION_ENABLED=false 유지. 실제 canary는 별도 운영자 승인 후
플래그 순서(readiness refresh 포함)를 따라야 한다.
