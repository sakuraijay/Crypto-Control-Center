# Crypto Control Center — Project State Index

> **운영 주의:** 이 문서는 실시간 상태 스냅샷이 아니다. 현재 HEAD/CI/배포/PAPER/GMX/Owner Approval/Canary readiness 값은 매 실행마다 authoritative source에서 새로 읽어야 한다. 과거 이 파일에 기록되어 있던 진행률, 배포 SHA, 플래그 기본값, 테스트 개수, readiness 상태는 역사 기록일 뿐 현재 상태로 사용하지 않는다.


## Canonical session implementation handoff — 2026-09-20

새 canonical 대화의 single writer가 Virtual 400 서버 worker 연결, 독립 위험회계,
Dashboard 시작/관찰 UI 및 회귀검증을 구현했다. 기존 PR #1은 OPEN/DRAFT로 유지하며
merge/force/rebase는 금지한다. 구체적 증거와 남은 gate는
[Virtual 400 runtime verification](verification/virtual400-runtime/RESULT.md)을 읽는다.
이 기록은 ALPHA_TESTED/BETA_TESTED 또는 최신 소스 배포 확인이 아니다.
과거 대화는 read-only로 유지한다. 배포/추가 개발 전 authoritative HEAD/CI를 다시 확인한다.


## 최신 테스트 모드 전환 지시 — 2026-09-20

**지시 ID: CCC-OWNER-VIRTUAL-ALPHA-BETA-20261001**  
**상태: 사용자 승인 반영. 기존 10월 1일 최종 시험 기한은 유지하되, 그 기한의 필수 시험은 실자금이 아닌 가상자본/PAPER 기반으로 전환한다.**

사용자 최신 지시 취지:
- 10월 1일 알파/베타에서 실제 자금을 넣지 않고 가상의 머니 또는 가상 매매를 구현할 수 있는지 확인한다.
- 실제 자금 투입이 일정의 허들이라면 실제 자금 자동매매 시연은 과감히 뒤로 미룬다.

### 확정 적용

- **2026-10-01 18:00 Asia/Manila까지 실시해야 하는 알파/베타 테스트의 필수 자본은 400 USDC의 가상자본(VIRTUAL/PAPER)으로 전환한다.**
- 10월 1일 테스트 성공에 실제 USDC 입금, 실제 GMX 주문, MetaMask/서브계정 금융 권한 갱신, LIVE/AUTO LIVE 활성화 또는 실제 자금 이동을 요구하지 않는다. 해당 항목은 10월 1일 일정의 차단 요소에서 제외한다.
- **실제 400 USDC 자동매매 시연은 10월 1일 이후의 별도 Real-Money Canary 단계로 연기한다.** 날짜는 이번 지시에서 새로 확정하지 않는다. 사용자가 별도로 Start/필요 지갑 권한을 수행하고, 소프트웨어·Stop·비용·정산·권한 조건을 재검증한 뒤 진행한다.
- 과거에 사용자가 실제 400 USDC 사용을 승인한 기록은 철회된 것으로 취급하지 않는다. 다만 그 승인은 10월 1일 시험의 필수조건이 아니며, 자동으로 LIVE를 활성화하지 않는다.

### 10월 1일 가상 알파/베타의 의미 있는 합격 기준

가상매매가 단순 차트 애니메이션이나 임의 숫자 변경이 되지 않도록 **실제 운영 코드 경로를 최대한 동일하게 사용하고 execution adapter만 PAPER/virtual로 분리**한다.

1. **가상자본 초기값 400 USDC**를 실제 지갑잔액·Planned Seed·기존 Active Capital과 명확히 분리한다.
2. 실제 시장 데이터 또는 명시적으로 표시된 REPLAY 데이터로 **Signal/Strategy → Risk ALLOW/REDUCE/REJECT → position sizing → OPEN → Stop/TP/protection → management → CLOSE → settlement/accounting** 전 과정을 통과한다.
3. 시장에서 유효 신호가 발생하지 않아 라이프사이클 검증을 못 하는 상황을 피하기 위해, **live PAPER 관측과 별도로 deterministic/replay 시나리오를 사용해 진입·보호·종료·정산 전체 경로를 반드시 실행**한다. REPLAY 결과를 live market 성과로 표시하지 않는다.
4. 수수료·slippage·funding·borrow·price impact는 가능한 실제 관측/기존 cost model을 사용하되, 실제 체결비용이 아닌 값은 **SIMULATED/ESTIMATED**로 표시한다.
5. browser/tab을 닫아도 서버 측 PAPER worker가 지속되고, 재접속·프로세스 재시작 후 상태 복구, duplicate suppression, unresolved/unsettled 차단과 기존 포지션 보호를 확인한다.
6. 신규 진입 차단이 기존 포지션의 Stop/TP/protection/정상 close를 제거하거나 의도하지 않은 close-all로 바뀌지 않는지 확인한다.
7. Dashboard에는 **VIRTUAL 400 USDC / PAPER**를 명확히 표시하고 실제 wallet balance나 LIVE trade로 오인될 표현을 금지한다.
8. 알파는 기능적 E2E 자동매매 경로 검증, 베타는 같은 소스에서 restart/reconnect/idempotency/error handling/지속 운용 안정성을 추가 검증한다. 둘 다 실제 수행 시각·source SHA·배포 SHA·테스트 로그를 남긴다.

### 일정·개발 우선순위 변화

- 10월 1일 기한을 맞추기 위한 우선순위에서 **실자금 wallet authorization, real order submission, LIVE/Relay 금융 활성화는 제거**한다.
- 우선순위는 **PAPER/virtual E2E lifecycle 완성 → 400 virtual accounting → Stop/TP/protection/settlement → restart/duplicate/reconciliation → dashboard/start usability → exact-source deployment → Oct1 alpha/beta execution** 순서다.
- 실제 자금 Canary 준비를 위해 이미 만든 코드·진단은 삭제하지 않지만, 10월 1일 테스트를 방해하는 선행조건으로 두지 않는다.
- 가상 테스트 통과는 실제 체결가격·slippage·funding·wallet permission·on-chain settlement까지 검증했다는 뜻이 아니다. Real-Money Canary에서 별도로 검증한다.

이 지시는 아래의 CCC-OWNER-DEADLINE-20261001-1800 최종기한 지시와 함께 읽으며, **10월 1일 시험의 자금 방식에 대해서는 이 최신 지시가 우선한다.**

## 최신 사용자 최종기한·중단·전환 지시 — 2026-09-20

**지시 ID: CCC-OWNER-DEADLINE-20261001-1800**  
**상태: 사용자 지시 기록·적용. 테스트 실시/성공 또는 개발 완료의 증거가 아님.**

사용자가 현재 canonical 대화에서 프로젝트 메모리에 기록하고 적용하도록 지시한 원문:

1. “반드시 10월1일 오후 6시까지는 알파/베타 테스트 실시할것.”
2. “10월 1일 시간 일정을 못 맞추면 해당 프로젝트는 폐기하고 나는 제미나이 또는 다른 AI 코딩 툴을 찾을 것임.”
3. “다른 코딩툴을 찾아서 내가 원하는 개발일정내로 개발완수하면 별도의 마케팅 툴을 만들어서 챗지피티가 달성하지 못한 테스크를 다른 코딩툴이 완성했다는 마케팅을 내세워서 마케팅을 할것임.”

### 확정 해석과 적용 범위

- **최종 시험 실시 기한: 2026-10-01 18:00 Asia/Manila (UTC+08:00), 즉 2026-10-01T10:00:00Z.** 기존 프로젝트 시간대인 필리핀 시간을 유지한다. 새 timezone이나 추가 연장을 임의로 적용하지 않는다.
- 9월 15일·9월 18일 알파 일정은 과거 계획으로 보존한다. 이번 최종 기한이 활성 일정 기준이며, 과거의 미완료·미확인 기록을 소급 성공으로 고치지 않는다. 10월 1일은 알파/베타 시험 기한이지 자동으로 정식 V1.0/공개 출시일이 아니다.
- 기한까지 계획표·작업 요청·CI 성공만 제시하는 것이 아니라 실제 시험을 실시하고, 실제 시작 시각·소스/배포 버전·시험 모드·수행 범위·결과를 남겨야 한다. **시험 실시 여부, 요구 범위 달성 여부, 시험 합격 여부를 구분한다.** 알파/베타 명칭만 바꾸거나 화면 애니메이션·보고서로 실시를 대체하지 않는다.
- 기존 목표인 손쉬운 대시보드/시작 절차와 **실제 400 USDC를 이용한 초기 제한 승인 이후의 무인 자동매매**를 유지한다. 사용자의 400 USDC 사용 승인은 이미 명시돼 있으며 승인 부재로 반복 보고하지 않는다. 모의·재생 시험은 모의·재생으로 표시하고 실제 400 USDC 목표 달성으로 바꾸지 않는다. 베타의 별도 증액·운용 기간·공개 참가 범위는 이번 지시에서 정하지 않았다.
- 이 지시는 실제 지갑 권한이나 기술적 준비를 생성하지 않는다. 사용자 통제하의 초기 권한/금융 Start와 이후 제품의 자동 운용은 구분한다. assistant/위임 에이전트가 실자금 주문·서명·자동 금융 활성화를 대신 실행하거나 예약하지 않는다. 소프트웨어 개발·수정·격리 검증은 계속할 수 있다.

### 기한 미준수 시 사용자 방침

- 사용자의 **프로젝트 폐기 및 Gemini(제미나이) 또는 다른 AI 코딩 도구로 전환** 방침을 최종기한 미준수의 결과로 기록한다. 기존 방식의 무기한 연장이나 사용자 선택을 방해하는 보고를 하지 않는다.
- 기한에 실제 시험 실시를 입증할 수 없으면 `DEADLINE_MISSED` 또는 `DEADLINE_NOT_VERIFIED`를 명확하게 보고한다. 달성 증거가 없는 상태를 `PASS`로 바꾸지 않는다. 이후 자동 신규 개발·유료 작업을 계속 발주하지 않고 이관/종료 판단을 위한 결과 정리로 전환한다.
- “폐기”를 저장소·소스·DB·로그·지갑·배포 자원을 자동 삭제하는 명령으로 해석하지 않는다. 기존 코드·시험 증거·지출/장애 내역과 재현 절차를 보존해 다른 도구가 이어받을 수 있게 한다. 운영 서버 또는 기존 포지션 보호를 임의로 종료하지 않는다. 삭제·계정 변경·비밀값 이전은 별도 사용자 지시 대상이다.

### 조건부 후속 마케팅 계획

- 상태는 **CONDITIONAL / NOT_STARTED**이다. 다른 도구가 사용자가 원하는 기한 안에 개발을 완수한 경우, 별도의 마케팅 도구를 만들어 **ChatGPT가 달성하지 못한 작업을 다른 코딩 도구가 완수했다는 실제 사례**를 마케팅하겠다는 사용자 계획을 보존한다.
- 현재 마케팅 도구를 개발하거나 외부 게시·광고·비용 집행을 시작하는 승인이 아니다. CCC 시험 준비를 앞질러 이 후속 작업을 수행하지 않는다.
- 향후 비교 자료에는 요청 범위, 실제 도구/버전, 기간, 비용, 기존 코드 재사용과 추가 수정 범위, 테스트·배포·운영 결과를 근거와 함께 구분한다. 불리한 결과도 숨기지 않고, 입증되지 않은 성공·실패·일반적 우월성이나 비용 수치를 만들지 않는다.

### 개발·보고 적용

- 남은 우선순위는 **실제 자동매매 경로와 자본/손실/권한/보호/정산의 미완료 연결 → 동일 수정본의 회귀·통합 검증 → 운영 배포/버전 일치와 사용성 검증 → 알파/베타 실제 시험 및 결과 기록**이다. 이미 완료된 기능을 재구현하지 않는다. UI 꾸미기·추가 거래소·신규 전략·새 도구 구축을 기한보다 앞세우지 않는다.
- Architect → 단일 Implementation Engineer → 독립 Reviewer → 수정/회귀 → SRE 최종 검증을 적용하고, 실제로 실행한 역할과 검증만 기록한다. 실제 소스·테스트 출력·원격 커밋·배포 버전으로 완료를 입증한다. 구현자가 자신의 완료 보고만으로 리뷰를 닫지 않는다.
- 기존 `CCC 시간별 개발` 작업은 매 실행마다 이 절을 먼저 읽고 최종기한, 지난 시간의 실제 완료, 현재 장애와 담당, 다음 실행할 작업, 기한 위험을 한국어로 보고한다. `busy`, 조회 실패, 예산 확인 대기 때문에 보고 자체를 생략하지 않는다. 새 자동화를 만들거나 타 세션을 재활성화하지 않는다.
- 중간 작업이 지연되면 그 실행에서 원인·대안·필요한 사용자 단일 액션을 보고하고, 독립적인 안전 작업을 계속한다. 같은 실패를 반복 조회하거나 정책 수정만 개발 진척으로 계산하지 않는다.
- 기존 비용·안전 권한을 유지한다. 이번 날짜 지정은 추가 충전, $150 예산 확정, 무제한 Agent 사용, 요금제 변경, 종료된 유료 예외의 자동 갱신, PR merge, force push, rebase 또는 Production DB/HWM/자본/Secrets 변경 승인이 아니다.

이 절은 최신 owner instruction의 영속 기록이며, 아래 공통 정책 및 과거 문서의 오래된 일정과 충돌하면 우선한다. 파일 저장은 다른 작업자가 이미 읽었다는 증거나 테스트 성공의 증거가 아니다.

## Canonical authority

1. 현재 canonical ChatGPT 대화의 최신 owner instruction — 위 `CCC-OWNER-DEADLINE-20261001-1800` 기록 포함
2. `docs/CCC_CANONICAL_OPERATING_POLICY_2026-09-07.md` — 최신 owner instruction과 충돌하지 않는 범위
3. 2026-09-01 CCC Master Plan — 위 두 항목과 충돌하지 않는 범위
4. 과거 handoff/task/PR comment 및 Git history

Canonical development branch는 `codex/handover-20260820`, canonical PR은 **#1**이다. `main`은 owner-approved normal PR merge 전까지 현재 개발 source-of-truth로 간주하지 않는다. PR merge, force push, rebase 또는 history rewrite는 별도 명시 승인 없이 수행하지 않는다.

## 프로젝트 정의

- 단일 사용자 개인용 **GMX V2 / Arbitrum One** AI 자동매매 시스템
- 외부 고객용 SaaS가 아님
- Arbitrage SaaS와 분리
- Replit Reserved VM이 Production runtime/final deployment layer
- Desktop-first React + TypeScript UI
- Figma `Crypto Control Center — Trading Terminal UX v1`의 **Institutional Trading Terminal** 방향을 UI/UX source-of-truth로 사용

## 현재 개발·운영 모델

- **ChatGPT/Codex + GitHub:** primary implementation, tests, refactor, docs, release preparation
- **GitHub Actions:** authoritative CI/build/test gate
- **Figma:** UI/UX source-of-truth
- **Replit:** Reserved VM, Production runtime, Secrets, last-mile validation, final publish
- **Replit Agent:** Replit-specific deployment/environment/runtime/rendering blocker 및 최신 명시 승인된 제한 작업에 사용. 시간별 점검, 동일 SHA 재검증, 중복 코드/UI 작업에는 사용하지 않는다.

Production publish는 의미 있는 validated release batch 기준으로 처리하며 정상 운영 중에는 최대 1회/일을 목표로 한다.

## 확정 마일스톤 및 우선순위 — 2026-09-20 사용자 최종기한

- **알파/베타 테스트 실시 최종기한: 2026-10-01 18:00 Asia/Manila (10:00 UTC).** 상세 조건과 미준수 시 종료/이관 방침은 문서 상단의 최신 사용자 지시를 따른다.
- 알파 목표: **손쉬운 사용법 + 초기의 제한된 세션 승인/Start 이후 사람의 매매 판단이나 매 주문 수동 승인 없이 자동으로 진입·보호·관리·종료·정산하는 모습**을 실제로 검증한다. 개발자 명령어, 수동 Buy/Sell, 주문마다 PIN/MetaMask 또는 채팅 지시가 필요한 시연은 이 목표를 충족하지 않는다.
- 초기 지갑 연결·권한 조건 확인·필요한 사용자 서명·제한된 Start 승인과 운용 중 개별 매매 승인은 구분한다. 비상 정지·권한 철회·자동 손실/위험 통제는 유지한다. 400 USDC 사용 승인이 있다는 사실과 현재 기술적 실행 가능성은 구분한다.
- **BETA:** 위 최종기한 안에 시험 실시. 별도의 자본 증액·시험 기간·참가자 범위는 미지정이며 임의로 확장하지 않는다. 알파와 베타의 수행 범위/결과를 각각 기록한다.
- **정식 V1.0/공개 출시일: 별도 미정.** 알파 결과를 반영한 결함 수정·사용성·무인운용 안정성·비용/정산 검증을 베타 준비의 우선순위로 둔다. 수익성 입증 완료 또는 외부 SaaS 출시로 해석하지 않는다.
- 과거 계획인 9월 15일 정오/13시 및 9월 18일 13시 알파와 그 사전 마감은 역사 기록으로 보존한다. 이미 지난 마감의 완료 증거가 없으면 미완료/미확인으로 보고하며 소급 PASS 처리하지 않는다.
- P0/P1 납품 차단 문제가 cosmetic polish보다 우선이며, 거래소/리워드 확대는 BACKLOG_ONLY다.
- 일정 압박으로 Stop, idempotency, duplicate-order protection, settlement/reconciliation, daily loss/drawdown protection을 제거하거나 우회하지 않는다.
- 기술적 기준은 공통 정책 sections 12/14를 최신 날짜 지시에 맞춰 읽는다. 기존 `FIXED_BETA_400`/`fixedBeta*` 내부 코드·DB 식별자는 호환성을 위해 유지할 수 있으며, 명칭 정정만을 이유로 rename/migration/자본 초기화를 수행하지 않는다.

## AI / Risk / Execution core contract

기존 architecture를 교체하지 않고 유지·확장한다.

- Closed candle: **4H / 1H / 15m**, closed candle only
- Tick/oracle price는 execution freshness/risk check용이며 candle strategy 대체 금지
- Missing/stale/invalid market evidence는 fail-closed; synthetic candle 및 fake zero-volume 금지
- Regime-aware strategy ensemble: Trend Pullback, Volatility Breakout, Range Mean Reversion 중심
- 기존 **Risk Engine이 최종 ALLOW / REDUCE / REJECT 권한** 보유
- Cost-aware execution: fees, funding, borrowing, gas/relay, slippage, price impact 포함
- Structural Stop, TP, REDUCE70/profit protection, trailing, emergency close 유지
- Durable intent, restart recovery, duplicate suppression, settlement/reconciliation 유지

## Capital model

- **Planned Seed:** 10,000 USDC
- **ALPHA:** 사용자가 승인한 별도 400 USDC 시험자본. 한 주문에 전액 투입/전액 손실 허용이 아니며 실제 지갑잔액과 구분한다. 기존 Risk/HWM과 충돌하지 않는 검증이 필요하고 Production 자본 변경은 별도 승인 대상이다.
- **BETA의 별도 자본 증액:** 미정. 명칭·일정 변경에 따른 자동 자본 증액은 없다.
- 서로 분리해 취급: wallet balance / Planned Seed / Active Trading Capital / Reserve Capital / runtime Risk Equity/HWM
- Active Capital ladder: **1,000 → 2,500 → 5,000 → 10,000 USDC**
- 실용 검증은 필요 시 1K → 5K → 10K로 압축할 수 있으나 **자동 승급 금지**
- 단계 승급은 비용 후 positive expectancy, GMX order/fill/settlement 신뢰성, Stop/emergency close, mismatch=0, loss/DD compliance, Canary validation 및 owner approval을 요구한다.

## Execution safety

현재 owner-approved configuration values로 유지·검증 가능한 값:

- `DELEGATED_SIGNER_ENABLED=true`
- `GMX_API_ORDER_SUBMISSION_ENABLED=true`
- `LIVE_TEST_EXECUTION_LOCKED=false`

그러나 위 플래그는 실제 주문 승인이 아니다. 사용자 통제의 제한적 활성화 전에는 다음 runtime boundary를 유지한다.

- `WORKER_ENGINE_MODE=PAPER`
- `AUTO_WORKER_LIVE_ENABLED=false`
- Relay submission OFF
- Relay submit network OFF

400 USDC 사용 승인은 기록됐지만 assistant/위임 에이전트가 실제 주문·자금 이동·금융 서명·자동 LIVE 활성화를 대신 수행하거나 예약하지 않는다. 새 MetaMask signature, owner-required secret mutation, Production DB/HWM/trading-capital mutation은 일정 변경으로 자동 승인되지 않는다.

Owner Approval이 과거 `OWNER_SIGNATURE_READY`에 도달했더라도 freshness와 현재 usable session을 다시 검증해야 하며, stale/expired consent는 재사용하지 않는다.

알파의 무인운용은 **사용자가 필요한 초기 권한을 승인한 유효한 제한 세션 안에서의 자동 실행** 요구다. 세션 시작 전과 운용 중 행위를 구분해 기록하고, 정상적인 운용 중 수동 매매 판단/개별 주문 승인 횟수 0을 실제 기록으로 확인해야 한다. 브라우저·채팅을 닫아도 서버 운용/보호가 유지돼야 한다. 권한 만료/액션 부족/위험 한도 도달 시 신규 진입을 자동 차단하고 검증된 보호 경로를 유지하며, 무기한 권한 연장이나 무인운용 합격을 추정하지 않는다.

## Controlled Canary fail-closed gate

다음이 **동시에 fresh PASS**일 때만 Canary를 검토한다.

- fresh Owner Approval
- canonical delegation / sufficient action budget
- exact observed immutable **$0.40 round-trip cost cap**
- Stop capability
- Risk permission / HARD_STOP-safe resolution
- release identity / safety attestation
- GMX/RPC/open-position consistency
- 사용자 통제의 실제 금융 시작과 승인 범위 확인

401, unavailable, stale 또는 과거 PASS는 현재 PASS로 추론하지 않는다.

## 이미 구축된 핵심 영역 — 상세 내역은 Git history/PR #1 참조

- GMX official reader/DataStore/ABI 기반 온체인 읽기
- PAPER worker와 AI/Risk integration
- closed-candle MTF foundation, market structure/regime/strategy ensemble 계열
- cost-readiness 및 fail-closed Canary diagnostics
- durable execution intent와 restart/idempotency/duplicate protection
- on-chain reconciliation 및 unresolved-state blocking
- delegated signer / owner approval / relay dry-run 및 gated relay architecture
- single-process/single-port Reserved VM deployment topology
- release identity/safety 및 health/readiness 진단 경로
- desktop operator terminal UI의 Figma migration 기반

이 항목들은 “현재 runtime PASS”를 의미하지 않는다. 구현 존재 여부와 현재 운영 evidence를 구분한다.

## 현재 P0/P1 delivery work 판단 기준

매 canonical run에서 아래를 fresh evidence로 재확인한다.

1. PR #1 state / HEAD / exact-head CI
2. Replit passive deployment/publish status
3. Production release identity/safety evidence when accessible
4. PAPER scheduler heartbeat
5. GMX RPC 및 positions consistency
6. Owner Approval freshness / canonical delegation / action budget
7. exact $0.40 cost evidence
8. Stop capability 및 Risk/HARD_STOP-safe state
9. unresolved/unsettled/duplicate execution state
10. publish source parity 및 post-deploy attestation
11. 쉬운 시작 절차 및 승인된 세션의 무인 실행/보호/정산 증거; 초기 설정과 운용 중 사용자 개입을 분리

증거가 unavailable이면 `UNKNOWN`으로 남기며 Replit Agent 사용만으로 상태를 알아내려 하지 않는다.

## Known P1 documentation/release-process item

`.github/workflows/post-publish-attestation.yml`의 scheduled trigger는 default branch에 workflow가 존재해야 dependable하게 동작한다. 현재 이 문제는 owner-approved normal PR flow로만 해결하며, 이를 이유로 `main` direct write나 PR merge를 수행하지 않는다.

## Historical material

이 파일의 2026-09-07 이전 버전에는 당시 task 번호, test count, 배포 SHA, 플래그 상태 및 단계별 delegated trading 구현 기록이 상세히 들어 있다. 해당 내용은 Git history에서 보존되며 architecture history/forensics 용도로만 사용한다. 현재 운영값의 근거로 사용하지 않는다.

과거의 9월 15일 베타/정오 알파/9월 18일 알파/10월 1일 정식 출시, 첫 LIVE 테스트의 매 주문 수동 승인 설명은 최신 시험 실시 기한 및 무인운용 목표와 구분한다. 과거 파일을 다시 읽었다는 이유로 최신 일정을 되돌리거나 개별 주문 수동 시연을 무인 알파 완료로 보고하지 않는다. 이 문서 업데이트는 다른 대화/자동화가 실제로 읽거나 실행했다는 증거가 아니다.

## 절대 금지

- 메인 지갑 private key / seed phrase / Secret 저장·출력
- assistant의 실자금 주문·서명·자동 금융 활성화 또는 자금 이동
- 중복 주문 또는 unresolved 상태에서의 추가 주문
- safety gate 우회
- mobile/Arbitrage SaaS 범위 확장
- `attached_assets/` 커밋
- owner 승인 없는 PR merge, force push, rebase, history rewrite
