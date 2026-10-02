# 단타·스윙 PAPER 모드 검증

2026-09-21 / 감독 지시 v10. 기준 부모4538303781da77e9dce793f54aa26183653de0b4.

구현: 기존 Virtual400에 서버 영속 모드 선택, 인증/낙관적 충돌 검증 API, 모드별 신호 필터, 최대 보유기간 비용 검증, 비용 포함 ROE 목표/손절 제한, 불변 결정 계획과 최종 실행 재검증, 재시작 이후 순손익/시간 종료 관리, 대시보드 선택 UI를 추가했다. Standard/LIVE·기존 계좌 위험/원장·레버리지 정책은 유지한다.

Figma 선행 설계 node23:22 및 get_design_context로 기존 스타일/컴포넌트를 확인하고 구현했다. 실제 Figma 스크린샷과 Noto Sans KR 폰트 검증 완료. React UI 선택·인증·저장·재접속은 jsdom으로 확인했으며 인증된 실서버 시각 수용 검수로 과장하지 않는다.

검증:

- API/Web TypeScript: PASS.
- 모드 계획·cycle·runtime·HTTP 대상4파일69개 PASS. 비용/rate 누락, horizon 비용 초과, 신호 기대값 부족, 전략 부적합, 하한5배 불가, 위조 계획, 저장 충돌/인증 실패, 세션/원장 보존 포함.
- 실제 PAPER executor의 상태 있는 메모리 저장소 E2E: 단타/스윙 진입→프로세스 상태 초기화→순익절/시간종료/갭손절/손상 계획 보호청산→추정 비용 순정산과 중복청산 방지. 추가로 위조 진입 계획과 실행 직전 비용 변화 거절을 검증한다. 최종 대상 묶음 결과는 아래 완료 인계/CI에서 확인한다. 합성 REPLAY이며 실제 시장 성과/운영 DB 시험이 아니다.
- UI 권위/재접속8개 PASS: 서버 모드 복원, 인증된 선택 저장, GET-only 재접속, START나 브라우저 매매 호출 없음.
- 전체 Web36파일463개 PASS.
- 전체 API 로컬:179파일2711개 PASS, 3개 skipped, 5개 suite 환경 차단. 3개는 DATABASE_URL 미지정 collection 오류, 2개는 격리 PostgreSQL initdb 실행파일 부재. 전체 API PASS로 주장하지 않는다. 기존 CI의 loopback 시험 환경 및 PostgreSQL gate 결과로 보완해야 한다.
- 위 DATABASE_URL 관련3개는 CI와 같은 비운영 loopback 주소로 다시 실행하여30개 PASS. 남은 격리 PostgreSQL2개는 initdb가 있는 CI에서 확인한다. 운영 DB 자격증명을 읽거나 사용하지 않았다.
- 최종 실행 전 비용 재검증·동일 밀리초 설정 충돌 방지를 포함한 API 대상4파일77개 PASS, 추가 위조/비용변경2개까지 포함한 E2E 파일22개 PASS. 마지막 변경 뒤 API 타입 검사 PASS.
- pnpm 자동 의존성 점검에서 esbuild build-script 승인이 없어 install이 중단됐다. 승인 정책을 변경하거나 설치 스크립트를 실행하지 않고 이미 설치된 잠금 버전의 tsc/vitest 실행파일로 검증했다. pnpm이 만든 미완성 allowBuilds 항목은 제거해 원래 설정을 보존했다.

현재 문서 작성 시 GitHub exact-head CI/배포/runtime: PENDING. 완료 인계는 실제 소스 SHA/tree·CI·배포 identity·조회시각을 따로 기록한다. 문서만을 위해 배포하지 않는다.

수익률 기준은 포지션 증거금 대비이며 사용자에게 설명한 해석이다. 초기7.5%/3%,15%/5%는 연구 프리셋이지 최적값이 아니다. 장기 실데이터 walk-forward, 자연 PAPER 목표 체결, Alpha/Beta 완료는 미검증이다. 10% 초과 갭 손실을 그대로 기록하는 회귀가 있으며 실제 최대손실 보장으로 표시하지 않는다.
