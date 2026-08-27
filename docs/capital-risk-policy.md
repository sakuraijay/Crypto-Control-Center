# Planned Seed / Active Capital / Reserve 정책

## 자본의 의미

- **Planned Seed Capital:** `10,000 USDC`. 계획·시뮬레이션·장기 평가 기준일 뿐이며 실제 입금, 자금 이동, Active 증액 또는 LIVE 권한이 아니다.
- **Approved Active Stage:** 현재 승인 단계 `1,000 USDC`. 자동 증액되지 않는다.
- **Current Risk Sizing Capital:** 저장된 실제 운용 설정값이며 Approved Active Stage 이하만 허용한다. 더 작은 기존 값은 안전한 축소이므로 강제로 덮어쓰지 않는다.
- **Reserve Capital:** Approved Active의 20%인 `200 USDC`; 승인 단계 기준 배포 가능액은 `800 USDC`다. 실제 sizing reserve는 Current Risk Sizing Capital에서 별도 파생한다.
- **On-chain Balance:** GMX RPC가 읽은 실제 지갑 잔액. Planned/Active/Reserve와 별도이며 어느 값도 실제 잔액으로 합성하지 않는다.

## 위험 정책

현재 Active `1,000` 기준:

- 거래당 기본 허용손실 0.25% = `$2.50`
- 거래당 절대 최대손실 0.5% = `$5.00`
- Defensive Mode 진입 0.5% 손실 = `-$5.00`
- 일일 최대손실 1% = `$10.00`
- 전체 Drawdown 중단선 8% = equity `$920`
- 주간 8%, reserve 최소 20%, 포지션당 담보 최대 `$334`, 최대 레버리지 3x, 동시 포지션 1개, cooldown 최소 30분 등 기존 더 엄격한 제한은 모든 profile에서 유지한다.
- 일일 +5%/+10%는 수익 목표가 아니라 과열 방지 경계다.
- 월 순수익 1~3%는 평가 참고치이며 강제 목표나 보장 수익이 아니다.
- 레버리지/거래횟수 강제 증가, 낮은 신뢰도 승인, 손실복구 확대, 물타기, 마틴게일, 비용 우회, Risk veto 무시는 금지한다.

## Active Capital 단계

`1,000 → 2,500 → 5,000 → 10,000 USDC`

각 단계는 자동 승격되지 않는다. 순차 단계마다 아래 조건을 모두 새로 확인하고 사용자에게 보고한 뒤 명시 승인을 받아야 한다.

1. 전체 비용 차감 후 양의 기대값
2. GMX 주문·체결·정산의 정확한 일치
3. Stop-Loss와 비상청산의 실제 실행 가능
4. unresolved 0
5. Drawdown 및 일일 손실 제한 준수
6. 해당 단계의 controlled Canary 검증
7. 사용자 보고 검토 및 명시 승인

## 현재 Canary 판정

- `$20 LONG / 1h` 관측 비용 약 `$0.48`은 `$0.40` cap을 초과한다.
- Stop readiness가 완료되지 않았다.
- 따라서 Canary 및 모든 LIVE/sign/subaccount/order/fund 동작은 계속 차단한다.
- 단일 `$20` quote로 경제적 최소 주문규모를 선형 추정할 수 없다. 동일 조건의 여러 notional에 대한 fresh 공식 read-only quote와 기대 edge를 비교해야 하며, 그 전에는 최소 경제적 주문규모를 `Unavailable`로 본다.

## 보존한 과거 `$1,000`

과거 production reset migration, audit 문서, historical fixture와 명시적 테스트 입력의 `$1,000`은 당시 상태를 재현하는 값이므로 변경하지 않는다. 현재 Active `1,000`도 사용자 승인 없는 증액을 막기 위해 유지한다.