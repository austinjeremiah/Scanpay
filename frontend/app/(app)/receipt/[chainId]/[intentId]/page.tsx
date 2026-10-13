'use client';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeftRight, CheckCircle2, CircleDashed, FileSignature, Globe, Info, Landmark, Loader2, SearchX, Share2, ShieldAlert,
  ShieldCheck, Store, Terminal, Undo2, XCircle, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/shell';
import { CopyButton, MerchantAvatar, Skeleton, TechDetails } from '@/components/app/ui';
import { api } from '@/lib/api';
import { explorerTx, findToken, useConfig, explorerAddr } from '@/lib/config';
import { formatToken, when } from '@/lib/format';
import type { VerifyRes } from '@/lib/shared';

type Section = VerifyRes['proofs']['merchant'];

function ProofCard({ icon: Icon, title, section }: { icon: typeof Store; title: string; section: Section }) {
  return (
    <div className="proof">
      <div className="hd">
        <Icon size={18} />
        <b>{title}</b>
        <span className={`dot ${section.ok === true ? 'ok' : section.ok === false ? 'bad' : ''}`} />
      </div>
      <div className="bd">
        {section.checks.map((c, i) => (
          <div className="check" key={i}>
            <span className={`ck ${c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'na'}`}>
              {c.ok === true ? <CheckCircle2 size={18} /> : c.ok === false ? <XCircle size={18} /> : <CircleDashed size={18} />}
            </span>
            <div>
              <div className="lb">{c.label}</div>
              <div className="dt">{c.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** P6 — public, shareable receipt: three proofs recomputed by the server from chain data. */
export default function ReceiptPage() {
  const { chainId: c, intentId } = useParams<{ chainId: string; intentId: string }>();
  const chainId = Number(c);
  const cfg = useConfig();
  const dep = cfg.get(chainId)?.deployment;

  const v = useQuery({
    queryKey: ['verify', chainId, intentId],
    queryFn: () => api.verify(chainId, intentId),
    refetchInterval: (q) => (q.state.data?.verdict === 'PENDING' ? 3000 : false),
    retry: false,
  });
  const intent = useQuery({ queryKey: ['intent', chainId, intentId], queryFn: () => api.intent(chainId, intentId), retry: false });
  const merchant = useQuery({
    queryKey: ['merchant', chainId, intent.data?.merchantId],
    queryFn: () => api.merchant(chainId, intent.data!.merchantId),
    enabled: !!intent.data,
    retry: false,
  });

  const verdict = v.data?.verdict;
  const banner =
    verdict === 'VERIFIED'
      ? { cls: 'ok', icon: ShieldCheck, text: 'Payment verified' }
      : verdict === 'PENDING'
        ? { cls: 'info', icon: Loader2, text: 'Payment in progress' }
        : verdict === 'REFUNDED'
          ? { cls: 'warn', icon: Undo2, text: 'Refunded' }
          : verdict === 'FAILED'
            ? { cls: 'bad', icon: ShieldAlert, text: 'Verification failed' }
            : { cls: 'bad', icon: SearchX, text: 'No such payment' };
  const Banner = banner.icon;

  const i = intent.data;
  const payout = findToken(dep, i?.payoutToken);
  const input = findToken(dep, i?.inputToken);
  const settledAt = i?.timeline.findLast?.((t) => t.status === 'SETTLED')?.at;
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: 'Payment receipt', url: location.href });
      else {
        await navigator.clipboard.writeText(location.href);
        toast.success('Link copied');
      }
    } catch { /* cancelled */ }
  };
  const cmd = `pnpm --filter @scanpay/api verify-receipt ${chainId} ${intentId}`;

  return (
    <AppShell title="Receipt" back="/app" nav="none" chainId={chainId}>
      {v.isLoading ? (
        <div className="col"><Skeleton h={120} /><Skeleton h={160} /><Skeleton h={160} /></div>
      ) : v.error || !v.data ? (
        <div className="verdict bad">
          <SearchX size={40} />
          <div className="vt">We couldn&apos;t check this payment</div>
          <div className="small">{(v.error as Error | null)?.message}</div>
        </div>
      ) : (
        <>
          <div className={`verdict ${banner.cls}`}>
            <Banner size={44} className={verdict === 'PENDING' ? 'spin' : undefined} />
            <div className="vt">{banner.text}</div>
            {settledAt && <div className="small">{when(settledAt)}</div>}
          </div>

          {i && payout && (
            <div className="card col">
              <div className="row">
                <MerchantAvatar logoUrl={merchant.data?.profile?.logoUrl} name={merchant.data?.profile?.displayName} />
                <div className="grow">
                  <div className="h3">
                    {formatToken(i.amountOut, payout.token.decimals)} {payout.token.displaySymbol} to {merchant.data?.profile?.displayName ?? 'the shop'}
                  </div>
                  {i.netToMerchant && (
                    <div className="small muted row" style={{ gap: 4 }}>
                      <Info size={13} /> Shop received {formatToken(i.netToMerchant, payout.token.decimals)} after the shop&apos;s fee
                    </div>
                  )}
                </div>
              </div>
              <span className="pill">
                {i.route === 'DIRECT' ? <Zap size={12} /> : i.route === 'SWAP' ? <ArrowLeftRight size={12} /> : <Globe size={12} />}
                {i.route === 'DIRECT' ? 'Direct' : i.route === 'SWAP' ? `Swapped from ${input?.token.displaySymbol ?? 'another token'}` : 'From another chain'}
              </span>
            </div>
          )}

          <ProofCard icon={Store} title="Who you paid" section={v.data.proofs.merchant} />
          <ProofCard icon={FileSignature} title="What you approved" section={v.data.proofs.intent} />
          <ProofCard icon={Landmark} title="Where the money went" section={v.data.proofs.settlement} />

          {v.data.trustNotes.length > 0 && (
            <div className="col gap-s">
              {v.data.trustNotes.map((n, k) => (
                <p key={k} className="help row" style={{ alignItems: 'flex-start' }}><Info size={14} style={{ flex: 'none', marginTop: 2 }} /> {n}</p>
              ))}
            </div>
          )}

          <button className="btn block" onClick={share}><Share2 size={18} /> Share receipt</button>

          <div className="card col gap-s">
            <div className="label row"><Terminal size={14} /> Verify it yourself</div>
            <div className="mono">{cmd}</div>
            <div className="row between">
              <span className="help">Checks the network directly. No need to trust us.</span>
              <CopyButton text={cmd} />
            </div>
          </div>

          <TechDetails
            rows={[
              { label: 'Payment id', value: intentId },
              { label: 'Commit transaction', value: i?.txs.commit ?? v.data.links.commitTx, href: explorerTx(dep, i?.txs.commit ?? v.data.links.commitTx) },
              { label: 'Settle transaction', value: i?.txs.settle ?? v.data.links.settleTx, href: explorerTx(dep, i?.txs.settle ?? v.data.links.settleTx) },
              { label: 'Vault', value: v.data.links.vault, href: explorerAddr(dep, v.data.links.vault) },
              { label: 'Registry', value: v.data.links.registry, href: explorerAddr(dep, v.data.links.registry) },
              { label: 'Network', value: dep?.network },
            ]}
          />
        </>
      )}
    </AppShell>
  );
}
