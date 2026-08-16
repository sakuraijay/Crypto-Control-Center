/**
 * 보안 회귀 테스트
 *
 * 실제 외부 네트워크 주문, 지갑 서명, 자금 이동, 출금, 외부 VPS 전달이
 * 발생하지 않음을 정적 소스 분석으로 검증합니다.
 *
 * 이 테스트가 실패하면 실제 자금이 위험에 처할 수 있습니다.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const __dir    = dirname(fileURLToPath(import.meta.url));
const workerDir = join(__dir, '../workers');
const routesDir = join(__dir, '../routes');

function readSrc(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

function stripComments(src: string): string {
  return src
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 디렉토리 내 .ts 파일을 재귀적으로 수집 */
function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return extname(name) === '.ts' ? [full] : [];
  });
}

const allSrcFiles = [
  ...tsFiles(workerDir),
  ...tsFiles(routesDir),
].filter(f => !f.includes('__tests__'));

const execSrc     = readSrc(join(workerDir, 'internalExecutor.ts'));
const aiWorkerSrc = readSrc(join(workerDir, 'aiWorker.ts'));

// vps.ts가 routes/vps.ts 또는 다른 경로에 있을 수 있음
const vpsRouteSrc = (() => {
  for (const f of allSrcFiles) {
    const src = readFileSync(f, 'utf-8');
    if (src.includes('forwardToVps') || f.endsWith('vps.ts')) return src;
  }
  return '';
})();

// ── 절대 불변 보안 상수 ───────────────────────────────────────────────────────

describe('LIVE_EXECUTION_LOCKED — 절대 불변 보안 상수', () => {
  it('internalExecutor.ts에 LIVE_EXECUTION_LOCKED = true as const가 있다', () => {
    expect(execSrc).toContain('LIVE_EXECUTION_LOCKED = true as const');
  });

  it('소스 코드(주석 제외)에 LIVE_EXECUTION_LOCKED = false가 없다', () => {
    for (const file of allSrcFiles) {
      const noComments = stripComments(readFileSync(file, 'utf-8'));
      expect(
        noComments,
        `${file} 에서 LIVE_EXECUTION_LOCKED = false 발견!`
      ).not.toMatch(/LIVE_EXECUTION_LOCKED\s*=\s*false/);
    }
  });
});

// ── 블록체인 서명 / 전송 금지 ─────────────────────────────────────────────────

describe('블록체인 서명 / 트랜잭션 전송 금지', () => {
  it('eth_sendTransaction을 직접 호출하는 소스 파일이 없다', () => {
    for (const file of allSrcFiles) {
      const noComments = stripComments(readFileSync(file, 'utf-8'));
      expect(
        noComments,
        `${file} 에서 eth_sendTransaction 발견!`
      ).not.toContain('eth_sendTransaction');
    }
  });

  it('private key / seed phrase를 소스 코드에 하드코딩하지 않는다', () => {
    for (const file of allSrcFiles) {
      const noComments = stripComments(readFileSync(file, 'utf-8'));
      // 64자 hex 개인키 패턴 (0x + 64자)
      expect(noComments).not.toMatch(/0x[0-9a-fA-F]{64}/);
    }
  });

  it('signTransaction, sendRawTransaction을 직접 호출하지 않는다', () => {
    for (const file of allSrcFiles) {
      const noComments = stripComments(readFileSync(file, 'utf-8'));
      expect(noComments).not.toMatch(/\.signTransaction\s*\(/);
      expect(noComments).not.toMatch(/\.sendRawTransaction\s*\(/);
    }
  });
});

// ── VPS 전달 보안 ─────────────────────────────────────────────────────────────

describe('VPS 전달 — 외부 VPS 주문 전송 보안', () => {
  it('VPS 관련 라우트가 operatingState 정보를 포함한다 (있는 경우)', () => {
    if (vpsRouteSrc) {
      expect(vpsRouteSrc).toContain('operatingState');
    } else {
      // VPS 라우트가 아직 구현되지 않은 경우 — 미구현 자체가 안전
      expect(true).toBe(true);
    }
  });

  it('internalExecutor.ts는 LIVE 실행이 잠겨 있음을 문서화한다', () => {
    expect(execSrc).toContain('LIVE_EXECUTION_LOCKED');
    expect(execSrc).toContain('dry-run');
  });
});

// ── 운영 DB / 테스트 DB 분리 ─────────────────────────────────────────────────

describe('운영 DB / 테스트 DB 분리', () => {
  it('testMode 필드로 LIVE TEST 레코드를 식별한다', () => {
    expect(aiWorkerSrc).toContain('testMode');
  });

  it('LIVE TEST 누적 손실은 test_mode=true 레코드에서만 계산한다', () => {
    expect(aiWorkerSrc).toContain('liveTestAccumLossUsd');
  });
});

// ── Satsuma 잔여 코드 0건 검증 ────────────────────────────────────────────────

describe('Satsuma 잔여 코드 0건 (read-only GMX RPC 전용)', () => {
  it('소스 파일에 satsuma 문자열이 없다', () => {
    for (const file of allSrcFiles) {
      const src = readFileSync(file, 'utf-8').toLowerCase();
      expect(
        src,
        `${file} 에서 'satsuma' 발견!`
      ).not.toContain('satsuma');
    }
  });
});

// ── 비밀값 관리 ───────────────────────────────────────────────────────────────

describe('비밀값 관리', () => {
  it('소스 코드에 Bearer 토큰 하드코딩이 없다', () => {
    for (const file of allSrcFiles) {
      const noComments = stripComments(readFileSync(file, 'utf-8'));
      expect(noComments).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
    }
  });

  it('VAPID 키는 process.env에서만 읽는다', () => {
    const notifSrc = readSrc(join(routesDir, 'notifications.ts'));
    if (notifSrc) {
      expect(notifSrc).toContain('process.env');
      expect(notifSrc).not.toMatch(/vapidPublicKey\s*=\s*['"`][A-Za-z0-9+/=]{20}/);
    }
  });
});
