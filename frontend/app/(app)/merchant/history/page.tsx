'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, BarChart3, CheckCircle2, ChevronDown, ChevronRight, Globe, Hash, Landmark, Receipt, TrendingUp, Undo2, Zap } from 'lucide-react';
import { AppShell } from '@/components/app/shell';
import { IndexedTag, Pill, Skeleton, StateBlock } from '@/components/app/ui';
import { api, streams } from '@/lib/api';
import { findToken } from '@/lib/config';
import { CHAIN_NAMES, formatToken, when } from '@/lib/format';
import { useSse } from '@/lib/sse';
import { useMerchant } from '@/lib/useMerchant';
import type { PaymentView } from '@/lib/shared';

/** M3 — sales stats, 14-day chart and payment list. */
export default function MerchantHistory() {
  const router = useRouter();
  const qc = useQueryClient();
  const mm = useMerchant();
  const { chainId, local } = mm;
  const dep = mm.chain?.deployment;
  const payout = findToken(dep, mm.view?.payoutToken);
  const dec = payout?.token.decimals ?? 6;
  const symbol = payout?.token.displaySymbol ?? 'USDC';
  const [pages, setPages] = useState(1);

  const stats = useQuery({
    queryKey: ['merchant-stats', chainId, local?.merchantId],
    queryFn: () => api.merchantStats(chainId, local!.merchantId, 14),
    enabled: !!local,
  });
  const pays = useQuery({
    queryKey: ['merchant-payments', chainId, local?.merchantId, pages],
    queryFn: () => api.merchantPayments(chainId, local!.merchantId, 25 * pages, 0),
    enabled: !!local,
  });
  useSse(local ? streams.merchant(chainId, local.merchantId) : null, (ev) => {
    if (ev.type === 'payment.settled') {
      void qc.invalidateQueries({ queryKey: ['merchant-payments'] });
      void qc.invalidateQueries({ queryKey: ['merchant-stats'] });
    }
  });

  if (mm.resolved && !local) {
    return (
      <AppShell title="History" nav="merchant">
        <StateBlock icon={Receipt} title="No shop on this network yet" action={<button className="btn" onClick={() => router.push('/merchant/setup')}>Set up your shop</button>} />
      </AppShell>
    );
  }

  const daily = stats.data?.daily ?? [];
  const max = daily.reduce((m, d) => Math.max(m, Number(d.volume)), 0) || 1;
  const today = daily[daily.length - 1];
  const items: PaymentView[] = pays.data?.items ?? [];
  const source = stats.data?.source === 'envio' || pays.data?.source === 'envio';
  const route = (p: PaymentView) => (p.routeName === 'DIRECT' ? <Zap size={16} /> : p.routeName === 'SWAP' ? <ArrowLeftRight size={16} /> : <Globe size={16} />);

  return (
    <AppShell title="History" nav="merchant" right={source ? <IndexedTag /> : undefined}>
      <div className="stats3">
        <div className="card"><div className="label"><TrendingUp size={12} /> Today</div><div className="amount md">{today ? formatToken(today.volume, dec) : '0.00'}</div></div>
        <div className="card"><div className="label"><Hash size={12} /> Payments</div><div className="amount md">{stats.data?.paymentCount ?? 0}</div></div>
        <div className="card"><div className="label"><Landmark size={12} /> Received</div><div className="amount md">{formatToken(stats.data?.netReceived ?? '0', dec)}</div></div>
      </div>

      <div className="card">
        <div className="label row" style={{ marginBottom: 10 }}><BarChart3 size={14} /> Last 14 days · {symbol}</div>
        {stats.isLoading ? (
          <Skeleton h={120} />
        ) : (
          <div className="bars">
            {daily.map((d, i) => (
              <div
                key={d.dayStart}
                className={`bar ${i === daily.length - 1 ? 'today' : ''}`}
                style={{ height: `${Math.max(3, (Number(d.volume) / max) * 100)}%` }}
                title={`${new Date(d.dayStart * 1000).toLocaleDateString()}: ${formatToken(d.volume, dec)} ${symbol} · ${d.payments} payment${d.payments === 1 ? '' : 's'}`}
              />
            ))}
          </div>
        )}
        {daily.length > 0 && (
          <div className="row between tiny muted" style={{ marginTop: 6 }}>
            <span>{new Date(daily[0]!.dayStart * 1000).getDate()}</span>
            <span>{new Date(daily[daily.length - 1]!.dayStart * 1000).getDate()}</span>
          </div>
        )}
      </div>

      {pays.isLoading ? (
        <div className="col"><Skeleton h={56} /><Skeleton h={56} /></div>
      ) : items.length === 0 ? (
        <StateBlock icon={Receipt} title="No payments yet" message="Show your first QR." action={<button className="btn" onClick={() => router.push('/merchant')}>Open checkout</button>} />
      ) : (
        <>
          <div className="col gap-s">
            {items.map((p) => (
              <button key={p.intentId} className="opt" onClick={() => router.push(`/receipt/${chainId}/${p.intentId}`)}>
                <span className="ico">{route(p)}</span>
                <span className="grow">
                  <div className="t">{formatToken(p.amountOut, dec)} {symbol}</div>
                  <div className="s">
                    {p.netToMerchant ? `net ${formatToken(p.netToMerchant, dec)} · ` : ''}{when(p.settledAt ?? p.committedAt)}
                    {p.sourceChainId ? ` · From ${CHAIN_NAMES[p.sourceChainId] ?? p.sourceChainId}` : ''}
                  </div>
                </span>
                {p.status === 'SETTLED' && <Pill tone="ok" icon={CheckCircle2}>Paid</Pill>}
                {p.status === 'COMMITTED' && <Pill tone="info">Pending</Pill>}
                {p.status === 'REFUNDED' && <Pill tone="warn" icon={Undo2}>Refunded</Pill>}
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
          {items.length >= 25 * pages && (
            <button className="btn ghost block" onClick={() => setPages((n) => n + 1)}><ChevronDown size={16} /> Load more</button>
          )}
        </>
      )}
    </AppShell>
  );
}
