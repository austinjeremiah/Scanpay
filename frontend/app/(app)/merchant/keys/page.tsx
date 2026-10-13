'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, Ban, BadgeCheck, Fingerprint, Info, KeyRound, Landmark, Lock, PauseCircle, QrCode, RefreshCw, Sparkles,
  Unlock, Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/shell';
import { useApp } from '@/components/app/providers';
import { IndexedTag, Sheet, Skeleton, Spinner, StateBlock, TechDetails } from '@/components/app/ui';
import { api, ApiError } from '@/lib/api';
import { ownerNonce } from '@/lib/chain';
import { explorerTx, findToken } from '@/lib/config';
import { shortHex, when } from '@/lib/format';
import { useSession } from '@/lib/session';
import { signRotation } from '@/lib/sign';
import { toWireSignerRotation } from '@/lib/shared';
import { useMerchant } from '@/lib/useMerchant';

/** M4 — "One Passkey, Many Keys": the key map, rotation, and the on-chain key history. */
export default function MerchantKeys() {
  const router = useRouter();
  const session = useSession();
  const { report } = useApp();
  const mm = useMerchant();
  const { chainId, local, view } = mm;
  const dep = mm.chain?.deployment;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const events = useQuery({
    queryKey: ['merchant-keys', chainId, local?.merchantId],
    queryFn: () => api.merchantKeys(chainId, local!.merchantId),
    enabled: !!local,
  });

  const rotate = async () => {
    if (!local || !view || !dep) return;
    setBusy(true);
    try {
      await session.withKeys('Replace your checkout key', async (ring) => {
        const owner = await ring.account('owner');
        const registry = dep.contracts.MerchantRegistry.address;
        const newSigner = ring.address('invoice', view.keyVersion + 1);
        const rot = {
          merchantId: local.merchantId,
          newSigner,
          nonce: await ownerNonce(chainId, registry, owner.address),
          deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
        };
        const ownerSig = await signRotation(owner, chainId, registry, rot);
        const r = await api.rotateSigner({ chainId, rotation: toWireSignerRotation(rot), ownerSig });
        session.lockTerminal();
        const next = { ...local, keyVersion: r.keyVersion, invoiceSigner: newSigner };
        session.setMerchant(next);
        mm.setLocal(next);
        toast.success(`Checkout key v${r.keyVersion} active. Old QR codes are dead.`);
      });
      void events.refetch();
      void mm.refetch();
      setConfirm(false);
    } catch (e) {
      report(e instanceof ApiError ? e : e);
    } finally {
      setBusy(false);
    }
  };

  if (mm.resolved && !local) {
    return (
      <AppShell title="Keys" nav="merchant">
        <StateBlock icon={KeyRound} title="No shop on this network yet" action={<button className="btn" onClick={() => router.push('/merchant/setup')}>Set up your shop</button>} />
      </AppShell>
    );
  }

  const unlocked = !!session.invoiceSignerUnlockedUntil;
  const minutes = session.invoiceSignerUnlockedUntil ? Math.max(0, Math.round((session.invoiceSignerUnlockedUntil - Date.now()) / 60000)) : 0;
  const tokenSym = (addr: string | null) => findToken(dep, addr)?.token.displaySymbol ?? 'a new token';
  const nodes = [
    { icon: KeyRound, t: 'Owner key', s: 'Approves changes to your shop', r: shortHex(view?.owner) },
    { icon: Landmark, t: 'Payout account', s: 'Receives your money', r: shortHex(view?.payoutWallet) },
    {
      icon: QrCode,
      t: `Checkout key v${view?.keyVersion ?? 1}`,
      s: 'Signs every QR. Replace it if a phone is lost.',
      r: unlocked ? `Unlocked · ${minutes} min` : 'Locked',
      ric: unlocked ? Unlock : Lock,
    },
    { icon: Wallet, t: 'Personal pay account', s: 'Pays other shops', r: shortHex(session.profile?.addresses.pay) },
    { icon: Lock, t: 'History vault key', s: 'Encrypts your history on this phone', r: 'Never leaves the phone' },
  ];

  return (
    <AppShell title="Keys" nav="merchant">
      <h1 className="display">One passkey. <span className="hl">Many keys.</span></h1>
      {mm.loading ? (
        <Skeleton h={300} />
      ) : (
        <div className="col">
          <div className="card ink row">
            <Fingerprint size={26} />
            <div>
              <div className="h3">Your passkey</div>
              <div className="small" style={{ opacity: 0.75 }}>Face ID · on this phone · synced by iCloud / Google</div>
            </div>
          </div>
          <div className="tree">
            {nodes.map((n) => (
              <div className="card row" key={n.t}>
                <span className="avatar sm"><n.icon size={16} /></span>
                <div className="grow">
                  <div className="h3">{n.t}</div>
                  <div className="small muted">{n.s}</div>
                </div>
                <span className="small row" style={{ gap: 4 }}>{n.ric && <n.ric size={13} />}{n.r}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <p className="help row"><Info size={14} /> All five come from one passkey. ScanPay never sees or stores any of them.</p>

      <button className="btn danger block" onClick={() => setConfirm(true)} disabled={!view || view.status === 'REVOKED'}>
        <RefreshCw size={16} /> Replace checkout key
      </button>

      <div className="row between">
        <h2 className="h3">Key history</h2>
        {events.data?.source === 'envio' && <IndexedTag />}
      </div>
      {events.isLoading ? (
        <Skeleton h={90} />
      ) : (
        <div className="timeline card">
          {(events.data?.events ?? []).map((e, i) => {
            const text =
              e.kind === 'REGISTERED' ? `Shop created · checkout key v${e.keyVersion}`
              : e.kind === 'STATUS' ? (e.toStatus === 2 ? 'Verified' : e.toStatus === 3 ? 'Suspended' : e.toStatus === 4 ? 'Revoked' : 'Status updated')
              : e.kind === 'SIGNER_ROTATED' ? `Checkout key replaced → v${e.keyVersion}`
              : `Payout changed to ${tokenSym(e.payoutToken)}`;
            const Ic = e.kind === 'REGISTERED' ? Sparkles : e.kind === 'SIGNER_ROTATED' ? RefreshCw : e.kind === 'PAYOUT_UPDATED' ? Landmark
              : e.toStatus === 3 ? PauseCircle : e.toStatus === 4 ? Ban : BadgeCheck;
            return (
              <div className="ev" key={i}>
                <Ic size={18} />
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{text}</div>
                  <div className="small muted">{when(e.timestamp)}</div>
                  <TechDetails rows={[{ label: 'Transaction', value: e.txHash, href: explorerTx(dep, e.txHash) }]} />
                </div>
              </div>
            );
          })}
          {(events.data?.events.length ?? 0) === 0 && <p className="muted">Nothing yet.</p>}
        </div>
      )}

      <Sheet open={confirm} onClose={() => setConfirm(false)} title="Replace your checkout key?" icon={AlertTriangle}>
        <p className="muted">All QR codes you showed before stop working immediately.</p>
        <div className="row">
          <button className="btn ghost block" onClick={() => setConfirm(false)} disabled={busy}>Cancel</button>
          <button className="btn danger block" onClick={rotate} disabled={busy}>
            {busy ? <Spinner size={14} /> : <RefreshCw size={16} />} Replace key
          </button>
        </div>
      </Sheet>
    </AppShell>
  );
}
