/**
 * Execution Intent 온체인 Reconciliation — 명확한 온체인 증거로만 차단 해소.
 *
 * 판정 규칙 (fail-closed):
 *  - PREPARED + txHash 없음        → UNRESOLVED 유지 (자동 FAILED 금지, 영구 차단)
 *  - receipt 없음/pending          → 상태 변경 없음 (SUBMITTED/UNRESOLVED 유지)
 *  - receipt reverted              → FAILED terminal + 증거(block) 저장
 *  - receipt success, key 추출 실패 → UNRESOLVED 유지 (근거만 기록)
 *  - order created만 확인          → 차단 유지 (key·생성 block 영속화)
 *  - OrderExecuted 확인            → CONFIRMED terminal + 이벤트 tx/block 증거
 *  - OrderCancelled 확인           → CANCELLED terminal + 취소 증거 (FAILED와 구분)
 *  - OrderFrozen / RPC 오류 / 파싱 실패 / chainId 불일치 → 차단 유지, 자동 해제 금지
 *
 * 동시성: 모든 terminal 전환은 조건부 UPDATE(차단 상태에서만)라 중복 전환 불가,
 * terminal → blocking 역행 불가 (executionIntents.resolveIntentTerminal).
 *
 * PAPER 무영향: 차단 intent가 0건이면 RPC 클라이언트 생성·조회가 전혀 발생하지 않는다.
 */

import { createPublicClient, http } from 'viem';
import { arbitrum } from 'viem/chains';
import {
  listBlockingIntents,
  resolveIntentTerminal,
  updateIntentEvidence,
  type TerminalIntentStatus,
} from './executionIntents';
import {
  ARBITRUM_ONE_CHAIN_ID,
  EVENT_LOG_2_TOPIC0,
  ORDER_EVENT_NAME_HASH,
  extractOrderKeyFromReceiptLogs,
  classifyOrderResolutionLogs,
  resolveGmxEventEmitterAddress,
  isValidEvmAddress,
  type RawLog,
} from './gmxOrderEvents';

// RPC 오류 로그 새니타이즈 — db-free 모듈로 분리 (기존 import 경로 호환을 위해 re-export)
export { sanitizeRpcError } from './rpcErrorSanitize';
import { sanitizeRpcError } from './rpcErrorSanitize';

// ── 온체인 클라이언트 추상화 (테스트에서 mock 주입) ────────────────────────────

export interface ReceiptResult {
  status:      'success' | 'reverted';
  blockNumber: string;          // 문자열로 정규화
  logs:        RawLog[];
}

export interface OnchainClient {
  getChainId(): Promise<number>;
  /** receipt 미존재/pending → null. RPC 오류는 throw. */
  getTransactionReceipt(txHash: string): Promise<ReceiptResult | null>;
  /** EventEmitter(허용 주소 집합)에서 orderKey에 대한 실행/취소/동결 이벤트 로그 조회 */
  getOrderResolutionLogs(orderKey: string, fromBlock: string | null, emitters: string[]): Promise<RawLog[]>;
}

/** 실제 RPC 클라이언트 — GMX_RPC_URL 필수 (없으면 throw → 차단 유지) */
export function createViemOnchainClient(): OnchainClient {
  const url = process.env.GMX_RPC_URL?.trim();
  if (!url) throw new Error('[IntentReconciler] GMX_RPC_URL 미설정 — 온체인 판정 불가 (차단 유지)');
  const client = createPublicClient({ chain: arbitrum, transport: http(url, { timeout: 8_000 }) });
  return {
    getChainId: () => client.getChainId(),
    async getTransactionReceipt(txHash) {
      try {
        const r = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
        return {
          status:      r.status === 'success' ? 'success' : 'reverted',
          blockNumber: String(r.blockNumber),
          logs:        r.logs.map(l => ({
            address:         l.address,
            topics:          [...l.topics],
            transactionHash: l.transactionHash,
            blockNumber:     l.blockNumber,
          })),
        };
      } catch (e: unknown) {
        // viem: receipt 미존재 시 TransactionReceiptNotFoundError
        const name = (e as { name?: string })?.name ?? '';
        if (name === 'TransactionReceiptNotFoundError') return null;
        throw e;
      }
    },
    async getOrderResolutionLogs(orderKey, fromBlock, emitters) {
      const params: Record<string, unknown> = {
        address:   emitters, // 현재 설정 emitter ∪ intent에 영속된 과거 매칭 emitter
        fromBlock: fromBlock ? `0x${BigInt(fromBlock).toString(16)}` : 'earliest',
        toBlock:   'latest',
        topics: [
          EVENT_LOG_2_TOPIC0, // 공식 EventLog2 signature — 좁은 필터 (위조 topic0 차단)
          [
            ORDER_EVENT_NAME_HASH.OrderExecuted,
            ORDER_EVENT_NAME_HASH.OrderCancelled,
            ORDER_EVENT_NAME_HASH.OrderFrozen,
          ],
          orderKey,
        ],
      };
      const raw = await client.request({
        method: 'eth_getLogs',
        params: [params],
      } as never) as Array<{ address: string; topics: string[]; transactionHash?: string; blockNumber?: string }>;
      return (raw ?? []).map(l => ({
        address:         l.address,
        topics:          l.topics,
        transactionHash: l.transactionHash ?? null,
        blockNumber:     l.blockNumber ? String(BigInt(l.blockNumber)) : null,
      }));
    },
  };
}

// ── Reconciliation 본체 ────────────────────────────────────────────────────────

export interface IntentResolution {
  intentId: string;
  txHash:   string | null;
  status:   TerminalIntentStatus;
  reason:   string;
}

export interface OnchainReconcileSummary {
  ok:            boolean;   // 전 과정에서 치명 오류 없음 (개별 intent 실패는 stillBlocking에 반영)
  checked:       number;
  resolutions:   IntentResolution[];  // terminal 전환 성공 목록 (감사로그 동기화용)
  stillBlocking: number;
}

/**
 * 차단 intent들을 온체인 증거로 판정. RPC/조회 오류는 개별 intent 차단 유지로
 * 흡수되며 절대 throw하지 않는다 (Worker 중단 방지).
 */
export async function reconcileBlockingIntentsOnchain(
  clientFactory: () => OnchainClient = createViemOnchainClient,
): Promise<OnchainReconcileSummary> {
  const blocking = await listBlockingIntents();
  if (blocking === null) return { ok: false, checked: 0, resolutions: [], stillBlocking: -1 };
  if (blocking.length === 0) return { ok: true, checked: 0, resolutions: [], stillBlocking: 0 };
  // 여기서부터만 RPC 사용 — PAPER 모드(차단 intent 없음)에서는 도달하지 않음

  let client: OnchainClient;
  try {
    client = clientFactory();
  } catch (e) {
    console.error(`[IntentReconciler] RPC 클라이언트 생성 실패 — 전원 차단 유지: ${sanitizeRpcError(e)}`);
    return { ok: false, checked: blocking.length, resolutions: [], stillBlocking: blocking.length };
  }

  // EventEmitter 주소 설정 검증 — 없거나 형식 오류면 어떤 판정도 하지 않는다 (fail-closed)
  const emitterCfg = resolveGmxEventEmitterAddress();
  if (!emitterCfg.ok) {
    console.error(`[IntentReconciler] EventEmitter 설정 오류 — 판정 중단, 차단 유지: ${emitterCfg.reason}`);
    return { ok: false, checked: blocking.length, resolutions: [], stillBlocking: blocking.length };
  }
  const configuredEmitter = emitterCfg.address;

  // chainId 검증 — Arbitrum One이 아니면 어떤 판정도 하지 않는다 (fail-closed)
  try {
    const chainId = await client.getChainId();
    if (chainId !== ARBITRUM_ONE_CHAIN_ID) {
      console.error(`[IntentReconciler] chainId 불일치 (${chainId} ≠ ${ARBITRUM_ONE_CHAIN_ID}) — 판정 중단, 차단 유지`);
      return { ok: false, checked: blocking.length, resolutions: [], stillBlocking: blocking.length };
    }
  } catch (e) {
    console.error(`[IntentReconciler] chainId 조회 실패 — 차단 유지: ${sanitizeRpcError(e)}`);
    return { ok: false, checked: blocking.length, resolutions: [], stillBlocking: blocking.length };
  }

  const resolutions: IntentResolution[] = [];
  let stillBlocking = 0;

  for (const intent of blocking) {
    try {
      const resolved = await reconcileSingleIntent(client, intent, configuredEmitter);
      if (resolved) resolutions.push(resolved);
      else stillBlocking++;
    } catch (e) {
      // 개별 intent의 RPC/파싱 오류 → 해당 intent 차단 유지, 루프는 계속
      console.error(`[IntentReconciler] intent 판정 오류 (id=${intent.id}) — 차단 유지: ${sanitizeRpcError(e)}`);
      stillBlocking++;
    }
  }

  if (resolutions.length > 0) {
    console.info(`[IntentReconciler] ${resolutions.length}개 intent 온체인 판정 완료, ${stillBlocking}개 차단 유지`);
  }
  return { ok: true, checked: blocking.length, resolutions, stillBlocking };
}

type IntentRow = NonNullable<Awaited<ReturnType<typeof listBlockingIntents>>>[number];

/** 단일 intent 판정. terminal 전환 성공 시 resolution 반환, 그 외 null(차단 유지). */
async function reconcileSingleIntent(
  client: OnchainClient,
  intent: IntentRow,
  configuredEmitter: string,
): Promise<IntentResolution | null> {
  // 허용 emitter 집합: 현재 설정값 ∪ 이 intent에 영속된 과거 매칭 주소.
  // GMX upgrade로 주소가 교체돼도 기존 intent는 저장된 주소로 계속 판정 가능하다.
  const allowedEmitters = [configuredEmitter];
  const storedEmitter = (intent as { orderEmitterAddress?: string | null }).orderEmitterAddress;
  if (isValidEvmAddress(storedEmitter) &&
      storedEmitter.toLowerCase() !== configuredEmitter.toLowerCase()) {
    allowedEmitters.push(storedEmitter);
  }
  // 1) txHash 없음 → broadcast 여부 불명. 자동 FAILED 금지, 영구 차단 (운영자 판정 필요)
  if (!intent.txHash) {
    return null;
  }

  // 2) receipt 조회 — 미존재/pending은 상태 변경 없음
  const receipt = await client.getTransactionReceipt(intent.txHash);
  if (receipt === null) return null;

  // 3) receipt reverted → 확정적 실패. FAILED terminal + 증거 저장
  if (receipt.status === 'reverted') {
    const okT = await resolveIntentTerminal(intent.id, 'FAILED', {
      receiptStatus:    'reverted',
      resolutionTxHash: intent.txHash,
      resolutionBlock:  receipt.blockNumber,
      resolutionReason: `트랜잭션 receipt reverted (block ${receipt.blockNumber})`,
    });
    return okT
      ? { intentId: intent.id, txHash: intent.txHash, status: 'FAILED', reason: 'receipt reverted' }
      : null;
  }

  // 4) receipt success → order key 확보 (기존 저장값 우선, 없으면 receipt 로그에서 추출)
  let orderKey = intent.orderKey ?? null;
  let createdBlock = intent.orderCreatedBlock ?? null;
  if (!orderKey) {
    const extraction = extractOrderKeyFromReceiptLogs(receipt.logs, allowedEmitters);
    if (!extraction.ok) {
      // receipt는 성공했지만 주문 생성을 확인할 수 없음 → UNRESOLVED 유지 (근거만 기록)
      await updateIntentEvidence(intent.id, {
        receiptStatus:    'success',
        resolutionReason: `receipt success지만 OrderCreated key 추출 실패 (${extraction.reason}) — 판정 불가, 차단 유지`,
      });
      return null;
    }
    orderKey = extraction.orderKey;
    createdBlock = receipt.blockNumber;
    // key·생성 block·실제 매칭 emitter 영속화 (차단 상태 유지한 채 —
    // 생성 확인만으로는 해소 아님; emitter 저장은 주소 교체 후 reconcile 대비)
    await updateIntentEvidence(intent.id, {
      receiptStatus:       'success',
      orderKey,
      orderCreatedBlock:   createdBlock,
      orderEmitterAddress: extraction.emitterAddress,
    });
    if (!allowedEmitters.some(a => a.toLowerCase() === extraction.emitterAddress.toLowerCase())) {
      allowedEmitters.push(extraction.emitterAddress);
    }
  }

  // 5) 주문 실행/취소/동결 이벤트 확인 (허용 emitter + 정확한 EventLog2 topic0)
  const logs = await client.getOrderResolutionLogs(orderKey, createdBlock, allowedEmitters);
  const resolution = classifyOrderResolutionLogs(logs, orderKey, allowedEmitters);

  if (resolution === null) {
    // 생성만 확인됨 — 실행 증거 없음 → 계속 차단
    return null;
  }

  if (resolution.kind === 'frozen') {
    // 동결 — 판정 불가. UNRESOLVED 유지, 자동 해제 금지
    await updateIntentEvidence(intent.id, {
      resolutionReason: `OrderFrozen 이벤트 확인 (tx ${resolution.txHash ?? '?'}) — 판정 불가, 차단 유지`,
    });
    return null;
  }

  const toStatus: TerminalIntentStatus = resolution.kind === 'executed' ? 'CONFIRMED' : 'CANCELLED';
  const reason = resolution.kind === 'executed'
    ? `OrderExecuted 이벤트 확인 (tx ${resolution.txHash ?? '?'}, block ${resolution.blockNumber ?? '?'})`
    : `OrderCancelled 이벤트 확인 — GMX keeper가 주문 취소 (tx ${resolution.txHash ?? '?'}, block ${resolution.blockNumber ?? '?'}); FAILED(제출 실패)와 구분되는 terminal 상태`;

  const okT = await resolveIntentTerminal(intent.id, toStatus, {
    receiptStatus:     'success',
    orderKey,
    orderCreatedBlock: createdBlock ?? undefined,
    resolutionTxHash:  resolution.txHash,
    resolutionBlock:   resolution.blockNumber,
    resolutionReason:  reason,
  });
  return okT
    ? { intentId: intent.id, txHash: intent.txHash, status: toStatus, reason }
    : null; // 0행 = 동시 reconcile에서 이미 처리됨 (중복 전환 없음)
}
