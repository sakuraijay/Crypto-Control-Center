/**
 * Production MOCK 금융 데이터 제거 검증 테스트
 *
 * 요구사항:
 *  1. futures-web은 모바일 mockData(MOCK_ACCOUNT/MOCK_POSITIONS/MOCK_TRADES/
 *     MOCK_LOGS/MOCK_WATCHLIST)를 어디에서도 import하지 않는다.
 *  2. 금융 수치에 Math.random 노이즈/드리프트가 없다.
 *  3. API/DB 실패 시 mock 대체값이 아닌 'Unavailable'을 표시한다 (dataStatus 패턴).
 *  4. 모드 배지는 서버 executor 상태(engineMode/liveExecutionLocked)를 근거로 한다.
 *  5. 초기 상태(DB 0건)는 빈 배열 — 임의 숫자 생성 없음.
 *
 * React 렌더링 없이 소스 코드 정적 분석으로 검증합니다 (기존 uiBadges 패턴).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir   = dirname(fileURLToPath(import.meta.url));
const srcDir  = join(__dir, '..');

function read(rel: string) {
  return readFileSync(join(srcDir, rel), 'utf-8');
}

/** src 전체 .ts/.tsx 파일 목록 (테스트 파일 제외) */
function allSourceFiles(dir = srcDir, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__') continue;
      allSourceFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const tradingSrc   = read('lib/context/TradingContext.tsx');
const watchlistSrc = read('lib/context/WatchlistContext.tsx');
const dashboardSrc = read('pages/dashboard.tsx');
const topBarSrc    = read('components/shell/TopBar.tsx');
const positionsSrc = read('pages/positions.tsx');

// ── 1. mockData import 완전 제거 ──────────────────────────────────────────────

describe('mockData import 제거', () => {
  it('futures-web 어떤 소스도 삭제된 mockData를 import하지 않는다', () => {
    for (const file of allSourceFiles()) {
      const src = readFileSync(file, 'utf-8');
      expect(src, `mockData import found in ${file}`).not.toMatch(/from\s+['"][^'"]*mockData['"]/);
      expect(src, `MOCK_ constant found in ${file}`).not.toMatch(/MOCK_(ACCOUNT|POSITIONS|TRADES|LOGS|WATCHLIST)/);
    }
  });
});

// ── 2. Math.random 금융 노이즈 제거 ───────────────────────────────────────────

describe('Math.random 금융 노이즈 제거', () => {
  it('TradingContext에 Math.random이 없다 (가격 노이즈/가짜 equity curve 금지)', () => {
    expect(tradingSrc).not.toContain('Math.random');
    expect(tradingSrc).not.toContain('generateInitialEquity');
  });

  it('WatchlistContext에 Math.random 점수 드리프트가 없다', () => {
    expect(watchlistSrc).not.toContain('Math.random');
  });

  it('금융 컨텍스트·페이지 어디에도 Math.random이 없다 (ui/ 스켈레톤 제외)', () => {
    for (const file of allSourceFiles()) {
      if (file.includes(`${join('components', 'ui')}`)) continue; // 장식용 skeleton 폭
      const src = readFileSync(file, 'utf-8');
      expect(src, `Math.random found in ${file}`).not.toContain('Math.random');
    }
  });
});

// ── 3. 실패 시 mock fallback 금지 — dataStatus/Unavailable 패턴 ───────────────

describe('API 실패 시 mock fallback 금지', () => {
  it('TradingContext가 dataStatus(loading|ok|error)를 노출한다', () => {
    expect(tradingSrc).toMatch(/dataStatus/);
    expect(tradingSrc).toMatch(/'loading'\s*\|\s*'ok'\s*\|\s*'error'/);
  });

  it('거래 로드 실패 시 error 상태로만 전환 (mock 배열 주입 없음)', () => {
    expect(tradingSrc).toMatch(/\.catch\(\(\)\s*=>\s*setTradesStatus\('error'\)\)/);
    expect(tradingSrc).toMatch(/\.catch\(\(\)\s*=>\s*setCapitalStatus\('error'\)\)/);
  });

  it('초기 상태는 전부 빈 배열이다 (positions/closedTrades/logs/equityHistory)', () => {
    expect(tradingSrc).toMatch(/useState<Position\[\]>\(\[\]\)/);
    expect(tradingSrc).toMatch(/useState<Trade\[\]>\(\[\]\)/);
    expect(tradingSrc).toMatch(/useState<StrategyLog\[\]>\(\[\]\)/);
    expect(tradingSrc).toMatch(/useState<EquityPoint\[\]>\(\[\]\)/);
  });

  it('tradingCapital은 서버 전략 설정에서만 온다 (하드코딩 잔고 금지)', () => {
    expect(tradingSrc).toContain("fetch('/api/data/strategy'");
    expect(tradingSrc).not.toMatch(/balance:\s*10[_,]?000/);
  });

  it('placeOrder는 실시간 가격 없으면 실패한다 (FALLBACK_PRICES/고정 100 금지)', () => {
    expect(tradingSrc).not.toContain('FALLBACK_PRICES');
    expect(tradingSrc).not.toMatch(/\?\?\s*100\b/);
    expect(tradingSrc).toContain('Market price unavailable');
  });

  it('dashboard는 dataStatus가 ok가 아니면 Unavailable을 표시한다', () => {
    expect(dashboardSrc).toContain('dataStatus');
    expect(dashboardSrc).toContain("'Unavailable'");
  });
});

// ── 4. 라벨: MOCK 제거, Paper Equity, 서버 기준 모드 배지 ─────────────────────

describe('라벨 및 모드 배지', () => {
  it("dashboard에 'MOCK' 라벨이 없고 'Paper Equity' 라벨이 있다", () => {
    expect(dashboardSrc).not.toMatch(/MOCK/);
    expect(dashboardSrc).toContain('Paper Equity');
  });

  it('positions 페이지에 MOCK 배지가 없다 (PAPER로 대체)', () => {
    expect(positionsSrc).not.toMatch(/>MOCK</);
    expect(positionsSrc).toMatch(/>PAPER</);
  });

  it('TopBar 배지는 서버 executor 상태를 폴링한다 (설정값 단독 근거 금지)', () => {
    expect(topBarSrc).toContain("fetch('/api/executor/status'");
    expect(topBarSrc).toContain('engineMode');
    expect(topBarSrc).toContain('liveExecutionLocked');
    expect(topBarSrc).not.toContain('useAiEngine');
  });

  it('TopBar는 PAPER / LIVE LOCKED / MODE UNKNOWN 상태를 렌더링한다', () => {
    expect(topBarSrc).toContain('LIVE LOCKED');
    expect(topBarSrc).toContain('MODE UNKNOWN');
    expect(topBarSrc).toMatch(/>[\s]*PAPER[\s]*</);
  });
});

// ── 5. localStorage 과거 mock 수치 무시 ───────────────────────────────────────

describe('localStorage 과거 mock 무시', () => {
  it('WatchlistContext는 심볼 목록만 복원하고 수치 캐시는 제거한다', () => {
    expect(watchlistSrc).toContain("localStorage.removeItem(LS_WATCHLIST)");
    expect(watchlistSrc).not.toMatch(/JSON\.parse\(raw\)\s+as\s+WatchlistSymbol\[\]/);
  });

  it('watchlist 초기 행은 전부 0으로 시작한다', () => {
    expect(watchlistSrc).toMatch(/price:\s*0,\s*change24h:\s*0/);
    expect(watchlistSrc).toMatch(/score1h:\s*0,\s*score4h:\s*0,\s*score1d:\s*0,\s*combinedScore:\s*0/);
  });
});
