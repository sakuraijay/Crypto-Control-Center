/**
 * Delegated Signer — Server-managed EOA for GMX V2 SubaccountRouter
 *
 * 보안 원칙:
 *   - 개인키는 AES-256-GCM + scrypt(SESSION_SECRET)로 암호화 후 DB 저장
 *   - 공개 주소만 외부 노출 (개인키·암호화키 절대 미노출)
 *   - 재시작 시 DB에서 복원 (동일 주소 유지)
 *   - 메인 지갑(MetaMask)의 Seed Phrase·Private Key 절대 요청/저장 금지
 *
 * 사용 전제:
 *   - SESSION_SECRET 환경변수 필수 (Replit Secrets에 설정)
 *   - DATABASE_URL 환경변수 필수
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

// ── 암호화 헬퍼 ───────────────────────────────────────────────────────────────

function getSessionSecret(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('[DelegatedSigner] SESSION_SECRET 환경변수가 설정되지 않았습니다');
  return Buffer.from(secret, 'utf8');
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

async function loadFromDb(): Promise<{ encryptedKey: string; createdAt: string } | null> {
  try {
    const rows = await db
      .select()
      .from(workerStateTable)
      .where(eq(workerStateTable.key, SIGNER_KEY_STATE_KEY));
    const metaRows = await db
      .select()
      .from(workerStateTable)
      .where(eq(workerStateTable.key, SIGNER_META_KEY));

    if (!rows.length) return null;
    const meta = metaRows.length ? JSON.parse(metaRows[0].value) as { createdAt: string } : null;
    return { encryptedKey: rows[0].value, createdAt: meta?.createdAt ?? new Date().toISOString() };
  } catch {
    return null;
  }
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

// ── 공개 API ──────────────────────────────────────────────────────────────────

/**
 * 서버 시작 시 한 번 호출.
 * DB에서 기존 키 복원 또는 신규 생성 후 DB 저장.
 * 개인키는 절대 로그 출력하지 않음.
 */
export async function initializeDelegatedSigner(): Promise<void> {
  if (_initialized) return;

  const existing = await loadFromDb();
  if (existing) {
    _privateKeyHex  = decryptPrivateKey(existing.encryptedKey);
    const account   = privateKeyToAccount(`0x${_privateKeyHex}` as `0x${string}`);
    _signerAddress  = account.address;
    _createdAt      = existing.createdAt;
    _initialized    = true;
    console.info(`[DelegatedSigner] DB에서 복원 — address=${_signerAddress} createdAt=${_createdAt}`);
    return;
  }

  // 신규 생성
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
