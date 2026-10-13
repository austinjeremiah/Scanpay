'use client';
import { useQuery } from '@tanstack/react-query';
import type { Hex } from 'viem';
import { tokenBalance } from './chain';
import type { ChainEntry } from './config';
import type { TokenInfo, TokenKey } from './shared';

export type BalanceRow = { key: TokenKey; token: TokenInfo; balance: bigint };

/** Balances of every configured token for one account, refreshed every 15 s. */
export function useBalances(chain: ChainEntry | null, address: string | undefined) {
  return useQuery({
    queryKey: ['balances', chain?.chainId, address],
    enabled: !!chain && !!address,
    refetchInterval: 15_000,
    queryFn: async (): Promise<BalanceRow[]> => {
      const entries = Object.entries(chain!.deployment.tokens) as [TokenKey, TokenInfo][];
      return Promise.all(
        entries.map(async ([key, token]) => ({
          key,
          token,
          balance: await tokenBalance(chain!.chainId, token.address as Hex, address as Hex).catch(() => 0n),
        })),
      );
    },
  });
}

/** Total in USD using each token's configured usdPrice (stablecoins are 1). */
export function totalUsd(rows: BalanceRow[] | undefined): number {
  if (!rows) return 0;
  return rows.reduce((s, r) => s + (Number(r.balance) / 10 ** r.token.decimals) * (r.token.usdPrice ?? 0), 0);
}
