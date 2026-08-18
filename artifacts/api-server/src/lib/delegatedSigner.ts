/**
 * Delegated Signer — Server-managed EOA for GMX V2 SubaccountRouter
 *
 * 보안 정책 (명확한 분리):
 *   - 메인 지갑(MetaMask)의 Private Key·Seed Phrase는 어떤 경우에도
 *     요청·저장·출력하지 않는다 (절대 금지).
 *   - 제한된 delegated signer(서버 생성 EOA)는 사용자가
 *     DELEGATED_SIGNER_ENABLED=true 로 명시적으로 활성화한 경우에만 생성되며,
 *     AES-256-GCM + scrypt(SESSION_SECRET)로 암호화 후 DB에 저장된다.
 *   - 최초 PAPER Publish에서는 DELEGATED_SIGNER_ENABLED 미설정(=비활성)이어야 한다.
 *
 * Fail-closed 규칙:
 *   - 신규 키 생성은 "DB 조회 성공 + 기존 signer가 확실히 없음"일 때만 허용
 *   - DB 조회 실패 / 복호화 실패 / 메타데이터 손상 → 신규 생성·overwrite 금지,
 *     signer는 초기화되지 않은 상태로 유지
 *   - SESSION_SECRET 변경으로 복호화가 실패해도 새 signer로 자동 교체하지 않음
 *   - 개인키·암호문·SESSION_SECRET은 로그와 API에 절대 출력하지 않음
 */

import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'node:crypto';
import { createWalletClient, createPublicClient, http, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import { db, workerStateTable } from '@workspace/db';
import { eq } from 'drizzle-orm';

// ── worker_state 키 ────────────────────────────────────────────────────────────
const SIGNER_KEY_STATE_KEY = 'delegatedSignerEncryptedKey';
const SIGNER_META_KEY      = 'delegatedSignerMeta';
/** #125 — 프로비저닝 시점에 파생된 공개 주소를 평문으로 별도 저장 (공개 정보).
 *  이후 조회는 이 행만 읽으며 암호문 조회·복호화·키 객체 생성이 0회다. */
const SIGNER_PUBLIC_ADDRESS_KEY = 'delegatedSignerPublicAddress';

// ── AES-256-GCM 상수 ──────────────────────────────────────────────────────────
const KEY_LEN   = 32; // 256-bit
const IV_LEN    = 16;
const TAG_LEN   = 16;
const SCRYPT_N  = 16384;
const SCRYPT_R  = 8;
const SCRYPT_P  = 1;
const SALT_LEN  = 32;

// ── 인메모리 캐시 (재시작 전까지 유지) ───────────────────────────────────────
let _privateKeyHex: string | null = null;
let _signerAddress: string | null = null;
let _createdAt: string | null     = null;
let _initialized                  = false;

/** 테스트 전용 — 모듈 인메모리 상태 초기화 */
export function __resetDelegatedSignerForTests(): void {
  _privateKeyHex = null;
  _signerAddress = null;
  _createdAt     = null;
  _initialized   = false;
}

// ── 명시적 활성화 게이트 ──────────────────────────────────────────────────────

/**
 * DELEGATED_SIGNER_ENABLED가 정확히 문자열 'true'일 때만 활성.
 * 미설정, 빈 값, 그 외 모든 값은 false (기본값 false, fail-closed).
 */
export function isDelegatedSignerEnabled(): boolean {
  return process.env.DELEGATED_SIGNER_ENABLED === 'true';
}

/**
 * 6단계 §4 — signer 저장소 접근(DB 조회·암호문 조회·복호화·개인키 생성) 허용 조건.
 * 아래 전부가 정확히 충족될 때만 true. read-only 네트워크만 켠 상태(canonical
 * 조회 목적)에서는 signer 저장소 접근이 구조적으로 0회가 되도록 보장한다.
 * (signer 초기화 여부·중앙 activation 게이트는 서명 시점에 별도로 검증된다 —
 * relaySignerBinding·relayActivationGate.)
 */
export function isSignerStorageAccessAllowed(env: NodeJS.ProcessEnv = process.env): {
  allowed: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  if (env.GMX_RELAY_READONLY_NETWORK_ENABLED !== 'true') missing.push("GMX_RELAY_READONLY_NETWORK_ENABLED !== 'true'");
  if (env.GMX_RELAY_NETWORK_ENABLED !== 'true') missing.push("GMX_RELAY_NETWORK_ENABLED !== 'true'");
  if (env.GMX_RELAY_SUBMISSION_ENABLED !== 'true') missing.push("GMX_RELAY_SUBMISSION_ENABLED !== 'true'");
  if (env.GMX_RELAY_MODE !== 'LIVE') missing.push("GMX_RELAY_MODE !== 'LIVE'");
  if (env.DELEGATED_SIGNER_ENABLED !== 'true') missing.push("DELEGATED_SIGNER_ENABLED !== 'true'");
  if (env.WORKER_ENGINE_MODE !== 'LIVE') missing.push('PAPER 모드 (WORKER_ENGINE_MODE ≠ LIVE)');
  if (env.LIVE_TEST_EXECUTION_LOCKED !== 'false') missing.push('LIVE 잠금 활성 (LIVE_TEST_EXECUTION_LOCKED ≠ false)');
  return { allowed: missing.length === 0, missing };
}

// ── 암호화 헬퍼 ───────────────────────────────────────────────────────────────

/** SESSION_SECRET 최소 안전 길이 (문자). 값 자체는 절대 로그 출력하지 않음. */
const MIN_SESSION_SECRET_LENGTH = 32;

function getSessionSecret(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('[DelegatedSigner] SESSION_SECRET 환경변수가 설정되지 않았습니다');
  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `[DelegatedSigner] SESSION_SECRET이 최소 안전 길이(${MIN_SESSION_SECRET_LENGTH}자) 미만입니다`,
    );
  }
  return Buffer.from(secret, 'utf8');
}

/**
 * 범용 민감 hex 데이터 암호화 (owner approval signature 등 capability 저장용).
 * SESSION_SECRET 기반 scrypt + AES-256-GCM. Format: salt(32)|iv(16)|tag(16)|ciphertext — hex.
 * 평문·암호문 모두 로그·API에 노출 금지.
 */
export function encryptSensitiveHex(plainHex: string): string {
  return encryptPrivateKey(plainHex.startsWith('0x') ? plainHex.slice(2) : plainHex);
}

/** encryptSensitiveHex 역연산 — 0x 접두사 붙여 반환 */
export function decryptSensitiveHex(encoded: string): string {
  return `0x${decryptPrivateKey(encoded)}`;
}

function encryptPrivateKey(privateKeyHex: string): string {
  const secret = getSessionSecret();
  const salt   = randomBytes(SALT_LEN);
  const iv     = randomBytes(IV_LEN);
  const key    = scryptSync(secret, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });

  const cipher  = createCipheriv('aes-256-gcm', key, iv);
  const payload = Buffer.from(privateKeyHex, 'hex');
  const enc     = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag     = cipher.getAuthTag();

  // Format: salt(32) | iv(16) | tag(16) | ciphertext(32) — all hex
  return Buffer.concat([salt, iv, tag, enc]).toString('hex');
}

function decryptPrivateKey(encoded: string): string {
  const secret = getSessionSecret();
  const buf    = Buffer.from(encoded, 'hex');

  const salt   = buf.subarray(0, SALT_LEN);
  const iv     = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag    = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const cipher = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN);

  const key    = scryptSync(secret, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(cipher), decipher.final()]);
  return decrypted.toString('hex');
}

// ── DB 읽기/쓰기 헬퍼 ──────────────────────────────────────────────────────────

/**
 * DB 조회 결과를 명시적으로 구분한다 (fail-closed의 핵심).
 *  - found:    조회 성공 + 기존 encrypted signer 존재
 *  - absent:   조회 성공 + 기존 signer 확실히 없음 (신규 생성이 허용되는 유일한 상태)
 *  - db_error: 조회 실패 (신규 생성 절대 금지)
 *  - corrupt:  signer 메타데이터 손상 (신규 생성·overwrite 금지)
 */
type SignerLoadResult =
  | { status: 'found'; encryptedKey: string; createdAt: string }
  | { status: 'absent' }
  | { status: 'db_error' }
  | { status: 'corrupt' };

async function loadFromDb(): Promise<SignerLoadResult> {
  let rows: { value: string }[];
  let metaRows: { value: string }[];
  try {
    rows = await db
      .select()
      .from(workerStateTable)
      .where(eq(workerStateTable.key, SIGNER_KEY_STATE_KEY));
    metaRows = await db
      .select()
      .from(workerStateTable)
      .where(eq(workerStateTable.key, SIGNER_META_KEY));
  } catch {
    // DB 오류를 '없음'으로 오인하면 기존 signer를 덮어쓸 수 있으므로 명시적으로 구분
    return { status: 'db_error' };
  }

  // 'absent'는 키·메타 두 레코드가 모두 없을 때만.
  // 메타만 남은 부분 손상 상태에서 신규 생성하면 기존 기록을 덮어쓰게 되므로 corrupt 처리.
  if (!rows.length) {
    return metaRows.length ? { status: 'corrupt' } : { status: 'absent' };
  }
  if (rows.length > 1 || metaRows.length > 1) return { status: 'corrupt' };

  const encryptedKey = rows[0].value;
  if (typeof encryptedKey !== 'string' || encryptedKey.length === 0) {
    return { status: 'corrupt' };
  }

  let createdAt = new Date().toISOString();
  if (metaRows.length) {
    try {
      const meta = JSON.parse(metaRows[0].value) as { createdAt?: string };
      if (meta && typeof meta.createdAt === 'string') createdAt = meta.createdAt;
    } catch {
      return { status: 'corrupt' };
    }
  }
  return { status: 'found', encryptedKey, createdAt };
}

async function saveToDb(encryptedKey: string, createdAt: string): Promise<void> {
  const now = new Date();
  await db
    .insert(workerStateTable)
    .values({ key: SIGNER_KEY_STATE_KEY, value: encryptedKey, updatedAt: now })
    .onConflictDoUpdate({
      target: workerStateTable.key,
      set: { value: encryptedKey, updatedAt: now },
    });
  await db
    .insert(workerStateTable)
    .values({ key: SIGNER_META_KEY, value: JSON.stringify({ createdAt }), updatedAt: now })
    .onConflictDoUpdate({
      target: workerStateTable.key,
      set: { value: JSON.stringify({ createdAt }), updatedAt: now },
    });
}

// ── 운영자 프로비저닝 (Canary P0 — 활성화 데드락 해소) ─────────────────────────

/**
 * signer 프로비저닝(명시적 1회 키 생성/조회) 허용 조건 — 최소권한 별도 경로.
 *
 * 데드락 배경: isSignerStorageAccessAllowed(6단계 §4)는 relay 제출·LIVE mode·
 * WORKER_ENGINE_MODE=LIVE·잠금 해제까지 요구하므로, Owner Approval에 필요한
 * signer 공개주소를 그 전에 확보할 수 없다. 이 게이트는 **정반대로 잠금 상태를
 * 요구**한다 — 제출·서명이 구조적으로 불가능한 상태에서만 키 생성/조회를 허용.
 *
 * 주의: 이 게이트는 프로비저닝(DB 키 생성/조회) 전용이다. 런타임 서명 경로
 * (signDigestWithDelegatedSigner)와 startup 초기화의 강한 게이트
 * (isSignerStorageAccessAllowed)는 그대로 유지되며 절대 완화하지 않는다.
 */
export function isSignerProvisioningAllowed(env: NodeJS.ProcessEnv = process.env): {
  allowed: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  if (env.GMX_API_READONLY_ENABLED !== 'true') missing.push("GMX_API_READONLY_ENABLED !== 'true'");
  if (env.DELEGATED_SIGNER_ENABLED !== 'true') missing.push("DELEGATED_SIGNER_ENABLED !== 'true'");
  if (env.WORKER_ENGINE_MODE === 'LIVE') missing.push('WORKER_ENGINE_MODE=LIVE — PAPER 모드에서만 프로비저닝 허용');
  if (env.LIVE_TEST_EXECUTION_LOCKED !== 'true') missing.push("LIVE_TEST_EXECUTION_LOCKED !== 'true' — 잠금 상태에서만 프로비저닝 허용");
  if (env.GMX_API_ORDER_SUBMISSION_ENABLED === 'true') missing.push('GMX_API_ORDER_SUBMISSION_ENABLED=true — 제출 활성 상태에서 프로비저닝 금지');
  if (env.GMX_RELAY_NETWORK_ENABLED === 'true') missing.push('GMX_RELAY_NETWORK_ENABLED=true — relay 제출 네트워크 활성 상태에서 프로비저닝 금지');
  if (env.GMX_RELAY_SUBMISSION_ENABLED === 'true') missing.push('GMX_RELAY_SUBMISSION_ENABLED=true — relay 제출 활성 상태에서 프로비저닝 금지');
  if (env.GMX_RELAY_MODE === 'LIVE') missing.push('GMX_RELAY_MODE=LIVE — LIVE mode에서 프로비저닝 금지');
  return { allowed: missing.length === 0, missing };
}

export type SignerProvisionResult = {
  created: boolean;
  /** 공개주소만 — 개인키·암호문은 어떤 경로로도 반환하지 않는다 */
  address: string;
  createdAt: string;
};

/** 프로비저닝 저장 — insert-if-absent (onConflictDoNothing). 동시 요청이 와도
 *  DB 단일 PK(worker_state.key)가 승자를 하나로 고정한다. */
async function saveToDbIfAbsent(encryptedKey: string, createdAt: string): Promise<void> {
  const now = new Date();
  try {
    await db
      .insert(workerStateTable)
      .values({ key: SIGNER_KEY_STATE_KEY, value: encryptedKey, updatedAt: now })
      .onConflictDoNothing();
    await db
      .insert(workerStateTable)
      .values({ key: SIGNER_META_KEY, value: JSON.stringify({ createdAt }), updatedAt: now })
      .onConflictDoNothing();
  } catch {
    // DB 원문 오류 메시지(연결 문자열 등) 노출 금지 — 고정 문구로 대체
    throw new Error('[DelegatedSigner] provisioning 저장 실패 (fail-closed)');
  }
}

/**
 * 운영자 명시적 프로비저닝 — LIVE 잠금을 풀지 않고 signer를 1회 생성/조회한다.
 *
 * 계약:
 *  - idempotent: 기존 signer가 있으면 새 키를 만들지 않고 동일 공개주소만 반환
 *  - 신규 생성은 loadFromDb()='absent'일 때만, 기존 SESSION_SECRET AES-256-GCM
 *    암호화 저장 계약(encryptPrivateKey/saveToDbIfAbsent) 사용
 *  - 동시성: insert onConflictDoNothing 후 재조회 — DB 승자의 키만 유효
 *  - 모듈 런타임 상태(_initialized/_privateKeyHex)는 절대 변경하지 않는다 →
 *    서명·prepare/submit·Owner Approval·nonce/task/intent·자금 이동 0회 유지
 *  - 개인키·암호문·SESSION_SECRET은 반환·로그 출력 금지 (공개주소만)
 */
export async function provisionDelegatedSigner(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SignerProvisionResult> {
  const gate = isSignerProvisioningAllowed(env);
  if (!gate.allowed) {
    throw new Error(`[DelegatedSigner] 프로비저닝 차단 (fail-closed): ${gate.missing.join(', ')}`);
  }

  // SESSION_SECRET 존재·최소 길이 사전 검증 (값은 출력하지 않음)
  getSessionSecret();

  const deriveAddress = (encryptedKey: string): string => {
    let plainHex: string;
    try {
      plainHex = decryptPrivateKey(encryptedKey);
    } catch {
      throw new Error('[DelegatedSigner] 기존 signer 복호화 실패 — 신규 생성·overwrite 금지 (fail-closed)');
    }
    // 요청 로컬 범위에서만 사용 — 모듈 상태에 저장하지 않는다
    return privateKeyToAccount(`0x${plainHex}` as `0x${string}`).address;
  };

  const loaded = await loadFromDb();
  switch (loaded.status) {
    case 'db_error':
      throw new Error('[DelegatedSigner] DB 조회 실패 — 기존 signer 존재 여부 불명, 신규 생성 금지 (fail-closed)');
    case 'corrupt':
      throw new Error('[DelegatedSigner] signer 데이터 손상 감지 — 신규 생성·overwrite 금지 (fail-closed)');
    case 'found': {
      const address = deriveAddress(loaded.encryptedKey);
      await savePublicAddressIfConsistent(address); // #125 — 공개 주소 backfill (write-once)
      return { created: false, address, createdAt: loaded.createdAt };
    }
    case 'absent': {
      const rawKey    = randomBytes(32);
      const plainHex  = rawKey.toString('hex');
      const createdAt = new Date().toISOString();
      const encrypted = encryptPrivateKey(plainHex);
      await saveToDbIfAbsent(encrypted, createdAt);

      // 재조회로 DB 승자를 확정 — 동시 요청 시에도 키는 정확히 1개
      const winner = await loadFromDb();
      if (winner.status !== 'found') {
        throw new Error('[DelegatedSigner] provisioning 검증 실패 — 저장 후 재조회 불일치 (fail-closed)');
      }
      const created = winner.encryptedKey === encrypted; // salt 랜덤 → 동일성 비교로 승자 판별
      const address = deriveAddress(winner.encryptedKey);
      await savePublicAddressIfConsistent(address); // #125 — 공개 주소 영속 (write-once)
      return { created, address, createdAt: winner.createdAt };
    }
  }
}

// ── #125 — 공개 signer 주소 안전 경로 (복호화 0회) ────────────────────────────

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * 프로비저닝이 파생한 공개 주소를 write-once로 영속한다.
 *  - insert onConflictDoNothing → 재조회 검증 (기존 저장값과 불일치 = fail-closed, overwrite 금지)
 *  - 공개 주소는 비밀이 아니다 — 평문 저장이 보안 계약을 약화시키지 않는다.
 */
async function savePublicAddressIfConsistent(address: string): Promise<void> {
  try {
    await db
      .insert(workerStateTable)
      .values({ key: SIGNER_PUBLIC_ADDRESS_KEY, value: address, updatedAt: new Date() })
      .onConflictDoNothing();
    const rows = await db
      .select()
      .from(workerStateTable)
      .where(eq(workerStateTable.key, SIGNER_PUBLIC_ADDRESS_KEY));
    if (rows.length !== 1 || String(rows[0].value).toLowerCase() !== address.toLowerCase()) {
      throw new Error('[DelegatedSigner] 공개 주소 영속 검증 실패 — 저장값과 파생 주소 불일치 (fail-closed)');
    }
  } catch (e: unknown) {
    if (e instanceof Error && e.message.startsWith('[DelegatedSigner]')) throw e;
    // DB 원문 오류 메시지(연결 문자열 등) 노출 금지 — 고정 문구로 대체
    throw new Error('[DelegatedSigner] 공개 주소 저장 실패 (fail-closed)');
  }
}

export type StoredPublicSignerAddressResult =
  | { ok: true; address: string }
  | { ok: false; reason: string };

/**
 * #125 — 저장된 공개 signer 주소를 검증해 반환하는 최소권한 경로.
 *
 * 보장 (adversarial 테스트로 고정):
 *  - 개인키·암호문 복호화 0회, 서명 객체(privateKeyToAccount/WalletClient) 생성 0회
 *  - nonce 할당·relay task·execution intent 생성 0회, 외부 네트워크 호출 0회
 *  - 모듈 런타임 상태(_initialized/_privateKeyHex/_signerAddress) 불변
 *  - 암호문 행은 존재 여부만 확인 (value는 사용하지 않는다)
 *
 * Fail-closed:
 *  - DELEGATED_SIGNER_ENABLED !== 'true' / DB 오류 / 행 없음·중복 / 형식 손상 /
 *    암호화 키 행 부재(고아 주소) / expectedAddress 불일치 → { ok: false }
 */
export async function getStoredPublicSignerAddress(
  expectedAddress: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredPublicSignerAddressResult> {
  if (env.DELEGATED_SIGNER_ENABLED !== 'true') {
    return { ok: false, reason: "DELEGATED_SIGNER_ENABLED !== 'true' — 공개 주소 조회 차단 (fail-closed)" };
  }
  if (!EVM_ADDRESS_RE.test(expectedAddress)) {
    return { ok: false, reason: '예상 주소 형식 오류 — 공개 주소 조회 차단 (fail-closed)' };
  }
  let addrRows: { value: string }[];
  let keyRows: { value: string }[];
  try {
    addrRows = await db
      .select()
      .from(workerStateTable)
      .where(eq(workerStateTable.key, SIGNER_PUBLIC_ADDRESS_KEY));
    keyRows = await db
      .select()
      .from(workerStateTable)
      .where(eq(workerStateTable.key, SIGNER_KEY_STATE_KEY));
  } catch {
    return { ok: false, reason: 'DB 조회 실패 — 공개 주소 확인 불가 (fail-closed)' };
  }
  if (addrRows.length === 0) {
    return { ok: false, reason: '저장된 공개 signer 주소 없음 — 프로비저닝(POST /executor/signer/provision) 1회 실행 필요' };
  }
  if (addrRows.length > 1) {
    return { ok: false, reason: '공개 주소 행 중복 감지 — 조회 차단 (fail-closed)' };
  }
  const stored = addrRows[0]?.value;
  if (typeof stored !== 'string' || !EVM_ADDRESS_RE.test(stored)) {
    return { ok: false, reason: '저장된 공개 주소 손상 — 조회 차단 (fail-closed)' };
  }
  // 고아 주소 방지: 암호화 키 행이 정확히 1개 존재해야 한다 (value는 검사하지 않음 — 복호화 0회)
  if (keyRows.length !== 1) {
    return { ok: false, reason: '암호화 signer 키 행 부재/중복 — 공개 주소 고아 상태 (fail-closed)' };
  }
  if (stored.toLowerCase() !== expectedAddress.toLowerCase()) {
    return { ok: false, reason: '저장된 공개 주소가 예상 canary signer와 불일치 — 차단 (fail-closed)' };
  }
  return { ok: true, address: stored };
}

// ── 공개 API ──────────────────────────────────────────────────────────────────

/**
 * 서버 시작 시 한 번 호출. Fail-closed 규칙:
 *  - DELEGATED_SIGNER_ENABLED !== 'true' → 아무것도 하지 않음 (DB 접근·키 생성 없음)
 *  - SESSION_SECRET 미설정/길이 미달 → 오류 (키 생성 없음)
 *  - DB 조회 실패 → 오류, 신규 생성 금지
 *  - 복호화 실패(SESSION_SECRET 변경 포함) → 오류, 신규 생성·overwrite 금지
 *  - 메타데이터 손상 → 오류, 신규 생성·overwrite 금지
 *  - 신규 생성은 "DB 조회 성공 + 기존 signer 확실히 없음"일 때만
 * 개인키·암호문·SESSION_SECRET은 절대 로그 출력하지 않음.
 */
export async function initializeDelegatedSigner(): Promise<void> {
  if (!isDelegatedSignerEnabled()) {
    // 비활성 상태: 초기화·키 생성·DB 읽기/쓰기 전부 금지. 상태만 기록.
    console.info('[DelegatedSigner] disabled — DELEGATED_SIGNER_ENABLED가 true가 아님 (기본값)');
    return;
  }
  // 6단계 §4 — 저장소 접근 게이트 (내부 최종 방어): read-only 네트워크만 켠
  // 상태 등에서는 DB 조회·암호문 조회·복호화·키 생성이 전부 0회여야 한다.
  const storage = isSignerStorageAccessAllowed();
  if (!storage.allowed) {
    console.info(`[DelegatedSigner] signer 저장소 접근 차단 (fail-closed): ${storage.missing.join(', ')}`);
    return;
  }
  if (_initialized) return;

  // SESSION_SECRET 존재·최소 길이 사전 검증 (값은 출력하지 않음)
  getSessionSecret();

  const loaded = await loadFromDb();

  switch (loaded.status) {
    case 'db_error':
      throw new Error('[DelegatedSigner] DB 조회 실패 — 기존 signer 존재 여부 불명, 신규 생성 금지 (fail-closed)');

    case 'corrupt':
      throw new Error('[DelegatedSigner] signer 데이터 손상 감지 — 신규 생성·overwrite 금지 (fail-closed)');

    case 'found': {
      let privateKeyHex: string;
      try {
        privateKeyHex = decryptPrivateKey(loaded.encryptedKey);
      } catch {
        // SESSION_SECRET 변경 등으로 복호화 실패 — 새 signer로 자동 교체하지 않음
        throw new Error('[DelegatedSigner] 기존 signer 복호화 실패 — 신규 생성·overwrite 금지 (fail-closed)');
      }
      _privateKeyHex  = privateKeyHex;
      const account   = privateKeyToAccount(`0x${_privateKeyHex}` as `0x${string}`);
      _signerAddress  = account.address;
      _createdAt      = loaded.createdAt;
      _initialized    = true;
      console.info(`[DelegatedSigner] DB에서 복원 — address=${_signerAddress} createdAt=${_createdAt}`);
      return;
    }

    case 'absent': {
      // 신규 생성이 허용되는 유일한 경로
      const rawKey   = randomBytes(32);
      _privateKeyHex = rawKey.toString('hex');
      const account  = privateKeyToAccount(`0x${_privateKeyHex}` as `0x${string}`);
      _signerAddress = account.address;
      _createdAt     = new Date().toISOString();

      const encrypted = encryptPrivateKey(_privateKeyHex);
      await saveToDb(encrypted, _createdAt);

      _initialized = true;
      console.info(`[DelegatedSigner] 신규 생성 — address=${_signerAddress}`);
      // 개인키는 절대 로그에 출력하지 않음
      return;
    }
  }
}

/** 공개 주소 반환. initializeDelegatedSigner() 이전에 호출하면 null. */
export function getSignerAddress(): string | null {
  return _signerAddress;
}

/** 초기화 완료 여부 */
export function isSignerInitialized(): boolean {
  return _initialized && _signerAddress !== null;
}

/** 생성 시각 */
export function getSignerCreatedAt(): string | null {
  return _createdAt;
}

/** viem WalletClient — 서명에 사용. 개인키 직접 반환 절대 금지. */
export function getSignerWalletClient(rpcUrl: string) {
  if (!_privateKeyHex) throw new Error('[DelegatedSigner] 초기화되지 않음. initializeDelegatedSigner() 먼저 호출 필요');
  const account = privateKeyToAccount(`0x${_privateKeyHex}` as `0x${string}`);
  return createWalletClient({
    account,
    chain: arbitrum,
    transport: http(rpcUrl, { timeout: 15_000 }),
  });
}

/** 서버 서명 지갑의 ETH 잔고 (for gas) */
export async function getSignerEthBalance(rpcUrl: string): Promise<{ ethWei: bigint; ethFormatted: string; readyForGas: boolean }> {
  if (!_signerAddress) return { ethWei: 0n, ethFormatted: '0', readyForGas: false };
  try {
    const client = createPublicClient({ chain: arbitrum, transport: http(rpcUrl, { timeout: 5_000 }) });
    const bal    = await client.getBalance({ address: _signerAddress as `0x${string}` });
    const MIN_GAS_ETH = 5_000_000_000_000_000n; // 0.005 ETH minimum
    return {
      ethWei:      bal,
      ethFormatted: formatEther(bal),
      readyForGas: bal >= MIN_GAS_ETH,
    };
  } catch {
    return { ethWei: 0n, ethFormatted: '0', readyForGas: false };
  }
}

/**
 * digest 로컬 서명 (5단계 §3) — RPC 없음, 개인키는 이 함수 스코프 밖으로
 * 절대 나가지 않는다. 게이트: enabled + initialized일 때만.
 * 프로덕션에서는 활성화 게이트가 먼저 차단하므로 실제 서명은 테스트
 * fixture 키로만 수행된다.
 */
export async function signDigestWithDelegatedSigner(digest: `0x${string}`): Promise<`0x${string}`> {
  if (!isDelegatedSignerEnabled()) throw new Error('[DelegatedSigner] disabled — 서명 금지');
  {
    // 6단계 §4 — 서명도 저장소 접근과 동일한 env 게이트를 통과해야 한다
    const storage = isSignerStorageAccessAllowed();
    if (!storage.allowed) throw new Error(`[DelegatedSigner] 서명 차단 (fail-closed): ${storage.missing.join(', ')}`);
  }
  if (!_initialized || !_privateKeyHex) throw new Error('[DelegatedSigner] 미초기화 — 서명 금지');
  if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) throw new Error('[DelegatedSigner] digest 형식 오류');
  // 요청 로컬 범위: account 객체는 이 스코프에서만 생성·사용
  const account = privateKeyToAccount(`0x${_privateKeyHex}` as `0x${string}`);
  return account.sign({ hash: digest });
}

/**
 * 내부 검증: 개인키가 주어진 주소와 일치하는지 확인.
 * 보안 검사 전용 — 개인키 자체는 절대 외부 반환하지 않음.
 */
export function validateSignerIntegrity(): boolean {
  if (!_privateKeyHex || !_signerAddress) return false;
  try {
    const account = privateKeyToAccount(`0x${_privateKeyHex}` as `0x${string}`);
    const addrA   = Buffer.from(_signerAddress.toLowerCase().replace('0x', ''), 'hex');
    const addrB   = Buffer.from(account.address.toLowerCase().replace('0x', ''), 'hex');
    return addrA.length === addrB.length && timingSafeEqual(addrA, addrB);
  } catch {
    return false;
  }
}
