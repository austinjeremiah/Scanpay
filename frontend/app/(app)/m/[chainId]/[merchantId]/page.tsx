'use client';
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Clock, Loader2, Send, ShieldAlert, StickyNote } from 'lucide-react';
import { AppShell } from '@/components/app/shell';
import { useApp } from '@/components/app/providers';
import {
  Countdown, FiatLine, Keypad, MerchantAvatar, Notice, Skeleton, Spinner, StateBlock, VerifiedBadge,
} from '@/components/app/ui';
import { api, ApiError, streams } from '@/lib/api';
import { findToken, useConfig } from '@/lib/config';
import { parseTokenInput } from '@/lib/format';
import { useFx } from '@/lib/hooks';
import { useSse } from '@/lib/sse';

/** P5 — printed counter QR: the customer types the amount, the shop confirms, the customer continues to Pay. */
export default function ShopQrPage() {
  const { chainId: chainParam, merchantId } = useParams<{ chainId: string; merchantId: string }>();
  const chainId = Number(chainParam);
  const router = useRouter();
  const cfg = useConfig();
  const { report } = useApp();
  const fx = useFx();

  const m = useQuery({ queryKey: ['merchant', chainId, merchantId], queryFn: () => api.merchant(chainId, merchantId), retry: false });
  const dep = cfg.get(chainId)?.deployment;
  const payout = findToken(dep, m.data?.payoutToken);
  const decimals = payout?.token.decimals ?? 6;
  const symbol = payout?.token.displaySymbol ?? 'USDC';

  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [req, setReq] = useState<{ id: string; expiresAt: number } | null>(null);
  const [expired, setExpired] = useState(false);

  const go = (shortCode: string) => router.replace(`/pay/${shortCode}`);
  useSse(req ? streams.invoiceRequest(req.id) : null, (ev) => {
    if (ev.type === 'invoice_request.created' && ev.request.shortCode) go(ev.request.shortCode);
  });
  useEffect(() => {
    if (!req) return;
    const t = setInterval(async () => {
      try {
        const r = await api.invoiceRequest(req.id);
        if (r.shortCode) go(r.shortCode);
        else if (r.status === 'EXPIRED' || r.status === 'CANCELLED') setExpired(true);
      } catch { /* keep polling */ }
    }, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  const verified = m.data?.status === 'ACTIVE' && m.data.profileVerified;
  const amountBase = parseTokenInput(value || '0', decimals) ?? 0n;
  const usd = Number(value || 0) * (payout?.token.usdPrice ?? 1);

  const send = async () => {
    setBusy(true);
    setExpired(false);
    try {
      const r = await api.createInvoiceRequest({
        chainId,
        merchantId,
        amount: amountBase.toString(),
        note: note.trim() || undefined,
      });
      setReq({ id: r.requestId, expiresAt: r.expiresAt });
    } catch (e) {
      report(e instanceof ApiError ? e : e);
    } finally {
      setBusy(false);
    }
  };

  if (m.isLoading) {
    return (
      <AppShell title="Pay a shop" back="/scan" nav="none">
        <Skeleton h={90} /> <Skeleton h={80} /> <Skeleton h={260} />
      </AppShell>
    );
  }
  if (m.error || !m.data) {
    return (
      <AppShell title="Pay a shop" back="/scan" nav="none">
        <StateBlock icon={ShieldAlert} tone="bad" title="We couldn't find this shop" message="Check the QR and try again." />
      </AppShell>
    );
  }

  return (
    <AppShell title="Pay a shop" back="/scan" nav="none" chainId={chainId}>
      <div className="card row">
        <MerchantAvatar logoUrl={m.data.profile?.logoUrl} name={m.data.profile?.displayName} />
        <div className="grow">
          <div className="h3">{m.data.profile?.displayName}</div>
          <div className="small muted">{[m.data.profile?.category, m.data.profile?.city].filter(Boolean).join(' · ')}</div>
        </div>
        <VerifiedBadge verified={verified} />
      </div>

      {!verified ? (
        <Notice tone="bad" icon={ShieldAlert}><b>This shop isn&apos;t verified. Don&apos;t pay.</b></Notice>
      ) : req && !expired ? (
        <div className="card col center">
          <Loader2 size={34} className="spin" style={{ alignSelf: 'center' }} />
          <h2 className="h2">Waiting for {m.data.profile?.displayName} to confirm…</h2>
          <p className="muted">Show this screen at the counter.</p>
          <div><Countdown until={req.expiresAt} onExpire={() => setExpired(true)} /></div>
        </div>
      ) : (
        <>
          {expired && (
            <Notice tone="warn" icon={Clock}>The shop didn&apos;t respond. Try again or scan their screen.</Notice>
          )}
          <div className="col gap-s center">
            <div className="amount xl">{value || '0'}<span className="h2 muted"> {symbol}</span></div>
            <FiatLine usd={usd} rate={fx.rate} currency={fx.currency} />
          </div>
          <Keypad value={value} onChange={setValue} />
          <label className="field">
            <span className="label">What&apos;s it for? (optional)</span>
            <span className="input-wrap">
              <StickyNote size={18} />
              <input className="input" maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} />
            </span>
          </label>
          <button className="btn neon big block" disabled={amountBase === 0n || busy} onClick={send}>
            {busy ? <Spinner /> : <Send size={20} />} Ask {m.data.profile?.displayName ?? 'the shop'} for a payment QR
          </button>
        </>
      )}
    </AppShell>
  );
}
