/**
 * gmxCanonicalClient — DataStore/relay router read-only 조회용 viem 클라이언트.
 *
 * GMX_RPC_URL 필수(fail-closed: 미설정 시 throw). readContract + 블록
 * timestamp만 노출 — 쓰기·서명 능력 없음. 테스트는 DataStoreClient mock을
 * 주입하며 이 팩토리를 호출하지 않는다.
 */

import { createPublicClient, http, type Address } from 'viem';
import { arbitrum } from 'viem/chains';
import type { DataStoreClient } from './gmxDataStore';

export function createCanonicalDataStoreClient(): DataStoreClient {
  const url = process.env.GMX_RPC_URL?.trim();
  if (!url) throw new Error('GMX_RPC_URL 미설정 — canonical 조회 불가 (fail-closed)');
  const client = createPublicClient({ chain: arbitrum, transport: http(url, { timeout: 8_000 }) });
  return {
    readContract: (args) =>
      client.readContract({
        address: args.address as Address,
        // viem의 정적 ABI 추론 대신 런타임 ABI 사용 (DataStoreClient 인터페이스 계약)
        abi: args.abi as never,
        functionName: args.functionName as never,
        args: args.args as never,
      }),
    getBlockTimestamp: async () => (await client.getBlock({ blockTag: 'latest' })).timestamp,
  };
}
