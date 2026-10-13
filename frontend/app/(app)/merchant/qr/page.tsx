'use client';
import { useRouter } from 'next/navigation';
import { ArrowLeft, BadgeCheck, FlaskConical, Printer, ScanLine, Store } from 'lucide-react';
import { MerchantAvatar, QrView, Skeleton, StateBlock } from '@/components/app/ui';
import { useConfig } from '@/lib/config';
import { useMerchant } from '@/lib/useMerchant';

/** M6 — print-optimised counter QR (no shell). */
export default function MerchantQrPage() {
  const router = useRouter();
  const cfg = useConfig();
  const mm = useMerchant();
  const { chainId, local, view } = mm;

  if (mm.resolved && !local) {
    return (
      <div className="sp-page">
        <StateBlock icon={Store} title="No shop on this network yet" action={<button className="btn" onClick={() => router.push('/merchant/setup')}>Set up your shop</button>} />
      </div>
    );
  }
  if (!local || !view) {
    return (
      <div className="sp-page"><Skeleton h={400} /></div>
    );
  }
  const base = cfg.publicAppUrl || (typeof window !== 'undefined' ? window.location.origin : '');
  const url = `${base}/m/${chainId}/${local.merchantId}`;

  return (
    <div className="sp-shell">
      <div className="sp-page print-page" style={{ alignItems: 'center', textAlign: 'center' }}>
        <div className="no-print row between" style={{ width: '100%' }}>
          <button className="btn ghost sm" onClick={() => router.push('/merchant/settings')}><ArrowLeft size={14} /> Back</button>
          <button className="btn sm" onClick={() => window.print()}><Printer size={14} /> Print</button>
        </div>
        <MerchantAvatar logoUrl={view.profile?.logoUrl} name={view.profile?.displayName} />
        <h1 className="display">{view.profile?.displayName}</h1>
        <div className="row" style={{ justifyContent: 'center' }}><BadgeCheck size={18} /> Verified ScanPay merchant</div>
        <QrView payload={url} size={320} />
        <div className="row h3" style={{ justifyContent: 'center' }}><ScanLine size={20} /> Scan to pay · any token · any chain · no fees</div>
        {chainId !== 143 && <span className="pill warn"><FlaskConical size={12} /> TEST MODE</span>}
      </div>
    </div>
  );
}
