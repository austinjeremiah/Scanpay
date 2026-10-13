'use client';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, CameraOff, ClipboardPaste, Flashlight, FlashlightOff, ShieldAlert } from 'lucide-react';
import { AppShell } from '@/components/app/shell';
import { MerchantAvatar, Sheet, Spinner } from '@/components/app/ui';
import { api, type ApiError } from '@/lib/api';
import { vibrate } from '@/lib/hooks';
import type { z } from 'zod';
import type { zQrResolveRes } from '@/lib/shared';

type Resolved = z.infer<typeof zQrResolveRes>;

function Scan() {
  const router = useRouter();
  const params = useSearchParams();
  const video = useRef<HTMLVideoElement | null>(null);
  const scanner = useRef<any>(null);
  const handling = useRef(false);
  const [denied, setDenied] = useState(false);
  const [flash, setFlash] = useState<{ has: boolean; on: boolean }>({ has: false, on: false });
  const [warn, setWarn] = useState<Resolved | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paste, setPaste] = useState(false);
  const [text, setText] = useState('');
  const [resolving, setResolving] = useState(false);

  const resolve = useCallback(
    async (data: string) => {
      if (handling.current) return;
      handling.current = true;
      setResolving(true);
      setError(null);
      try {
        scanner.current?.stop();
        vibrate(30);
        const r = await api.qrResolve(data);
        if (r.kind === 'invoice' && r.verified && r.shortCode) return void router.push(`/pay/${r.shortCode}`);
        if (r.kind === 'merchant' && r.verified && r.chainId && r.merchantId) {
          return void router.push(`/m/${r.chainId}/${r.merchantId}`);
        }
        setWarn(r); // never auto-continue on warnings
      } catch (e) {
        setError((e as ApiError).message ?? 'Could not read this QR.');
      } finally {
        setResolving(false);
        handling.current = false;
      }
    },
    [router],
  );

  const startCamera = useCallback(async () => {
    if (!video.current) return;
    try {
      const { default: QrScanner } = await import('qr-scanner');
      scanner.current?.destroy();
      const s = new QrScanner(video.current, (r) => void resolve(r.data), {
        returnDetailedScanResult: true,
        highlightScanRegion: false,
        preferredCamera: 'environment',
      });
      scanner.current = s;
      await s.start();
      setDenied(false);
      setFlash({ has: await s.hasFlash().catch(() => false), on: false });
    } catch {
      setDenied(true);
    }
  }, [resolve]);

  useEffect(() => {
    const data = params.get('data');
    if (data) {
      void resolve(data);
      return;
    }
    void startCamera();
    return () => {
      scanner.current?.destroy();
      scanner.current = null;
    };
  }, [params, resolve, startCamera]);

  const again = () => {
    setWarn(null);
    setError(null);
    router.replace('/scan');
    void startCamera();
  };

  return (
    <AppShell title="Scan" back="/app" nav="customer">
      <div className="scanner">
        <video ref={video} playsInline muted />
        <div className="frame" />
        <div className="line" />
        {resolving && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,.5)', color: '#fff' }}>
            <Spinner size={32} />
          </div>
        )}
      </div>
      <p className="center muted">Point at a ScanPay QR</p>

      {flash.has && (
        <button
          className="btn soft"
          onClick={async () => {
            await scanner.current?.toggleFlash();
            setFlash((f) => ({ ...f, on: !f.on }));
          }}
        >
          {flash.on ? <FlashlightOff size={16} /> : <Flashlight size={16} />} Torch
        </button>
      )}

      {denied && (
        <div className="card line col center">
          <CameraOff size={28} style={{ alignSelf: 'center' }} />
          <b>Allow camera access to scan</b>
          <button className="btn" onClick={() => void startCamera()}>Try again</button>
        </div>
      )}
      {error && (
        <div className="notice bad"><ShieldAlert size={18} /><div>{error}</div></div>
      )}
      <button className="btn ghost block" onClick={() => setPaste(true)}>
        <ClipboardPaste size={16} /> Paste a link instead
      </button>

      <Sheet open={paste} onClose={() => setPaste(false)} title="Paste a payment link" icon={ClipboardPaste}>
        <input className="input" placeholder="https://… or payment code" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn block" disabled={!text.trim()} onClick={() => { setPaste(false); void resolve(text.trim()); }}>
          Continue
        </button>
      </Sheet>

      <Sheet open={!!warn} onClose={again} title="This QR isn't safe to pay" icon={ShieldAlert}>
        {warn?.warnings.map((w) => (
          <div key={w} className="notice bad"><AlertTriangle size={18} /><div>{w}</div></div>
        ))}
        {warn?.merchant && (
          <div className="card row">
            <MerchantAvatar logoUrl={warn.merchant.profile?.logoUrl} name={warn.merchant.profile?.displayName} />
            <div>
              <b>{warn.merchant.profile?.displayName ?? 'Unknown shop'}</b>
              <div className="small muted">Status: {warn.merchant.status}</div>
            </div>
          </div>
        )}
        <button className="btn block" onClick={again}>Scan again</button>
        {warn?.kind === 'invoice' && warn.shortCode && warn.merchant && warn.merchant.status !== 'ACTIVE' && (
          <button className="btn ghost sm" onClick={() => router.push(`/pay/${warn.shortCode}`)}>Show details</button>
        )}
      </Sheet>
    </AppShell>
  );
}

export default function ScanPage() {
  return (
    <Suspense>
      <Scan />
    </Suspense>
  );
}
