'use client';
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowLeft, ArrowLeftRight, BarChart3, Check, CircleDot, Download, FlaskConical, Home, KeyRound,
  Receipt, ScanLine, Settings, ShieldCheck, Share, Store, WifiOff, Wallet, X,
} from 'lucide-react';
import { useConfig } from '@/lib/config';
import { store } from '@/lib/store';
import { Notice, Sheet } from './ui';

export type NavKind = 'customer' | 'merchant' | 'none';

function NetworkPill() {
  const cfg = useConfig();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<number | null>(null);
  const live = cfg.chainId === 143;
  const choose = (id: number) => {
    if (id === cfg.chainId) return setOpen(false);
    if (id === 143) return setConfirm(id);
    cfg.setChainId(id);
    void qc.invalidateQueries();
    setOpen(false);
  };
  const name = (id: number) => (id === 143 ? 'Live' : id === 31337 ? 'Local' : 'Test mode');
  const sub = (id: number) =>
    id === 143 ? 'Real money. Payments are capped at 25 USD.' : id === 31337 ? 'Local development network.' : 'Free test money. Try everything.';
  return (
    <>
      <button className={`pill btnlike ${live ? 'ok' : 'warn'}`} onClick={() => setOpen(true)} aria-label="Change network">
        {live ? <CircleDot size={13} /> : <FlaskConical size={13} />}
        {live ? 'Live' : 'Test mode'}
      </button>
      <Sheet open={open && confirm === null} onClose={() => setOpen(false)} title="Network">
        {(cfg.chains.length ? cfg.chains.map((c) => c.chainId) : [cfg.chainId]).map((id) => (
          <button key={id} className={`opt ${id === cfg.chainId ? 'sel' : ''}`} onClick={() => choose(id)}>
            <span className="ico">{id === 143 ? <CircleDot size={20} /> : <FlaskConical size={20} />}</span>
            <span className="grow">
              <div className="t">{name(id)}</div>
              <div className="s">{sub(id)}</div>
            </span>
            {id === cfg.chainId && <Check size={20} />}
          </button>
        ))}
      </Sheet>
      <Sheet open={confirm !== null} onClose={() => setConfirm(null)} title="Switch to real money?" icon={AlertTriangle}>
        <p className="muted">You&apos;re switching to real money. Payments made in Live mode are real.</p>
        <div className="row">
          <button className="btn ghost block" onClick={() => setConfirm(null)}>Cancel</button>
          <button
            className="btn block"
            onClick={() => {
              cfg.setChainId(confirm!);
              void qc.invalidateQueries();
              setConfirm(null);
              setOpen(false);
            }}
          >
            Switch
          </button>
        </div>
      </Sheet>
    </>
  );
}

/** Same chain badge for pages that carry their own network (pay links, receipts). */
export function ChainPill({ chainId }: { chainId: number }) {
  return chainId === 143 ? (
    <span className="pill ok"><CircleDot size={13} /> Live</span>
  ) : (
    <span className="pill warn"><FlaskConical size={13} /> Test mode</span>
  );
}

function InstallBanner() {
  const [evt, setEvt] = useState<any>(null);
  const [ios, setIos] = useState(false);
  const [hidden, setHidden] = useState(true);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    try {
      const until = Number(localStorage.getItem('scanpay.installDismissed') ?? 0);
      if (Date.now() < until) return;
    } catch { /* ignore */ }
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone;
    if (standalone) return;
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIos) {
      setIos(true);
      setHidden(false);
    }
    const h = (e: Event) => {
      e.preventDefault();
      setEvt(e);
      setHidden(false);
    };
    window.addEventListener('beforeinstallprompt', h);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);
  if (hidden) return null;
  const dismiss = () => {
    setHidden(true);
    try { localStorage.setItem('scanpay.installDismissed', String(Date.now() + 7 * 86400_000)); } catch { /* ignore */ }
  };
  return (
    <>
      <div className="card line row">
        <Download size={20} />
        <span className="grow">Add ScanPay to your home screen</span>
        <button className="btn sm" onClick={() => (ios ? setHelp(true) : evt?.prompt())}>Install</button>
        <button className="sp-icon-btn" style={{ width: 30, height: 30 }} onClick={dismiss} aria-label="Dismiss"><X size={14} /></button>
      </div>
      <Sheet open={help} onClose={() => setHelp(false)} title="Add to Home Screen" icon={Share}>
        <p>Tap <b>Share</b>, then <b>Add to Home Screen</b>.</p>
        <button className="btn block" onClick={() => setHelp(false)}>Got it</button>
      </Sheet>
    </>
  );
}
export { InstallBanner };

const CUSTOMER_NAV = [
  { href: '/app', label: 'Home', icon: Home },
  { href: '/scan', label: 'Scan', icon: ScanLine, scan: true },
  { href: '/activity', label: 'Activity', icon: Receipt },
  { href: '/wallet', label: 'Wallet', icon: Wallet },
];
const MERCHANT_NAV = [
  { href: '/merchant', label: 'Checkout', icon: Store },
  { href: '/merchant/history', label: 'History', icon: BarChart3 },
  { href: '/merchant/keys', label: 'Keys', icon: KeyRound },
  { href: '/merchant/settings', label: 'Settings', icon: Settings },
];

export function AppShell({
  title, nav = 'customer', back, children, hideTop, right, chainId,
}: { title?: string; nav?: NavKind; back?: string | boolean; children: ReactNode; hideTop?: boolean; right?: ReactNode; chainId?: number }) {
  const path = usePathname();
  const router = useRouter();
  const [online, setOnline] = useState(true);
  const [mode, setMode] = useState<'customer' | 'merchant'>('customer');
  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    setMode(store.mode());
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const items = nav === 'merchant' ? MERCHANT_NAV : CUSTOMER_NAV;
  const isActive = (href: string) => (href === '/app' || href === '/merchant' ? path === href : path.startsWith(href));
  const homeHref = nav === 'merchant' ? '/merchant' : '/app';

  const switchMode = () => {
    const next = nav === 'merchant' ? 'customer' : 'merchant';
    store.setMode(next);
    setMode(next);
    router.push(next === 'merchant' ? '/merchant' : '/app');
  };

  return (
    <div className={`sp-shell ${nav !== 'none' ? 'has-nav' : ''}`}>
      {!online && (
        <div className="sp-banner warn">
          <WifiOff size={16} /> You&apos;re offline. Payments need a connection.
        </div>
      )}
      {!hideTop && (
        <header className="sp-top">
          {back ? (
            <Link href={typeof back === 'string' ? back : homeHref} className="sp-icon-btn" aria-label="Back">
              <ArrowLeft size={18} />
            </Link>
          ) : (
            <Link href={homeHref} className="sp-brand" aria-label="ScanPay home">
              <span className="mark"><ShieldCheck size={16} /></span>
              ScanPay
            </Link>
          )}
          <div className="title">{title ?? ''}</div>
          {right}
          {chainId ? <ChainPill chainId={chainId} /> : <NetworkPill />}
          <button className="sp-icon-btn" onClick={switchMode} aria-label={`Switch to ${mode === 'merchant' ? 'customer' : 'merchant'} mode`} title="Customer / merchant">
            <ArrowLeftRight size={16} />
          </button>
        </header>
      )}
      <main className="sp-page">{children}</main>
      {nav !== 'none' && (
        <nav className="sp-nav" aria-label="Main">
          {items.map((it) => (
            <Link key={it.href} href={it.href} className={`${isActive(it.href) ? 'active' : ''} ${(it as any).scan ? 'scan' : ''}`}>
              {(it as any).scan ? (
                <span className="bubble"><it.icon size={26} /></span>
              ) : (
                <it.icon size={20} />
              )}
              {it.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}

/** Banner shown when the API can't be reached. */
export function ConfigGate({ children }: { children: ReactNode }) {
  const cfg = useConfig();
  if (cfg.error && !cfg.ready) {
    return (
      <Notice tone="bad" icon={WifiOff}>
        <b>Can&apos;t reach ScanPay.</b> Check your connection and try again.
      </Notice>
    );
  }
  return <>{children}</>;
}
