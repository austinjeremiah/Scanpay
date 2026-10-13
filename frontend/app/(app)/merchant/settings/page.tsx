'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeftRight, Banknote, Link2, Lock, Printer, Share2, Store } from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/shell';
import { useApp } from '@/components/app/providers';
import { CopyButton, MerchantAvatar, Pill, Sheet, Skeleton, Spinner, StateBlock, TechDetails } from '@/components/app/ui';
import { api, ApiError } from '@/lib/api';
import { ownerNonce } from '@/lib/chain';
import { explorerAddr, findToken, useConfig } from '@/lib/config';
import { useSession } from '@/lib/session';
import { signPayoutUpdate } from '@/lib/sign';
import { toWirePayoutUpdate, type TokenKey } from '@/lib/shared';
import { store } from '@/lib/store';
import { useMerchant } from '@/lib/useMerchant';

/** M5 — shop settings + payout token change (owner AND payout-wallet signatures). */
export default function MerchantSettings() {
  const router = useRouter();
  const cfg = useConfig();
  const session = useSession();
  const { report } = useApp();
  const mm = useMerchant();
  const { chainId, local, view } = mm;
  const dep = mm.chain?.deployment;
  const [sheet, setSheet] = useState(false);
  const [pick, setPick] = useState<TokenKey | null>(null);
  const [busy, setBusy] = useState(false);

  const current = findToken(dep, view?.payoutToken);
  const options = (Object.entries(dep?.tokens ?? {}) as [TokenKey, NonNullable<NonNullable<typeof dep>['tokens'][TokenKey]>][]).filter(([, t]) => t.roles.includes('payout'));
  const link = local ? `${cfg.publicAppUrl || (typeof window !== 'undefined' ? window.location.origin : '')}/m/${chainId}/${local.merchantId}` : '';

  const changePayout = async () => {
    if (!pick || !local || !dep) return;
    setBusy(true);
    try {
      await session.withKeys('Change how you get paid', async (ring) => {
        const owner = await ring.account('owner');
        const payout = await ring.account('payout');
        const registry = dep.contracts.MerchantRegistry.address;
        const u = {
          merchantId: local.merchantId,
          payoutWallet: payout.address,
          payoutToken: dep.tokens[pick]!.address,
          nonce: await ownerNonce(chainId, registry, owner.address),
          deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
        };
        const { ownerSig, payoutSig } = await signPayoutUpdate(owner, payout, chainId, registry, u);
        const r = await api.updatePayout({ chainId, update: toWirePayoutUpdate(u), ownerSig, payoutSig });
        session.lockTerminal(); // keyVersion bumped
        const next = { ...local, keyVersion: r.keyVersion, payoutTokenKey: pick };
        session.setMerchant(next);
        mm.setLocal(next);
        toast.success(`You'll now be paid in ${dep.tokens[pick]!.displaySymbol}`);
      });
      setSheet(false);
      void mm.refetch();
    } catch (e) {
      report(e instanceof ApiError ? e : e);
    } finally {
      setBusy(false);
    }
  };

  if (mm.resolved && !local) {
    return (
      <AppShell title="Settings" nav="merchant">
        <StateBlock icon={Store} title="No shop on this network yet" action={<button className="btn" onClick={() => router.push('/merchant/setup')}>Set up your shop</button>} />
      </AppShell>
    );
  }
  if (mm.loading || !view) {
    return (
      <AppShell title="Settings" nav="merchant"><Skeleton h={90} /><Skeleton h={160} /></AppShell>
    );
  }

  return (
    <AppShell title="Settings" nav="merchant">
      <div className="card row">
        <MerchantAvatar logoUrl={view.profile?.logoUrl} name={view.profile?.displayName} />
        <div className="grow">
          <div className="h3">{view.profile?.displayName}</div>
          <div className="small muted">{[view.profile?.category, view.profile?.city, view.profile?.country].filter(Boolean).join(' · ')}</div>
        </div>
        <Pill tone={view.status === 'ACTIVE' ? 'ok' : view.status === 'PENDING' ? 'warn' : 'bad'}>{view.status}</Pill>
      </div>
      <p className="help">To change shop details, create a new shop. Details are locked to your registration.</p>

      <div className="card col gap-s">
        <div className="label row"><Banknote size={14} /> Get paid in</div>
        <div className="row between">
          <b>{current?.token.displaySymbol ?? '—'}</b>
          <button className="btn sm soft" onClick={() => { setPick(null); setSheet(true); }}>Change</button>
        </div>
      </div>

      <div className="card col gap-s">
        <div className="label row"><Link2 size={14} /> Shop link</div>
        <div className="mono">{link}</div>
        <div className="row">
          <CopyButton text={link} label="Copy" small={false} />
          <button
            className="btn ghost"
            onClick={async () => {
              try {
                if (navigator.share) await navigator.share({ title: view.profile?.displayName ?? 'ScanPay', url: link });
              } catch { /* cancelled */ }
            }}
          >
            <Share2 size={16} /> Share
          </button>
        </div>
      </div>

      <button className="btn block" onClick={() => router.push('/merchant/qr')}><Printer size={16} /> Print shop QR</button>
      <button className="btn soft block" onClick={() => { session.lockTerminal(); toast('Checkout locked'); }}><Lock size={16} /> Lock checkout now</button>
      <button className="btn ghost block" onClick={() => { store.setMode('customer'); router.push('/app'); }}>
        <ArrowLeftRight size={16} /> Switch to customer
      </button>

      <TechDetails
        rows={[
          { label: 'Merchant id', value: view.merchantId },
          { label: 'Owner', value: view.owner, href: explorerAddr(dep, view.owner) },
          { label: 'Payout wallet', value: view.payoutWallet, href: explorerAddr(dep, view.payoutWallet) },
          { label: 'Checkout key', value: view.invoiceSigner },
          { label: 'Key version', value: String(view.keyVersion) },
          { label: 'Registry', value: dep?.contracts.MerchantRegistry.address, href: explorerAddr(dep, dep?.contracts.MerchantRegistry.address) },
        ]}
      />

      <Sheet open={sheet} onClose={() => setSheet(false)} title="Get paid in" icon={Banknote}>
        <div className="col gap-s">
          {options.map(([key, t]) => (
            <button key={key} className={`opt ${(pick ?? current?.key) === key ? 'sel' : ''}`} onClick={() => setPick(key)}>
              <span className="ico"><Banknote size={20} /></span>
              <span className="grow"><div className="t">{t.displaySymbol}</div><div className="s">{t.symbol}</div></span>
            </button>
          ))}
        </div>
        <p className="help">This replaces your checkout key too. Old QR codes stop working.</p>
        <button className="btn big block" disabled={!pick || pick === current?.key || busy} onClick={changePayout}>
          {busy ? <Spinner /> : null} Confirm with Face ID
        </button>
      </Sheet>
    </AppShell>
  );
}
