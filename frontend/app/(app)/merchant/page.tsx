'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftRight, Banknote, BellRing, CheckCircle2, Clock, Globe, Inbox, Landmark, Link2, Loader2, Lock, QrCode, Receipt,
  Share2, ShieldAlert, StickyNote, Unlock, User, X, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/shell';
import { useApp } from '@/components/app/providers';
import {
  Amount, Countdown, FiatLine, Keypad, MerchantAvatar, Notice, QrView, Sheet, Skeleton, Spinner, StateBlock, VerifiedBadge,
  CopyButton,
} from '@/components/app/ui';
import { api, ApiError, streams } from '@/lib/api';
import { findToken } from '@/lib/config';
import { formatToken, parseTokenInput } from '@/lib/format';
import { useFx, useNow, vibrate } from '@/lib/hooks';
import { PasskeyError, useSession } from '@/lib/session';
import { signInvoice } from '@/lib/sign';
import { useSse } from '@/lib/sse';
import { randomBytes32, toWireInvoice } from '@/lib/shared';
import { useMerchant } from '@/lib/useMerchant';

type Current = { shortCode: string; invoiceId: string; qrPayload: string; url: string; expiresAt: number; amount: bigint };
type Paid = { intentId: string; amountOut: string; net: string | null; route: string; ms: number | null };

function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.value = 0.08;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.12);
  } catch { /* no audio */ }
}

/** M2 — checkout terminal: keypad -> signed QR -> "Paid" within a second. Also the inbox for static-QR requests. */
export default function MerchantTerminal() {
  const router = useRouter();
  const qc = useQueryClient();
  const session = useSession();
  const { report, ensureProfile } = useApp();
  const mm = useMerchant();
  const { chainId, local, view, resolved } = mm;
  const dep = mm.chain?.deployment;
  const payout = findToken(dep, view?.payoutToken);
  const decimals = payout?.token.decimals ?? 6;
  const symbol = payout?.token.displaySymbol ?? 'USDC';
  const cap = payout ? dep?.config.amountCaps[payout.key] : undefined;
  const now = useNow();
  const fx = useFx();

  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [fiatMode, setFiatMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<Current | null>(null);
  const [reserved, setReserved] = useState(false);
  const [paid, setPaid] = useState<Paid | null>(null);
  const [inbox, setInbox] = useState(false);
  const shownAt = useRef<number>(0);
  const paidTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (resolved && !local && session.profile !== undefined) router.replace('/merchant/setup');
  }, [resolved, local, router, session.profile]);

  const requests = useQuery({
    queryKey: ['requests', chainId, local?.merchantId],
    queryFn: () => api.merchantRequests(chainId, local!.merchantId),
    enabled: !!local,
    refetchInterval: 15_000,
  });
  const pending = (requests.data?.requests ?? []).filter((r) => r.status === 'PENDING' && r.expiresAt > now);

  /** the amount in payout-token base units (fiat mode converts with the live rate, rounded up to cents) */
  const amountBase = useMemo(() => {
    if (!value) return 0n;
    if (!fiatMode) return parseTokenInput(value, decimals) ?? 0n;
    if (!fx.rate) return 0n;
    const usd = Math.ceil((Number(value) / fx.rate) * 100) / 100;
    return parseTokenInput(usd.toFixed(2), decimals) ?? 0n;
  }, [value, fiatMode, fx.rate, decimals]);
  const overCap = !!cap && amountBase > BigInt(cap);

  const resetSale = () => {
    setCurrent(null);
    setReserved(false);
    setPaid(null);
    setValue('');
    setNote('');
    if (paidTimer.current) clearTimeout(paidTimer.current);
  };

  const onPaid = (p: Paid) => {
    setPaid(p);
    vibrate([60, 40, 60]);
    chime();
    if (paidTimer.current) clearTimeout(paidTimer.current);
    paidTimer.current = setTimeout(resetSale, 8000);
  };

  useSse(local ? streams.merchant(chainId, local.merchantId) : null, (ev) => {
    if (ev.type === 'invoice_request.created') {
      void qc.invalidateQueries({ queryKey: ['requests', chainId, local?.merchantId] });
      if (!current) setInbox(true);
    }
    if (ev.type === 'payment.settled') {
      const p = ev.payment;
      if (current && p.invoiceId.toLowerCase() === current.invoiceId.toLowerCase()) {
        onPaid({
          intentId: p.intentId, amountOut: p.amountOut, net: p.netToMerchant, route: p.routeName,
          ms: p.settledAt ? Math.max(0, p.settledAt - Math.floor(shownAt.current / 1000)) : null,
        });
      } else {
        toast.success(`Received ${formatToken(p.amountOut, decimals)} ${symbol}`, { icon: <CheckCircle2 size={16} /> });
      }
      void qc.invalidateQueries({ queryKey: ['merchant-payments'] });
    }
  });
  useSse(current ? streams.invoice(current.shortCode) : null, (ev) => {
    if (ev.type === 'invoice.updated') {
      if (ev.state === 'RESERVED') setReserved(true);
      if (ev.state === 'PAID' && !paid) {
        void api.invoice(current!.shortCode).then((v) =>
          onPaid({ intentId: v.paidIntentId ?? '', amountOut: v.invoice.amount, net: null, route: 'DIRECT', ms: null }),
        );
      }
    }
  });

  const showQr = async (amount: bigint, opts: { memo?: string; fiat?: { currency: string; amount: string }; requestId?: string }) => {
    if (!local || !view || !mm.chain || !dep) return;
    setBusy(true);
    try {
      await ensureProfile();
      const signer = await session.invoiceSigner(view.keyVersion, view.invoiceSigner);
      const vault = dep.contracts.IntentVault.address;
      const inv = {
        merchantId: local.merchantId,
        invoiceId: randomBytes32(),
        payoutToken: view.payoutToken as `0x${string}`,
        amount,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) + 15 * 60),
        keyVersion: view.keyVersion,
      };
      const merchantSig = await signInvoice(signer, chainId, vault, inv);
      const res = await api.createInvoice({
        chainId, invoice: toWireInvoice(inv), merchantSig, memo: opts.memo, fiat: opts.fiat, requestId: opts.requestId,
      });
      shownAt.current = Date.now();
      setReserved(false);
      setCurrent({ shortCode: res.shortCode, invoiceId: inv.invoiceId, qrPayload: res.qrPayload, url: res.url, expiresAt: res.expiresAt, amount });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'MERCHANT_KEYS_CHANGED') {
        session.lockTerminal();
        void mm.refetch();
        toast.error('Your checkout key changed. Unlock again.');
      } else if (e instanceof PasskeyError || e instanceof ApiError) report(e);
      else if ((e as Error)?.message !== 'dismissed') report(e);
    } finally {
      setBusy(false);
    }
  };

  const unlockedLeft = session.invoiceSignerUnlockedUntil ? Math.max(0, Math.floor((session.invoiceSignerUnlockedUntil - Date.now()) / 60000)) : 0;
  const unlocked = !!session.invoiceSignerUnlockedUntil;
  const status = view?.status;
  const disabled = status !== 'ACTIVE';

  if (!resolved || mm.loading || !local) {
    return (
      <AppShell title="Checkout" nav="merchant">
        <Skeleton h={70} /> <Skeleton h={120} /> <Skeleton h={260} />
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Checkout"
      nav="merchant"
      right={
        <button
          className={`pill btnlike ${unlocked ? 'ok' : ''}`}
          onClick={() => (unlocked ? session.lockTerminal() : undefined)}
          aria-label={unlocked ? 'Lock checkout' : 'Checkout locked'}
        >
          {unlocked ? <Unlock size={12} /> : <Lock size={12} />}
          {unlocked ? `${unlockedLeft} min` : 'Locked'}
        </button>
      }
    >
      <div className="card row">
        <MerchantAvatar logoUrl={view?.profile?.logoUrl} name={view?.profile?.displayName ?? local.displayName} />
        <div className="grow">
          <div className="h3">{view?.profile?.displayName ?? local.displayName}</div>
          <div className="small muted">Accepting {symbol}</div>
        </div>
        <VerifiedBadge verified={status === 'ACTIVE'} />
      </div>

      {status === 'PENDING' && (
        <Notice tone="warn" icon={Clock}><b>Waiting for verification.</b> You can&apos;t take payments yet.</Notice>
      )}
      {(status === 'SUSPENDED' || status === 'REVOKED') && (
        <Notice tone="bad" icon={ShieldAlert}><b>Your shop is {status.toLowerCase()}.</b> Contact support.</Notice>
      )}

      {current ? (
        /* State B — showing QR */
        <div className="col center">
          <Amount value={current.amount} decimals={decimals} symbol={symbol} size="xl" />
          <FiatLine usd={Number(formatToken(current.amount, decimals).replace(/,/g, ''))} rate={fx.rate} currency={fx.currency} />
          <QrView payload={current.qrPayload} size={280} />
          <div className="row" style={{ justifyContent: 'center' }}>
            <span className="pill"><Link2 size={12} /> <span className="mono">{current.shortCode}</span></span>
            <CopyButton text={current.shortCode} />
          </div>
          <Countdown until={current.expiresAt} onExpire={() => { toast('QR expired'); resetSale(); }} />
          <p className="muted row" style={{ justifyContent: 'center' }}>
            <Loader2 size={16} className="spin" /> {reserved ? 'Customer is paying…' : 'Waiting for payment…'}
          </p>
          <div className="row">
            <button
              className="btn soft"
              onClick={async () => {
                try {
                  if (navigator.share) await navigator.share({ title: 'ScanPay', url: current.url });
                  else await navigator.clipboard.writeText(current.url);
                } catch { /* cancelled */ }
              }}
            >
              <Share2 size={16} /> Share
            </button>
            <button className="btn ghost" onClick={resetSale}><X size={16} /> New sale</button>
          </div>
        </div>
      ) : (
        /* State A — keypad */
        <>
          <div className="col gap-s center">
            <div className="amount xl">
              {fiatMode && <span className="h2 muted">{fx.currency} </span>}
              {value || '0.00'}
              {!fiatMode && <span className="h2 muted"> {symbol}</span>}
            </div>
            {fiatMode ? (
              fx.rate ? <span className="muted small">≈ {formatToken(amountBase, decimals)} {symbol}</span> : <span className="muted small">Loading rate…</span>
            ) : (
              <FiatLine usd={Number(value || 0)} rate={fx.rate} currency={fx.currency} />
            )}
            {cap && <span className="tiny muted">Payments are capped at {formatToken(cap, decimals)} {symbol}</span>}
          </div>
          <Keypad value={value} onChange={setValue} />
          <div className="row">
            <label className="field grow">
              <span className="input-wrap">
                <StickyNote size={18} />
                <input className="input" placeholder="Add a note" maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} />
              </span>
            </label>
            {fx.currency !== 'USD' && (
              <button className={`btn ${fiatMode ? 'neon' : 'soft'} sm`} onClick={() => { setFiatMode((m) => !m); setValue(''); }} aria-pressed={fiatMode}>
                <Banknote size={14} /> Bill in {fx.currency}
              </button>
            )}
          </div>
          {overCap && <Notice tone="warn">Live payments are capped at {formatToken(cap, decimals)} {symbol}.</Notice>}
          <button
            className="btn neon big block"
            disabled={busy || amountBase === 0n || disabled || overCap}
            onClick={() =>
              showQr(amountBase, {
                memo: note.trim() || undefined,
                fiat: fiatMode ? { currency: fx.currency, amount: Number(value).toFixed(2) } : undefined,
              })
            }
          >
            {busy ? <Spinner /> : <QrCode size={22} />} Show QR
          </button>
          {pending.length > 0 && (
            <button className="btn soft block" onClick={() => setInbox(true)}>
              <BellRing size={16} /> {pending.length} customer{pending.length > 1 ? 's' : ''} waiting
            </button>
          )}
        </>
      )}

      {/* State C — paid */}
      {paid && (
        <div className="paid" role="status">
          <div className="tick"><CheckCircle2 size={72} /></div>
          <div className="display">Paid</div>
          <div className="amount lg">{formatToken(paid.amountOut, decimals)} {symbol}</div>
          <div className="row small" style={{ justifyContent: 'center' }}>
            {paid.route === 'DIRECT' ? <Zap size={16} /> : paid.route === 'SWAP' ? <ArrowLeftRight size={16} /> : <Globe size={16} />}
            {paid.route === 'DIRECT' ? 'Direct' : paid.route === 'SWAP' ? 'Customer paid in another token' : 'From another chain'}
          </div>
          {paid.net && <div className="row small"><Landmark size={16} /> You received {formatToken(paid.net, decimals)} {symbol}</div>}
          {paid.ms !== null && <div className="row small"><Clock size={16} /> Confirmed in {paid.ms} s</div>}
          <div className="row">
            {paid.intentId && (
              <button className="btn" onClick={() => router.push(`/receipt/${chainId}/${paid.intentId}`)}><Receipt size={16} /> Receipt</button>
            )}
            <button className="btn ghost" onClick={resetSale}>New sale</button>
          </div>
        </div>
      )}

      {/* State D — inbox */}
      <Sheet open={inbox} onClose={() => setInbox(false)} title="Customers asking to pay" icon={BellRing}>
        {pending.length === 0 ? (
          <StateBlock icon={Inbox} title="No requests" />
        ) : (
          pending.map((r) => (
            <div className="card row" key={r.requestId}>
              <User size={20} />
              <div className="grow">
                <b>{formatToken(r.amount, decimals)} {symbol}</b>
                {r.note && <div className="small muted">{r.note}</div>}
                <Countdown until={r.expiresAt} />
              </div>
              <button
                className="btn sm"
                disabled={busy}
                onClick={async () => {
                  setInbox(false);
                  await showQr(BigInt(r.amount), { memo: r.note ?? undefined, requestId: r.requestId });
                  void requests.refetch();
                }}
              >
                Accept
              </button>
            </div>
          ))
        )}
      </Sheet>
    </AppShell>
  );
}
