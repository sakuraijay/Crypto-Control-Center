/**
 * WalletContext — Read-only 브라우저 지갑 연결
 *
 * EIP-1193 표준을 통해 MetaMask 등 브라우저 지갑에서 주소를 읽어옵니다.
 *
 * 보안 원칙 (절대 지켜야 함):
 *   ✅ 지갑 주소 조회 — 허용
 *   ✅ 온체인 잔고 read-only 조회 (eth_call, eth_getBalance) — 허용
 *   ❌ 개인키 · 시드문구 · 서명키 수신 금지
 *   ❌ eth_sendTransaction · eth_signTypedData 등 서명 요청 금지
 *   ❌ 서버(Replit)로 지갑 비밀 정보 전송 금지
 *
 * Arbitrum One 체인 ID: 42161 (0xa4b1)
 */

import {
  createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode,
} from 'react';

// ── Arbitrum One 상수 ────────────────────────────────────────────────────────
const ARBITRUM_CHAIN_ID = 42161;
/** USDC Native on Arbitrum One */
const USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
/** ERC-20 balanceOf(address) 함수 선택자 */
const BALANCE_OF_SELECTOR = '0x70a08231';

// ── Types ─────────────────────────────────────────────────────────────────────

export type WalletConnectStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'wrong_network'
  | 'no_provider'
  | 'error';

export interface WalletState {
  status:       WalletConnectStatus;
  address:      string | null;
  /** ETH balance (formatted, e.g. "0.042") */
  ethBalance:   string | null;
  /** USDC balance (formatted, e.g. "1234.50") */
  usdcBalance:  string | null;
  chainId:      number | null;
  isArbitrum:   boolean;
  error:        string | null;
}

interface WalletContextType extends WalletState {
  /** 지갑 연결 (eth_requestAccounts — 서명 없음) */
  connect: () => Promise<void>;
  /** 연결 해제 (로컬 상태만 초기화) */
  disconnect: () => void;
  /** 잔고 새로고침 */
  refreshBalances: () => Promise<void>;
  /**
   * Re-reads eth_chainId immediately and updates wallet state.
   * Call this after a chain switch request to bypass the chainChanged
   * event-listener delay that causes the 'wrong_network' badge to stick.
   */
  refreshChainStatus: () => Promise<void>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hexToNumber(hex: string): number {
  return parseInt(hex, 16);
}

function weiToEth(weiHex: string): string {
  const wei = BigInt(weiHex);
  const eth = Number(wei) / 1e18;
  return eth.toFixed(6);
}

function usdcRawToFormatted(rawHex: string): string {
  // USDC has 6 decimals on Arbitrum
  const raw = BigInt(rawHex);
  const usdc = Number(raw) / 1e6;
  return usdc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function padAddress(address: string): string {
  // Pad address to 32-byte ABI encoding
  return '000000000000000000000000' + address.replace('0x', '').toLowerCase();
}

// ── Context ───────────────────────────────────────────────────────────────────

const WalletContext = createContext<WalletContextType | undefined>(undefined);

// ── Provider ──────────────────────────────────────────────────────────────────

export function WalletProvider({ children }: { children: ReactNode }) {
  // Detect EIP-1193 provider synchronously on first render.
  // Using a lazy initializer avoids a flicker: no-provider browsers start at
  // 'no_provider' immediately instead of briefly showing 'disconnected'.
  const [state, setState] = useState<WalletState>(() => {
    const hasProvider =
      typeof window !== 'undefined' && !!(window as { ethereum?: unknown }).ethereum;
    return {
      status:      hasProvider ? 'disconnected' : 'no_provider',
      address:     null,
      ethBalance:  null,
      usdcBalance: null,
      chainId:     null,
      isArbitrum:  false,
      error:       null,
    };
  });

  const addressRef = useRef<string | null>(null);

  // ── Read balances for a given address ────────────────────────────────────
  const fetchBalances = useCallback(async (address: string) => {
    const provider = (window as any).ethereum;
    if (!provider) return;

    try {
      // ETH balance
      const ethWei: string = await provider.request({
        method: 'eth_getBalance',
        params: [address, 'latest'],
      });

      // USDC balance via eth_call
      const callData = BALANCE_OF_SELECTOR + padAddress(address);
      const usdcRaw: string = await provider.request({
        method: 'eth_call',
        params: [{ to: USDC_ADDRESS, data: callData }, 'latest'],
      });

      setState(prev => ({
        ...prev,
        ethBalance:  weiToEth(ethWei),
        usdcBalance: usdcRaw && usdcRaw !== '0x'
          ? usdcRawToFormatted(usdcRaw)
          : '0.00',
      }));
    } catch {
      // 잔고 조회 실패는 non-fatal — 주소는 유지
    }
  }, []);

  const refreshBalances = useCallback(async () => {
    if (addressRef.current) await fetchBalances(addressRef.current);
  }, [fetchBalances]);

  const refreshChainStatus = useCallback(async () => {
    const provider = (window as any).ethereum;
    if (!provider) return;
    try {
      const chainHex: string = await provider.request({ method: 'eth_chainId' });
      const chainId = hexToNumber(chainHex);
      const isArbitrum = chainId === ARBITRUM_CHAIN_ID;
      setState(prev => ({
        ...prev,
        chainId,
        isArbitrum,
        status: prev.address
          ? (isArbitrum ? 'connected' : 'wrong_network')
          : prev.status,
        error: isArbitrum ? null : `네트워크 불일치: Arbitrum One(42161)으로 전환해주세요. 현재: ${chainId}`,
      }));
      if (isArbitrum && addressRef.current) await fetchBalances(addressRef.current);
    } catch { /* non-fatal */ }
  }, [fetchBalances]);

  // ── Connect ───────────────────────────────────────────────────────────────
  const connect = useCallback(async () => {
    const provider = (window as any).ethereum;

    if (!provider) {
      setState(prev => ({
        ...prev,
        status: 'no_provider',
        error:  'MetaMask 또는 EIP-1193 호환 지갑이 설치되어 있지 않습니다.',
      }));
      return;
    }

    setState(prev => ({ ...prev, status: 'connecting', error: null }));

    try {
      // ── 주소 요청 (서명 없음, read-only) ──
      const accounts: string[] = await provider.request({
        method: 'eth_requestAccounts',
      });

      if (!accounts.length) {
        setState(prev => ({
          ...prev,
          status: 'error',
          error:  '지갑에서 계정을 반환하지 않았습니다.',
        }));
        return;
      }

      const address = accounts[0];
      addressRef.current = address;

      // ── 체인 확인 ──
      const chainHex: string = await provider.request({ method: 'eth_chainId' });
      const chainId = hexToNumber(chainHex);
      const isArbitrum = chainId === ARBITRUM_CHAIN_ID;

      setState(prev => ({
        ...prev,
        status:     isArbitrum ? 'connected' : 'wrong_network',
        address,
        chainId,
        isArbitrum,
        error:      isArbitrum ? null : `네트워크 불일치: Arbitrum One(42161)으로 전환해주세요. 현재: ${chainId}`,
      }));

      if (isArbitrum) await fetchBalances(address);

    } catch (err: any) {
      const msg = err?.message ?? String(err);
      setState(prev => ({
        ...prev,
        status: msg.includes('rejected') ? 'disconnected' : 'error',
        error:  msg.includes('rejected') ? null : msg,
      }));
    }
  }, [fetchBalances]);

  // ── Disconnect ────────────────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    addressRef.current = null;
    setState({
      status: 'disconnected', address: null,
      ethBalance: null, usdcBalance: null,
      chainId: null, isArbitrum: false, error: null,
    });
  }, []);

  // ── 30s auto-refresh when connected on Arbitrum ──────────────────────────
  // Skips when the tab is hidden to avoid unnecessary RPC load.
  const balanceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (balanceTimerRef.current) {
      clearInterval(balanceTimerRef.current);
      balanceTimerRef.current = null;
    }
    if (state.status !== 'connected' || !state.isArbitrum) return;
    balanceTimerRef.current = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (addressRef.current) void fetchBalances(addressRef.current);
    }, 30_000);
    return () => {
      if (balanceTimerRef.current) {
        clearInterval(balanceTimerRef.current);
        balanceTimerRef.current = null;
      }
    };
  }, [state.status, state.isArbitrum, fetchBalances]);

  // ── Listen for account / chain changes ───────────────────────────────────
  useEffect(() => {
    const provider = (window as any).ethereum;
    if (!provider) return;

    const onAccountsChanged = (accounts: string[]) => {
      if (!accounts.length) {
        disconnect();
      } else {
        addressRef.current = accounts[0];
        setState(prev => ({ ...prev, address: accounts[0] }));
        fetchBalances(accounts[0]);
      }
    };

    const onChainChanged = (chainHex: string) => {
      const chainId = hexToNumber(chainHex);
      const isArbitrum = chainId === ARBITRUM_CHAIN_ID;
      setState(prev => ({
        ...prev,
        chainId,
        isArbitrum,
        status: prev.address
          ? (isArbitrum ? 'connected' : 'wrong_network')
          : prev.status,
        error: isArbitrum ? null : `네트워크 불일치: Arbitrum One으로 전환해주세요.`,
      }));
      if (isArbitrum && addressRef.current) fetchBalances(addressRef.current);
    };

    provider.on('accountsChanged', onAccountsChanged);
    provider.on('chainChanged', onChainChanged);

    return () => {
      provider.removeListener?.('accountsChanged', onAccountsChanged);
      provider.removeListener?.('chainChanged', onChainChanged);
    };
  }, [disconnect, fetchBalances]);

  return (
    <WalletContext.Provider value={{ ...state, connect, disconnect, refreshBalances, refreshChainStatus }}>
      {children}
    </WalletContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useWallet(): WalletContextType {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used inside WalletProvider');
  return ctx;
}
