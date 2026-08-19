import { describe, expect, it } from 'vitest';
import { bindExactProtectionPosition } from '../lib/protectionPositionBinding';

const KEY = '0x' + '1'.repeat(64);
const OTHER_KEY = '0x' + '2'.repeat(64);
const MARKET = '0x' + '3'.repeat(40);
const USDC = '0x' + '4'.repeat(40);
const OTHER_COLLATERAL = '0x' + '5'.repeat(40);
const request = { positionKey: KEY, marketAddress: MARKET, isLong: true, sizeDeltaUsd: 20 };
const exact = {
  positionKey: KEY, marketAddress: MARKET, collateralToken: USDC,
  isLong: true, sizeUsd: 20,
};

describe('protection pre-submit exact position binding', () => {
  it('exact key+market+direction+collateral+size만 허용', () => {
    expect(bindExactProtectionPosition(request, [exact], USDC)).toMatchObject({ ok: true });
  });

  it('position disappearance → fail-closed', () => {
    expect(bindExactProtectionPosition(request, [], USDC)).toMatchObject({
      ok: false, reason: expect.stringContaining('0건'),
    });
  });

  it('same market/direction의 다른 position key는 대체 증거가 될 수 없음', () => {
    const other = { ...exact, positionKey: OTHER_KEY };
    expect(bindExactProtectionPosition(request, [other], USDC)).toMatchObject({
      ok: false, reason: expect.stringContaining('exact position key'),
    });
  });

  it('exact key라도 collateral token이 다르면 차단', () => {
    expect(bindExactProtectionPosition(
      request,
      [{ ...exact, collateralToken: OTHER_COLLATERAL }],
      USDC,
    )).toMatchObject({ ok: false, reason: expect.stringContaining('collateral') });
  });

  it.each([0, 19, 21])('position size=%s 변경/소멸 → stale full-size 제출 금지', (sizeUsd) => {
    expect(bindExactProtectionPosition(
      request,
      [{ ...exact, sizeUsd }],
      USDC,
    )).toMatchObject({ ok: false, reason: expect.stringContaining('size') });
  });

  it('같은 market/direction position이 여러 개여도 exact key 1건만 선택', () => {
    const other = {
      ...exact, positionKey: OTHER_KEY, collateralToken: OTHER_COLLATERAL,
    };
    const result = bindExactProtectionPosition(request, [other, exact], USDC);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.position.positionKey).toBe(KEY);
  });
});