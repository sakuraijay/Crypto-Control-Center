/**
 * relayStatus 헬퍼 테스트 — 3단계 UI 계약.
 * 핵심: DRY_RUN_VALIDATED·TASK_ACCEPTED를 성공(ok)으로 표시하지 않는다.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  mapRelayModeToView, mapRelayTaskStatusToView, formatWeiToEth,
  fetchUnresolvedTasks, postUnresolvedRecheck,
} from '../relayStatus';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('mapRelayModeToView', () => {
  it('DRY_RUN은 경고 톤(성공 아님)', () => {
    expect(mapRelayModeToView('DRY_RUN').tone).toBe('warn');
  });
  it('DISABLED는 muted', () => {
    expect(mapRelayModeToView('DISABLED').tone).toBe('muted');
  });
  it('LIVE는 오류로 표시(이번 단계에서 존재 불가)', () => {
    const v = mapRelayModeToView('LIVE');
    expect(v.tone).toBe('error');
  });
});

describe('mapRelayTaskStatusToView — 성공 표시 계약', () => {
  it('CONFIRMED만 ok 톤', () => {
    const okStatuses = Object.entries({
      PREPARED: 0, DRY_RUN_VALIDATED: 0, SUBMITTING: 0, TASK_ACCEPTED: 0,
      TX_SUBMITTED: 0, ORDER_CREATED: 0, CONFIRMED: 1, CANCELLED: 0,
      FAILED_PRE_BROADCAST: 0, UNRESOLVED: 0,
    }).filter(([s]) => mapRelayTaskStatusToView(s).tone === 'ok').map(([s]) => s);
    expect(okStatuses).toEqual(['CONFIRMED']);
  });
  it('DRY_RUN_VALIDATED·TASK_ACCEPTED 라벨은 성공이 아님을 명시', () => {
    expect(mapRelayTaskStatusToView('DRY_RUN_VALIDATED').label).toContain('제출 아님');
    expect(mapRelayTaskStatusToView('TASK_ACCEPTED').label).toContain('성공 아님');
  });
  it('UNRESOLVED는 수동 확인 필요 표시', () => {
    expect(mapRelayTaskStatusToView('UNRESOLVED').label).toContain('수동');
  });
  it('알 수 없는 상태는 muted fall-through', () => {
    expect(mapRelayTaskStatusToView('WHATEVER').tone).toBe('muted');
  });
});

describe('formatWeiToEth', () => {
  it('wei → ETH 문자열', () => {
    expect(formatWeiToEth('1000000000000000000')).toBe('1.000000 ETH');
    expect(formatWeiToEth('78000000000000')).toBe('0.000078 ETH');
  });
  it('null·잘못된 값은 —', () => {
    expect(formatWeiToEth(null)).toBe('—');
    expect(formatWeiToEth('abc')).toBe('—');
  });
});

describe('UNRESOLVED investigation client', () => {
  it('UNRESOLVED와 stale SUBMITTING의 비민감 증거를 파싱한다', async () => {
    const task = {
      id: 'task-1', kind: 'OPEN', status: 'SUBMITTING', relayTaskId: null,
      txHash: null, orderKey: null, userNonce: '7', approvalNonce: '3',
      errorClass: 'AMBIGUOUS', resolutionBasis: 'task id 저장 실패',
      createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:01:00.000Z',
      transportGen: 'jsonrpc-gasless-0.0.10', ageMs: 120_000,
      staleSubmitting: true, links: { arbiscanTx: null }, blocking: true,
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { ok: true, tasks: [task] })));
    const result = await fetchUnresolvedTasks('123456');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.data[0]).toMatchObject(task);
  });

  it('목록 unavailable과 정상 empty를 구분하며 자동 재시도하지 않는다', async () => {
    const unavailableFetch = vi.fn(async () => jsonResponse(503, { ok: false }));
    vi.stubGlobal('fetch', unavailableFetch);
    const unavailable = await fetchUnresolvedTasks('123456');
    expect(unavailable.kind).toBe('UNVERIFIED');
    if (unavailable.kind !== 'ok') expect(unavailable.message).toContain('상태 미확인/유지');
    expect(unavailableFetch).toHaveBeenCalledTimes(1);

    const emptyFetch = vi.fn(async () => jsonResponse(200, { ok: true, tasks: [] }));
    vi.stubGlobal('fetch', emptyFetch);
    const empty = await fetchUnresolvedTasks('123456');
    expect(empty).toEqual({ kind: 'ok', data: [] });
    expect(emptyFetch).toHaveBeenCalledTimes(1);
  });

  it('recheck 인증 오류는 구분하고 네트워크 오류는 fail-closed다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { ok: false })));
    expect((await postUnresolvedRecheck({ pin: 'bad-pin', taskId: 'task-1' })).kind)
      .toBe('OPERATOR_AUTH_REQUIRED');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('rpc down'); }));
    const network = await postUnresolvedRecheck({ pin: '123456', taskId: 'task-1' });
    expect(network.kind).toBe('UNVERIFIED');
    if (network.kind !== 'ok') expect(network.message).toContain('상태 유지');
  });

  it('legacy transport와 증거 부족 결과는 rechecked=false로 유지한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      ok: true, rechecked: false,
      reason: 'legacy transport 세대 — 신형 endpoint 조회 금지',
      verdictBasis: 'UNRESOLVED_LEGACY_TRANSPORT',
      task: null,
    })));
    const result = await postUnresolvedRecheck({ pin: '123456', taskId: 'task-1' });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.data.rechecked).toBe(false);
      expect(result.data.reason).toContain('legacy transport');
    }
  });
});
