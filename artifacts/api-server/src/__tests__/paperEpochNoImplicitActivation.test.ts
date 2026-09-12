import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('PAPER epoch activation ownership', () => {
  it('앱 startup·scheduler·PAPER tick·deploy config는 activation API를 참조하지 않는다', () => {
    const implicitLifecycleSources = [
      source('../startup.ts'),
      source('../index.ts'),
      source('../workers/aiWorker.ts'),
      source('../workers/serverPaperExecutor.ts'),
      source('../../.replit-artifact/artifact.toml'),
    ];

    for (const text of implicitLifecycleSources) {
      expect(text).not.toMatch(/\bactivatePaperEpoch\b/);
      expect(text).not.toMatch(/\bpaperEpochActivation\b/);
    }
  });

  it('production activation caller는 operator-authenticated POST route 하나뿐이다', () => {
    const route = source('../routes/gmxapi.ts');
    const productionSources = [
      source('../startup.ts'),
      source('../index.ts'),
      source('../workers/aiWorker.ts'),
      source('../workers/serverPaperExecutor.ts'),
      route,
    ];

    expect(route).toContain(
      "router.post('/executor/gmx-api/paper-epoch/activate', requireOperatorAuth",
    );
    expect(route.match(/\bpaperEpochActivator\s*\(/g)).toHaveLength(1);
    expect(
      productionSources.filter((text) => /\bpaperEpochActivator\s*\(/.test(text)),
    ).toEqual([route]);
  });

  it('status GET 구간에는 activation 호출이 없고 상태 생성도 명시적으로 read-only다', () => {
    const route = source('../routes/gmxapi.ts');
    const getStart = route.indexOf("router.get('/executor/gmx-api/status'");
    const postStart = route.indexOf("router.post('/executor/gmx-api/paper-epoch/activate'");

    expect(getStart).toBeGreaterThan(-1);
    expect(postStart).toBeGreaterThan(getStart);
    const getOnly = route.slice(getStart, postStart);
    expect(getOnly).not.toMatch(/\bpaperEpochActivator\s*\(/);
    expect(getOnly).toContain('buildGmxApiStatusSnapshot');
  });
});