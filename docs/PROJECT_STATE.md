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

### Task #173 — Canary read-only 진단 정합성 (완료)

- PAPER readiness와 Canary status/preflight가 공용 deployment verification
  snapshot을 사용하도록 정합성을 맞추고, 실패·미시도 결과도 fail-closed로 반영
- bounded quote grid의 exact seed quote 계수와 실제 관측 배열을 일치시키고,
  최대 5초 clock skew는 age 0으로 정규화하되 더 먼 미래 시각은 거부
- 구현 `315f4099d4e52c8c340fa88f4f03a97b2fa3e39d`, CI 보정
  `56253280e327d031ef6c42357b456943fa29dfce`가 원격 브랜치와 PR #1에 반영됨
- 집중 회귀 54개, 전체 API 2,093개, Web 379개, TypeScript 및 production
  build/topology 검증 통과; 독립 검토 PASS
- GitHub Actions CI run #192 Quality Gate SUCCESS
- `$0.40` cost cap과 Owner Approval, canonical delegation, signer, stop,
  execution gate는 변경하지 않았으며 Production publish/deploy는 별도 범위

### Task #175 — Canary 증거 fail-closed 강화 (완료)

- 인증된 GMX status/readiness 스냅샷은 요청 실패(401/403/503/network/server),
  PIN 변경, 30초 freshness 만료 시 즉시 폐기하여 이전 PASS성 표시를 남기지 않음
- PAPER 비용 긍정 표시는 서버 고정 `$0.40` cap, observational freshness,
  execution snapshot freshness·eligibility, `withinCap=true`가 모두 필요
- LIVE Stop “가능” 표시는 PAPER가 아니며, 최근 successful readiness refresh와
  5초 이내로 결속된 fresh capability 평가가 있을 때만 허용
- 현재 운영 기준은 계속 PAPER, AUTO LIVE off, Relay 제출·네트워크 off이며
  authorization/action budget·Stop capability 부재와 `HARD_STOPPED`가 Canary 차단 사유
- 다음 운영 행동은 새 기능 활성화가 아니라 Owner Approval/authorization,
  action budget, Stop readiness를 각각 명시적으로 충족한 뒤 authenticated refresh로
  다시 관측하는 것; 이 작업은 실행·인증 경계와 capital 값을 변경하지 않음
- focused Web 69개, 전체 API 2,095개, 전체 Web 391개 및 TypeScript 검증 통과

## 테스트 기준

- api-server 318개 + futures-web 53개 = **총 371개** PASS
- durable execution intent 테스트 추가 (executionIntents.test.ts, durableExecutionIntent.test.ts)
- 온체인 intent reconciliation 테스트 추가 (intentReconciler.test.ts — mock RPC·고정 fixture 전용)
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
- **온체인 intent reconciliation** (migration 0012): SUBMITTED/UNRESOLVED
  intent를 tx receipt + GMX EventEmitter 이벤트(OrderCreated→key 추출,
  OrderExecuted/OrderCancelled/OrderFrozen 조회)라는 온체인 증거로만 판정.
  receipt reverted→FAILED, OrderExecuted→CONFIRMED, OrderCancelled→CANCELLED
  (terminal, FAILED와 구분), frozen·pending·key 추출 실패·RPC 오류·chainId
  불일치(≠42161)→차단 유지. 판정 근거(orderKey·생성 block·resolution tx/block·
  사유)는 execution_intents에 영속 저장. 상태 전환은 조건부 UPDATE(차단
  상태에서만)로 원자적 — terminal→blocking 역행·동시 reconcile 중복 전환 불가.
  재시작 시 + 5분 주기(차단 intent 존재 시에만 RPC) 실행, RPC 오류는 Worker를
  중단시키지 않음. read-only 상태 API: GET /api/executor/intents (수동 변경
  엔드포인트 없음). PAPER 모드에서는 RPC 조회·intent 변경 전무.
- **남은 reconciliation 한계**: PREPARED+txHash 없음(broadcast 불명) intent와
  OrderFrozen·판정 불가 intent는 온체인으로 해소되지 않고 영구 차단 유지 —
  운영자 수동 판정 절차는 의도적으로 미구현(fail-closed). LIVE 실행은 여전히
  잠금·미검증 상태이며 금지 유지.
- migration 0010~0012는 코드에만 존재 — Production DB에는 다음 Publish 시
  서버 기동 마이그레이션으로 자동 적용됨 (수동 적용 금지)
- **GMX 최신 delegated trading 1단계 (구현 완료, LIVE 미검증)**:
  - EventEmitter 하드코딩 기본값 제거 — 과거 기본값 0xAf2E…89C2는 공식 문서상
    Botanix/MegaETH 체인 주소였음(구성 결함). Arbitrum One 공식 주소는
    0xC8ee91A54287DB53897056e12D9819156D3822Fb (문서화 상수로만 유지, 자동 사용
    금지). GMX_EVENT_EMITTER_ADDRESS 미설정/형식 오류/타 체인 주소 → fail-closed
    (LIVE·신규 reconciliation 차단, PAPER 무영향, intent 영속 emitter는
    historical reconcile 전용)
  - legacy SubaccountRouter 직접 주문 경로(multicall/sendTokens/createOrder)는
    DEPRECATED — Production broadcast 가드로 차단, 중앙 게이트에 relayConfigured
    체크 추가 (legacy env만으로 LIVE 불가)
  - 신규 구성: GMX_SUBACCOUNT_GELATO_RELAY_ROUTER_ADDRESS / GMX_DATA_STORE_ADDRESS /
    GMX_EVENT_EMITTER_ADDRESS (전부 필수, 기본값 없음, chainId 42161 고정,
    Production 값 미설정 상태 유지)
  - EIP-712 순수 빌더/검증기(gmxEip712): SubaccountApproval(owner 서명,
    공식 typehash 필드 순서) + RelayParams(abi.encode 해시, signature 제외),
    domain = GmxBaseGelatoRelayRouter v1. replay(nonce)·만료(deadline)·타 체인·
    타 라우터·서명자 불일치 전부 거부. 개인키 비보관·비반환
  - DataStore canonical reader(gmxDataStore): 공식 Keys 스킴으로
    expiresAt/maxAllowedCount/used/remaining/integrationId + 라우터
    subaccountApprovalNonces 조회. 클라이언트 주입식 — 테스트는 mock fixture 전용,
    오류 시 fail-closed(UNVERIFIED)
  - 인증 상태 모델(subaccountAuthState) + read-only API
    GET /api/executor/subaccount-auth — 상태 enum·signer 공개 주소·구성 결함
    사유만 노출(개인키·서명 전문·env 원문 금지). 1단계는 온체인 조회 미연결로
    항상 UNVERIFIED 이하 → LIVE 차단 유지
- GMX delegated trading 2단계 완료 — MetaMask owner approval 준비·canonical 연결
  - 승인 세션 영속 모델: `subaccount_approval_sessions` 테이블(migration 0014),
    상태 PREPARED→OWNER_SIGNATURE_READY(→INVALIDATED/CONSUMED/REVOKED),
    서명은 AES-256-GCM(scrypt, SESSION_SECRET) 암호문으로만 저장
  - Prepare API `POST /api/executor/subaccount-approval/prepare`:
    운영자 인증(OPERATOR_MASTER_PIN 헤더, 미설정 시 503 fail-closed) + JSON
    content-type 강제(CSRF 방어). 서버가 canonical router nonce를 직접 읽어
    typed data 생성 — expiry ≤1h(기본 1h), maxAllowedCount 기본 2(1–10 클램프),
    deadline 10분, actionType·chainId(42161)·router·integrationId 서버 고정
  - 서명 제출 API `POST /api/executor/subaccount-approval/signature`:
    서버가 세션에서 typed data 재구성(digest 재계산으로 변조 검사),
    recovered owner == GMX_WALLET_ADDRESS 필수, nonce/deadline 재검증,
    검증 후 암호화 저장 → OWNER_SIGNATURE_READY까지만 (온체인 제출·LIVE 해제 없음)
  - GET /executor/subaccount-auth에 canonical 온체인 조회 연결:
    expiresAt/max/used/remaining/nonce/integrationId + feature/integration
    disabled 플래그(→REVOKED) + 블록 timestamp 기준 만료 판정. RPC 실패 →
    UNVERIFIED/ERROR 유지. displayState로 READY 세션 표기(AUTHORIZED와 구분).
    이 단계에서도 중앙 LIVE 게이트는 이 상태로 통과 불가
  - Settings UI: Owner Approval 카드 — 상태·온체인 요약·권한 설명(주문
    생성/수정/취소 가능, 출금·claim·이전 불가), PIN → Prepare → 필드 검토 →
    MetaMask eth_signTypedData_v4(chain 42161·계정 일치 강제), 취소 정상 처리,
    revoke 비활성. 개인키 입력 UI 없음
  - CreateOrder 오프라인 빌더(gmxCreateOrder): 공식 RelayUtils typehash
    (골든 fixture로 고정), subaccountApprovalHash = struct 전체(signature 포함)
    plain abi.encode, OPEN=MarketIncrease(2)/CLOSE=MarketDecrease(4),
    receiver/cancellationReceiver=main account 강제, externalCalls 거부,
    5-인자 createOrder calldata 인코딩까지만 — 제출 0회
  - 신규 env: OPERATOR_MASTER_PIN(운영자 인증), GMX_WALLET_ADDRESS(owner 검증)
    — 미설정 시 관련 API fail-closed
  - 다음 단계 남은 작업: 저장된 서명의 온체인 등록/relay 제출 경로(Gelato)
    구현·검증, revoke 지원 — LIVE 실행은 여전히 잠금·금지 상태

- GMX delegated trading 3단계 (Gelato relay 강제 DRY-RUN + revoke) — 완료:
  - relay 모드: GMX_RELAY_SUBMISSION_ENABLED='true' + GMX_RELAY_MODE=DRY_RUN만
    활성. LIVE 요청은 구조적으로 DISABLED 강등(사유 기록). 어떤 경로도
    Gelato/온체인 제출 없음 — submitEligible 항상 false, externalCallBudget=0
  - durable relay lifecycle: relay_tasks 테이블(migration 0016) + 전이 테이블
    (PREPARED→DRY_RUN_VALIDATED→…→CONFIRMED / terminal 역행 금지 / UNRESOLVED
    자동 FAILED 금지 / idempotency_key unique / 조건부 UPDATE 전이)
  - fee 방어: mock quote(gas×price×1.3), WETH allowlist·feeSwapPath 금지·
    절대상한 0.005 ETH·stale 30s·notional 100bps·ETH 가격 미확인 fail-closed
  - revoke 세션: purpose='REVOKE' owner 서명 흐름(RemoveSubaccount typehash,
    digest 재계산 변조검사, recoverAddress owner 일치, AES 암호화 저장,
    단일활성). APPROVAL 경로와 purpose 완전 격리(교차 무효화 버그 수정).
    활성 revoke 세션 중 신규 주문 relay 차단
  - 라우트: /executor/relay/status·dry-run·revoke/* 전부 운영자 인증(PIN),
    dry-run 결과는 OPEN/CLOSE/REVOKE 모두 relay_tasks에 durable 기록.
    revoke dry-run은 OWNER_SIGNATURE_READY 세션 필수
  - Settings UI: RelayStatusCard — 모드·게이트·quote·revoke 흐름·최근 task,
    DRY_RUN_VALIDATED/TASK_ACCEPTED를 성공처럼 표시하지 않음
  - 테스트: api-server 458 PASS(신규 44 — 골든 typehash·결정성·변조 거부·
    fee 방어·전이표·교차-purpose 회귀), futures-web 78 PASS
  - 다음 단계 남은 작업: 실제 Gelato 제출 경로(별도 승인 후에만),
    UNRESOLVED 수동 복구 UI — LIVE 실행은 여전히 잠금·금지 상태
- GMX delegated trading 4단계 (실제 Gelato adapter — 구조 완성, 전면 비활성) — 완료:
  - relay_nonces 테이블(migration 0017) — userNonce durable 단조증가 allocation,
    충돌 재시도, fail-closed, 재사용 금지
  - relayTransport: 실제 Gelato HTTP adapter (host allowlist=api.gelato.digital,
    HTTPS only, redirect 금지, 256KB 응답 제한, 오류 sanitize) + **중앙 네트워크
    게이트** — GMX_RELAY_NETWORK_ENABLED 미설정이면 transport 자체가 모든 요청
    차단(호출측 게이트와 이중). API key(GELATO_RELAY_API_KEY)·활성화 env 전부 미설정 유지
  - relaySubmission.runSubmitFlow: 원자적 제출 흐름 — 게이트→live quote 재검증
    (mock quote 거부)→receiver 검증→durable task→서명 결속 검증→SUBMITTING
    조건부 전환 후에만 transport 1회. 어떤 실패에도 재호출 0회.
    taskId 저장 실패→UNRESOLVED 전환 재시도(3회), 영구 실패 시 SUBMITTING
    잔존을 조사 대상에 포함
  - relayTaskReconciler: Gelato 상태만으로 terminal 전이 금지 — CONFIRMED는
    온체인 OrderExecuted, FAILED는 독립 수집 온체인 receipt(TX_REVERTED)만.
    ExecReverted 보고는 UNRESOLVED 유지
  - routes: /executor/relay/unresolved(+recheck)·activation 진단; recheck는
    증거 재수집만(강제 종결·재제출·삭제 없음), SUBMITTING stale 행도 조사 대상.
    /executor/execute — revoke 진행 중 409 차단, 세션 조회 실패도 503 fail-closed
  - futures-web: RelayStatusCard UNRESOLVED 조사 섹션, activeRevoke 시
    NewOrderDrawer 주문 차단 + AiStateCard 자동실행 토글 차단(확인창 레이스 포함)
  - 테스트: api-server 538 PASS(신규 stage4 ~80), futures-web 78 PASS.
    실제 네트워크 호출 0회 — mock transport 전용
  - 활성화 조건은 전부 미충족이 정상: networkEligible=false 하드코딩 유지,
    LIVE 실행은 여전히 잠금·금지 상태

### 5단계 — 활성화 전 통합 완성 및 폐쇄형 검증 (완료, 전면 비활성 유지)

- 공식 소스 조사(§2):
  - gmx-synthetics `a85ea3491c19c93bb4b5a002d9b358fb769b7849`
    `BaseGelatoRelayRouter.sol` — replay 방지는 **used-digest 맵**
    (`digests` public mapping, `InvalidUserDigest` revert). userNonce는
    해시 입력일 뿐 온체인 단조증가 제약 없음
  - gmx-interface `c233f85007c59c52ec70c29ee1345908d3a97d8f` —
    `userNonce=nowInSeconds()`, `@gelatocloud/gasless` sponsor API key로 제출,
    sponsor 잔액은 1Balance(`relayer.getBalance()`)
  - §7 비용 결론: Gelato 가스는 sponsor 1Balance가 지불, payload의
    feeToken/feeAmount는 main account 자금에서 `_handleRelayFee`가 WNT 인출
    (잔여 환급) — 별도 주체, 이중 청구 아님
- 신규 모듈 (api-server src/lib/):
  - `relayDigestReadback.ts` — 제출 직전 `digests(digest)` eth_call readback;
    조회 실패=차단(PREPARED 유지·transport 0회), used=UNRESOLVED
    (`DIGEST_ALREADY_USED`) 전환·새 nonce 자동 재제출 금지 (DB 복원 방어)
  - `relaySignerBinding.ts` — DI 서명 결속: 플래그→main≠signer→digest
    재계산 결속→무결성(키 접근1)→서명(키 접근2)→recoverAddress 재검증;
    실패 시 키 접근 0회 보장
  - `relayReceiptCollector.ts` — 온체인 증거 수집: receipt reverted만
    TX_REVERTED, OrderExecuted만 CONFIRMED 근거, 복수 orderKey·비허용
    emitter·chainId 불일치·RPC 오류는 전부 판정 금지 (throw 없음)
  - `relayActivationStatus.ts` — startup reconciliation(§8: intent·relay
    task·미결속 nonce·revoke·canonical readback) + 10분 freshness;
    `evaluateFreshLiveQuote`는 mock 불인정·payload hash 결속 필수
  - `delegatedSigner.signDigestWithDelegatedSigner` — 로컬 서명(RPC 없음),
    enabled+initialized 게이트
- activation 진단 GET: reconciliationComplete/freshLiveFeeQuote 하드코딩 제거,
  실제 파생값 + UI용 statusFlags(readyForControlledCanary 포함); 조회는
  네트워크 부작용 없음. index.ts 시작 순서에 startup reconciliation 추가 —
  canonical readback은 네트워크 비활성으로 "미수행" 기록 →
  reconciliationComplete=false 유지가 정상(fail-closed)
- futures-web: RelayStatusCard Activation 체크리스트(9항목+canary 준비 배지,
  표시 전용)
- 테스트: api-server 570 PASS(신규 stage5 32), futures-web 78 PASS —
  실제 RPC·Gelato·signer 저장소 호출 0회, fixture 키만 사용
- LIVE 제출·네트워크 활성화는 여전히 구조적 차단 상태

- GMX delegated trading 6F-2 (GMX 공식 fee 산정 + Gelato JSON-RPC 이전) — 완료:
  - Gelato transport를 legacy REST(api.gelato.digital)에서 신형 JSON-RPC
    (`https://api.gelato.cloud/rpc`, `X-API-Key`)로 전면 이전 — method
    allowlist(read: relayer_getStatus·gelato_getBalance / submit:
    relayer_sendTransaction), envelope(id 일치)·크기 상한·redirect 차단·
    sanitize(코드 정수만) 강제, 자동 retry 0회
  - fee 산정을 Gelato fee oracle에서 GMX 공식 방식으로 교체:
    `gmxFeeEstimate.ts` — applyFactor(gasLimit×gasPrice, DataStore
    multiplierFactor)+30% buffer, 입력 실패 시 fail-closed (fallback 금지);
    quote는 chainId·relayRouter·payloadHash 결속 필수, mock/미결속 quote는
    제출 검증에서 거부. 공식 pin은 docs/GMX_OFFICIAL_PIN.md 참조
  - `relay_tasks.transport_gen` (migration 0018) — legacy 세대 task는 신형
    조회 금지, UNRESOLVED_LEGACY_TRANSPORT로 고정 (자동 재제출 없음)
  - readiness/activation에 §11 항목 추가: gelatoApiConfigured(boolean만),
    transport 'JSON-RPC v0.0.10', fee estimate(fresh/unavailable),
    sponsor balance(verified/insufficient/unverified) — 전부 fail-closed 표시
  - futures-web RelayStatusCard에 §11 표시 반영
  - `GELATO_API_KEY` Secret은 이번 단계에서 생성하지 않음 — 미설정 시 외부
    fetch 0회. readyForControlledCanary=false 유지, LIVE 제출 구조적 차단 유지

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
