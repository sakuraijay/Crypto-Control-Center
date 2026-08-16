# Crypto Control Center — 프로젝트 상태 기준 문서

> 목적: ChatGPT(작업 설계·검수)와 Replit Agent(구현·테스트)가 새 세션에서도
> 동일한 기준으로 작업하기 위한 고정 기준 문서.
> 이 문서에는 실제 Secret 값, 지갑 개인키, 토큰, 민감한 URL을 기록하지 않는다.

## 프로젝트 정의

- **프로젝트명**: Crypto Control Center
- **단일 사용자 개인용 GMX 자동매매 시스템** (GMX V2 / Arbitrum One)
- 외부 고객용 SaaS가 **아님**
- Arbitrage SaaS 프로젝트 B와 **완전히 분리** — 관련 코드 추가 금지
- **외부 VPS 사용 안 함** — Replit Reserved VM에서 24시간 운영
- **데스크톱 웹 우선**, 모바일(`artifacts/futures-terminal`) 개발 보류

## 코드 기준 소스

- GitHub 저장소: `sakuraijay/Crypto-Control-Center`, 브랜치 `main` (원격 이름: `github`)
- 마지막 검증된 배포 구조 기준 커밋: `e3ef40489d952b752860505e9345f4370211f9b8`
  (Reserved VM 단일 프로세스·단일 포트 구조, GitHub Actions Quality Gate success)

## 진척도

- 현재 전체 개발 진척도 추정: **약 74%** (Publish 안전성 보정 진행 중)
- **LIVE 주문 전송 코드는 존재하나 잠금 상태이며 미검증** —
  `LIVE_TEST_EXECUTION_LOCKED` 기본 잠금 + `DELEGATED_SIGNER_ENABLED` 기본 비활성 +
  중앙 실행 게이트로 실제 실행이 차단되어 있음. 실제 수익 운용은 아직 완료되지 않았음
- 실제 GMX 사이트에서의 지갑 연결과 Crypto Control Center의 Subaccount
  실행 권한은 **별개** — GMX 사이트 연결이 되어도 본 시스템의 주문 권한과 무관

## 완료된 핵심 작업

- GMX 공식 reader/DataStore/ABI 기반 온체인 조회 (RPC 전용, Satsuma 제거)
- 서버 Worker와 브라우저 Strategy 설정 동기화
- 안전 잠금(LIVE/LIVE TEST fail-closed) 및 회귀 테스트
- futures-web 프로덕션 빌드 수정 (PORT/BASE_PATH 미주입 빌드 가능)
- GitHub Actions CI (타입검사·빌드·배포 빌드 게이트·전체 테스트)
- Reserved VM 단일 프로세스·단일 포트 배포 구조
- api-server가 API + 정적 웹 + SPA fallback을 단일 포트로 제공

## 테스트 기준

- api-server 289개 + futures-web 53개 = **총 342개** PASS
- durable execution intent 테스트 추가 (executionIntents.test.ts, durableExecutionIntent.test.ts)
- CI: `bash scripts/typecheck-ci.sh` → 배포 빌드 → 전체 테스트

## 남은 작업 순서

1. Production Secrets 준비
2. Reserved VM 최초 Publish
3. Production DB 마이그레이션
4. READ-ONLY 상태 확인
5. PAPER 모드 연속 운전
6. 재시작·복구·중복 주문 방지 검증
7. GMX Subaccount 인증
8. TEST 주문 왕복 검증
9. 극소액 LIVE 검증
10. 24시간 안정성 검증

## 키 저장 정책 (명확한 분리)

- **메인 지갑(MetaMask) Private Key·Seed Phrase**: 어떤 형태로도 요청·저장·출력 금지
- **제한된 delegated signer(서버 생성 EOA)**: `DELEGATED_SIGNER_ENABLED=true`로
  명시 활성화한 경우에만 생성되며, AES-256-GCM + scrypt(SESSION_SECRET) 암호화 후
  DB에 저장 (공개 주소만 노출). 기본값은 비활성 — 최초 PAPER Publish에서는 미설정 유지
- DB 조회 실패·복호화 실패·메타데이터 손상 시 신규 생성/overwrite 금지 (fail-closed)

## 실행 안전 장치 (Publish 전 보강 완료)

- 중앙 실행 게이트: `WORKER_ENGINE_MODE=LIVE` + `liveTestMode` + 잠금 해제 +
  `DELEGATED_SIGNER_ENABLED=true` + Emergency Stop 비활성 + signer 초기화 +
  DB/RPC 정상 + reconciliation 완료가 **전부** 충족돼야 실제 트랜잭션 서명에 도달
- 재시작 reconciliation: SUBMITTED 주문은 임의로 FAILED 처리하지 않고
  `UNRESOLVED`로 보존(txHash 유지). 상태불명 주문이 남아 있으면 신규
  LIVE TEST 주문 차단 유지 (시간 경과만으로 FAILED 전환 금지)
- **Durable execution intent** (`execution_intents` 테이블, migration 0010):
  `writeContract` 도달 전에 PREPARED intent를 DB에 커밋해야 하며, 저장 실패 시
  온체인 제출에 절대 도달하지 않음. intent id = idempotency key
  (`intent:<open|close>:<decisionId>`)로 동일 intent 중복 제출을 PK 충돌로 차단.
  제출 성공 시 txHash+SUBMITTED 갱신 — 갱신 실패해도 PREPARED 기록이 남아
  재시작 reconciliation이 반드시 발견. writeContract 오류(타임아웃 포함)는
  자동 FAILED 금지, UNRESOLVED 처리. 중앙 실행 게이트가 미해소 intent
  (PREPARED/SUBMITTED/UNRESOLVED) 존재 시 최종 차단. OPEN·CLOSE 동일 경로,
  PAPER 모드 무영향
- **남은 reconciliation 작업**: UNRESOLVED intent의 온체인 확인(트랜잭션
  조회로 CONFIRMED/FAILED 판정) 및 운영자 수동 판정 UI는 미구현 —
  현재는 UNRESOLVED가 남으면 신규 LIVE 주문이 영구 차단됨 (fail-closed).
  LIVE 실행은 여전히 잠금·미검증 상태이며 금지 유지.
- migration 0010은 코드에만 존재 — Production DB에는 다음 Publish 시
  서버 기동 마이그레이션으로 자동 적용됨 (수동 적용 금지)

## 절대 금지 사항

- 메인 지갑 개인키·시드 문구·Secret 저장 또는 출력
- 승인 없는 LIVE 주문과 자금 이동
- 중복 주문
- 불확실한 체결 상태에서 추가 주문
- `LIVE_TEST_EXECUTION_LOCKED` 임의 해제
- 모바일 또는 Arbitrage SaaS로 작업 범위 확대
- `attached_assets/` 커밋
- force push 및 히스토리 재작성

## 작업 운영 방식

- ChatGPT가 작업 설계와 검수 담당
- Replit Agent가 구현·테스트 담당
- GitHub에서 교차 검증
- 한쪽 작업이 끝난 후 다음 작업 진행 (동시 작업 금지)
