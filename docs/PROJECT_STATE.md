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

## V1.0 목표 및 우선순위

- 공식 V1.0 목표: **2026-10-01**
- P0/P1 launch blocker가 cosmetic polish보다 우선
- 일정 압박으로 Stop, idempotency, duplicate-order protection, settlement/reconciliation, daily loss/drawdown protection을 제거하거나 우회하지 않는다.

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
- 서로 분리해 취급: wallet balance / Planned Seed / Active Trading Capital / Reserve Capital / runtime Risk Equity/HWM
- Active Capital ladder: **1,000 → 2,500 → 5,000 → 10,000 USDC**
- 실용 검증은 필요 시 1K → 5K → 10K로 압축할 수 있으나 **자동 승급 금지**
- 단계 승급은 비용 후 positive expectancy, GMX order/fill/settlement 신뢰성, Stop/emergency close, mismatch=0, loss/DD compliance, Canary validation 및 owner approval을 요구한다.

## Execution safety

현재 owner-approved configuration values로 유지·검증 가능한 값:

- `DELEGATED_SIGNER_ENABLED=true`
- `GMX_API_ORDER_SUBMISSION_ENABLED=true`
- `LIVE_TEST_EXECUTION_LOCKED=false`

그러나 위 플래그는 실제 주문 승인이 아니다. 다음 runtime boundary는 유지한다.

- `WORKER_ENGINE_MODE=PAPER`
- `AUTO_WORKER_LIVE_ENABLED=false`
- Relay submission OFF
- Relay submit network OFF

별도 명시 승인 없이 실제 주문 제출, 자금 이동, on-chain subaccount authorization, LIVE/AUTO LIVE unlock, 새 MetaMask signature, owner-required secret mutation, Production DB/HWM/trading-capital mutation을 수행하지 않는다.

Owner Approval이 과거 `OWNER_SIGNATURE_READY`에 도달했더라도 freshness와 현재 usable session을 다시 검증해야 하며, stale/expired consent는 재사용하지 않는다.

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

## 현재 P0/P1 launch work 판단 기준

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

증거가 unavailable이면 `UNKNOWN`으로 남기며 Replit Agent 사용만으로 상태를 알아내려 하지 않는다.

## Known P1 documentation/release-process item

`.github/workflows/post-publish-attestation.yml`의 scheduled trigger는 default branch에 workflow가 존재해야 dependable하게 동작한다. 현재 이 문제는 owner-approved normal PR flow로만 해결하며, 이를 이유로 `main` direct write나 PR merge를 수행하지 않는다.

## Historical material

이 파일의 2026-09-07 이전 버전에는 당시 task 번호, test count, 배포 SHA, 플래그 상태 및 단계별 delegated trading 구현 기록이 상세히 들어 있다. 해당 내용은 Git history에서 보존되며 architecture history/forensics 용도로만 사용한다. 현재 운영값의 근거로 사용하지 않는다.

## 절대 금지

- 메인 지갑 private key / seed phrase / Secret 저장·출력
- 승인 없는 실제 주문 또는 자금 이동
- 중복 주문 또는 unresolved 상태에서의 추가 주문
- safety gate 우회
- mobile/Arbitrage SaaS 범위 확장
- `attached_assets/` 커밋
- owner 승인 없는 PR merge, force push, rebase, history rewrite
