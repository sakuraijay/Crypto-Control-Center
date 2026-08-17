/**
 * 6G-2 §11/§14 — GmxApiStatusCard 렌더·fetch 계약 검증.
 *
 *  - 서버 스냅샷 fixture → 19항목 runtime 렌더 (renderToStaticMarkup)
 *  - submission flag false → "구조적으로 비활성" 표시
 *  - 조회 실패를 "미설정"으로 표시하지 않음 — 401/403/503/network 구분
 *  - readyForControlledCanary는 서버 값 그대로 (false)
 *  - legacy relay 벤더(Gelato Enterprise/Gas Tank/API key) 문구 0건
 *  - main wallet private key 관련 UI 0건
 *  - 소스 계약: PIN 저장·polling 없음, apiUrl 헬퍼(origin root /api)만 사용
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { GmxApiStatusCard } from '../GmxApiStatusCard';
import {
  fetchGmxApiStatus, postGmxApiReadinessRefresh, classifyGmxApiHttpFailure,
  type GmxApiStatusView,
} from '@/lib/gmxApiStatus';

const STATUS_FIXTURE: GmxApiStatusView = {
  transportGen: 'GMX_API_V2',
  legacyDisabled: true,
  peers: ['arbitrum.gmxapi.io', 'arbitrum.gmxapi.ai'],
  readonlyEnabled: false,
  submissionEnabled: false,
  signerEnabled: false,
  signerInitialized: false,
  liveTestExecutionLocked: true,
  emergencyStopActive: false,
  reconciled: true,
  dbOk: true,
  canonical: {
    authorized: false, approvalRemainingOk: false,
    reason: 'canonical readback 미조회 — 저장 스냅샷 없음 (fail-closed)',
    expiresAt: null, remaining: null,
  },
  approvalSessionReady: false,
  blockingIntentCount: 0,
  openRelayTaskCount: 0,
  unresolvedTaskCount: 0,
  activeRevokeInProgress: false,
  gmxConfigOk: false,
  deploymentVerification: { attempted: false, ok: false, atMs: null, manifestVersion: null },
  manifestVersion: '1',
  feeEstimate: { attempted: false, ok: false, atMs: null, fresh: false },
  lastReadinessRefresh: { attempted: false, atMs: null, ok: false, basis: null },
  gmxTaskCounts: {},
  recentGmxTasks: [],
  readyForControlledCanary: false,
  // 6G-3 §7 신규 항목
  prepareStageCounts: { PREPARED: 0, PREPARE_REQUESTED: 0, API_PREPARED: 0, SUBMITTING: 0, UNRESOLVED: 0 },
  oldestBlockingTaskAt: null,
  prepareStartupReconciliation: {
    attempted: true, ok: true, atMs: 1_700_000_000_000,
    stalePreparedFailed: 0, requestedToUnresolved: 0, apiPreparedHeld: 0,
  },
  blockedReasons: ['order submission flag 비활성 — 구조적 차단'],
  notices: [
    '자동 재시도 없음 — UNRESOLVED/API_PREPARED는 운영자 확인 전 어떤 자동 조치도 하지 않습니다.',
    '운영자 확인 전 서명·제출 금지 — 이 화면은 조회 전용이며 강제 완료·삭제·재제출 기능이 없습니다.',
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchGmxApiStatus — 오류 구분 (silent null 금지)', () => {
  it('200 → ok + status 파싱', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { ok: true, status: STATUS_FIXTURE })));
    const r = await fetchGmxApiStatus('123456');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.data.transportGen).toBe('GMX_API_V2');
  });

  it('401 → OPERATOR_AUTH_REQUIRED / 403 → FORBIDDEN / 503 → SERVICE_UNAVAILABLE', async () => {
    expect(classifyGmxApiHttpFailure(401).kind).toBe('OPERATOR_AUTH_REQUIRED');
    expect(classifyGmxApiHttpFailure(403).kind).toBe('FORBIDDEN');
    expect(classifyGmxApiHttpFailure(503).kind).toBe('SERVICE_UNAVAILABLE');
    expect(classifyGmxApiHttpFailure(500).kind).toBe('SERVER_ERROR');
  });

  it('네트워크 오류 → NETWORK (미설정으로 위장 금지)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const r = await fetchGmxApiStatus('123456');
    expect(r.kind).toBe('NETWORK');
  });

  it('POST refresh는 JSON Content-Type + 인증 헤더로 호출된다', async () => {
    const spy = vi.fn(async () => jsonResponse(200, { ok: true, status: STATUS_FIXTURE }));
    vi.stubGlobal('fetch', spy);
    await postGmxApiReadinessRefresh('123456');
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toMatch(/\/api\/executor\/gmx-api\/readiness\/refresh$/);
    const headers = init.headers as Record<string, string>;
    expect(headers['x-operator-pin']).toBe('123456');
    expect(headers['content-type']).toBe('application/json');
  });
});

describe('GmxApiStatusCard — 렌더 계약', () => {
  it('조회 전에는 상태 값을 표시하지 않는다 (지어내기 금지)', () => {
    const html = renderToStaticMarkup(<GmxApiStatusCard />);
    expect(html).toContain('아직 조회 전입니다');
    expect(html).not.toContain('GMX_API_V2');
  });

  it('금지 문구 0건 — legacy 벤더·private key 언급 없음', () => {
    const html = renderToStaticMarkup(<GmxApiStatusCard />);
    expect(html).not.toMatch(/Gelato Enterprise|Gas Tank|GELATO_API_KEY/i);
    expect(html).not.toMatch(/private[_ ]?key/i);
  });
});

describe('소스 계약 (§11 규칙)', () => {
  const cardSrc = readFileSync(path.resolve(__dirname, '../GmxApiStatusCard.tsx'), 'utf8');
  const libSrc = readFileSync(path.resolve(__dirname, '../../lib/gmxApiStatus.ts'), 'utf8');

  it('19항목 라벨이 전부 카드에 존재한다', () => {
    for (const label of [
      'GMX API v2 Official', 'Read-only flag', 'Order submission flag', 'Peer A / Peer B',
      'Delegated signer', 'Owner Approval 세션', 'Canonical verified', 'Remaining actions',
      'Approval expiresAt', 'Active revoke', 'Blocking intents', 'Open tasks / Unresolved',
      'Reconciliation', 'LIVE 잠금', 'Emergency Stop', 'Fee estimate',
      '최근 requestId/status', 'readyForControlledCanary', '구조적으로 비활성',
    ]) {
      expect(cardSrc).toContain(label);
    }
  });

  it('Gelato 벤더 문구 0건 (카드+lib)', () => {
    expect(cardSrc + libSrc).not.toMatch(/Gelato|Gas Tank|GELATO_API_KEY/i);
  });

  it('PIN 저장 없음(localStorage/sessionStorage 0건)·자동 polling 없음(setInterval 0건)', () => {
    expect(cardSrc + libSrc).not.toMatch(/localStorage|sessionStorage|setInterval/);
  });

  it('내부 API는 apiUrl 헬퍼만 사용 (origin root /api 규칙)', () => {
    expect(libSrc).toContain("from './apiUrl'");
    expect(libSrc).not.toMatch(/BASE_URL.?api|https?:\/\//);
  });

  it('readyForControlledCanary는 서버 값 그대로 표시 (클라이언트 파생 금지)', () => {
    expect(cardSrc).toContain('String(s.readyForControlledCanary)');
  });

  // 6G-3 §7 — prepare 단계 관측 항목
  it('prepare 단계·startup reconciliation·차단 사유·고지 라벨이 카드에 존재한다', () => {
    for (const label of [
      'Prepare 단계 (REQ/PREP/SUBM)', '가장 오래된 blocking task',
      'Prepare startup reconciliation', '신규 주문 차단 사유',
    ]) expect(cardSrc).toContain(label);
  });

  it('강제 완료·재제출·삭제 버튼 코드 0건 (조회 전용 계약)', () => {
    expect(cardSrc).not.toMatch(/강제 완료|재제출|force[- ]?complete|resubmit/i);
  });
});
