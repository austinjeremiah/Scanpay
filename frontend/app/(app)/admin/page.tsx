'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, BadgeCheck, CheckCircle2, Clock, Globe, KeyRound, PauseCircle, PlayCircle, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/shell';
import { MerchantAvatar, Sheet, Skeleton, Spinner, StateBlock, TechDetails } from '@/components/app/ui';
import { api, ApiError } from '@/lib/api';
import { explorerTx, useConfig } from '@/lib/config';
import { shortHex, when } from '@/lib/format';

type Action = 'approve' | 'reactivate' | 'suspend' | 'revoke';
const TABS = [
  { status: 'PENDING', label: 'Pending', icon: Clock },
  { status: 'ACTIVE', label: 'Active', icon: BadgeCheck },
  { status: 'SUSPENDED', label: 'Suspended', icon: PauseCircle },
  { status: 'REVOKED', label: 'Revoked', icon: Ban },
] as const;
const VALID: Record<string, { a: Action; label: string; icon: typeof BadgeCheck }[]> = {
  PENDING: [{ a: 'approve', label: 'Approve', icon: BadgeCheck }, { a: 'revoke', label: 'Revoke', icon: Ban }],
  ACTIVE: [{ a: 'suspend', label: 'Suspend', icon: PauseCircle }, { a: 'revoke', label: 'Revoke', icon: Ban }],
  SUSPENDED: [{ a: 'reactivate', label: 'Reactivate', icon: PlayCircle }, { a: 'revoke', label: 'Revoke', icon: Ban }],
  REVOKED: [],
};

/** O2 — verifier console (not linked from the nav; open by URL). */
export default function AdminPage() {
  const cfg = useConfig();
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState('');
  const [chainId, setChainId] = useState<number | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]['status']>('PENDING');
  const [confirm, setConfirm] = useState<{ id: string; name: string; action: Action } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try { setSaved(sessionStorage.getItem('scanpay.admin') ?? ''); } catch { /* ignore */ }
  }, []);
  const cid = chainId ?? cfg.chainId;
  const dep = cfg.get(cid)?.deployment;

  const list = useQuery({
    queryKey: ['admin', cid, tab, saved],
    queryFn: () => api.adminMerchants(saved, cid, tab),
    enabled: !!saved,
    retry: false,
  });

  if (!saved) {
    return (
      <AppShell title="Admin" nav="none" back="/app">
        <div className="col">
          <h1 className="display">Verifier <span className="hl">console</span></h1>
          <label className="field">
            <span className="label">Admin token</span>
            <span className="input-wrap"><KeyRound size={18} />
              <input className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
            </span>
          </label>
          <button
            className="btn block"
            disabled={!token}
            onClick={() => {
              try { sessionStorage.setItem('scanpay.admin', token); } catch { /* ignore */ }
              setSaved(token);
            }}
          >
            Continue
          </button>
        </div>
      </AppShell>
    );
  }

  const unauthorized = (list.error as ApiError | null)?.code === 'UNAUTHORIZED' || (list.error as ApiError | null)?.status === 401;

  const act = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      const r = await api.adminAction(saved, cid, confirm.id, confirm.action);
      toast.success(`${confirm.name}: ${r.status.toLowerCase()}`, {
        description: dep?.explorer ? undefined : shortHex(r.txHash, 6),
        action: explorerTx(dep, r.txHash) ? { label: 'View', onClick: () => window.open(explorerTx(dep, r.txHash), '_blank') } : undefined,
      });
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ['admin'] });
    } catch (e) {
      toast.error((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell title="Admin" nav="none" back="/app">
      <label className="field">
        <span className="label row"><Globe size={13} /> Network</span>
        <select className="input" value={cid} onChange={(e) => setChainId(Number(e.target.value))}>
          {(cfg.chains.length ? cfg.chains.map((c) => c.chainId) : [cid]).map((id) => (
            <option key={id} value={id}>{id === 143 ? 'Live' : id === 31337 ? 'Local' : 'Test mode'} ({id})</option>
          ))}
        </select>
      </label>
      <div className="row wrap" style={{ gap: 6 }}>
        {TABS.map((t) => (
          <button key={t.status} className={`pill btnlike ${tab === t.status ? 'ink' : ''}`} onClick={() => setTab(t.status)}>
            <t.icon size={12} /> {t.label}
          </button>
        ))}
        <button className="pill btnlike" onClick={() => { try { sessionStorage.removeItem('scanpay.admin'); } catch { /* ignore */ } setSaved(''); }}>Sign out</button>
      </div>

      {unauthorized ? (
        <StateBlock icon={XCircle} tone="bad" title="Wrong admin token" action={<button className="btn" onClick={() => { try { sessionStorage.removeItem('scanpay.admin'); } catch { /* ignore */ } setSaved(''); }}>Enter again</button>} />
      ) : list.isLoading ? (
        <Skeleton h={90} />
      ) : list.error ? (
        <StateBlock icon={XCircle} tone="bad" title="Couldn't load merchants" message={(list.error as Error).message} />
      ) : (list.data?.merchants.length ?? 0) === 0 ? (
        <StateBlock icon={CheckCircle2} title="Nothing here" />
      ) : (
        list.data!.merchants.map((m) => (
          <div key={m.merchantId} className="card col gap-s">
            <div className="row">
              <MerchantAvatar logoUrl={m.profile?.logoUrl} name={m.profile?.displayName} />
              <div className="grow">
                <div className="h3">{m.profile?.displayName ?? shortHex(m.merchantId, 6)}</div>
                <div className="small muted">
                  {[m.profile?.city, m.profile?.country].filter(Boolean).join(', ')} · {when(m.registeredAt)}
                </div>
              </div>
              {m.profileVerified ? <CheckCircle2 size={20} color="var(--ok)" /> : <XCircle size={20} color="var(--bad)" />}
            </div>
            <div className="small muted">Owner <span className="mono">{shortHex(m.owner, 6)}</span></div>
            <div className="row wrap">
              {(VALID[m.status] ?? []).map((v) => (
                <button key={v.a} className={`btn sm ${v.a === 'revoke' ? 'danger' : ''}`} onClick={() => setConfirm({ id: m.merchantId, name: m.profile?.displayName ?? 'Shop', action: v.a })}>
                  <v.icon size={14} /> {v.label}
                </button>
              ))}
            </div>
            <TechDetails rows={[{ label: 'Merchant id', value: m.merchantId }, { label: 'Payout wallet', value: m.payoutWallet }]} />
          </div>
        ))
      )}

      <Sheet open={!!confirm} onClose={() => setConfirm(null)} title={`${confirm?.action ?? ''} ${confirm?.name ?? ''}?`}>
        <div className="row">
          <button className="btn ghost block" onClick={() => setConfirm(null)} disabled={busy}>Cancel</button>
          <button className="btn block" onClick={act} disabled={busy}>{busy ? <Spinner size={14} /> : null} Confirm</button>
        </div>
      </Sheet>
    </AppShell>
  );
}
