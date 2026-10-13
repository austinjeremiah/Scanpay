'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { EyeOff, Fingerprint, Info, KeyRound, ScanFace, User, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/shell';
import { useApp } from '@/components/app/providers';
import { Spinner } from '@/components/app/ui';
import { useSession } from '@/lib/session';

function Welcome() {
  const session = useSession();
  const { report } = useApp();
  const router = useRouter();
  const next = useSearchParams().get('next') ?? '/app';
  const [name, setName] = useState('My ScanPay');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await session.onboard(name.trim() || 'My ScanPay');
      toast.success("You're set");
      router.replace(next.startsWith('/') ? next : '/app');
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell nav="none" hideTop>
      <div className="col gap-l" style={{ paddingTop: 24 }}>
        <div className="col" style={{ alignItems: 'flex-start' }}>
          <div className="avatar"><Fingerprint size={26} /></div>
          <h1 className="display">Pay with your <span className="hl">face.</span> That&apos;s it.</h1>
        </div>
        <div className="col">
          <div className="row"><KeyRound size={20} /> No passwords or recovery words</div>
          <div className="row"><EyeOff size={20} /> Your keys never leave this phone</div>
          <div className="row"><Zap size={20} /> No fees to pay</div>
        </div>
        <label className="field">
          <span className="label">Your name (shown only on this device)</span>
          <span className="input-wrap">
            <User size={18} />
            <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </span>
        </label>
        <button className="btn neon big block" onClick={create} disabled={busy}>
          {busy ? <Spinner /> : <ScanFace size={22} />} Create passkey
        </button>
        <div className="col gap-s">
          <p className="help row"><Info size={14} /> Uses your phone&apos;s passkey (iCloud Keychain / Google Password Manager).</p>
          <p className="help">
            Lost this phone? Your passkey syncs through iCloud or Google. Sign in on a new phone with the same passkey.
          </p>
        </div>
      </div>
    </AppShell>
  );
}

export default function WelcomePage() {
  return (
    <Suspense>
      <Welcome />
    </Suspense>
  );
}
