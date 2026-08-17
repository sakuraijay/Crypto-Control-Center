/**
 * 6E-8 §5 — Readiness 진단 UI 다중 항목 표시 정적 검증.
 *
 * 기존 uiBadges.test.ts와 동일한 방식: 컴포넌트를 렌더링하지 않고
 * 소스 코드를 정적으로 검증한다 (테스트 러너에 DOM 환경 없음).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const comp = (name: string) => readFileSync(join(__dir, '../components', name), 'utf-8');
const lib = (name: string) => readFileSync(join(__dir, '../lib', name), 'utf-8');

const relayCard = comp('RelayStatusCard.tsx');
const readinessCard = comp('ReadinessRefreshCard.tsx');
const relayStatusLib = lib('relayStatus.ts');

describe('ReadinessRefreshCard — basis/failures 전체 표시', () => {
  it('basis 배열 전체를 map으로 렌더링한다', () => {
    expect(readinessCard).toMatch(/result\.basis\.map/);
  });
  it('failures 배열 전체를 map으로 렌더링한다', () => {
    expect(readinessCard).toMatch(/result\.failures\.map/);
  });
  it('실패 섹션은 fail-closed 표기를 유지한다', () => {
    expect(readinessCard).toContain('fail-closed');
  });
});

describe('RelayStatusCard — readiness failures 전체 표시 (첫 항목만 표시 금지)', () => {
  it('refresh.failures 전체를 map으로 렌더링한다', () => {
    expect(relayCard).toMatch(/refresh\.failures\.map/);
  });
  it('failures[0] 단독 축약 표시가 제거되었다', () => {
    expect(relayCard).not.toContain('refresh.failures[0]');
  });
  it('refresh.ok=false는 실패(fail-closed) 문구로 표시한다 (성공 표기와 분리)', () => {
    expect(relayCard).toContain("'실패(fail-closed)'");
  });
});

describe('RelayStatusCard — 배포 검증 스냅샷 표시 (추가 외부 호출 없음)', () => {
  it('deploymentVerification basis/failures를 렌더링한다', () => {
    expect(relayCard).toMatch(/deploymentVerification\.basis\.map/);
    expect(relayCard).toMatch(/deploymentVerification\.failures\.map/);
  });
  it('저장 스냅샷 재사용임을 명시한다 (fetch 추가 호출 코드 없음)', () => {
    expect(relayCard).toContain('저장 스냅샷');
    // deploymentVerification 표시 블록에서 별도 fetch를 호출하지 않는다
    expect(relayCard).not.toMatch(/fetch\([^)]*deployment/i);
  });
  it('ActivationStatusFlags 타입에 deploymentVerification이 정의되어 있다', () => {
    expect(relayStatusLib).toMatch(/deploymentVerification\?:\s*\{/);
  });
});
