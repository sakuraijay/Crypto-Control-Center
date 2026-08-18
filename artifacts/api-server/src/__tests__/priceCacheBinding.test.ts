/**
 * #120 — 가격 캐시 SDK registry 결속 + 범위 검증 (Beta RC P0).
 *
 *  §1 정상: XRP(dec6)/HYPE(dec8)/BTC(dec8) 실측 raw → 올바른 USD (과거 1e10~1e12배 오염 재발 방지).
 *  §2 fail-closed: SDK 미등재 주소·심볼 불일치·비정상 raw·범위 밖 = tick 폐기 (0/클램프/추측 금지).
 *  §3 계측: 폐기는 priceTickRejectStats에 집계 (침묵 금지).
 *  §4 루트 /healthz: JSON 전용 — readiness 전 503, 후 200 (SPA HTML 아님).
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { bindAndConvertTick, priceTickRejectStats, PRICE_SANE_MIN_USD, PRICE_SANE_MAX_USD, PRICE_SOURCE_PIN } from '../routes/gmx';
import app from '../app';
import { markReady, markNotReady } from '../lib/readiness';

const XRP = { addr: '0xc14e065b0067dE91534e032868f5Ac6ecf2c6868', dec: 6 };
const HYPE = { addr: '0xfDFA0A749dA3bCcee20aE0B4AD50E39B26F58f7C', dec: 8 };
const BTC = { addr: '0x47904963fc8b2340414262125aF798B9655E58Cd', dec: 8 };

const tick = (addr: string, sym: string, minUsd: number, dec: number) => ({
  tokenAddress: addr, tokenSymbol: sym,
  minPrice: BigInt(Math.round(minUsd * 1e6)) * 10n ** BigInt(24 - dec) + '',
  maxPrice: BigInt(Math.round(minUsd * 1e6)) * 10n ** BigInt(24 - dec) + '',
  updatedAt: 1_787_000_000_000,
});

describe('#120 §1 SDK 결속 정상 변환', () => {
  it('XRP dec=6 raw → $1.31 (1e12배 오염 재발 방지)', () => {
    const t = bindAndConvertTick(tick(XRP.addr, 'XRP', 1.31, XRP.dec), {});
    expect(t).not.toBeNull();
    expect(t!.priceUsd).toBeCloseTo(1.31, 6);
  });
  it('HYPE dec=8 → $58.9; BTC dec=8 → $64741; 대소문자 무관 주소 결속', () => {
    expect(bindAndConvertTick(tick(HYPE.addr, 'HYPE', 58.9, HYPE.dec), {})!.priceUsd).toBeCloseTo(58.9, 6);
    expect(bindAndConvertTick(tick(BTC.addr.toLowerCase(), 'BTC', 64741.33, BTC.dec), {})!.priceUsd).toBeCloseTo(64741.33, 2);
  });
  it('과거 버그 재현 입력: XRP raw를 dec=18 가정으로 만들면 범위 밖 → 폐기 (클램프 아님)', () => {
    // 오염된 업스트림이 1e12배 큰 raw를 보내는 상황과 동일
    const bad = { ...tick(XRP.addr, 'XRP', 1.31, XRP.dec), minPrice: '1310000' + '0'.repeat(30), maxPrice: '1310000' + '0'.repeat(30) };
    expect(bindAndConvertTick(bad, {})).toBeNull();
  });
});

describe('#120 §1b native/wrapped 결속 (공식 tickers 계약)', () => {
  it('ETH 심볼 + WETH 주소(0x82aF…) = SDK wrappedAddress 결속으로 정상 변환', () => {
    const WETH_ADDR = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
    const t = bindAndConvertTick(tick(WETH_ADDR, 'ETH', 3_412.55, 18), {});
    expect(t).not.toBeNull();
    expect(t!.priceUsd).toBeCloseTo(3_412.55, 4);
    // 같은 주소에 WETH 심볼도 유효 (SDK 자체 항목)
    expect(bindAndConvertTick(tick(WETH_ADDR, 'WETH', 3_412.55, 18), {})).not.toBeNull();
    // 그 외 심볼은 불일치 폐기
    expect(bindAndConvertTick(tick(WETH_ADDR, 'BTC', 3_412.55, 18), {})).toBeNull();
  });
});

describe('#120 §2 fail-closed 폐기', () => {
  it('SDK 미등재 주소 → 폐기 (decimals 추측 금지)', () => {
    expect(bindAndConvertTick(tick('0x' + '77'.repeat(20), 'FAKE', 10, 8), {})).toBeNull();
  });
  it('심볼 불일치 (주소=XRP, 심볼=BTC) → 폐기', () => {
    expect(bindAndConvertTick(tick(XRP.addr, 'BTC', 1.31, XRP.dec), {})).toBeNull();
  });
  it('비정상 raw (음수/소수/빈 문자열/비숫자) → 폐기', () => {
    for (const raw of ['-5', '1.5e30', '', 'abc']) {
      expect(bindAndConvertTick({ ...tick(XRP.addr, 'XRP', 1, 6), minPrice: raw, maxPrice: raw }, {})).toBeNull();
    }
  });
  it('범위 밖 (< 1e-9, > 1e8) 및 max<min → 폐기', () => {
    expect(PRICE_SANE_MIN_USD).toBe(1e-9);
    expect(PRICE_SANE_MAX_USD).toBe(1e8);
    const tiny = { ...tick(XRP.addr, 'XRP', 1, 6), minPrice: '1', maxPrice: '1' }; // 1e-24 USD
    expect(bindAndConvertTick(tiny, {})).toBeNull();
    const inv = { ...tick(XRP.addr, 'XRP', 1, 6), maxPrice: tick(XRP.addr, 'XRP', 0.5, 6).maxPrice };
    expect(bindAndConvertTick(inv, {})).toBeNull();
  });
});

describe('#120 §3 폐기 집계 + source pin', () => {
  it('폐기는 stats에 사유별 집계된다 (침묵 금지)', () => {
    const before = priceTickRejectStats.unknownAddress + priceTickRejectStats.symbolMismatch;
    bindAndConvertTick(tick('0x' + '88'.repeat(20), 'ZZZ', 5, 8), {});
    bindAndConvertTick(tick(HYPE.addr, 'XRP', 5, 8), {});
    expect(priceTickRejectStats.unknownAddress + priceTickRejectStats.symbolMismatch).toBe(before + 2);
    expect(priceTickRejectStats.lastRejectSymbols.length).toBeGreaterThan(0);
  });
  it('source pin은 공식 소스를 명시한다', () => {
    expect(PRICE_SOURCE_PIN).toContain('gmxinfra.io/prices/tickers');
    expect(PRICE_SOURCE_PIN).toContain('configs/tokens[42161]');
  });
});

describe('#119/P1 §4 루트 /healthz — JSON 전용', () => {
  it('readiness 전 503 JSON, 후 200 JSON — HTML 아님', async () => {
    markNotReady();
    const r1 = await request(app).get('/healthz');
    expect(r1.status).toBe(503);
    expect(r1.headers['content-type']).toContain('application/json');
    expect(r1.body).toEqual({ status: 'starting', ready: false });

    markReady();
    const r2 = await request(app).get('/healthz');
    expect(r2.status).toBe(200);
    expect(r2.headers['content-type']).toContain('application/json');
    expect(r2.body).toEqual({ status: 'ok', ready: true });
    expect(String(r2.text)).not.toContain('<!DOCTYPE');
  });
});
