'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Hex } from 'viem';
import {
  AlertTriangle, ArrowLeftRight, CheckCircle2, Clock, Globe, Info, Loader2, Lock, RefreshCw, ScanFace, SearchX, ShieldAlert,
  ShieldCheck, StickyNote, Zap, FlaskConical, ReceiptText,
} from 'lucide-react';
import { AppShell } from '@/components/app/shell';
import { useApp } from '@/components/app/providers';
import {
  Amount, Countdown, FiatLine, MerchantAvatar, Notice, Sheet, Skeleton, Spinner, StateBlock, TechDetails, TokenChip,
  VerifiedBadge,
} from '@/components/app/ui';
import { api, ApiError, streams } from '@/lib/api';
import { approveMax, nativeBalance } from '@/lib/chain';
import { findToken, useConfig, explorerAddr } from '@/lib/config';
import { CHAIN_NAMES, formatToken, shortHex } from '@/lib/format';
import { useFx, useMounted, useNow, vibrate } from '@/lib/hooks';
import { PasskeyError, useSession } from '@/lib/session';
import { signPrepared } from '@/lib/sign';
import { useSse } from '@/lib/sse';
import { useBalances } from '@/lib/useBalances';
import type { QuoteRes, TokenKey } from '@/lib/shared';

type Choice =
  | { route: 'DIRECT' }
  | { route: 'SWAP'; tokenKey: TokenKey; quote?: QuoteRes }
  | { route: 'CROSSCHAIN'; assetId: string; quote?: QuoteRes; refundTo?: string };

export default function PayPage() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const cfg = useConfig();
  const session = useSession();
  const { report, ensureProfile } = useApp();
  const mounted = useMounted();
  const now = useNow();

  const inv = useQuery({ queryKey: ['invoice', code], queryFn: () => api.invoice(code), retry: false });
  const routes = useQuery({
    queryKey: ['routes', code],
    queryFn: () => api.routes(code),
    enabled: !!inv.data,
    retry: false,
  });
  useSse(streams.invoice(code), () => void qc.invalidateQueries({ queryKey: ['invoice', code] }));

  const invoice = inv.data;
  const chainId = invoice?.chainId ?? cfg.chainId;
  const chain = cfg.get(chainId);
  const dep = chain?.deployment;
  const payout = findToken(dep, invoice?.invoice.payoutToken);
  const decimals = payout?.token.decimals ?? 6;
  const symbol = payout?.token.displaySymbol ?? 'USDC';
  const profile = mounted ? session.profile : null;
  const bal = useBalances(chain, profile?.addresses.pay);
  const nativeMon = useQuery({
    queryKey: ['native-balance', chainId, profile?.addresses.pay],
    enabled: !!profile,
    refetchInterval: 15_000,
    queryFn: () => nativeBalance(chainId, profile!.addresses.pay as `0x${string}`),
  });
  const fx = useFx(invoice?.fiat?.currency);

  const [choice, setChoice] = useState<Choice | null>(null);
  const [tokenSheet, setTokenSheet] = useState(false);
  const [chainSheet, setChainSheet] = useState(false);
  const [permission, setPermission] = useState<null | ((ok: boolean) => void)>(null);
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [refundDraft, setRefundDraft] = useState('');
  const [quotes, setQuotes] = useState<Record<string, QuoteRes | 'loading' | 'error'>>({});

  const balanceOf = (key: TokenKey) => {
    const erc20 = bal.data?.find((r) => r.key === key)?.balance ?? 0n;
    // WMON on mainnet: native MON can also be used (add to show real available balance)
    if (key === 'WMON' && nativeMon.data) return erc20 + nativeMon.data;
    return erc20;
  };
  const amount = invoice ? BigInt(invoice.invoice.amount) : 0n;
  const expiresAt = invoice ? Number(invoice.invoice.expiresAt) : 0;
  const expired = invoice ? invoice.state === 'EXPIRED' || (expiresAt > 0 && now >= expiresAt) : false;
  const merchant = invoice?.merchant;
  const verified = !!merchant && merchant.status === 'ACTIVE' && merchant.profileVerified;
  const amountLabel = `${formatToken(amount, decimals)} ${symbol}`;
  const usd = (Number(amount) / 10 ** decimals) * (payout?.token.usdPrice ?? 1);

  const loadQuote = useCallback(
    async (key: string, req: Parameters<typeof api.quote>[0]) => {
      setQuotes((q) => ({ ...q, [key]: 'loading' }));
      try {
        const r = await api.quote(req);
        setQuotes((q) => ({ ...q, [key]: r }));
        return r;
      } catch {
        setQuotes((q) => ({ ...q, [key]: 'error' }));
        return undefined;
      }
    },
    [],
  );

  // keep the chosen quote fresh
  useEffect(() => {
    if (!choice || choice.route === 'DIRECT' || !choice.quote || !profile) return;
    if (choice.quote.expiresAt - now > 0) return;
    const req =
      choice.route === 'SWAP'
        ? { shortCode: code, route: 'SWAP' as const, inputTokenKey: choice.tokenKey, payer: profile.addresses.pay }
        : { shortCode: code, route: 'CROSSCHAIN' as const, originAssetId: choice.assetId, payer: profile.addresses.pay };
    void api.quote(req).then((q) => setChoice((c) => (c && c.route !== 'DIRECT' ? { ...c, quote: q } : c))).catch(() => undefined);
  }, [now, choice, profile, code]);

  const openTokens = async () => {
    try {
      const p = await ensureProfile();
      setTokenSheet(true);
      for (const key of routes.data?.swap.tokens ?? []) {
        void loadQuote(`SWAP:${key}`, { shortCode: code, route: 'SWAP', inputTokenKey: key, payer: p.addresses.pay as Hex });
      }
    } catch { /* dismissed */ }
  };
  const openChains = async () => {
    try {
      await ensureProfile();
      setChainSheet(true);
    } catch { /* dismissed */ }
  };

  const pickToken = (key: TokenKey) => {
    const q = quotes[`SWAP:${key}`];
    setChoice({ route: 'SWAP', tokenKey: key, quote: typeof q === 'object' ? q : undefined });
    setTokenSheet(false);
  };
  const pickAsset = async (assetId: string) => {
    if (!profile) return;
    const q = await loadQuote(`CC:${assetId}`, { shortCode: code, route: 'CROSSCHAIN', originAssetId: assetId, payer: profile.addresses.pay as Hex });
    setChoice({ route: 'CROSSCHAIN', assetId, quote: q, refundTo: refundDraft || profile.addresses.pay });
    setChainSheet(false);
  };

  const confirmPermission = () => new Promise<boolean>((resolve) => setPermission(() => (ok: boolean) => { setPermission(null); resolve(ok); }));

  const pay = async () => {
    if (!invoice || !choice) return;
    setBusy(true);
    setFailure(null);
    try {
      const p = await ensureProfile();
      const prep = await api.prepare({
        shortCode: code,
        route: choice.route,
        inputTokenKey: choice.route === 'SWAP' ? choice.tokenKey : undefined,
        origin:
          choice.route === 'CROSSCHAIN'
            ? { assetId: choice.assetId, refundTo: choice.refundTo ?? p.addresses.pay }
            : undefined,
        payer: p.addresses.pay as Hex,
      });
      if (prep.swap?.needsApproval && !(await confirmPermission())) return;

      if (choice.route === 'CROSSCHAIN') {
        const asset = routes.data?.crosschain.originAssets.find((a) => a.assetId === choice.assetId);
        try {
          sessionStorage.setItem(
            `scanpay.origin.${prep.intentId}`,
            JSON.stringify({ ...asset, amount: prep.crosschain?.originAmountIn ?? null }),
          );
        } catch { /* ignore */ }
      }

      const merchantName = merchant?.profile?.displayName ?? 'the shop';
      await session.withKeys(`Pay ${amountLabel} to ${merchantName}`, async (ring) => {
        const acct = await ring.account('pay');
        if (prep.swap?.needsApproval) {
          if (prep.swap.dripAvailable) await api.drip(prep.chainId, acct.address, (choice as { tokenKey: TokenKey }).tokenKey);
          await approveMax(prep.chainId, acct, prep.intent.inputToken as Hex, prep.swap.spender as Hex);
        }
        const sigs = await signPrepared(acct, prep);
        const res = await api.submit({ draftId: prep.draftId, ...sigs });
        await session.saveReceipt(
          {
            chainId: prep.chainId,
            intentId: prep.intentId,
            merchantName,
            amount: prep.intent.amountOut,
            tokenSymbol: symbol,
            route: choice.route,
            at: Math.floor(Date.now() / 1000),
          },
          ring,
        );
        vibrate(res.lifecycle === 'SETTLED' ? 80 : 30);
        router.replace(`/payment/${prep.chainId}/${prep.intentId}`);
      });
    } catch (e) {
      if (e instanceof ApiError) setFailure(e);
      else if (e instanceof PasskeyError) report(e);
      else if ((e as Error)?.message !== 'dismissed') report(e);
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------------------------------------- render */
  if (inv.isLoading) {
    return (
      <AppShell title="Pay" back="/scan" nav="none">
        <Skeleton h={90} /> <Skeleton h={60} w="50%" /> <Skeleton h={70} /> <Skeleton h={70} />
      </AppShell>
    );
  }
  if (inv.error || !invoice) {
    const notFound = (inv.error as ApiError | null)?.code === 'INVOICE_NOT_FOUND';
    return (
      <AppShell title="Pay" back="/scan" nav="none">
        <StateBlock
          icon={notFound ? SearchX : ShieldAlert}
          tone="bad"
          title={notFound ? "This payment link doesn't exist" : "Can't load this payment"}
          message={notFound ? 'Ask the shop for a new QR.' : (inv.error as ApiError | null)?.message}
          action={<button className="btn" onClick={() => router.push('/scan')}>Scan again</button>}
        />
      </AppShell>
    );
  }

  const header = (
    <>
      <div className="card">
        <div className="row">
          <MerchantAvatar logoUrl={merchant?.profile?.logoUrl} name={merchant?.profile?.displayName} />
          <div className="grow">
            <div className="h3">{merchant?.profile?.displayName ?? 'Unknown shop'}</div>
            <div className="small muted">
              {[merchant?.profile?.category, merchant?.profile?.city].filter(Boolean).join(' · ')}
            </div>
          </div>
          <button onClick={() => setTrust(true)} aria-label="Why you can trust this"><VerifiedBadge verified={verified} /></button>
        </div>
      </div>
      <div className="col gap-s">
        <Amount value={amount} decimals={decimals} symbol={symbol} size="xl" />
        {invoice.fiat ? (
          <span className="muted small">{invoice.fiat.currency} {invoice.fiat.amount} bill</span>
        ) : (
          <FiatLine usd={usd} rate={fx.rate} currency={fx.currency} />
        )}
        {invoice.memo && <div className="row small muted"><StickyNote size={14} /> {invoice.memo}</div>}
        {!expired && invoice.state === 'OPEN' && <div><Countdown until={expiresAt} label="Expires in" /></div>}
      </div>
    </>
  );

  // terminal / blocked states
  let blocked: React.ReactNode = null;
  if (invoice.state === 'PAID') {
    blocked = (
      <StateBlock
        icon={CheckCircle2}
        tone="ok"
        title="Already paid"
        action={
          invoice.paidIntentId ? (
            <button className="btn" onClick={() => router.push(`/receipt/${invoice.chainId}/${invoice.paidIntentId}`)}>View receipt</button>
          ) : undefined
        }
      />
    );
  } else if (expired) {
    blocked = (
      <StateBlock
        icon={Clock}
        tone="warn"
        title="This QR expired"
        message="Ask the shop to show a new one."
        action={<button className="btn" onClick={() => router.push('/scan')}>Scan again</button>}
      />
    );
  } else if (invoice.state === 'RESERVED') {
    blocked = <StateBlock icon={Loader2} title="Someone is paying this QR right now" message="If it was you, check Activity." />;
  }

  const insufficientDirect = routes.data?.direct.available && payout ? balanceOf(payout.key) < amount : false;
  const sel = choice?.route;
  const swapKey = choice?.route === 'SWAP' ? choice.tokenKey : null;
  const swapToken = swapKey ? dep?.tokens[swapKey] : null;
  const quote = choice && choice.route !== 'DIRECT' ? choice.quote : undefined;
  const canPay = !!choice && !busy && verified && (choice.route !== 'DIRECT' || !insufficientDirect);

  return (
    <AppShell title="Pay" back="/scan" nav="none" chainId={invoice.chainId}>
      {header}

      {!verified && (
        <Notice tone="bad" icon={ShieldAlert}>
          <b>This shop isn&apos;t verified. Don&apos;t pay.</b>
        </Notice>
      )}

      {blocked ??
        (verified && (
          <>
            <div className="label">Pay with</div>
            <div className="col gap-s">
              {/* A — DIRECT */}
              {routes.data?.direct.available !== false && (
                <button
                  className={`opt ${sel === 'DIRECT' ? 'sel' : ''}`}
                  disabled={!routes.data?.direct.available || insufficientDirect}
                  onClick={() => setChoice({ route: 'DIRECT' })}
                >
                  <span className="ico"><Zap size={20} /></span>
                  <span className="grow">
                    <div className="t">{symbol} balance</div>
                    <div className="s">{insufficientDirect ? 'Not enough funds' : 'Instant · no fees'}</div>
                  </span>
                  <span className="small">{profile ? `You have ${formatToken(balanceOf(payout?.key ?? 'USDC'), decimals)}` : ''}</span>
                </button>
              )}
              {/* B — SWAP */}
              {routes.data?.swap.available && (
                <button className={`opt ${sel === 'SWAP' ? 'sel' : ''}`} onClick={openTokens}>
                  <span className="ico"><ArrowLeftRight size={20} /></span>
                  <span className="grow">
                    <div className="t">Another token</div>
                    <div className="s">
                      {swapToken ? `${swapToken.displaySymbol}` : (routes.data.swap.tokens ?? []).map((k) => dep?.tokens[k]?.displaySymbol ?? k).join(', ')}
                    </div>
                  </span>
                  {swapKey && profile && <span className="small">{formatToken(balanceOf(swapKey), swapToken?.decimals ?? 18)}</span>}
                </button>
              )}
              {/* C — CROSSCHAIN */}
              {routes.data?.crosschain.available && (
                <button className={`opt ${sel === 'CROSSCHAIN' ? 'sel' : ''}`} onClick={openChains}>
                  <span className="ico"><Globe size={20} /></span>
                  <span className="grow">
                    <div className="t">Another chain</div>
                    <div className="s">Base, Arbitrum, Ethereum…</div>
                  </span>
                  {routes.data.crosschain.mode === 'simulated' && <span className="pill warn"><FlaskConical size={12} /> Simulated</span>}
                </button>
              )}
              {routes.isLoading && <Skeleton h={64} />}
              {routes.error && <Notice tone="bad"><b>{(routes.error as ApiError).message}</b></Notice>}
            </div>

            {/* 12 — summary */}
            {choice && (
              <div className="card">
                <div className="label row"><ReceiptText size={14} /> Summary</div>
                {choice.route !== 'DIRECT' && quote && (
                  <>
                    <div className="kv">
                      <span className="k">You pay</span>
                      <span className="v">
                        ≈{' '}
                        {choice.route === 'CROSSCHAIN' && quote.originAmountIn
                          ? (() => {
                              const a = routes.data?.crosschain.originAssets.find((x) => x.assetId === choice.assetId);
                              return `${formatToken(quote.originAmountIn, a?.decimals ?? 6)} ${a?.symbol ?? ''}`;
                            })()
                          : `${formatToken(quote.estimatedIn, swapToken?.decimals ?? 18)} ${swapToken?.displaySymbol ?? ''}`}
                      </span>
                    </div>
                    {choice.route === 'SWAP' && (
                      <div className="kv">
                        <span className="k row" style={{ gap: 4 }}>Max you can pay <Info size={13} /></span>
                        <span className="v muted">{formatToken(quote.maxAmountIn, swapToken?.decimals ?? 18)} {swapToken?.displaySymbol}</span>
                      </div>
                    )}
                  </>
                )}
                {choice.route === 'DIRECT' && (
                  <div className="kv"><span className="k">You pay</span><span className="v">{amountLabel}</span></div>
                )}
                <div className="kv"><span className="k">{merchant?.profile?.displayName ?? 'Shop'} receives</span><span className="v">{amountLabel}</span></div>
                <div className="kv"><span className="k">Network fee</span><span className="v" style={{ color: 'var(--ok)' }}>Free</span></div>
                {quote && choice.route !== 'DIRECT' && (
                  <div className="kv"><span className="k">Price valid for</span><span className="v"><Countdown until={quote.expiresAt} /></span></div>
                )}
                {choice.route === 'SWAP' && quote && <p className="help" style={{ marginTop: 6 }}>Unused amount is returned automatically.</p>}
              </div>
            )}

            {failure && (
              <div className="col gap-s">
                <Notice tone="bad" icon={ShieldAlert}>
                  <b>{failure.message}</b>
                </Notice>
                <TechDetails
                  rows={[
                    { label: 'Code', value: failure.code },
                    { label: 'Request', value: failure.requestId },
                  ]}
                />
              </div>
            )}

            <button className="btn neon big block" disabled={!canPay} onClick={pay}>
              {busy ? <Spinner /> : <ScanFace size={22} />}
              {busy ? 'Confirming…' : profile ? 'Pay with Face ID' : 'Create passkey to pay'}
            </button>
            <p className="center tiny muted row" style={{ justifyContent: 'center' }}>
              <Lock size={12} /> The shop, amount and where the money goes are locked by your confirmation.
            </p>
          </>
        ))}

      <TechDetails
        rows={[
          { label: 'Merchant id', value: shortHex(merchant?.merchantId, 8), href: explorerAddr(dep, merchant?.payoutWallet) },
          { label: 'Order id', value: shortHex(invoice.invoice.invoiceId, 8) },
          { label: 'Payout token', value: payout?.token.address },
          { label: 'Network', value: dep?.network },
        ]}
      />

      {/* P4.1 token sheet */}
      <Sheet open={tokenSheet} onClose={() => setTokenSheet(false)} title="Pay with another token" icon={ArrowLeftRight}>
        <div className="col gap-s">
          {(routes.data?.swap.tokens ?? []).map((key) => {
            const t = dep?.tokens[key];
            const q = quotes[`SWAP:${key}`];
            const enough = typeof q === 'object' ? balanceOf(key) >= BigInt(q.maxAmountIn) : true;
            const failed = q === 'error';
            const retry = () => profile && loadQuote(`SWAP:${key}`, { shortCode: code, route: 'SWAP', inputTokenKey: key, payer: profile.addresses.pay as Hex });
            return (
              <button key={key} className="opt" disabled={!failed && (!enough)} onClick={() => failed ? retry() : pickToken(key)}>
                <TokenChip symbol={t?.displaySymbol ?? key} />
                <span className="grow small muted">You have {formatToken(balanceOf(key), t?.decimals ?? 18)}</span>
                <span className="small">
                  {q === 'loading' || q === undefined ? <Spinner size={14} /> : failed ? <><RefreshCw size={14} /> Retry</> : enough ? `≈ ${formatToken(q.estimatedIn, t?.decimals ?? 18)}` : 'Not enough'}
                </span>
              </button>
            );
          })}
        </div>
        <p className="help row"><Info size={14} /> First time with a token? You&apos;ll give a one-time permission. Still confirmed with Face ID every time.</p>
      </Sheet>

      {/* P4.2 chain sheet */}
      <Sheet open={chainSheet} onClose={() => setChainSheet(false)} title="Pay from another chain" icon={Globe}>
        {routes.data?.crosschain.mode === 'simulated' && (
          <Notice tone="warn" icon={FlaskConical}>Test mode: delivery is simulated. You&apos;ll tap a button instead of sending real funds.</Notice>
        )}
        {cfg.isLive(invoice.chainId) && (
          <label className="field">
            <span className="label">Your address on that chain (for refunds)</span>
            <input className="input" placeholder={profile?.addresses.pay} value={refundDraft} onChange={(e) => setRefundDraft(e.target.value)} />
            {refundDraft && !/^0x[0-9a-fA-F]{40}$/.test(refundDraft) && <span className="err">That doesn&apos;t look like a valid address.</span>}
          </label>
        )}
        {Object.entries(
          (routes.data?.crosschain.originAssets ?? []).reduce<Record<string, NonNullable<typeof routes.data>['crosschain']['originAssets']>>((m, a) => {
            (m[a.blockchain] ??= []).push(a);
            return m;
          }, {}),
        ).map(([chain, assets]) => (
          <div key={chain} className="col gap-s">
            <div className="label">{CHAIN_NAMES[assets[0]!.evmChainId ?? -1] ?? chain}</div>
            {assets.map((a) => {
              const q = quotes[`CC:${a.assetId}`];
              const badRefund = cfg.isLive(invoice.chainId) && !!refundDraft && !/^0x[0-9a-fA-F]{40}$/.test(refundDraft);
              return (
                <button key={a.assetId} className="opt" disabled={badRefund} onClick={() => void pickAsset(a.assetId)}>
                  <TokenChip symbol={a.symbol} chain={chain} />
                  <span className="grow" />
                  <span className="small">{typeof q === 'object' && q.originAmountIn ? `≈ ${formatToken(q.originAmountIn, a.decimals)}` : ''}</span>
                </button>
              );
            })}
          </div>
        ))}
        <p className="help row"><Clock size={14} /> Usually arrives in 1–3 minutes. If it doesn&apos;t, you&apos;re refunded automatically.</p>
      </Sheet>

      {/* P4.3 one-time permission */}
      <Sheet open={!!permission} onClose={() => permission?.(false)} title={`Allow ${swapToken?.displaySymbol ?? 'this token'} for ScanPay payments`} icon={ShieldCheck}>
        <p className="muted">One time only. ScanPay can only move {swapToken?.displaySymbol ?? 'it'} when you confirm a payment with Face ID.</p>
        <div className="col gap-s">
          <div className="row"><CheckCircle2 size={16} /> We cover the small network cost</div>
          <div className="row"><CheckCircle2 size={16} /> You can remove it anytime</div>
        </div>
        <button className="btn big block" onClick={() => permission?.(true)}><ScanFace size={20} /> Allow and pay</button>
        <button className="btn ghost block" onClick={() => permission?.(false)}>Cancel</button>
      </Sheet>

      {/* trust sheet */}
      <Sheet open={trust} onClose={() => setTrust(false)} title="Why you can trust this" icon={ShieldCheck}>
        <div className="col">
          <div className="row"><CheckCircle2 size={18} /> Registered and verified by ScanPay ({merchant?.status === 'ACTIVE' ? 'active' : merchant?.status?.toLowerCase()})</div>
          <div className="row"><CheckCircle2 size={18} /> Payout account is locked to this shop</div>
          <div className="row"><CheckCircle2 size={18} /> This QR was signed by the shop&apos;s checkout key (version {invoice.invoice.keyVersion})</div>
          <div className="row">
            {merchant?.profileVerified ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />} Shop details match what they registered
          </div>
        </div>
        <TechDetails
          rows={[
            { label: 'Merchant id', value: merchant?.merchantId },
            { label: 'Owner', value: merchant?.owner, href: explorerAddr(dep, merchant?.owner) },
            { label: 'Payout wallet', value: merchant?.payoutWallet, href: explorerAddr(dep, merchant?.payoutWallet) },
            { label: 'Registry', value: dep?.contracts.MerchantRegistry.address, href: explorerAddr(dep, dep?.contracts.MerchantRegistry.address) },
          ]}
        />
      </Sheet>
    </AppShell>
  );
}
