/**
 * 6I-2 §6 — GMX 1e30 스케일 수치 정밀 처리 (db-free 순수 모듈).
 *
 * 원칙:
 *  - API string → BigInt 파싱 (Number 조기 변환 금지 — 1e30 값은 safe integer 초과)
 *  - 합산 등 중간 계산은 BigInt로 유지 (long+short 합산 scale 동일 검증은 호출부 책임)
 *  - 최종 UI/DB 직렬화 경계에서만 bounded decimal(Number) 변환
 *  - overflow/파싱 실패 = null (작은 정상값으로 clamp 금지, 0 위장 금지)
 *  - exponent notation('1e30')·소수점·NaN/Infinity 문자열 = 파싱 거부 (정수 문자열만)
 */

const USD_SCALE = 30n;
/** 변환 시 유지할 소수 자릿수 (micro-USD) */
const OUT_DECIMALS = 6n;

/** 정수 문자열(±) → BigInt. 그 외(지수 표기·소수점·공백·빈 문자열) = null */
export function parseBigIntStr(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) {
    try { return BigInt(v); } catch { return null; }
  }
  return null;
}

/**
 * 1e30 스케일 USD BigInt → Number (소수 6자리 유지).
 * |값| ≥ 1e15 USD는 비정상 입력으로 간주해 null (clamp 금지).
 */
export function usd30ToNumber(raw: bigint | null): number | null {
  if (raw === null) return null;
  const divisor = 10n ** (USD_SCALE - OUT_DECIMALS);   // 1e24
  const scaled = raw / divisor;                        // micro-USD (BigInt 나눗셈 — truncation)
  const abs = scaled < 0n ? -scaled : scaled;
  // 1e15 USD = 1e21 micro-USD 상한 (Number.MAX_SAFE_INTEGER ≈ 9e15 micro-USD보다 먼저 차단)
  if (abs >= 10n ** 21n) return null;
  if (abs > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(scaled) / 1e6;
}

/** 1e30 스케일 USD 문자열 → Number USD. 실패=null */
export function usd30StrToNumber(v: unknown): number | null {
  const b = parseBigIntStr(v);
  if (b === null) return null;
  if (b < 0n) return null; // 유동성/OI는 음수 불가값
  return usd30ToNumber(b);
}

/** 두 1e30 USD 문자열의 합 → Number USD. 한쪽이라도 실패=null (부분합 위장 금지) */
export function usd30SumToNumber(a: unknown, b: unknown): number | null {
  const ba = parseBigIntStr(a);
  const bb = parseBigIntStr(b);
  if (ba === null || bb === null) return null;
  if (ba < 0n || bb < 0n) return null;
  return usd30ToNumber(ba + bb);   // BigInt로 합산 후 1회만 변환 (scale 일치: 둘 다 1e30)
}

/**
 * per-second 1e30 스케일 rate 문자열 → 시간당 비율 Number.
 * funding은 음수 허용. 변환은 micro(1e-6 단위 정밀) 경계에서 1회.
 * |시간당| ≥ 1 (100%/h)는 비정상 rate로 null.
 */
/**
 * per-HOUR 1e30 스케일 rate 문자열 → 시간당 비율 Number (공식 API v1 MarketTicker 계약).
 * @gmx-io/sdk@1.7.0 getMarketTicker: fundingRateLong 등 = factorPerSecond×3600 (이미 시간당).
 * 부호 유지 (음수=지불). |시간당| ≥ 1 (100%/h)는 단위 계약 위반으로 null (근사·clamp 금지).
 */
export function rate30PerHourToNumber(v: unknown): number | null {
  const b = parseBigIntStr(v);
  if (b === null) return null;
  const abs = b < 0n ? -b : b;
  if (abs >= 10n ** USD_SCALE) return null;          // |rate/h| ≥ 1 = 계약 위반 (clamp 금지)
  // BigInt→Number는 double 유효자리(~15~17자리) 전체 보존 — 이후 1e30 나눗셈은 지수 조정만
  return Number(b) / 1e30;
}

/**
 * per-second 1e30 rate → 시간당. 온체인 factorPerSecond(DataStore) 전용 —
 * 공식 API v1 ticker 필드는 이미 시간당이므로 이 함수를 쓰면 안 된다 (rate30PerHourToNumber 사용).
 */
export function rate30PerSecToPerHour(v: unknown): number | null {
  const b = parseBigIntStr(v);
  if (b === null) return null;
  const perHour30 = b * 3600n;                       // BigInt 곱 — overflow 없음
  const divisor = 10n ** (USD_SCALE - 12n);          // 1e18 → 1e-12 정밀 유지
  const scaled = perHour30 / divisor;
  const abs = scaled < 0n ? -scaled : scaled;
  if (abs >= 10n ** 12n) return null;                // |rate/h| ≥ 1 차단
  if (abs > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(scaled) / 1e12;
}
