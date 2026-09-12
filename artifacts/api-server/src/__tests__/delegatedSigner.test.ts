/**
 * delegatedSigner.ts 단위 테스트
 *
 * DB I/O 없이 키 생성·암호화·복원 로직을 검증한다.
 * @workspace/db는 mock으로 차단.
 */

import { describe, expect, it, vi, beforeAll } from 'vitest';

// ── @workspace/db 모킹 ────────────────────────────────────────────────────────
const mockOnConflictDoUpdate = vi.fn().mockResolvedValue([]);
const mockValues             = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
const mockWhere              = vi.fn().mockResolvedValue([]); // 빈 결과 = 키 없음
const mockFrom               = vi.fn().mockReturnValue({ where: mockWhere });

vi.mock('@workspace/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({ from: mockFrom }),
    insert: vi.fn().mockReturnValue({ values: mockValues }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
  },
  workerStateTable: { key: 'key', value: 'value', updatedAt: 'updatedAt' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col, val) => `eq(${String(val)})`),
}));

// ── SESSION_SECRET / DELEGATED_SIGNER_ENABLED 설정 ───────────────────────────
beforeAll(() => {
  process.env.SESSION_SECRET = 'test-session-secret-for-delegated-signer-init-test-abc';
  process.env.DELEGATED_SIGNER_ENABLED = 'true';
  // 6단계 §4 — signer 저장소 접근 게이트 통과용 (테스트 fixture 전용)
  process.env.GMX_RELAY_READONLY_NETWORK_ENABLED = 'true';
  process.env.GMX_RELAY_NETWORK_ENABLED = 'true';
  process.env.GMX_RELAY_SUBMISSION_ENABLED = 'true';
  process.env.GMX_RELAY_MODE = 'LIVE';
  process.env.WORKER_ENGINE_MODE = 'LIVE';
  process.env.LIVE_TEST_EXECUTION_LOCKED = 'false';
});

// ── 테스트 ──────────────────────────────────────────────────────────────────

describe('delegatedSigner — initializeDelegatedSigner', () => {
  it('SESSION_SECRET 있으면 새 주소를 생성하고 0x... 형식으로 반환한다', async () => {
    const { initializeDelegatedSigner, getSignerAddress } = await import('../lib/delegatedSigner');
    await initializeDelegatedSigner();
    const addr = getSignerAddress();
    expect(addr).not.toBeNull();
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
  }, 30_000);

  it('두 번 호출해도 주소가 동일하다 (idempotent)', async () => {
    const { initializeDelegatedSigner, getSignerAddress } = await import('../lib/delegatedSigner');
    await initializeDelegatedSigner();
    const addr1 = getSignerAddress();
    await initializeDelegatedSigner();
    const addr2 = getSignerAddress();
    expect(addr1).toBe(addr2);
  });

  it('초기화 후 isSignerInitialized()=true', async () => {
    const { initializeDelegatedSigner, isSignerInitialized } = await import('../lib/delegatedSigner');
    await initializeDelegatedSigner();
    expect(isSignerInitialized()).toBe(true);
  });
});

describe('delegatedSigner — getSignerWalletClient', () => {
  it('초기화 후 WalletClient를 반환한다 (not null, not throws)', async () => {
    const { initializeDelegatedSigner, getSignerWalletClient } = await import('../lib/delegatedSigner');
    await initializeDelegatedSigner();
    let client: unknown;
    expect(() => { client = getSignerWalletClient('https://arb1.arbitrum.io/rpc'); }).not.toThrow();
    expect(client).not.toBeNull();
    expect(client).toBeDefined();
  });
});

describe('delegatedSigner — getSignerEthBalance', () => {
  it('초기화 후 { ethWei, ethFormatted, readyForGas } 구조를 반환한다', async () => {
    const { initializeDelegatedSigner, getSignerEthBalance } = await import('../lib/delegatedSigner');
    await initializeDelegatedSigner();
    // RPC 오류를 삼켜서 0 ETH 반환 (fallback)
    const balance = await getSignerEthBalance('invalid-rpc-url');
    expect(balance).toHaveProperty('ethWei');
    expect(balance).toHaveProperty('ethFormatted');
    expect(balance).toHaveProperty('readyForGas');
    expect(typeof balance.ethWei).toBe('bigint');
  });
});

describe('delegatedSigner — validateSignerIntegrity', () => {
  it('초기화 후 validateSignerIntegrity()=true', async () => {
    const { initializeDelegatedSigner, validateSignerIntegrity } = await import('../lib/delegatedSigner');
    await initializeDelegatedSigner();
    expect(validateSignerIntegrity()).toBe(true);
  });
});

describe('delegatedSigner — 부분 손상 signer 레코드', () => {
  it('메타만 존재하고 키 레코드가 없으면 corrupt — 신규 생성/overwrite 금지', async () => {
    const mod = await import('../lib/delegatedSigner');
    mod.__resetDelegatedSignerForTests();
    // 1번째 select = 키 레코드(없음), 2번째 select = 메타 레코드(존재)
    mockWhere
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ key: 'delegatedSignerMeta', value: '{"createdAt":"2026-01-01T00:00:00.000Z"}' }]);
    mockValues.mockClear();
    await expect(mod.initializeDelegatedSigner()).rejects.toThrow(/손상/);
    expect(mod.isSignerInitialized()).toBe(false);
    expect(mockValues).not.toHaveBeenCalled(); // DB overwrite 없음
    mockWhere.mockResolvedValue([]); // 기본 동작 복구
  });
});

describe('delegatedSigner — SESSION_SECRET 검증', () => {
  it('SESSION_SECRET 없으면 initializeDelegatedSigner가 오류를 던진다 (키 생성 없음)', async () => {
    const saved = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    try {
      const mod = await import('../lib/delegatedSigner');
      mod.__resetDelegatedSignerForTests();
      await expect(mod.initializeDelegatedSigner()).rejects.toThrow(/SESSION_SECRET/);
      expect(mod.isSignerInitialized()).toBe(false);
    } finally {
      process.env.SESSION_SECRET = saved;
    }
  });

  it('SESSION_SECRET이 최소 길이(32자) 미만이면 오류 (값 비노출)', async () => {
    const saved = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'short-secret';
    try {
      const mod = await import('../lib/delegatedSigner');
      mod.__resetDelegatedSignerForTests();
      await expect(mod.initializeDelegatedSigner()).rejects.toThrow(/최소 안전 길이/);
      // 오류 메시지에 secret 값 자체가 포함되지 않아야 함
      await mod.initializeDelegatedSigner().catch((e: Error) => {
        expect(e.message).not.toContain('short-secret');
      });
      expect(mod.isSignerInitialized()).toBe(false);
    } finally {
      process.env.SESSION_SECRET = saved;
    }
  });
});

describe('delegatedSigner — DELEGATED_SIGNER_ENABLED 게이트', () => {
  it("미설정이면 isDelegatedSignerEnabled()=false (기본값 비활성)", async () => {
    const saved = process.env.DELEGATED_SIGNER_ENABLED;
    delete process.env.DELEGATED_SIGNER_ENABLED;
    try {
      const { isDelegatedSignerEnabled } = await import('../lib/delegatedSigner');
      expect(isDelegatedSignerEnabled()).toBe(false);
    } finally {
      process.env.DELEGATED_SIGNER_ENABLED = saved;
    }
  });

  it("'TRUE', '1', 'yes' 등 정확히 'true'가 아닌 값은 전부 비활성", async () => {
    const saved = process.env.DELEGATED_SIGNER_ENABLED;
    const { isDelegatedSignerEnabled } = await import('../lib/delegatedSigner');
    try {
      for (const v of ['TRUE', 'True', '1', 'yes', ' true', 'true ', '']) {
        process.env.DELEGATED_SIGNER_ENABLED = v;
        expect(isDelegatedSignerEnabled()).toBe(false);
      }
      process.env.DELEGATED_SIGNER_ENABLED = 'true';
      expect(isDelegatedSignerEnabled()).toBe(true);
    } finally {
      process.env.DELEGATED_SIGNER_ENABLED = saved;
    }
  });

  it('비활성 상태에서 initializeDelegatedSigner는 DB 접근·키 생성 없이 no-op', async () => {
    const saved = process.env.DELEGATED_SIGNER_ENABLED;
    delete process.env.DELEGATED_SIGNER_ENABLED;
    try {
      const mod = await import('../lib/delegatedSigner');
      mod.__resetDelegatedSignerForTests();
      mockWhere.mockClear();
      mockValues.mockClear();
      await expect(mod.initializeDelegatedSigner()).resolves.toBeUndefined();
      expect(mod.isSignerInitialized()).toBe(false);
      expect(mod.getSignerAddress()).toBeNull();
      expect(mockWhere).not.toHaveBeenCalled();   // DB 읽기 없음
      expect(mockValues).not.toHaveBeenCalled();  // DB 쓰기 없음
    } finally {
      process.env.DELEGATED_SIGNER_ENABLED = saved;
    }
  });
});
