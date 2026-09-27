# GMX 공식 소스 Pin (6F-2)

이 코드베이스의 GMX relay fee 산정과 Gelato transport 계약은 아래 공식
소스 버전에 고정(pin)되어 있다. 산정 로직·상수를 변경할 때는 반드시 이
pin을 갱신하고 근거 diff를 확인한다.

## Pin 대상

| 항목 | 값 |
| --- | --- |
| gmx-interface commit | `e27759a2835c7dc2197f41b6a6043bf07b935621` |
| @gmx-io/sdk | `1.7.0` |
| @gelatocloud/gasless | `0.0.10` |
| transport 세대 식별자 | `jsonrpc-gasless-0.0.10` (`relay_tasks.transport_gen`) |
| Gelato endpoint | `https://api.gelato.cloud/rpc` (JSON-RPC 2.0, `X-API-Key` 헤더) |

## fee 산정 (gmxFeeEstimate.ts)

- `fee = applyFactor(gasLimit × gasPrice, gelatoRelayFeeMultiplierFactor)`
  — `applyFactor(v, f) = v × f / 1e30` (bigint 내림, 공식 `utils.ts`와 동일)
- multiplierFactor는 DataStore `getUint(hashKeyString('GELATO_RELAY_FEE_MULTIPLIER_FACTOR'))`
  — 온체인 실시간 값만 사용, 하드코딩·fallback 금지
- buffer: Arbitrum `EXECUTION_FEE_BUFFER_BPS = 3000` (30%), base 산정 후 별도 내림
- gasPrice는 read-only RPC `eth_gasPrice`, gasLimit은 estimateGas 결과 필수
  (어느 하나라도 실패 시 산정 불가 — fail-closed, 제출 차단)
- feeToken = WNT(WETH Arbitrum) 고정, `feeSwapPath = []`
  — USDC 등 swap 경로 지불은 공식 pin에서 근거를 확정하지 못해 차단
- Gelato fee oracle(`/oracles/`)은 GMX 공식 흐름에서 사용되지 않음 — 제거됨

## Gelato JSON-RPC (relayTransport.ts)

- read-only method: `relayer_getStatus`, `gelato_getBalance`
- submit method: `relayer_sendTransaction`
- StatusCode: 100 PENDING · 110 SUBMITTED · 200 SUCCESS · 400 REJECTED · 500 REVERTED
- legacy REST(api.gelato.digital, `/relays/v2/sponsored-call`, `/tasks/status/`)는
  실행 경로에서 완전 제거 — legacy 세대 task는 UNRESOLVED_LEGACY_TRANSPORT로만 처리

## 갱신 절차

1. gmx-interface에서 대상 commit의 `sdk/src/utils/fees/executionFee.ts`,
   `domain/synthetics/express/` 산정 경로 diff 확인
2. 상수·순서(내림 포함) 변경이 있으면 `gmxFeeEstimate.ts` 골든 테스트
   (`gmxRelayStage6F2.test.ts`) fixture를 함께 갱신
3. 이 문서의 pin 표를 새 값으로 교체
