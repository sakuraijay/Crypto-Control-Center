# Crypto Control Center — Project State Index

> **운영 주의:** 이 문서는 실시간 상태 스냅샷이 아니다. 현재 HEAD/CI/배포/PAPER/GMX/Owner Approval/Canary readiness 값은 매 실행마다 authoritative source에서 새로 읽어야 한다. 과거 이 파일에 기록되어 있던 진행률, 배포 SHA, 플래그 기본값, 테스트 개수, readiness 상태는 역사 기록일 뿐 현재 상태로 사용하지 않는다.

## Canonical authority

1. 현재 canonical ChatGPT 대화의 최신 owner instruction
2. `docs/CCC_CANONICAL_OPERATING_POLICY_2026-09-07.md`
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
- **Replit Agent:** Replit-specific deployment/environment/runtime/rendering blocker에만 예외적으로 사용. 시간별 점검, 동일 SHA 재검증, ordinary code/UI 작업에는 사용하지 않는다.

Production publish는 의미 있는 validated release batch 기준으로 처리하며 정상 운영 중에는 최대 1회/일을 목표로 한다.

## 확정 마일스톤 및 우선순위 — 2026-09-11 사용자 정정

- **ALPHA: 2026-09-15 12:00 Asia/Manila.** 기존 9월 15일 베타의 명칭을 알파로 정정하며 날짜·정오 시각·실제 400 USDC 범위는 유지한다.
- 알파 목표: **손쉬운 사용법 + 초기의 제한된 세션 승인/Start 이후 사람의 매매 판단이나 매 주문 수동 승인 없이 자동으로 진입·보호·관리·종료·정산하는 모습**을 실제로 검증한다. 개발자 명령어, 수동 Buy/Sell, 주문마다 PIN/MetaMask 또는 채팅 지시가 필요한 시연은 이 목표를 충족하지 않는다.
- 초기 지갑 연결·권한 조건 확인·필요한 사용자 서명·제한된 Start 승인과 운용 중 개별 매매 승인은 구분한다. 비상 정지·권한 철회·자동 손실/위험 통제는 유지한다. 이번 요구사항은 현재 LIVE 활성화나 실제 주문 승인이 아니다.
- **BETA: 2026-10-01, Asia/Manila.** 기존 10월 1일 정식 V1.0 출시라는 표현은 이 사용자 지시로 대체된다. 시작 시각·베타 자본·시험 기간·참가자 범위는 미지정이며 임의로 확장하지 않는다.
- **정식 V1.0/공개 출시일: 별도 미정.** 알파 결과를 반영한 결함 수정·사용성·무인운용 안정성·비용/정산 검증을 베타 준비의 우선순위로 둔다. 수익성 입증 완료 또는 외부 SaaS 출시로 해석하지 않는다.
- 알파 내부 마감은 유지: **9월 12일 18:00 필수 코드/검증 → 9월 13일 18:00 후보 배포/브라우저 확인 → 9월 14일 18:00 리허설/변경 동결 → 9월 15일 12:00 알파**. 각 단계의 완료는 별도 증거가 있어야 한다.
- P0/P1 납품 차단 문제가 cosmetic polish보다 우선이며, 거래소/리워드 확대는 BACKLOG_ONLY다.
- 일정 압박으로 Stop, idempotency, duplicate-order protection, settlement/reconciliation, daily loss/drawdown protection을 제거하거나 우회하지 않는다.
- 상세 기준은 공통 정책 sections 12/14를 따른다. 기존 `FIXED_BETA_400`/`fixedBeta*` 내부 코드·DB 식별자는 호환성을 위해 유지할 수 있으며, 명칭 정정만을 이유로 rename/migration/자본 초기화를 수행하지 않는다.

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
- **9월 15일 ALPHA:** 별도로 구분된 400 USDC 시험자본. 한 주문에 전액 투입/전액 손실 허용이 아니며 실제 지갑잔액과 구분한다. 기존 Risk/HWM과 충돌하지 않는 검증이 필요하고 Production 자본 변경은 별도 승인 대상이다.
- **10월 1일 BETA 자본:** 미정. 명칭·일정 변경에 따른 자동 자본 증액은 없다.
- 서로 분리해 취급: wallet balance / Planned Seed / Active Trading Capital / Reserve Capital / runtime Risk Equity/HWM
- Active Capital ladder: **1,000 → 2,500 → 5,000 → 10,000 USDC**
- 실용 검증은 필요 시 1K → 5K → 10K로 압축할 수 있으나 **자동 승급 금지**
- 단계 승급은 비용 후 positive expectancy, GMX order/fill/settlement 신뢰성, Stop/emergency close, mismatch=0, loss/DD compliance, Canary validation 및 owner approval을 요구한다.

## Execution safety

현재 owner-approved configuration values로 유지·검증 가능한 값:

- `DELEGATED_SIGNER_ENABLED=true`
- `GMX_API_ORDER_SUBMISSION_ENABLED=true`
- `LIVE_TEST_EXECUTION_LOCKED=false`

그러나 위 플래그는 실제 주문 승인이 아니다. 별도 승인된 제한적 활성화 전에는 다음 runtime boundary를 유지한다.

- `WORKER_ENGINE_MODE=PAPER`
- `AUTO_WORKER_LIVE_ENABLED=false`
- Relay submission OFF
- Relay submit network OFF

별도 명시 승인 없이 실제 주문 제출, 자금 이동, on-chain subaccount authorization, LIVE/AUTO LIVE unlock, 새 MetaMask signature, owner-required secret mutation, Production DB/HWM/trading-capital mutation을 수행하지 않는다.

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
- explicit approval for 실제 금융 실행

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

과거의 9월 15일 베타/10월 1일 정식 출시, 첫 LIVE 테스트의 매 주문 수동 승인 설명은 최신 알파·베타 일정 및 무인운용 합격 기준과 구분한다. 과거 파일을 다시 읽었다는 이유로 최신 일정을 되돌리거나 개별 주문 수동 시연을 무인 알파 완료로 보고하지 않는다. 이 문서 업데이트는 다른 대화/자동화가 실제로 읽거나 실행했다는 증거가 아니다.

## 절대 금지

- 메인 지갑 private key / seed phrase / Secret 저장·출력
- 승인 없는 실제 주문 또는 자금 이동
- 중복 주문 또는 unresolved 상태에서의 추가 주문
- safety gate 우회
- mobile/Arbitrage SaaS 범위 확장
- `attached_assets/` 커밋
- owner 승인 없는 PR merge, force push, rebase, history rewrite
