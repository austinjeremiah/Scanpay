'use client';
import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowDownToLine, CheckCircle2, Link2, Loader2, Lock, Receipt, RefreshCw, Send,
  ShieldAlert, ShieldCheck, Sparkles, Timer, Undo2, Wallet, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/shell';
import { useApp } from '@/components/app/providers';
import {
  CopyButton, Countdown, MerchantAvatar, QrView, Skeleton, Spinner, StateBlock, StepList, TechDetails, type StepState,
} from '@/components/app/ui';
import { api, ApiError, streams } from '@/lib/api';
import { explorerTx, findToken, useConfig } from '@/lib/config';
import { formatToken, when } from '@/lib/format';
import { vibrate } from '@/lib/hooks';
import { useSse } from '@/lib/sse';
import type { IntentView } from '@/lib/shared';
import { ORIGIN_CHAINS, originBalance, signOriginAuth } from '@/lib/originPay';
import { useSession } from '@/lib/session';

type Origin = { symbol?: string; blockchain?: string; decimals?: number; evmChainId?: number | null; contractAddress?: string | null; amount?: string | null };

/** P9 — live payment status: instant for DIRECT/SWAP, minutes (with deposit instructions) for CROSSCHAIN. */
export default function PaymentStatusPage() {
  const { chainId: c, intentId } = useParams<{ chainId: string; intentId: string }>();
  const chainId = Number(c);
  const router = useRouter();
  const qc = useQueryClient();
  const cfg = useConfig();
  const { report } = useApp();
  const dep = cfg.get(chainId)?.deployment;

  const q = useQuery({
    queryKey: ['intent', chainId, intentId],
    queryFn: () => api.intent(chainId, intentId),
    refetchInterval: 6000,
    retry: 1,
  });
  useSse(
    streams.intent(chainId, intentId),
    (ev) => ev.type === 'intent.updated' && qc.setQueryData(['intent', chainId, intentId], ev.intent),
    () => void q.refetch(),
  );
  const i = q.data as IntentView | undefined;
  const merchant = useQuery({
    queryKey: ['merchant', chainId, i?.merchantId],
    queryFn: () => api.merchant(chainId, i!.merchantId),
    enabled: !!i,
  });

  const [origin, setOrigin] = useState<Origin | null>(null);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(`scanpay.origin.${intentId}`);
      if (raw) setOrigin(JSON.parse(raw));
    } catch { /* ignore */ }
  }, [intentId]);

  const [txInput, setTxInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [originHeld, setOriginHeld] = useState<bigint>(0n);
  const session = useSession();
  const payout = findToken(dep, i?.payoutToken);
  const symbol = payout?.token.displaySymbol ?? 'USDC';
  const dec = payout?.token.decimals ?? 6;
  const shop = merchant.data?.profile?.displayName ?? 'the shop';
  const amount = i ? `${formatToken(i.amountOut, dec)} ${symbol}` : '';
  const l = i?.lifecycle;

  useEffect(() => {
    if (l === 'SETTLED') vibrate(80);
  }, [l]);

  const steps = useMemo<{ label: string; state: StepState }[]>(() => {
    if (!i) return [];
    const st = i.lifecycle;
    if (i.route === 'CROSSCHAIN') {
      const received = i.crosschain ? BigInt(i.crosschain.received) >= BigInt(i.crosschain.required) && BigInt(i.crosschain.required) > 0n : false;
      const depositSeen = received || st === 'PROCESSING' || st === 'SETTLED';
      const done = st === 'SETTLED';
      return [
        { label: 'Order locked', state: 'done' },
        { label: 'Deposit received', state: depositSeen ? 'done' : st === 'AWAITING_DEPOSIT' || st === 'COMMITTED' ? 'active' : 'todo' },
        { label: 'Converting & delivering', state: done ? 'done' : st === 'PROCESSING' ? 'active' : 'todo' },
        { label: 'Paid', state: done ? 'done' : 'todo' },
      ];
    }
    const failed = st === 'FAILED';
    const settled = st === 'SETTLED';
    return [
      { label: 'Confirmed', state: 'done' },
      { label: 'Checked shop & amount', state: failed ? 'error' : 'done' },
      { label: 'Sending', state: settled ? 'done' : failed ? 'todo' : 'active' },
      { label: 'Paid', state: settled ? 'done' : 'todo' },
    ];
  }, [i]);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.success(ok);
      void q.refetch();
    } catch (e) {
      if (e instanceof ApiError) toast.error(e.message);
      else report(e);
    } finally {
      setBusy(null);
    }
  };

  if (q.isLoading) {
    return (
      <AppShell title="Payment" nav="none" back="/app">
        <Skeleton h={80} /> <Skeleton h={200} />
      </AppShell>
    );
  }
  if (!i) {
    return (
      <AppShell title="Payment" nav="none" back="/app">
        <StateBlock icon={ShieldAlert} tone="bad" title="We can't find this payment" message={(q.error as Error | null)?.message} />
      </AppShell>
    );
  }

  const cc = i.crosschain;
  const deposit = cc?.depositAddress ?? null;
  const showDeposit = i.route === 'CROSSCHAIN' && !!deposit && ['AWAITING_DEPOSIT', 'COMMITTED', 'PROCESSING', 'UNDERPAID', 'EXPIRED'].includes(l!);
  const required = cc ? BigInt(cc.required) : 0n;
  const received = cc ? BigInt(cc.received) : 0n;
  const pct = required > 0n ? Number((received * 100n) / required) : 0;
  const originAmount = origin?.amount ?? cc?.originAmountIn ?? null;
  const originSym = origin?.symbol ?? 'tokens';
  const originDec = origin?.decimals ?? 6;
  const eip681 =
    origin?.evmChainId && deposit && originAmount
      ? origin.contractAddress
        ? `ethereum:${origin.contractAddress}@${origin.evmChainId}/transfer?address=${deposit}&uint256=${originAmount}`
        : `ethereum:${deposit}@${origin.evmChainId}?value=${originAmount}`
      : deposit ?? '';
  const refundAt = i.refundableAt;
  const simulated = cc?.mode === 'simulated';

  const originChainIdForBal = origin?.evmChainId ?? null;
  const payAddress = session.profile?.addresses.pay ?? null;
  useEffect(() => {
    if (!originChainIdForBal || !payAddress || !ORIGIN_CHAINS[originChainIdForBal]) return;
    let live = true;
    const read = () =>
      originBalance(originChainIdForBal, payAddress as `0x${string}`)
        .then((b) => live && setOriginHeld(b))
        .catch(() => undefined);
    read();
    const t = setInterval(read, 15_000);
    return () => { live = false; clearInterval(t); };
  }, [originChainIdForBal, payAddress]);

  // The customer can settle the origin leg from their own passkey wallet when that wallet
  // holds enough of the origin stablecoin. They sign; the relayer pays the origin gas, so
  // the wallet never needs native currency on that chain.
  const originChainId = origin?.evmChainId ?? null;
  const originSupported = !!originChainId && !!ORIGIN_CHAINS[originChainId];
  const canPayFromWallet =
    originSupported && !!originAmount && originHeld >= BigInt(originAmount) && l === 'AWAITING_DEPOSIT';

  const payFromWallet = async () => {
    if (!originChainId || !deposit || !originAmount) return;
    setBusy('origin');
    try {
      await session.withKeys(`Pay ${formatToken(originAmount, originDec)} ${originSym}`, async (ring) => {
        const acct = await ring.account('pay');
        const auth = await signOriginAuth(originChainId, acct, deposit as `0x${string}`, BigInt(originAmount));
        await api.originPay(chainId, intentId, auth);
      });
      toast.success('Sent — waiting for it to arrive');
      qc.invalidateQueries({ queryKey: ['intent', chainId, intentId] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not pay from your wallet');
    } finally {
      setBusy(null);
    }
  };

  const hashFrom = (s: string) => s.match(/0x[0-9a-fA-F]{64}/)?.[0] ?? s.trim();

  return (
    <AppShell title="Payment" nav="none" back="/app" chainId={chainId}>
      <div className="card row">
        <MerchantAvatar logoUrl={merchant.data?.profile?.logoUrl} name={merchant.data?.profile?.displayName} />
        <div className="grow">
          <div className="small muted">Paying</div>
          <div className="h3">{amount} to {shop}</div>
        </div>
      </div>

      {l !== 'SETTLED' && l !== 'REFUNDED' && l !== 'FAILED' && <StepList steps={steps} />}

      {/* ------- results ------- */}
      {l === 'SETTLED' && (
        <div className="verdict ok">
          <CheckCircle2 size={64} />
          <div className="vt">Paid</div>
          <div>{shop} received {amount}</div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn" onClick={() => router.push(`/receipt/${chainId}/${intentId}`)}><Receipt size={16} /> View receipt</button>
            <button className="btn ghost" onClick={() => router.push('/app')}>Done</button>
          </div>
        </div>
      )}
      {l === 'REFUNDED' && (
        <div className="verdict warn">
          <Undo2 size={48} />
          <div className="vt">Refunded</div>
          <div>Your money was returned to your account.</div>
          <button className="btn" onClick={() => router.push('/app')}>Done</button>
        </div>
      )}
      {l === 'FAILED' && (
        <div className="verdict bad">
          <XCircle size={48} />
          <div className="vt">Payment didn&apos;t go through</div>
          <div>{i.error?.message ?? 'Something went wrong.'} Nothing was charged.</div>
          <button className="btn" onClick={() => router.push(`/pay/${i.invoiceShortCode}`)}>Try again</button>
        </div>
      )}
      {l === 'SUBMITTED' && (
        <div className="notice info"><Loader2 size={18} className="spin" /><div><b>Sending…</b> This takes about a second.</div></div>
      )}
      {l === 'PROCESSING' && (
        <div className="notice info"><RefreshCw size={18} className="spin" /><div><b>Deposit seen — converting.</b> Usually 1–3 minutes.</div></div>
      )}
      {l === 'UNDERPAID' && (
        <div className="notice warn">
          <AlertTriangle size={18} />
          <div>
            <b>Not enough arrived.</b> Received {formatToken(received, dec)} of {formatToken(required, dec)}. Send the rest, or wait.
            {refundAt ? ` You'll be refunded automatically at ${when(refundAt)}.` : ''}
          </div>
        </div>
      )}
      {l === 'RECONCILIATION_REQUIRED' && (
        <div className="notice warn">
          <ShieldAlert size={18} />
          <div>
            <b>We&apos;re double-checking.</b> The exchange said it&apos;s done, but the money hasn&apos;t arrived. The shop isn&apos;t marked paid.
            {refundAt ? ` If it doesn't arrive, you're refunded at ${when(refundAt)}.` : ''}
          </div>
        </div>
      )}
      {l === 'EXPIRED' && (
        <div className="notice warn">
          <Timer size={18} />
          <div>
            <b>Time&apos;s up.</b> If you already sent it, it will still complete. Otherwise you&apos;ll be refunded
            {refundAt ? ` at ${when(refundAt)}` : ' automatically'}.
          </div>
        </div>
      )}

      {/* ------- deposit panel ------- */}
      {showDeposit && deposit && canPayFromWallet && (
        <div className="card col">
          <div className="label row"><Wallet size={14} /> Pay from your wallet</div>
          <div>
            Your account holds <b>{formatToken(originHeld, originDec)} {originSym}</b> on{' '}
            <b>{ORIGIN_CHAINS[originChainId!]!.name}</b>. Pay straight from it — you sign, we cover the gas.
          </div>
          <button className="btn neon big block" disabled={busy === 'origin'} onClick={payFromWallet}>
            {busy === 'origin' ? <Spinner /> : <Wallet size={18} />} Pay {formatToken(originAmount!, originDec)} {originSym}
          </button>
          <div className="help">No gas needed on {ORIGIN_CHAINS[originChainId!]!.name}. Your wallet only holds {originSym}.</div>
        </div>
      )}

      {showDeposit && deposit && (
        <div className="card col">
          <div className="label row"><Send size={14} /> Send</div>
          <div>
            Send exactly{' '}
            <b>
              {originAmount ? formatToken(originAmount, originDec) : '—'} {originSym}
            </b>
            {origin?.blockchain ? <> on <b>{origin.blockchain}</b></> : null}
            {originAmount && <> <CopyButton text={formatToken(originAmount, originDec, { stable: false }).replace(/,/g, '')} /></>}
          </div>
          <div className="mono">{deposit}</div>
          <div><CopyButton text={deposit} label="Copy address" small={false} /></div>
          <QrView payload={eip681} size={200} />
          <div className="row between">
            <Countdown until={i.expiresAt} label="Send within" />
          </div>
          <div className="notice warn">
            <AlertTriangle size={18} />
            <div>Only {originSym}{origin?.blockchain ? ` on ${origin.blockchain}` : ''}. Other tokens or chains can&apos;t be recovered.</div>
          </div>

          <label className="field">
            <span className="label row"><Link2 size={13} /> I&apos;ve sent it</span>
            <input className="input" placeholder="Paste the transaction link or hash" value={txInput} onChange={(e) => setTxInput(e.target.value)} />
          </label>
          <button
            className="btn"
            disabled={txInput.trim().length < 10 || busy === 'src'}
            onClick={() => run('src', () => api.sourceTx(chainId, intentId, hashFrom(txInput)), "Thanks — we're watching for it")}
          >
            {busy === 'src' ? <Spinner size={14} /> : <Link2 size={16} />} Submit
          </button>

          <div className="col gap-s">
            <div className="row between small">
              <span>Received {formatToken(received, dec)} of {formatToken(required, dec)} {symbol}</span>
              <span>{pct}%</span>
            </div>
            <div style={{ height: 8, background: 'var(--pale-2)' }}>
              <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: 'var(--ink)' }} />
            </div>
          </div>

          {simulated && (
            <div className="col gap-s">
              <button className="btn neon block" disabled={busy === 'sim'} onClick={() => run('sim', () => api.simulateDeposit(chainId, intentId))}>
                {busy === 'sim' ? <Spinner size={14} /> : <Sparkles size={16} />} Simulate delivery
              </button>
              <button
                className="btn ghost sm"
                disabled={busy === 'half'}
                onClick={() => run('half', () => api.simulateDeposit(chainId, intentId, (required / 2n).toString()))}
              >
                Simulate partial (50%)
              </button>
            </div>
          )}
        </div>
      )}

      {l !== 'SETTLED' && (
        <p className="help row"><Lock size={13} /> <ShieldCheck size={13} /> The shop only gets paid when the exact amount arrives.</p>
      )}

      <TechDetails
        rows={[
          { label: 'Payment id', value: intentId },
          { label: 'Submit tx', value: i.txs.submit, href: explorerTx(dep, i.txs.submit) },
          { label: 'Commit tx', value: i.txs.commit, href: explorerTx(dep, i.txs.commit) },
          { label: 'Settle tx', value: i.txs.settle, href: explorerTx(dep, i.txs.settle) },
          { label: 'Refund tx', value: i.txs.refund, href: explorerTx(dep, i.txs.refund) },
          { label: 'Attest tx', value: i.txs.attest, href: explorerTx(dep, i.txs.attest) },
          { label: 'Forwarder', value: i.forwarder },
        ]}
      />
    </AppShell>
  );
}
