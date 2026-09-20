# CCC 감독 및 시간별 실행 계약

- 지시 버전: CCC-SUPERVISION-20260920-04
- 기록 시각: 2026-09-20 (이번 감독 요청 반영)
- 근거: 사용자가 현재 대화를 관리·감독 및 추가 개발 요구·일정 입력 창으로 지정하고, 기존 CCC 시간별 개발 대화가 정상 실행되며 새 지시를 자동 반영하도록 명시적으로 요청했다.
- 이 문서는 감독/실행 역할에 관한 이전의 모호한 지시보다 우선한다. 금융·예산·데이터 보존 안전제약은 완화하지 않는다.

## 최신 지시 — 브라우저 자동매매 제거 및 서버 상태 통일

사용자 승인: “너가 제시한 방향으로 진행해… 사용자에게 혼란… 필요한것이 아니라면 삭제… 꼭 필요한 기능이면 지금 당장 수정”.
구형 브라우저 AI 패널과 자동 판단/모의주문/결정 쓰기 경로는 Virtual400 서버 자동매매에 불필요하므로 제거한다.
CASH/Confidence/cycles/Auto-executing 및 브라우저 기반 MANUAL/AUTO 표시를 서버 세션/판단/설정/정산으로 대체한다.
대시보드·사이드바·AI 이력 화면은 같은 서버 스냅샷을 공유하고 재접속 시 서버 저장 설정을 읽는다.
연결 실패/120초 초과 증거는 활성 실행으로 표시하지 않는다. 저장된 이력/승인 검토·알림 및 서버 Risk/전략/보호/정산 기능은 유지한다.
Standard와 Virtual400 기록은 별도임을 명시한다. 기존 세션·시작시각·정책 appliedAt·원장·손익/HWM을 보존한다.
이번 수정/검증/기존 PAPER 배포까지 감독이 임시 단일 writer다. 완료 후 시간별 실행에 후속 개발을 인계한다.
이 항목이 아래 역사상의 임시 소유권/REQUESTED 상태보다 우선하며 기한·금융·예산 제약을 변경하지 않는다.

이전 긴급 변경의 실제 완료 증거: d9069a2/tree a0abc3f7, CI287 success(API2669+Web431),
production identity d9069a2 및 virtual400-active/v1 적용 2026-09-20T15:18:52.069Z 확인.
2026-09-20T15:36:18Z 재확인: 기존 ACTIVE session vp400-8fca5a3d-e988-4c98-b4a3-f9953ff54289,
시작14:21:14.615Z 유지, fresh/NORMAL/NO_TRADE, 자산400/정산0. 첫 자연 체결과 Alpha/Beta는 미검증.

## 긴급 우선순위와 실행 소유권 (2026-09-20)

사용자: “버그 해결 그리고 공격적 가상 매매를 최우선으로 하고 바로 퍼블리싱해줘.”
두 변경의 검증된 PAPER 배포까지 승인됐다. 감독 세션이 이번 변경의 단일 코드 writer,
Replit은 검증 소스 동기화 및 기존 Reserved VM 배포를 맡는다.
시간별 실행 세션은 중복 코드/배포를 발주하지 않고 독립 검증·보고를 계속한다.
배포 인계 후 다시 실행 세션이 후속 개발을 맡는다. 이 일시적 소유권은 전체 개발 중단을 뜻하지 않는다.
증거: docs/verification/virtual400-active/RESULT.md. 실제 배포 identity와 적용 설정을 확인하기 전 DEPLOYED로 보고하지 않는다.

## 최신 개발 지시 — 가상 매매 적극성 및 손익 설명 (2026-09-20)

상태: REQUESTED. 아래 내용은 사용자 요구를 구체화한 구현·검증 기준이며 운영 반영 완료를 뜻하지 않는다.
사용자 원문: “가상 매매는 좀더 공격적으로 매매하도록하자, 수익이 나던 손실이 나던 투자자들이 봤을때 수긍할만하나 손익/손실이 나야함”.

1. 범위는 기존 400 USDC Virtual/PAPER 세션이다. 기존 전략의 유효한 거래 기회와 위험 예산을 확대하고 거래별 손익을 설명한다. 목표 수익률·손실액·거래 횟수를 만들기 위한 강제 진입은 요구하지 않는다.
2. Virtual400 전용 버전 설정을 구현한다. BTC 단독 탐색을 기존 지원 BTC/ETH/SOL로 확대하되 각 종목의 공식 closed-candle/quote/cost/시장 매핑이 검증된 경우에만 활성화한다. unsupported 종목은 사유를 기록한다. 여러 후보는 기존 전략 arbiter를 재사용해 순위화하고 한 사이클에서 한 번만 진입한다.
3. 정상 상태의 1회 위험 예산을 자산 0.25%에서 기존 허용 상한 0.5%로 높인다(400 USDC 기준 모델상 $1→$2). 감소한 자산과 Risk REDUCE/방어 모드에 따라 줄이고, 기존 자동복리 금지에 따라 기준자본 400을 초과해 증액하지 않는다. Virtual 전용 leverage 상한은 1x→2x, margin 상한은 $100 유지, notional 상한은 $200와 기존 더 낮은 cap 중 작은 값. 레버리지는 수익/손실 목표가 아니라 증거금·노출 관계다. stop-distance와 왕복 비용·슬리피지를 포함해 전체 위험 예산을 만족하도록 사이징하고 레버리지로 위험 예산이 다시 배가되지 않게 검증한다. 비용/최소주문/손절 거리 때문에 불가능하면 거절한다.
4. 유효 신호 재탐색 기회를 늘리기 위해 진입 cooldown은 30분→15분으로 하되 동일 signal ID 재진입 금지 및 durable claim/idempotency는 유지한다. confidence 80, 현재 전략 유효성/구조적 손절/최소 R:R/닫힌 캔들/데이터 freshness/$0.40 비용 gate를 임의 완화하지 않는다. 기존 동시포지션 1, 하루 최대진입 3, 일일 손실 1%, 방어 모드 손실 0.5%, HWM 최대낙폭 8%, 연속손실 차단·sticky stop·martingale/물타기 금지를 유지한다. 손절·손실 한도는 모델과 실행 가드이며 갭/슬리피지 하에서 실제 손실 상한을 보장한다고 표시하지 않는다.
5. 기존 NO_TRADE/NO_ELIGIBLE_CLOSED_CANDLE_SIGNAL을 종목별로 추적 가능하게 개선한다. 데이터 부족·신호 부재·confidence·비용·가격 변동·위험 veto·중복·cooldown을 구분해 후보 수와 차단 사유를 기록한다. 신호 경로/상태 연속성 결함이 있다면 우선 수정한다. 단순히 큰 주문 설정만으로 거래가 생긴다고 보고하지 않는다.
6. 투자자가 확인할 자료: PAPER/가상 표시, 설정 버전·변경 시각, 종목·방향·진입/청산 시각·가격, 전략/시장 국면/진입 근거, 손절/목표·사전 위험액, 청산 사유, 총손익과 수수료/펀딩/슬리피지 등 적용 모델의 항목별 추정 비용 및 순손익, 실현/미실현 구분, R 배수, 누적 손익·최대낙폭·표본 거래 수. 비용이 가정이면 ESTIMATED, 재생시험이면 REPLAY로 구분하고 비용 누락을 0으로 꾸미지 않는다. 손실 거래도 같은 기준으로 남긴다.
7. 현재 ACTIVE sessionId vp400-8fca5a3d-e988-4c98-b4a3-f9953ff54289의 ledger/HWM/손익/횟수/시작시각을 보존한다. 설정은 OPEN/pending/unresolved가 없는 안전한 사이클 경계에서 원자적으로 적용하고 버전을 저장한다. 이전 포지션에는 개설 당시 보호·설정을 유지한다. START 재요구, 세션 재시작이나 손실 초기화는 하지 않는다. global risk policy/Standard/LIVE 프로필은 변경하지 않는다.
8. 기존 지갑 연결 화면 깜빡임 결함 수정이 사용자 화면 최우선이다. GmxAccountContext의 30초 background loading과 onboarding readiness/visibility를 분리하고 Virtual 관찰에 실제 지갑 서명을 강제하지 않는다. 인증/실제 거래 readiness는 유지한다. 이 수정과 위 적극성 변경은 지정된 실행 세션의 단일 writer가 구현·회귀 검증·정상 push·동일 소스 PAPER 배포로 완료한다. raw-candle E2E/실제 PostgreSQL restart/보호·정산 검증 및 기존 기한을 유지한다.
9. 필수 회귀: 여러 종목 동시 후보 중 단일 진입, 2x에서도 비용 포함 위험 예산 초과 없음, 중복/재시작 진입 방지, 일일 손실·HWM·비용 초과 veto, STOP 이후 기존 보호 지속, 활성 세션 변경 전후 원장 연속성, global/Standard/LIVE 불변. 운영 적용 설정 버전과 실제 거래/미거래 사유를 보고해 완료를 판정한다. 자연 신호가 없으면 명시적인 별도 REPLAY로 손익 계산을 검증한다.

최근 운영 스냅샷(2026-09-20T14:29Z): production6115eb6, Virtual ACTIVE, runtimeFresh=true, Risk NORMAL, NO_TRADE/NO_ELIGIBLE_CLOSED_CANDLE_SIGNAL, 자산400/실현손익0/포지션0/정산0. 과거 아래의 399351c/API404/미시작 상태는 이 스냅샷 기준 해소됐다. 매 실행 fresh 조회한다.

## 역할

현재 사용자와 대화하는 새 감독 세션은 요구사항·우선순위·일정·예산 해석과 검증 보고의 기준이다.
기존 자동화 `CCC 시간별 개발` (id `6a90dc4399d0819190a6176d7cf8ec06`)는 이 감독 세션에서 전달한 지시를 수행하는 개발·시험·보고 실행 주체다.
기존 실행 conversation_id `6aa6bad5-eec8-83ec-89a2-f065b77829e1`는 실행 및 결과 전달 창으로 유지한다. 연결 대화 이전은 실행 재개의 선행조건이 아니다.
그 외 과거 CCC 감독 대화는 역사 참고자료다.

이전 assistant가 넣은 “새 대화로 연결되기 전까지 read-only만 수행” 규칙을 철회한다.
기존 실행 자동화는 승인된 범위의 실제 코드·테스트·정상 GitHub push·검증된 PAPER 배포 작업을 수행한다.
새 감독 세션이 실행 주체인 것처럼 가장하거나 독립적으로 정책·일정을 변경하지 않는다.

## 새 사용자 지시 반영

1. 감독 세션은 여기서 받은 명확한 개발 요구·일정 변경을 같은 응답 작업 중 이 계약과 기존 자동화 prompt에 반영한다. 같은 승인을 반복 요청하지 않는다.
2. 버전·적용 시각·변경 내용·유지하는 제약을 기록하고 저장 후 readback으로 확인한다. 저장 실패를 적용 완료로 보고하지 않는다.
3. 실행 자동화는 시작 시, GitHub push 직전, 유료 발주 또는 배포 직전에 최신 자동화 prompt와 이 문서를 다시 읽어 버전 변경을 확인한다. 중간 변경은 다음 안전한 경계에서 반영한다. 기존 실행 중인 작업에 대한 즉시 interrupt/실시간 전달을 보장하지 않는다.
4. 요구가 충돌하거나 실금융·추가 비용 등 기존 승인을 확장하면 그 항목만 보류한다. 독립적인 개발·시험은 계속한다.
5. 이 문서와 자동화 prompt가 다르면 사용자 지시의 출처·버전·시각을 확인한다. 오래된 제한 때문에 전체 개발을 멈추거나 더 위험한 해석을 임의 채택하지 않는다.
6. 각 보고에 적용한 감독 지시 버전과 적용/미적용 변경을 명시한다.

## 단일 writer 및 감독 검증

- 각 실행은 fresh HEAD/CI/배포 및 기존 writer·Replit 작업의 증거를 확인하고 실행 가능한 우선순위 작업을 실제 수행한다.
- 감독 세션에서 별도 구현을 수행할 때는 실행 자동화와 소유권을 조정한다. 원격 HEAD가 바뀌면 non-fast-forward를 덮어쓰지 않고 변경을 검토한다.
- 현재 HEAD가 같다는 사실만으로 다른 writer가 없다고 확정하지 않는다. 진행 중 작업을 확인할 수 없으면 같은 대상 쓰기/배포를 중복 발주하지 않는다.
- Architect → 단일 Implementation → actual diff Reviewer → SRE passes. 실제 수행한 검증만 기록하고 가상의 팀/상주 감시자를 꾸미지 않는다.
- 문서/prompt 수정은 감독 설정 변경이며 제품 기능 진척으로 계산하지 않는다.

## 목표와 금지사항

최종 기한은 2026-10-01 18:00 Asia/Manila (10:00 UTC), 초기자본은 400 USDC VIRTUAL/PAPER.
9월23일18시 전체 lifecycle 검증, 9월25일 첫 사용자 가상 Alpha, 9월28일 restart/reconnect/stability Beta, 9월30일 리허설. 이는 보장이 아니다.
9월23/25 checkpoint 미달 또는 복구 전망 악화는 DEADLINE_AT_RISK로 보고한다.
실자금 Canary는 후속 별도 미정 단계이며 가상 시험 blocker가 아니다.

실제 주문·송금·금융서명·키/시드 취급·LIVE/Relay 실거래 활성화·Standard/real-money DB/HWM/자본 reset·Secrets/PIN 임의 변경·PR merge·force/rebase 금지.
손실·횟수·HWM·sticky stop·정산 증거를 보존한다. entry veto만으로 close-all하지 않는다.
closed 4h/1h/15m, 기존 Risk 최종 권한, 기존 $0.40 비용 gate를 유지한다. REPLAY/ESTIMATED를 실제 성과로 표현하지 않는다.
추가 충전·요금제·auto-reload 변경 금지. $150를 새 예산 승인으로 간주하지 않는다. Replit 유료 호출은 기존 승인 범위의 실제 runtime/deploy blocker에 한정하며 보고용 반복 유료 폴링을 하지 않는다.
repo sakuraijay/Crypto-Control-Center, branch codex/handover-20260820, PR #1 OPEN/DRAFT 유지. 신규 중복 자동화는 만들지 않는다.

## 재개 시 출발 증거와 우선순위

2026-09-20T13:19Z 점검: 제품 HEAD67a6d40, CI283 success; production399351c (9월6일 build), Virtual400 API404.
315 focused regressions와 타입검사/빌드, 합성 signal-contract REPLAY는 통과했으나 raw-candle E2E, 실제 PostgreSQL restart, 사용자 Alpha/Beta는 미검증.
증거: docs/verification/virtual400-runtime/RESULT.md. 초기 namespace/session 구현을 반복하지 않는다.
위 값은 역사 스냅샷이다. 실행마다 fresh 상태를 읽는다.

기존 Replit 동기화 요청은 67a6d40 대상이며 turnId:
877dcc77-7f35-46f2-bf9a-4cedf6eb8f9c/01a00177-8036-7649-bb7f-420e7181ca85/01a0bc94-6bc7-702e-b379-d4dedfdf4cbc
접수만 확인됐고 완료 증거 없음. 중복 유료 요청 전에 결과/작업공간 소스 증거를 확인한다.
공통 우선순위: 그 동기화 결과 확보 및 exact validated source 배포/source parity → Virtual Dashboard 및 실제 PAPER 관측.
배포 접근이 막혀도 독립적으로 가능한 raw-candle replay, isolated PostgreSQL restart/concurrency, signal lifecycle/regime continuity와 오류복구 검증을 진행한다.

## 보고와 전달 한계

매 실행 한국어 보고: 실제 확인시간, 적용 지시 버전, 지난 실행 이후 실제 산출물, HEAD/CI, 배포 SHA, PAPER runtime/정산, 현재 writer와 blocker, 다음 구체 작업, 사용자 전용 조치, 기한 영향, Agent/publish/cost 확인값 또는 UNKNOWN.
REQUESTED, CI_VERIFIED, DEPLOYED, RUNTIME_VERIFIED, ALPHA_TESTED, BETA_TESTED를 구분한다.
무변경을 개발 완료로 표현하지 않는다. timestamp는 실행/보고 성공 증거가 아니다.

보고는 기존 자동화의 실제 delivery 설정을 따른다. 현재 감독 대화로의 자동 복사, 알림/email 복구, 이 대화의 백그라운드 상주 감시는 구현·검증되지 않았다.
감독 대화는 사용자가 이 창에서 지시/점검을 요청할 때 최신 실행 증거를 조회하고 판단한다. 접근하지 못한 전체 과거 대화를 모두 읽었다고 주장하지 않는다.
최종 기한 미달 시 DEADLINE_MISSED/NOT_VERIFIED를 보고하고 신규 자동 유료 개발을 중단하며 코드·시험·비용·장애 증거를 보존한다.
