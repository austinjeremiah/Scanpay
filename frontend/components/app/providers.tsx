'use client';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster, toast } from 'sonner';
import {
  EyeOff, Fingerprint, Info, KeyRound, ScanFace, Smartphone, ShieldOff, User, UserPlus, Zap,
} from 'lucide-react';
import { ConfigProvider } from '@/lib/config';
import { PasskeyError, SessionProvider, useSession } from '@/lib/session';
import { ApiError } from '@/lib/api';
import type { LocalProfile } from '@/lib/store';
import { QrView, Sheet, Spinner } from './ui';

type Ctx = {
  /** Show a passkey error sheet or an API error toast. */
  report: (e: unknown) => void;
  /** Resolves with the profile; opens the onboarding sheet when none exists. Rejects if dismissed. */
  ensureProfile: () => Promise<LocalProfile>;
};
const AppCtx = createContext<Ctx | null>(null);

export function useApp() {
  const c = useContext(AppCtx);
  if (!c) throw new Error('useApp outside AppProviders');
  return c;
}

const PASSKEY_SHEETS: Record<string, { icon: typeof ScanFace; title: string; action?: 'retry' | 'phone' | 'copy' | 'create' }> = {
  CANCELLED: { icon: ScanFace, title: 'Not confirmed', action: 'retry' },
  PASSKEY_OPERATION_FAILED: { icon: ScanFace, title: 'Not confirmed', action: 'retry' },
  PRF_UNAVAILABLE: { icon: Smartphone, title: "This device can't be used", action: 'phone' },
  CRYPTO_UNAVAILABLE: { icon: ShieldOff, title: 'Browser not supported', action: 'copy' },
  NO_PROFILE: { icon: UserPlus, title: 'Create your passkey first', action: 'create' },
  WRONG_PASSKEY: { icon: ShieldOff, title: "This passkey doesn't own this shop" },
};

function Inner({ children }: { children: ReactNode }) {
  const session = useSession();
  const [passkeyErr, setPasskeyErr] = useState<PasskeyError | null>(null);
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [name, setName] = useState('My ScanPay');
  const [busy, setBusy] = useState(false);
  const waiter = useRef<{ resolve: (p: LocalProfile) => void; reject: (e: Error) => void } | null>(null);

  const report = useCallback((e: unknown) => {
    if (e instanceof PasskeyError) {
      if (e.code === 'NO_PROFILE') return setOnboardOpen(true);
      return setPasskeyErr(e);
    }
    if (e instanceof ApiError) return void toast.error(e.message);
    toast.error('Something went wrong. Try again.');
  }, []);

  const ensureProfile = useCallback(() => {
    const existing = session.profile;
    if (existing) return Promise.resolve(existing);
    return new Promise<LocalProfile>((resolve, reject) => {
      waiter.current = { resolve, reject };
      setOnboardOpen(true);
    });
  }, [session.profile]);

  const create = async () => {
    setBusy(true);
    try {
      const p = await session.onboard(name.trim() || 'My ScanPay');
      toast.success("You're set");
      setOnboardOpen(false);
      waiter.current?.resolve(p);
      waiter.current = null;
    } catch (e) {
      setOnboardOpen(false);
      report(e);
      waiter.current?.reject(e as Error);
      waiter.current = null;
    } finally {
      setBusy(false);
    }
  };

  const dismissOnboard = () => {
    setOnboardOpen(false);
    waiter.current?.reject(new Error('dismissed'));
    waiter.current = null;
  };

  const sheetInfo = passkeyErr ? PASSKEY_SHEETS[passkeyErr.code] ?? { icon: ScanFace, title: 'Something went wrong' } : null;
  const here = typeof window !== 'undefined' ? window.location.href : '';

  return (
    <AppCtx.Provider value={{ report, ensureProfile }}>
      {children}

      {/* G3 — Face ID overlay */}
      {session.prompt && (
        <div className="faceid" role="status" aria-live="polite">
          <div>
            <div className="ring">
              <ScanFace size={54} />
            </div>
            <h2 className="h2" style={{ marginBottom: 6 }}>{session.prompt.reason}</h2>
            <p style={{ opacity: 0.75 }}>Confirm with Face ID or your fingerprint.</p>
          </div>
        </div>
      )}

      {/* G4 — passkey error sheet */}
      <Sheet open={!!passkeyErr && !!sheetInfo} onClose={() => setPasskeyErr(null)} title={sheetInfo?.title} icon={sheetInfo?.icon}>
        <p className="muted">
          {passkeyErr?.code === 'CANCELLED' || passkeyErr?.code === 'PASSKEY_OPERATION_FAILED'
            ? "Nothing was paid. Try again when you're ready."
            : passkeyErr?.message}
        </p>
        {sheetInfo?.action === 'phone' && (
          <div className="col center">
            <QrView payload={here} size={180} />
            <span className="small muted">Scan with your phone to open ScanPay there.</span>
          </div>
        )}
        <div className="row">
          {sheetInfo?.action === 'copy' && (
            <button className="btn block" onClick={() => navigator.clipboard?.writeText(here).then(() => toast.success('Link copied'))}>
              Copy link
            </button>
          )}
          <button className="btn ghost block" onClick={() => setPasskeyErr(null)}>
            {sheetInfo?.action === 'retry' ? 'Try again' : 'Close'}
          </button>
        </div>
      </Sheet>

      {/* G7 — onboarding sheet */}
      <Sheet open={onboardOpen} onClose={dismissOnboard}>
        <div className="col" style={{ alignItems: 'center', textAlign: 'center' }}>
          <Fingerprint size={48} />
          <h2 className="h2">Pay with your face. That&apos;s it.</h2>
        </div>
        <div className="col gap-s">
          <div className="row"><KeyRound size={18} /> <span>No passwords or recovery words</span></div>
          <div className="row"><EyeOff size={18} /> <span>Your keys never leave this phone</span></div>
          <div className="row"><Zap size={18} /> <span>No fees to pay</span></div>
        </div>
        <label className="field">
          <span className="label">Your name (shown only on this device)</span>
          <span className="input-wrap">
            <User size={18} />
            <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </span>
        </label>
        <button className="btn big block" onClick={create} disabled={busy}>
          {busy ? <Spinner /> : <ScanFace size={20} />} Create passkey
        </button>
        <p className="help row"><Info size={14} /> Uses your phone&apos;s passkey (iCloud Keychain / Google Password Manager).</p>
      </Sheet>
    </AppCtx.Provider>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [qc] = useState(
    () => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } }),
  );
  return (
    <QueryClientProvider client={qc}>
      <ConfigProvider>
        <SessionProvider>
          <Inner>{children}</Inner>
          <Toaster position="bottom-center" richColors closeButton />
        </SessionProvider>
      </ConfigProvider>
    </QueryClientProvider>
  );
}
