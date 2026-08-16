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

- 현재 전체 개발 진척도 추정: **약 74%**
- **LIVE 주문 전송과 실제 수익 운용은 아직 완료되지 않았음**
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

- api-server 219개 + futures-web 53개 = **총 272개** PASS
- 이번 PORT 파서 격리 테스트가 여기에 추가됨 (port.test.ts)
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

## 절대 금지 사항

- 개인키·시드 문구·Secret 저장 또는 출력
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
