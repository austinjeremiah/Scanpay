'use client';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Deployment, TokenInfo, TokenKey } from './shared';
import { api } from './api';
import { ENV } from './env';

export type ChainEntry = {
  chainId: number;
  deployment: Deployment;
  features: { direct: boolean; swap: boolean; crosschain: 'live' | 'simulated' | 'off'; faucet: boolean; attackLab: boolean; indexer: boolean };
};
type Ctx = {
  ready: boolean;
  error: unknown;
  chains: ChainEntry[];
  chainId: number;
  setChainId: (id: number) => void;
  chain: ChainEntry | null;
  publicAppUrl: string;
  get: (chainId: number) => ChainEntry | null;
  isLive: (chainId: number) => boolean;
};
const ConfigCtx = createContext<Ctx | null>(null);
const LS_KEY = 'scanpay.chainId';

export function ConfigProvider({ children }: { children: ReactNode }) {
  const { data, error } = useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: 5 * 60_000, retry: 1 });
  const [chainId, setChainIdState] = useState<number>(ENV.DEFAULT_CHAIN_ID);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(LS_KEY));
      if (v) setChainIdState(v);
    } catch { /* private mode */ }
  }, []);
  const value = useMemo<Ctx>(() => {
    const chains = (data?.chains ?? []) as unknown as ChainEntry[];
    const get = (id: number) => chains.find((c) => c.chainId === id) ?? null;
    const effective = get(chainId) ? chainId : chains[0]?.chainId ?? chainId;
    return {
      ready: Boolean(data),
      error,
      chains,
      chainId: effective,
      setChainId: (id) => {
        setChainIdState(id);
        try { localStorage.setItem(LS_KEY, String(id)); } catch { /* ignore */ }
      },
      chain: get(effective),
      publicAppUrl: data?.publicAppUrl ?? '',
      get,
      isLive: (id) => id === 143,
    };
  }, [data, error, chainId]);
  return <ConfigCtx.Provider value={value}>{children}</ConfigCtx.Provider>;
}

export function useConfig() {
  const c = useContext(ConfigCtx);
  if (!c) throw new Error('useConfig outside ConfigProvider');
  return c;
}

export function findToken(d: Deployment | undefined, address: string | null | undefined): { key: TokenKey; token: TokenInfo } | null {
  if (!d || !address) return null;
  for (const [key, token] of Object.entries(d.tokens) as [TokenKey, TokenInfo][]) {
    if (token.address.toLowerCase() === address.toLowerCase()) return { key, token };
  }
  return null;
}

export const explorerTx = (d: Deployment | undefined, tx: string | null | undefined) =>
  d?.explorer && tx ? `${d.explorer.replace(/\/$/, '')}/tx/${tx}` : undefined;
export const explorerAddr = (d: Deployment | undefined, a: string | null | undefined) =>
  d?.explorer && a ? `${d.explorer.replace(/\/$/, '')}/address/${a}` : undefined;
