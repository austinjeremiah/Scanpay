'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, streams } from './api';
import { useConfig } from './config';
import { useSession } from './session';
import { useSse } from './sse';
import type { LocalMerchant } from './store';
import type { MerchantView } from './shared';

/**
 * Merchant mode entry (all /merchant pages): finds this device's shop on the selected network,
 * restoring it from the chain (by owner address) when local storage was cleared.
 * The chain is the truth for status and keyVersion; local state is kept in sync.
 */
export function useMerchant() {
  const cfg = useConfig();
  const session = useSession();
  const qc = useQueryClient();
  const chainId = cfg.chainId;
  const [local, setLocal] = useState<LocalMerchant | null>(null);
  const [resolved, setResolved] = useState(false);
  const owner = session.profile?.addresses.owner;

  useEffect(() => {
    if (!cfg.ready) return;
    let live = true;
    (async () => {
      let m = session.merchant(chainId);
      if (!m && owner) {
        try {
          const r = await api.merchantsByOwner(chainId, owner);
          const v = r.merchants[0];
          if (v) {
            m = {
              chainId,
              merchantId: v.merchantId as `0x${string}`,
              keyVersion: v.keyVersion,
              invoiceSigner: v.invoiceSigner as `0x${string}`,
              payoutTokenKey: v.payoutTokenKey ?? 'USDC',
              displayName: v.profile?.displayName ?? 'My shop',
            };
            session.setMerchant(m);
          }
        } catch { /* offline: fall through to setup */ }
      }
      if (live) {
        setLocal(m);
        setResolved(true);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.ready, chainId, owner]);

  const q = useQuery({
    queryKey: ['merchant', chainId, local?.merchantId],
    queryFn: () => api.merchant(chainId, local!.merchantId),
    enabled: !!local,
    refetchInterval: 20_000,
  });
  const view = q.data as MerchantView | undefined;

  useEffect(() => {
    if (!local || !view) return;
    if (view.keyVersion !== local.keyVersion || view.invoiceSigner.toLowerCase() !== local.invoiceSigner.toLowerCase()) {
      const next: LocalMerchant = { ...local, keyVersion: view.keyVersion, invoiceSigner: view.invoiceSigner as `0x${string}` };
      session.setMerchant(next);
      setLocal(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.keyVersion, view?.invoiceSigner]);

  useSse(local ? streams.merchant(chainId, local.merchantId) : null, (ev) => {
    if (ev.type === 'merchant.updated') qc.setQueryData(['merchant', chainId, local?.merchantId], ev.merchant);
  });

  return {
    chainId,
    chain: cfg.chain,
    local,
    view,
    resolved,
    loading: !resolved || (!!local && q.isLoading),
    refetch: q.refetch,
    setLocal,
  };
}
