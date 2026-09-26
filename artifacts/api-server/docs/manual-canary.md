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

현재 승인된 Production effective 목표는 다음과 같다.

- `WORKER_ENGINE_MODE=PAPER`
- `AUTO_WORKER_LIVE_ENABLED=false`
- `DELEGATED_SIGNER_ENABLED=true`
- `GMX_API_ORDER_SUBMISSION_ENABLED=true`
- `LIVE_TEST_EXECUTION_LOCKED=false`
- `GMX_RELAY_SUBMISSION_ENABLED=false`
- `GMX_RELAY_NETWORK_ENABLED=false`
- `GMX_RELAY_MODE=DISABLED`

`DELEGATED_SIGNER_ENABLED=true`, `GMX_API_ORDER_SUBMISSION_ENABLED=true`,
`LIVE_TEST_EXECUTION_LOCKED=false`는 signer와 주문 API의 lower-layer capability를
관측·검증할 수 있도록 준비한 상태일 뿐, 실제 execution authorization이나 주문
제출 승인이 아니다.

실제 주문 제출은 PAPER 모드와 AUTO LIVE 차단을 우회할 수 없으며, Relay
submission/network가 모두 비활성화된 동안에는 구조적으로 차단된다. 이후에도
fresh Owner Approval, canonical subaccount listed/authorized 상태와 action budget,
Stop capability, fresh cost-cap, RiskEngine 허용, Controlled Canary readiness,
운영자 명시 승인을 각각 통과해야 한다. 하나라도 충족하지 않으면 fail-closed로
실행 권한은 부여되지 않는다.

따라서 위 capability flag만으로 signer 사용, subaccount authorization, Relay
submit, 실제 주문, 자금 이동 또는 Active Capital 승격이 자동 수행되지 않는다.
실제 canary는 별도 운영자 승인 후 readiness refresh를 포함한 정해진 gate 순서를
따라야 한다.

## Controlled Canary blocker provenance

운영자 status는 blocker의 출처와 실행 결과를 다음처럼 분리한다. 과거 기록이나
PAPER 관측값을 active canonical READY 또는 execution-eligible 증거로 승격하지 않는다.

| Blocker | Authoritative status provenance | Operator-facing 표시 | 실행 결과 |
|---|---|---|---|
| Historical Owner Approval READY | `staleOwnerSignatureReadySessionCount`; canonical nonce에 결속된 `approvalSessionReady`와 별도 | stale READY 수와 active READY 없음 | `actualSubmitPossible=false`; 과거 서명 재사용 금지 |
| PAPER canonical authorization | `paperRelayEvidence.executionOnly[].failureId=CANONICAL_AUTHORIZATION_NOT_EVALUATED_IN_PAPER` | `NOT EVALUATED`, `READ-ONLY / NOT EXECUTION AUTHORIZATION` | canonical authorized로 간주하지 않음 |
| PAPER action budget | `paperRelayEvidence.executionOnly[].failureId=ACTION_BUDGET_NOT_EVALUATED_IN_PAPER` | `NOT EVALUATED`; remaining actions를 `0`으로 대체하지 않음 | action budget sufficient로 간주하지 않음 |
| RiskEngine HARD_STOPPED | `paperEpochPreflight.current`와 `preservedExecutionGates`의 risk state | `HARD_STOPPED`, entry false, unchanged | Canary/OPEN 차단; epoch 제안이 해제하지 않음 |
| Fresh `$0.40` cost-cap evidence 없음 | `paperRuntimeReadiness.costs.*.executionSnapshot` 및 `executionEligibleCostEvidence` | `UNAVAILABLE (fail-closed)` 또는 cap 초과 blocker | 관측 비용을 실행 적격 비용으로 승격하지 않음 |
| Stop capability false | `stopCapability.available=false`와 전체 `reasons` | `UNAVAILABLE (fail-closed)`, 평가 시각·경계·이유 | 보호 Stop을 보장할 수 없으므로 OPEN 차단 |
| Relay disabled | `relaySubmissionEnabled=false`, `relaySubmitNetworkEnabled=false`, `relayMode=DISABLED` | `false / false / DISABLED`, 구조적으로 비활성 | Relay/LIVE 제출 불가 |

모든 행은 독립 blocker다. 하나의 행이 PASS처럼 보이더라도 다른 blocker를 완화하지
않으며, read-only status 조회 자체는 서명·authorization·주문·자금 이동을 수행하지
않는다.

## PAPER readiness와 Stop capability 진단

- `GET /api/executor/gmx-api/status`는 process-memory snapshot만 표시하며 외부
  호출, DB 상태 전이, signer 접근, 서명, prepare/submit을 수행하지 않는다.
- 이 endpoint와 `POST /api/executor/gmx-api/readiness/refresh`는 모두 기존
  operator 인증 경계 안에 있다. 인증되지 않은 자동 감사는 이 경계를 우회하지
  않으며, 공개 `GET /api/executor/livetest/status`를 Canary 비용·Stop capability의
  authoritative evidence로 해석하지 않는다.
- 따라서 인증되지 않은 감사에서 fresh BTC/ETH cost-cap evidence가 보이지 않는
  것은 GMX/RPC 조회 실패 판정이 아니라 `AUTHENTICATED_EVIDENCE_NOT_OBSERVED`다.
  Stop capability도 같은 이유로 공개 status만으로 PASS를 주장할 수 없다.
- 인증된 read-only snapshot의 상태 코드는 다음처럼 해석한다.
  `NOT_EVALUATED`는 현재 process/generation에서 아직 평가 시도가 없었음을,
  `MISSING`/`UNAVAILABLE`은 필요한 관측값이 없음을, `STALE`은 freshness window를
  벗어났음을, `FAILED`는 새니타이즈된 조회 실패가 기록됐음을 뜻한다. 어느
  상태도 PASS로 승격하거나 과거 snapshot을 fresh evidence로 재사용하지 않는다.
- `paperRuntimeReadiness.boundary`는 항상
  `READ_ONLY_NOT_EXECUTION_AUTHORIZATION`이다. Deployment/RPC/decimals/cost가
  모두 verified여도 `readyForControlledCanary`나 Stop 실행 권한을 만들지 않는다.
- Stop capability는 LIVE Stop 실행 전제조건의 순수 파생 상태다. UI는
  `stopCapability.reasons` 전체와 평가 시각을 표시한다. PAPER에서 signer,
  submission, 실행 잠금 등 독립 LIVE 조건이 미충족이면 불가가 정상이다.
- scheduler는 45초 주기로 동작하며 process restart 시 cache를
  `not_evaluated`에서 다시 구성한다. 같은 process의 timer, explicit refresh,
  stop→restart 세대는 단일 active promise에 합류해 외부 read를 겹치지 않는다.
- 실패 후 retry는 이전 cycle이 종료된 뒤 새 cycle 한 번으로만 수행한다.
  중복 start는 새 scheduler를 만들지 않고, 정지된 이전 generation은 다음
  timer를 예약하지 않는다.
- 이 진단과 회귀 테스트는 DB-free dependency injection을 사용한다. HWM,
  거래자본, 주문, execution-eligible cost evidence는 변경하지 않는다.

## PAPER 비용 경제성 파생값

- fresh/verified read-only cost snapshot에서만 거래수수료, 가스, 진입·청산
  price impact, funding/borrowing, 기타 보수 조정과 총액을 표시한다.
- 총 비용률은 `roundTripCost / $20`, cap 초과액은
  `max(0, roundTripCost - $0.40)`, 필요 절감률은
  `cap 초과액 / roundTripCost`로만 계산한다.
- 현재 관측된 `$20 LONG / 1h` 총 비용 약 `$0.48`은 canonical `$0.40`
  cap을 초과하므로 Canary는 차단 상태다. 이 한 점을 더 큰 주문에 선형
  외삽하지 않는다. 경제적 최소 주문규모는 동일 market/direction/holding
  조건에서 여러 notional의 fresh 공식 quote를 읽기 전용으로 sweep하고
  `expectedGrossEdge(N) - effectiveRoundTripCost(N) > 0`인 최소 N을 찾아야 한다.
  양의 기대값 근거와 Stop 실행 가능성이 모두 없으면 최소 주문규모는
  `Unavailable`이며 주문 확대 근거로 사용할 수 없다.
- 비용 회수 최소 gross move/edge는 총비용 USD와 `$20` 대비 총 비용률이다.
  이는 수익 보장이나 주문 크기 확대 제안이 아니다.
- snapshot이 missing/stale/invalid이면 비용 성분·총액·비율·절감값·손익분기값과
  source를 모두 비우고 fail-closed `blockReason`만 표시한다.
- 이 파생값은 process-memory 표시 전용이며 `$0.40` cap, HARD_STOP, HWM,
  거래자본, LIVE/PAPER 잠금이나 execution-eligible evidence를 변경하지 않는다.
