'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeftRight, CheckCircle2, Globe, Loader2, Lock, Receipt, ScanLine, Undo2, XCircle, Zap } from 'lucide-react';
import { AppShell } from '@/components/app/shell';
import { useApp } from '@/components/app/providers';
import { Pill, StateBlock, TokenChip } from '@/components/app/ui';
import { api } from '@/lib/api';
import { formatToken, when } from '@/lib/format';
import { useSession } from '@/lib/session';
import { readReceipts } from '@/lib/vault';
import type { ReceiptEntry } from '@/lib/store';
import { useMounted } from '@/lib/hooks';

type Status = 'PAID' | 'PENDING' | 'REFUNDED' | 'FAILED' | undefined;

const statusOf = (l: string): Status =>
  l === 'SETTLED' ? 'PAID' : l === 'REFUNDED' ? 'REFUNDED' : l === 'FAILED' ? 'FAILED' : 'PENDING';

/** P7 — the customer's private history, encrypted on this device with the vault key. */
export default function ActivityPage() {
  const session = useSession();
  const { report } = useApp();
  const router = useRouter();
  const mounted = useMounted();
  const [rows, setRows] = useState<ReceiptEntry[] | null>(null);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [busy, setBusy] = useState(false);

  const unlock = async () => {
    setBusy(true);
    try {
      const list = await session.withKeys('Open your history', async (ring) => readReceipts(await ring.vaultKey()));
      setRows(list.sort((a, b) => b.at - a.at));
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!rows) return;
    let live = true;
    rows.slice(0, 20).forEach(async (r) => {
      try {
        const v = await api.intent(r.chainId, r.intentId);
        if (live) setStatus((s) => ({ ...s, [r.intentId]: statusOf(v.lifecycle) }));
      } catch { /* unknown */ }
    });
    return () => {
      live = false;
    };
  }, [rows]);

  const icon = (route: string) => (route === 'DIRECT' ? <Zap size={18} /> : route === 'SWAP' ? <ArrowLeftRight size={18} /> : <Globe size={18} />);

  return (
    <AppShell
      title="Activity"
      nav="customer"
      right={
        rows ? (
          <button className="sp-icon-btn" onClick={() => setRows(null)} aria-label="Lock history"><Lock size={16} /></button>
        ) : undefined
      }
    >
      {!rows ? (
        <StateBlock
          icon={Lock}
          title="Your history is encrypted on this phone"
          message={mounted && !session.profile ? 'Create a passkey and make a payment to see it here.' : undefined}
          action={
            <button className="btn neon" onClick={unlock} disabled={busy || !session.profile}>
              {busy ? <Loader2 size={16} className="spin" /> : null} Unlock with Face ID
            </button>
          }
        />
      ) : rows.length === 0 ? (
        <StateBlock
          icon={Receipt}
          title="No payments yet"
          action={<Link href="/scan" className="btn"><ScanLine size={16} /> Scan to pay</Link>}
        />
      ) : (
        <div className="col gap-s">
          {rows.map((r) => {
            const st = status[r.intentId];
            const pending = st === 'PENDING';
            return (
              <button
                key={r.intentId}
                className="opt"
                onClick={() => router.push(pending ? `/payment/${r.chainId}/${r.intentId}` : `/receipt/${r.chainId}/${r.intentId}`)}
              >
                <span className="ico">{icon(r.route)}</span>
                <span className="grow">
                  <div className="t">{r.merchantName}</div>
                  <div className="s">{when(r.at)}</div>
                </span>
                <span className="col" style={{ alignItems: 'flex-end', gap: 4 }}>
                  <b>{formatToken(r.amount, 6)} {r.tokenSymbol}</b>
                  {st === 'PAID' && <Pill tone="ok" icon={CheckCircle2}>Paid</Pill>}
                  {st === 'PENDING' && <Pill tone="info" icon={Loader2}>Pending</Pill>}
                  {st === 'REFUNDED' && <Pill tone="warn" icon={Undo2}>Refunded</Pill>}
                  {st === 'FAILED' && <Pill tone="bad" icon={XCircle}>Failed</Pill>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
