# 6I-4 — GMX 비용 성분 단위 계약 (공식 소스 감사 결과)

기록: 2026-08-18. 감사 대상: 설치된 `@gmx-io/sdk@1.7.0` (pnpm lock 고정) 빌드 산출물.

## 결론 (source pin)

비용 입력(rate·OI)은 **오직** 다음 소스에서 읽는다:

- Base URL: `https://arbitrum.gmxapi.io` — SDK `configs/api.ts` `API_URLS.production[ARBITRUM]`
- Endpoint: `GET /v1/markets/tickers` — SDK `utils/markets/api.ts` `fetchApiMarketsTickers`
- 응답 타입: `MarketTicker` — SDK `utils/markets/types.d.ts`

pin 문자열(코드 상수 `COST_SOURCE_PIN`, dataSource.ts):
`arbitrum.gmxapi.io/v1/markets/tickers@sdk1.7.0(MarketTicker per-hour 1e30, 음수=지불)`

## 필드별 계약 (SDK 코드 인용 근거)

`utils/markets/utils.js` `getMarketTicker()`:

```js
const SECONDS_PER_HOUR = BigInt(periodToSeconds(1, "1h"));           // 3600
const fundingRateLong  = getFundingFactorPerPeriod(marketInfo, true,  SECONDS_PER_HOUR);
const fundingRateShort = getFundingFactorPerPeriod(marketInfo, false, SECONDS_PER_HOUR);
const borrowingRateLong  = getBorrowingFactorPerPeriod(marketInfo, true,  SECONDS_PER_HOUR);
const borrowingRateShort = getBorrowingFactorPerPeriod(marketInfo, false, SECONDS_PER_HOUR);
```

`utils/fees/index.js`:

```js
function getFundingFactorPerPeriod(marketInfo, isLong, periodInSeconds) {
  // 지불 사이드: fundingFactorPerSecond × period × -1  → 음수
  // 수취 사이드: OI 비율로 환산된 rate × period        → 양수
}
function getBorrowingFactorPerPeriod(marketInfo, isLong, periodInSeconds) {
  return factorPerSecond * periodInSeconds;              // 항상 ≥ 0 (비용)
}
function getFundingFeeRateUsd(marketInfo, isLong, sizeInUsd, periodInSeconds) {
  return applyFactor(sizeInUsd, factor);                 // sizeUsd × factor / 1e30
}
```

| 필드 | 스케일 | 시간 단위 | 부호 | 방향 결속 |
|---|---|---|---|---|
| `fundingRateLong` / `fundingRateShort` | 1e30 (PRECISION) | **per-hour** | 음수=해당 사이드 **지불**, 양수=수취 | Long/Short 필드 각각 해당 사이드 전용 |
| `borrowingRateLong` / `borrowingRateShort` | 1e30 | **per-hour** | 항상 ≥0 (비용) | 동일 |
| `longInterestUsd` / `shortInterestUsd` | 1e30 USD | — | ≥0 | impact imbalance 산정용 |
| `marketTokenAddress` | — | — | — | 시장 결속 키 (checksum 주소) |

USD 비용 환산: `costUsd/h = notionalUsd × (rate/1e30)`; 보유기간 비용 = `× holdingHours`.

## 실측 골든 fixture

`src/__tests__/fixtures/gmxMarketsTickersGolden.json` — 2026-08-18 실 프로덕션 응답 발췌
(SOL: LONG 지불/SHORT 수취, BTC: LONG 수취/SHORT 지불, borrowing 0 케이스 포함).
예: SOL `fundingRateLong = -20133947528265847430278800` → −2.013e−5/h ≈ −0.0020%/h (지불).

## 금지 소스 (실측 불일치)

legacy `https://arbitrum-api.gmxinfra.io/markets/info` 의 `fundingRateLong` 등은 위 계약과
**부호·스케일 모두 불일치** (같은 시각 SOL: legacy `+1.7595e29` vs 공식 `-2.0134e25`).
SDK 어떤 타입에도 대응되지 않으므로 비용 입력으로 사용 금지. (universe scan의
유동성/OI 합계에만 계속 사용 — 해당 필드는 1e30 USD로 공식 tickers와 일치 확인.)

## DataStore 직접 실측 (기존 6I-3 유지)

- `POSITION_FEE_FACTOR(forPositiveImpact=false)`, `POSITION_IMPACT_FACTOR(isPositive=false)`,
  `POSITION_IMPACT_EXPONENT_FACTOR` — 1e30, getUint(eth_call) 실측 (gmxCostReader.ts)
- impact는 exponent가 정확히 2.0(2e30)일 때만 공식 `f=factor·d²/1e30` 경로로 산출, 아니면 null.
- gas: `ESTIMATED_GAS_FEE_*`, `INCREASE/DECREASE_ORDER_GAS_LIMIT` × 실측 `eth_gasPrice` × oracle ETH가.

## fail-closed 규칙 (변경 없음)

- 스키마/단위 계약 위반 record = 폐기 (계측 `tickersSchemaRejects`) — 근사·경험적 보정·clamp 금지
- 성분 확보 실패 = 해당 성분 null → totalCost null → ENV null (0 대체·부분합 금지)
- 만료 캐시 반환 금지, 429 backoff 중 신규 요청 차단
- freshness = 모든 실측 성분 관측 시각의 최솟값 (`costSnapshotFetchedAtMs`), 성분별 시각은
  `componentObservedAtMs`로 노출
