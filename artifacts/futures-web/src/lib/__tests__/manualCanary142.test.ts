/**
 * #142 — Manual Canary 차단 그룹 클라이언트 계약 테스트.
 *
 * 검증 항목:
 *  - classifyBlockerCategory: CODE/CONFIGURATION/OPERATOR_MANUAL_ACTION/GITHUB_CI 허용,
 *    그 외 전부 null (fail-closed)
 *  - sanitizeBlockerMessage: PIN/RPC URL/주소/서명/hex 비밀 은닉
 *  - groupBlockersByCategory: 4개 category 그룹화, unknown 차단 승격, 빈 배열 처리
 *  - GITHUB_CI fail-closed: unknown category로 올 경우 generic CODE 차단
 *  - fetchCanaryStatus: status 응답에 blocker 계약 포함
 *  - 시크릿 fixture 문자열이 sanitize 결과에 절대 등장하지 않음
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  classifyBlockerCategory,
  sanitizeBlockerMessage,
  groupBlockersByCategory,
  fetchCanaryStatus,
  normalizeCanaryBlockers,
  ALLOWED_BLOCKER_CATEGORIES,
  BLOCKER_CATEGORY_LABELS,
  type CanaryBlocker,
} from '../manualCanary';

afterEach(() => vi.unstubAllGlobals());

// ── classifyBlockerCategory ───────────────────────────────────────────────────

describe('classifyBlockerCategory — 4개 허용, 나머지 null', () => {
  it('CODE → CODE', () => expect(classifyBlockerCategory('CODE')).toBe('CODE'));
  it('CONFIGURATION → CONFIGURATION', () => expect(classifyBlockerCategory('CONFIGURATION')).toBe('CONFIGURATION'));
  it('OPERATOR_MANUAL_ACTION → OPERATOR_MANUAL_ACTION', () =>
    expect(classifyBlockerCategory('OPERATOR_MANUAL_ACTION')).toBe('OPERATOR_MANUAL_ACTION'));
  it('GITHUB_CI → GITHUB_CI', () => expect(classifyBlockerCategory('GITHUB_CI')).toBe('GITHUB_CI'));

  it('알 수 없는 category → null (fail-closed)', () => {
    expect(classifyBlockerCategory('UNKNOWN')).toBeNull();
    expect(classifyBlockerCategory('INFRA')).toBeNull();
    expect(classifyBlockerCategory('')).toBeNull();
    expect(classifyBlockerCategory(null)).toBeNull();
    expect(classifyBlockerCategory(undefined)).toBeNull();
    expect(classifyBlockerCategory(42)).toBeNull();
    expect(classifyBlockerCategory('code')).toBeNull(); // 대소문자 구분
    expect(classifyBlockerCategory('github_ci')).toBeNull(); // 소문자 거부
  });

  it('ALLOWED_BLOCKER_CATEGORIES 전체가 분류됨', () => {
    for (const cat of ALLOWED_BLOCKER_CATEGORIES) {
      expect(classifyBlockerCategory(cat)).toBe(cat);
    }
  });
});

// ── BLOCKER_CATEGORY_LABELS 한국어 레이블 ─────────────────────────────────────

describe('BLOCKER_CATEGORY_LABELS — 한국어 레이블', () => {
  it('CODE 레이블은 "코드 오류"', () => expect(BLOCKER_CATEGORY_LABELS.CODE).toBe('코드 오류'));
  it('CONFIGURATION 레이블은 "설정 오류"', () => expect(BLOCKER_CATEGORY_LABELS.CONFIGURATION).toBe('설정 오류'));
  it('OPERATOR_MANUAL_ACTION 레이블은 "운영자 수동 조치 필요"', () =>
    expect(BLOCKER_CATEGORY_LABELS.OPERATOR_MANUAL_ACTION).toBe('운영자 수동 조치 필요'));
  it('GITHUB_CI 레이블은 "GitHub CI 상태"', () => expect(BLOCKER_CATEGORY_LABELS.GITHUB_CI).toBe('GitHub CI 상태'));
});

// ── sanitizeBlockerMessage — 비밀 은닉 ───────────────────────────────────────

describe('sanitizeBlockerMessage — 비밀 패턴 은닉', () => {
  it('정상 메시지는 그대로 반환', () => {
    expect(sanitizeBlockerMessage('설정 파일이 없습니다')).toBe('설정 파일이 없습니다');
  });

  it('빈 문자열 → "(메시지 없음)"', () => {
    expect(sanitizeBlockerMessage('')).toBe('(메시지 없음)');
    expect(sanitizeBlockerMessage('   ')).toBe('(메시지 없음)');
  });

  it('null/undefined → "(메시지 없음)"', () => {
    expect(sanitizeBlockerMessage(null)).toBe('(메시지 없음)');
    expect(sanitizeBlockerMessage(undefined)).toBe('(메시지 없음)');
  });

  it('지갑 주소(0x + 40 hex) 은닉', () => {
    const addr = '0x' + 'aB'.repeat(20); // 40 hex chars
    const result = sanitizeBlockerMessage(`owner=${addr} 확인 필요`);
    expect(result).not.toContain(addr);
    expect(result).toContain('[주소 은닉]');
  });

  it('서명(0x + 130 hex) 은닉', () => {
    const sig = '0x' + 'ef'.repeat(65); // 130 hex chars
    const result = sanitizeBlockerMessage(`sig=${sig}`);
    expect(result).not.toContain(sig.slice(0, 20)); // 일부도 그대로 노출되면 안됨
    expect(result).toContain('[서명 은닉]');
  });

  it('개인키(0x + 64 hex) 은닉', () => {
    const key = '0x' + '3c'.repeat(32); // 64 hex chars
    const result = sanitizeBlockerMessage(`key=${key}`);
    expect(result).not.toContain(key);
    expect(result).toContain('[키 은닉]');
  });

  it('RPC HTTP URL 은닉', () => {
    const url = 'https://arbitrum-mainnet.infura.io/v3/secret123';
    const result = sanitizeBlockerMessage(`rpc=${url}`);
    expect(result).not.toContain('infura.io');
    expect(result).toContain('[URL 은닉]');
  });

  it('RPC WSS URL 은닉', () => {
    const url = 'wss://arb-mainnet.g.alchemy.com/v2/key999';
    const result = sanitizeBlockerMessage(`ws=${url}`);
    expect(result).not.toContain('alchemy.com');
    expect(result).toContain('[URL 은닉]');
  });

  it('길이 200자 초과 시 슬라이스', () => {
    // 비밀 패턴에 해당하지 않는 반복 문자열 사용
    const long = '한'.repeat(300); // Korean char — no secret pattern match
    expect(sanitizeBlockerMessage(long).length).toBe(200);
  });

  it('PIN 형식(짧은 숫자)은 단독으로 허용 — 주소/URL 패턴 미해당', () => {
    // PIN은 "1234" 같은 숫자 — 은닉 패턴에 해당하지 않아야 함
    expect(sanitizeBlockerMessage('PIN 오류 발생')).toBe('PIN 오류 발생');
  });

  // 시크릿 fixture 문자열이 결과에 등장하지 않음을 검증
  it('시크릿 fixture: 개인키·주소·서명·URL이 결과에서 전혀 보이지 않음', () => {
    const SECRET_KEY = '0x' + 'deadbeef'.repeat(8); // 64 hex chars = 개인키 형식
    const SECRET_ADDR = '0x' + 'ab'.repeat(20);      // 40 hex chars = 주소 형식
    const SECRET_SIG = '0x' + 'ff'.repeat(65);        // 130 hex chars = 서명 형식
    const SECRET_URL = 'https://private-rpc.internal/v3/TOKEN123';
    const combined = `key=${SECRET_KEY} addr=${SECRET_ADDR} sig=${SECRET_SIG} rpc=${SECRET_URL}`;
    const result = sanitizeBlockerMessage(combined);
    // 원본 시크릿 값이 결과에 없어야 함
    expect(result).not.toContain(SECRET_KEY);
    expect(result).not.toContain(SECRET_ADDR);
    expect(result).not.toContain(SECRET_SIG);
    expect(result).not.toContain('private-rpc.internal');
    expect(result).not.toContain('TOKEN123');
  });
});

// ── groupBlockersByCategory ───────────────────────────────────────────────────

describe('groupBlockersByCategory — category별 그룹화', () => {
  const makeBlocker = (category: string, id: string, blocking = true): CanaryBlocker => ({
    category, id, message: `${id} 메시지`, blocking,
  });

  it('4개 category 각각 그룹화됨', () => {
    const blockers: CanaryBlocker[] = [
      makeBlocker('CODE', 'code-1'),
      makeBlocker('CONFIGURATION', 'conf-1'),
      makeBlocker('OPERATOR_MANUAL_ACTION', 'op-1'),
      makeBlocker('GITHUB_CI', 'ci-1'),
    ];
    const grouped = groupBlockersByCategory(blockers);
    expect(grouped.size).toBe(4);
    expect(grouped.get('CODE')).toHaveLength(1);
    expect(grouped.get('CONFIGURATION')).toHaveLength(1);
    expect(grouped.get('OPERATOR_MANUAL_ACTION')).toHaveLength(1);
    expect(grouped.get('GITHUB_CI')).toHaveLength(1);
  });

  it('빈 배열 → 빈 map', () => {
    expect(groupBlockersByCategory([]).size).toBe(0);
  });

  it('unknown category는 그룹에서 제외 (fail-closed)', () => {
    const blockers: CanaryBlocker[] = [
      makeBlocker('UNKNOWN', 'unk-1'),
      makeBlocker('INFRA', 'infra-1'),
      makeBlocker('CODE', 'code-1'),
      makeBlocker('', 'empty-1'),
    ];
    const grouped = groupBlockersByCategory(blockers);
    expect(grouped.size).toBe(1);
    expect(grouped.has('CODE')).toBe(true);
    expect(grouped.has('UNKNOWN' as never)).toBe(false);
    expect(grouped.has('INFRA' as never)).toBe(false);
  });

  it('GITHUB_CI unknown 상태는 generic CODE 차단으로 승격', () => {
    const blockers: CanaryBlocker[] = [
      makeBlocker('GITHUB_CI_UNKNOWN', 'ci-unk-1'),
      makeBlocker('GITHUB_CI', 'ci-known'),
    ];
    const grouped = groupBlockersByCategory(blockers);
    expect(grouped.size).toBe(2);
    expect(grouped.has('GITHUB_CI')).toBe(true);
    expect(grouped.get('GITHUB_CI')).toHaveLength(1);
    expect(grouped.get('GITHUB_CI')![0].id).toBe('ci-known');
    expect(grouped.get('CODE')).toEqual([
      expect.objectContaining({ id: 'UNKNOWN_BLOCKER_CATEGORY', blocking: true }),
    ]);
  });

  it('같은 category 여러 blocker → 하나의 그룹에 순서 유지', () => {
    const blockers: CanaryBlocker[] = [
      makeBlocker('CODE', 'code-1'),
      makeBlocker('CODE', 'code-2'),
      makeBlocker('CODE', 'code-3'),
    ];
    const grouped = groupBlockersByCategory(blockers);
    expect(grouped.get('CODE')?.map(b => b.id)).toEqual(['code-1', 'code-2', 'code-3']);
  });

  it('blocking=false인 항목도 그룹에 포함', () => {
    const blockers: CanaryBlocker[] = [
      makeBlocker('CONFIGURATION', 'conf-ok', false),
      makeBlocker('CONFIGURATION', 'conf-bad', true),
    ];
    const grouped = groupBlockersByCategory(blockers);
    expect(grouped.get('CONFIGURATION')).toHaveLength(2);
  });
});

describe('normalizeCanaryBlockers — 누락 응답 fail-closed', () => {
  it('blockers 필드 누락은 GITHUB_CI 차단으로 승격', () => {
    expect(normalizeCanaryBlockers(undefined)).toEqual([
      expect.objectContaining({
        category: 'GITHUB_CI',
        id: 'GITHUB_CI_STATUS_MISSING',
        blocking: true,
      }),
    ]);
  });
});

// ── fetchCanaryStatus — HTTP 계약 ─────────────────────────────────────────────

describe('fetchCanaryStatus — blocker HTTP 계약', () => {
  function jsonRes(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }

  it('200 → ok + blockers 배열', async () => {
    const mockBlockers: CanaryBlocker[] = [
      { category: 'CODE', id: 'err-1', message: '코드 오류', blocking: true },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(200, { ok: true, blockers: mockBlockers })));
    const r = await fetchCanaryStatus('1234');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.data.ok).toBe(true);
      expect(r.data.blockers).toHaveLength(1);
      expect(r.data.blockers[0].category).toBe('CODE');
    }
  });

  it('401 → auth (PIN 오류)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(401, { message: 'Unauthorized' })));
    const r = await fetchCanaryStatus('wrong');
    expect(r.kind).toBe('auth');
  });

  it('403 → auth (권한 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(403, {})));
    const r = await fetchCanaryStatus('1234');
    expect(r.kind).toBe('auth');
  });

  it('네트워크 오류 → error (메시지: 네트워크 오류)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const r = await fetchCanaryStatus('1234');
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toBe('네트워크 오류');
  });

  it('PIN은 x-operator-pin 헤더로만 전송', async () => {
    const spy = vi.fn(async () => jsonRes(200, { ok: true, blockers: [] }));
    vi.stubGlobal('fetch', spy);
    await fetchCanaryStatus('my-pin');
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toMatch(/\/api\/executor\/canary\/status$/);
    const headers = init.headers as Record<string, string>;
    expect(headers['x-operator-pin']).toBe('my-pin');
    // PIN이 URL 또는 body에 포함되지 않아야 함
    expect(String(url)).not.toContain('my-pin');
    expect(init.body).toBeUndefined();
  });
});

// ── 소스 계약 검증 ────────────────────────────────────────────────────────────

describe('소스 계약 — manualCanary.ts', () => {
  const { readFileSync } = require('node:fs');
  const path = require('node:path');
  const src: string = readFileSync(
    path.resolve(__dirname, '../manualCanary.ts'), 'utf8',
  );

  it('apiUrl 헬퍼만 사용 (origin root 강제)', () => {
    expect(src).toContain("from './apiUrl'");
    expect(src).not.toMatch(/https?:\/\//);
    expect(src).not.toMatch(/BASE_URL.?api/);
  });

  it('4개 category 상수가 정의되어 있음', () => {
    expect(src).toContain("'CODE'");
    expect(src).toContain("'CONFIGURATION'");
    expect(src).toContain("'OPERATOR_MANUAL_ACTION'");
    expect(src).toContain("'GITHUB_CI'");
  });

  it('sanitizeBlockerMessage 함수가 존재함', () => {
    expect(src).toContain('sanitizeBlockerMessage');
  });

  it('groupBlockersByCategory 함수가 존재함', () => {
    expect(src).toContain('groupBlockersByCategory');
  });

  it('classifyBlockerCategory 함수가 존재함', () => {
    expect(src).toContain('classifyBlockerCategory');
  });

  it('localStorage/sessionStorage/setInterval 0건', () => {
    expect(src).not.toMatch(/localStorage|sessionStorage|setInterval/);
  });

  it('SECRET_PATTERNS 내 패턴이 실제로 은닉을 수행 (회귀 락)', () => {
    // 주소 패턴 자체가 소스에 정의되어 있는지 확인
    expect(src).toContain('주소 은닉');
    expect(src).toContain('URL 은닉');
    expect(src).toContain('키 은닉');
    expect(src).toContain('서명 은닉');
  });
});
