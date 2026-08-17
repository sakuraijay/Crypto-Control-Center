/**
 * 6E-10 §8 — 실제 route fixture → runtime 렌더 검증.
 *
 *  - postReadinessRefresh: 실제 서버 응답 계약(fixture) → refresh+snapshot 파싱
 *  - RelayStatusCard: snapshot props → deploymentVerification 7개 항목·failures·
 *    readiness 시각·fail-closed 문구 runtime 렌더 (renderToStaticMarkup)
 *  - snapshot 없음 → "확인 불가 — 운영자 인증 후 Readiness 검증 필요" 표시,
 *    초기 false값을 실제 상태처럼 표시하지 않음, 새로고침 아이콘 disabled+안내
 *  - fetch 오류 분류 (401→OPERATOR_AUTH_REQUIRED / 503→NOT_CONFIGURED /
 *    network→UNVERIFIED) — silent null 제거
 *  - PIN 비전달·비저장·자동 polling 없음 (소스 계약 검증)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// RelayStatusCard는 WalletContext에 의존 — 렌더 전용 stub (네트워크·지갑 0회)
vi.mock('@/lib/context', () => ({
  useWallet: () => ({ status: 'disconnected', isArbitrum: false, address: null }),
}));

import { RelayStatusCard } from '../RelayStatusCard';
import { ReadinessRefreshCard } from '../ReadinessRefreshCard';
import {
  postReadinessRefresh, fetchRelayStatus, classifyRelayHttpFailure,
  type ReadinessSnapshotView,
} from '@/lib/relayStatus';

// ── 실제 서버 응답 계약 fixture (api-server readinessSnapshot.http.test.ts와 동일 구조) ──
const SNAPSHOT_FIXTURE: ReadinessSnapshotView = {
  atMs: 1766000000000,
  deploymentVerification: {
    attempted: true, atMs: 1766000000000, ok: true, manifestVersion: 1,
    basis: [
      'env 주소가 manifest v1 감사 주소와 일치',
      'chainId 42161 확인',
      'SubaccountGelatoRelayRouter 코드 존재 확인',
      'DataStore 코드 존재 확인',
      'EventEmitter 코드 존재 확인',
      'digests(bytes32) decode 정상 (selector 0x82c9469e)',
      'DataStore.getUint decode 정상',
    ],
    failures: [],
  },
  canonical: {
    confirmed: false,
    reason: 'canonical readback 생략: delegated signer 미초기화 (예상된 fail-closed)',
    approvalNonce: null, isSubaccountListed: null, expiresAt: null, remaining: null,
    atMs: 1766000000000,
  },
  lastReadinessRefresh: {
    attempted: true, atMs: 1766000000000, ok: false,
    basis: ['할당된 userNonce 0건 (신규 할당 없음)', '미종결 relay task 0건 (taskId 보유 0건)'],
    failures: [
      'canonical readback 생략: delegated signer 미초기화 (예상된 fail-closed)',
      'fee oracle 조회 실패 (외부 fee oracle 일시 장애 — HTTP 500)',
    ],
  },
  statusFlags: {
    readonlyNetworkDisabled: false, submitNetworkDisabled: true, submissionDisabled: true,
    relayMode: 'DISABLED', signerDisabled: true, liveLocked: true, manifestVersion: 1,
    readyForControlledCanary: false,
  },
};

const ROUTE_FIXTURE = {
  ok: true,
  refresh: { attempted: true, ...SNAPSHOT_FIXTURE.lastReadinessRefresh },
  snapshot: SNAPSHOT_FIXTURE,
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('postReadinessRefresh — route fixture → snapshot 파싱', () => {
  it('응답의 refresh + snapshot을 그대로 반환한다 (PIN은 헤더로만 전달)', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(200, ROUTE_FIXTURE));
    vi.stubGlobal('fetch', fetchSpy);
    const r = await postReadinessRefresh({ pin: 'test-pin-123456' });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.refresh.ok).toBe(false);
    expect(r.snapshot?.deploymentVerification.basis).toHaveLength(7);
    expect(r.snapshot?.statusFlags.readyForControlledCanary).toBe(false);
    // 단 1회 호출 — 자동 재시도·추가 GET 없음
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('구서버 응답(snapshot 없음)도 하위호환 — snapshot=null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { ok: true, refresh: ROUTE_FIXTURE.refresh })));
    const r = await postReadinessRefresh({ pin: 'test-pin-123456' });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.snapshot).toBeNull();
  });
});

describe('RelayStatusCard — snapshot runtime 렌더', () => {
  it('deploymentVerification 7개 항목·failures·readiness 시각·fail-closed 전부 표시', () => {
    const html = renderToStaticMarkup(<RelayStatusCard snapshot={SNAPSHOT_FIXTURE} />);
    for (const item of SNAPSHOT_FIXTURE.deploymentVerification.basis) {
      expect(html).toContain(item.replace(/&/g, '&amp;'));
    }
    // failures 전체 렌더 — HTTP 500을 성공으로 오표시하지 않음
    expect(html).toContain('외부 fee oracle 일시 장애 — HTTP 500');
    expect(html).toContain('delegated signer 미초기화 (예상된 fail-closed)');
    // signer 비활성 = 시스템 고장 아님 구분 표기
    expect(html).toContain('예상된 fail-closed — 시스템 고장 아님');
    // canary — 절대 적격으로 표시하지 않음
    expect(html).toContain('LIVE 적격 여부: 준비 미완료 (fail-closed)');
    expect(html).not.toContain('Ready for controlled canary');
    // readiness 갱신 시각 표시
    expect(html).toContain('Readiness 갱신:');
    expect(html).toContain('실패 (fail-closed)');
  });

  it('snapshot 없음 → 확인 불가 표시 (초기 false값을 실제 상태처럼 표시하지 않음)', () => {
    const html = renderToStaticMarkup(<RelayStatusCard />);
    expect(html).toContain('확인 불가 — 운영자 인증 후 Readiness 검증 필요');
    expect(html).toContain('최근 인증된 snapshot 없음');
    expect(html).toContain('LIVE 적격 여부: 확인 불가 (fail-closed)');
    // 과거의 오해 유발 표시 제거
    expect(html).not.toContain('비활성 (기본)');
    // 페이지 새로고침 시 snapshot 소실 안내
    expect(html).toContain('페이지 새로고침 시 snapshot은 사라집니다');
  });

  it('원형 새로고침 아이콘 — PIN 미입력 시 disabled + 사유·안내 표시 (무반응 금지)', () => {
    const html = renderToStaticMarkup(<RelayStatusCard />);
    // 버튼 disabled + title 사유
    expect(html).toMatch(/data-testid="button-refresh-relay"[^>]*/);
    const btn = html.slice(html.indexOf('title="운영자 PIN'), html.indexOf('data-testid="button-refresh-relay"') + 80);
    expect(html).toContain('disabled=""');
    expect(html).toContain('운영자 PIN(6자 이상) 입력 시에만 조회 가능');
    // 안내 문구
    expect(html).toContain('상태 갱신은 위 Readiness 카드에서 수행');
    expect(btn.length).toBeGreaterThan(0);
  });
});

describe('ReadinessRefreshCard — 초기 렌더', () => {
  it('초기 상태는 결과 없이 렌더되고 PIN 안내만 표시된다', () => {
    const html = renderToStaticMarkup(<ReadinessRefreshCard />);
    expect(html).toContain('Relay Readiness — 읽기 전용 검증');
    expect(html).toContain('요청 즉시 삭제됩니다');
    expect(html).not.toContain('전 항목 확인됨');
  });
});

describe('인증 오류 분류 — silent null 제거 (§7)', () => {
  it('401/403 → OPERATOR_AUTH_REQUIRED, 503 → NOT_CONFIGURED, 기타 → ERROR', () => {
    expect(classifyRelayHttpFailure(401).kind).toBe('OPERATOR_AUTH_REQUIRED');
    expect(classifyRelayHttpFailure(403).kind).toBe('OPERATOR_AUTH_REQUIRED');
    expect(classifyRelayHttpFailure(503).kind).toBe('NOT_CONFIGURED');
    expect(classifyRelayHttpFailure(500).kind).toBe('ERROR');
  });

  it('fetchRelayStatus — 401은 메시지로 구분되고, network 오류는 UNVERIFIED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { ok: false })));
    const r1 = await fetchRelayStatus('bad-pin-123456');
    expect(r1.kind).toBe('OPERATOR_AUTH_REQUIRED');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const r2 = await fetchRelayStatus('test-pin-123456');
    expect(r2.kind).toBe('UNVERIFIED');
  });
});

describe('소스 계약 — PIN 비저장·비전달·자동 조회 없음 (§3·§6)', () => {
  const readinessSrc = readFileSync(path.resolve(__dirname, '../ReadinessRefreshCard.tsx'), 'utf8');
  const relaySrc = readFileSync(path.resolve(__dirname, '../RelayStatusCard.tsx'), 'utf8');
  const settingsSrc = readFileSync(path.resolve(__dirname, '../../pages/settings.tsx'), 'utf8');

  it('PIN은 요청 직전 삭제되고 callback/props/storage로 전달되지 않는다', () => {
    // setPin('')이 postReadinessRefresh 호출보다 먼저 온다
    expect(readinessSrc.indexOf("setPin('')")).toBeGreaterThan(-1);
    expect(readinessSrc.indexOf("setPin('')")).toBeLessThan(readinessSrc.indexOf('await postReadinessRefresh'));
    // onSnapshot 시그니처에 pin 없음
    expect(readinessSrc).toContain('onSnapshot?: (snapshot: ReadinessSnapshotView | null) => void');
    expect(readinessSrc).not.toContain('onSnapshot?.(pin');
    // storage 미사용
    for (const src of [readinessSrc, relaySrc, settingsSrc]) {
      expect(src).not.toContain('localStorage');
      expect(src).not.toContain('sessionStorage');
      expect(src).not.toContain('indexedDB');
      expect(src).not.toContain('document.cookie');
    }
    // settings는 snapshot state만 전달 (PIN 아님)
    expect(settingsSrc).toContain('onSnapshot={setRelaySnapshot}');
    expect(settingsSrc).toContain('snapshot={relaySnapshot}');
  });

  it('RelayStatusCard는 mount 자동 GET·polling·자동 retry가 없다', () => {
    expect(relaySrc).not.toMatch(/useEffect\(\(\)\s*=>\s*\{\s*void refresh/);
    expect(relaySrc).not.toContain('setInterval');
    expect(readinessSrc).not.toContain('setInterval');
  });
});
