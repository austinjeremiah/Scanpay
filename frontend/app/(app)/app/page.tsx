'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  BadgeCheck, CheckCircle2, ClipboardPaste, CloudOff, Lock, Receipt, ScanLine, Store,
  Wallet, Zap,
} from 'lucide-react';
import { AppShell, InstallBanner } from '@/components/app/shell';
import { useApp } from '@/components/app/providers';
import { Sheet, Skeleton, StateBlock, TokenChip } from '@/components/app/ui';
import { useConfig } from '@/lib/config';
import { useSession } from '@/lib/session';
import { useBalances, totalUsd } from '@/lib/useBalances';
import { formatFiat, formatToken } from '@/lib/format';
import { useFx, useMounted } from '@/lib/hooks';
import { store } from '@/lib/store';

export default function HomePage() {
  const cfg = useConfig();
  const session = useSession();
  const { ensureProfile } = useApp();
  const router = useRouter();
  const mounted = useMounted();
  const fx = useFx();
  const [pasteOpen, setPasteOpen] = useState(false);
  const [paste, setPaste] = useState('');

  const profile = mounted ? session.profile : null;
  const bal = useBalances(cfg.chain, profile?.addresses.pay);
  const total = totalUsd(bal.data);
  const stables = (bal.data ?? []).filter((r) => r.key === 'USDC' || r.key === 'AUSD');

  const goMerchant = () => {
    store.setMode('merchant');
    router.push('/merchant');
  };

  return (
    <AppShell nav="customer">
      <div className="col gap-s">
        <span className="eyebrow">{profile ? 'Welcome back' : 'Welcome'}</span>
        <h1 className="display">{profile ? <>Hi {profile.label}</> : <>Scan. <span className="hl">Pay.</span></>}</h1>
      </div>

      {Boolean(cfg.error) && !cfg.ready && (
        <StateBlock icon={CloudOff} tone="bad" title="Can't reach ScanPay" message="Check your connection." />
      )}

      {/* 2 — balance */}
      <div className="card ink">
        <div className="row between">
          <span className="label">Your balance</span>
          <Wallet size={18} />
        </div>
        {!profile ? (
          <div className="col" style={{ marginTop: 10 }}>
            <p style={{ opacity: 0.8 }}>Create your passkey to get an account. Takes 5 seconds.</p>
            <button className="btn neon" onClick={() => void ensureProfile().catch(() => undefined)}>Create passkey</button>
          </div>
        ) : bal.isLoading ? (
          <div className="col" style={{ marginTop: 12 }}>
            <Skeleton h={34} w="60%" />
            <Skeleton h={18} w="40%" />
          </div>
        ) : (
          <Link href="/wallet" className="col" style={{ marginTop: 12, gap: 8 }}>
            <div className="amount lg">{fx.rate !== null ? formatFiat(total, fx.rate, fx.currency) : `$${total.toFixed(2)}`}</div>
            <div className="row wrap" style={{ gap: 16 }}>
              {stables.map((r) => (
                <span key={r.key} className="row" style={{ gap: 8 }}>
                  <TokenChip symbol={r.token.displaySymbol} />
                  <b>{formatToken(r.balance, r.token.decimals)}</b>
                </span>
              ))}
            </div>
          </Link>
        )}
      </div>

      {/* 3 — big scan */}
      <Link href="/scan" className="btn neon big block"><ScanLine size={24} /> Scan to pay</Link>

      {/* 4 — secondary */}
      <div className="row">
        <button className="btn soft block" onClick={() => setPasteOpen(true)}><ClipboardPaste size={16} /> Paste a link</button>
        <button className="btn soft block" onClick={goMerchant}><Store size={16} /> I&apos;m a merchant</button>
      </div>

      {/* 5 — why it's safe */}
      <div className="card">
        <div className="label" style={{ marginBottom: 8 }}>Why it&apos;s safe</div>
        <div className="col gap-s">
          <div className="row"><BadgeCheck size={18} /> Every shop is verified</div>
          <div className="row"><Lock size={18} /> The amount is locked when you confirm</div>
          <div className="row"><CheckCircle2 size={18} /> You get proof the money arrived</div>
        </div>
      </div>

      <Link href="/activity" className="row small muted"><Receipt size={16} /> Payment history</Link>
      <InstallBanner />
      <p className="center tiny muted row" style={{ justifyContent: 'center' }}>
        <Zap size={12} /> Settles in under a second · Built on Monad
      </p>

      <Sheet open={pasteOpen} onClose={() => setPasteOpen(false)} title="Paste a payment link" icon={ClipboardPaste}>
        <input className="input" placeholder="https://… or payment code" value={paste} onChange={(e) => setPaste(e.target.value)} />
        <button
          className="btn block"
          disabled={!paste.trim()}
          onClick={() => router.push(`/scan?data=${encodeURIComponent(paste.trim())}`)}
        >
          Continue
        </button>
      </Sheet>
    </AppShell>
  );
}
