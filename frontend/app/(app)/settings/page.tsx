'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Banknote, Check, CircleDot, Fingerprint, FlaskConical, ExternalLink, Globe, Info, LogOut, ShieldCheck } from 'lucide-react';
import { AppShell } from '@/components/app/shell';
import { Sheet } from '@/components/app/ui';
import { useConfig } from '@/lib/config';
import { useMounted } from '@/lib/hooks';
import { useSession } from '@/lib/session';

const CURRENCIES = ['AUTO', 'INR', 'USD', 'EUR', 'GBP', 'SGD', 'AED', 'JPY'];

/** O3 — customer settings. */
export default function SettingsPage() {
  const cfg = useConfig();
  const session = useSession();
  const router = useRouter();
  const qc = useQueryClient();
  const mounted = useMounted();
  const [currency, setCurrency] = useState('AUTO');
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    try { setCurrency(localStorage.getItem('scanpay.currency') ?? 'AUTO'); } catch { /* ignore */ }
  }, []);
  const profile = mounted ? session.profile : null;

  return (
    <AppShell title="Settings" nav="customer" back="/app">
      <div className="card col gap-s">
        <div className="label row"><Globe size={14} /> Network</div>
        {(cfg.chains.length ? cfg.chains.map((c) => c.chainId) : [cfg.chainId]).map((id) => (
          <button
            key={id}
            className={`opt ${id === cfg.chainId ? 'sel' : ''}`}
            onClick={() => {
              cfg.setChainId(id);
              void qc.invalidateQueries();
            }}
          >
            <span className="ico">{id === 143 ? <CircleDot size={20} /> : <FlaskConical size={20} />}</span>
            <span className="grow">
              <div className="t">{id === 143 ? 'Live' : id === 31337 ? 'Local' : 'Test mode'}</div>
              <div className="s">{id === 143 ? 'Real money. Payments are capped at 25 USD.' : 'Free test money. Try everything.'}</div>
            </span>
            {id === cfg.chainId && <Check size={18} />}
          </button>
        ))}
      </div>

      <label className="field">
        <span className="label row"><Banknote size={14} /> Display currency</span>
        <select
          className="input"
          value={currency}
          onChange={(e) => {
            setCurrency(e.target.value);
            try { localStorage.setItem('scanpay.currency', e.target.value); } catch { /* ignore */ }
            void qc.invalidateQueries({ queryKey: ['fx'] });
          }}
        >
          {CURRENCIES.map((c) => <option key={c} value={c}>{c === 'AUTO' ? 'Auto (from your locale)' : c}</option>)}
        </select>
      </label>

      <div className="card col gap-s">
        <div className="label row"><Fingerprint size={14} /> Passkey</div>
        {profile ? (
          <>
            <div><b>{profile.label}</b> · created {new Date(profile.createdAt).toLocaleDateString()}</div>
            <p className="help">Your passkey lives in iCloud Keychain / Google Password Manager.</p>
          </>
        ) : (
          <p className="muted">You haven&apos;t created a passkey on this phone yet.</p>
        )}
      </div>

      <Link href="/attack-lab" className="card col gap-s">
        <div className="label row"><ShieldCheck size={14} /> How you&apos;re protected</div>
        <div>Every shop is verified. The amount is locked when you confirm. You get proof the money arrived.</div>
        <span className="link small">See attacks we block →</span>
      </Link>

      <button className="btn danger block" onClick={() => setConfirm(true)}><LogOut size={16} /> Forget this device</button>

      <div className="card col gap-s">
        <div className="label row"><Info size={14} /> About</div>
        <div>ScanPay Guard · settles on Monad in under a second · open source</div>
        <a className="link row small" href="https://github.com/austinjeremiah/Scanpay" target="_blank" rel="noreferrer"><ExternalLink size={14} /> GitHub</a>
      </div>

      <Sheet open={confirm} onClose={() => setConfirm(false)} title="Forget this device?" icon={LogOut}>
        <p className="muted">Removes ScanPay data from this phone. Your passkey stays in your password manager.</p>
        <div className="row">
          <button className="btn ghost block" onClick={() => setConfirm(false)}>Cancel</button>
          <button
            className="btn danger block"
            onClick={() => {
              session.forgetDevice();
              setConfirm(false);
              router.replace('/welcome');
            }}
          >
            Forget
          </button>
        </div>
      </Sheet>
    </AppShell>
  );
}
