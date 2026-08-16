/**
 * relayReadonlyClient — 6단계 §5: relay 읽기 전용 RPC 클라이언트 분리.
 *
 * 논리적 클라이언트 분리:
 *  - Market/PAPER 데이터 client: 기존 동작 그대로 (이 모듈과 무관 — PAPER 가격
 *    조회는 relay 플래그의 영향을 받지 않는다).
 *  - Relay read-only client(이 모듈): GMX_RELAY_READONLY_NETWORK_ENABLED='true'
 *    일 때만 생성 가능. eth_call(readContract)·receipt·block·logs 조회만 노출.
 *    eth_sendRawTransaction·wallet_*·contract write·sponsored-call POST는
 *    구조적으로 존재하지 않는다.
 *  - Relay submit transport: relayTransport.ts — 제출용 3중 플래그 + LIVE 필요.
 *
 * fail-closed: 플래그 미설정·GMX_RPC_URL 미설정이면 client를 만들지 않고
 * 사유만 반환한다 (어떤 네트워크 연결도 시작하지 않음).
 */

import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { arbitrum } from 'viem/chains';
import { isRelayReadonlyNetworkEnabled } from './relayActivationStatus';
import type { DataStoreClient } from './gmxDataStore';

/** 읽기 전용 메서드만 노출하는 relay 조회 클라이언트 */
export interface RelayReadonlyClient extends DataStoreClient {
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<unknown>;
  getLogs(args: { address?: Address; fromBlock?: bigint; toBlock?: bigint }): Promise<unknown[]>;
  /** 6C §7 — 배포 코드 존재 검증용 eth_getCode (읽기 전용) */
  getCode(args: { address: Address }): Promise<`0x${string}` | undefined>;
  /** 6C §7 — chainId 42161 확인용 eth_chainId (읽기 전용) */
  getChainId(): Promise<number>;
}

export type RelayReadonlyClientResult =
  | { ok: true; client: RelayReadonlyClient }
  | { ok: false; reason: string };

/** 테스트 주입 지점 — 실제 viem client 생성을 대체 */
let publicClientFactory: ((url: string) => PublicClient) | null = null;
export function __setRelayReadonlyPublicClientFactoryForTests(f: ((url: string) => PublicClient) | null): void {
  publicClientFactory = f;
}

export function createRelayReadonlyClient(env: NodeJS.ProcessEnv = process.env): RelayReadonlyClientResult {
  if (!isRelayReadonlyNetworkEnabled(env)) {
    return { ok: false, reason: "GMX_RELAY_READONLY_NETWORK_ENABLED !== 'true' — relay 읽기 전용 클라이언트 비활성 (fail-closed)" };
  }
  const url = env.GMX_RPC_URL?.trim();
  if (!url) return { ok: false, reason: 'GMX_RPC_URL 미설정 — relay 읽기 전용 클라이언트 생성 불가 (fail-closed)' };

  const client = publicClientFactory
    ? publicClientFactory(url)
    : createPublicClient({ chain: arbitrum, transport: http(url, { timeout: 8_000 }) });

  // 허용 메서드만 명시적으로 래핑 — 쓰기·서명·전송 능력은 노출하지 않는다.
  return {
    ok: true,
    client: {
      readContract: (args) =>
        client.readContract({
          address: args.address as Address,
          abi: args.abi as never,
          functionName: args.functionName as never,
          args: args.args as never,
        }),
      getBlockTimestamp: async () => (await client.getBlock({ blockTag: 'latest' })).timestamp,
      getTransactionReceipt: (args) => client.getTransactionReceipt(args),
      getLogs: (args) => client.getLogs(args as never),
      getCode: (args) => client.getCode(args),
      getChainId: () => client.getChainId(),
    },
  };
}
