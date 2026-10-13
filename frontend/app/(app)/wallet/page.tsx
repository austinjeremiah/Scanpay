'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Droplets, KeyRound, Plus, User, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app/shell';
import { useApp } from '@/components/app/providers';
import { CopyButton, QrView, Sheet, Skeleton, Spinner, StateBlock, TokenChip } from '@/components/app/ui';
import { api } from '@/lib/api';
import { nativeBalance } from '@/lib/chain';
import { useConfig } from '@/lib/config';
import { formatFiat, formatToken, shortHex } from '@/lib/format';
import { useFx, useMounted } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { totalUsd, useBalances } from '@/lib/useBalances';

/** P8 — balances, add money, and the test-mode faucet. */
export default function WalletPage() {
  const cfg = useConfig();
  const session = useSession();
  const { report, ensureProfile } = useApp();
  const qc = useQueryClient();
  const mounted = useMounted();
  const fx = useFx();
  const profile = mounted ? session.profile : null;
  const bal = useBalances(cfg.chain, profile?.addresses.pay);
  const monBal = useQuery({
    queryKey: ['native-balance', cfg.chainId, profile?.addresses.pay],
    enabled: !!profile,
    refetchInterval: 15_000,
    queryFn: () => nativeBalance(cfg.chainId, profile!.addresses.pay as `0x${string}`),
  });
  const [add, setAdd] = useState(false);
  const [busy, setBusy] = useState(false);
  const testMode = cfg.chainId !== 143;
  const nativeMon = monBal.data ?? 0n;
  const total = totalUsd(bal.data);

  const faucet = async () => {
    setBusy(true);
    try {
      const p = await ensureProfile();
      await api.faucet(cfg.chainId, p.addresses.pay);
      toast.success('Test money added');
      void qc.invalidateQueries({ queryKey: ['balances'] });
    } catch (e) {
      const err = e as { code?: string };
      if (err.code === 'FAUCET_LIMIT') toast.error('Already used today');
      else report(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell title="Wallet" nav="customer">
      {!profile ? (
        <StateBlock
          icon={Wallet}
          title="Create your account"
          message="One passkey. No passwords, no recovery words."
          action={<button className="btn neon" onClick={() => void ensureProfile().catch(() => undefined)}>Create passkey</button>}
        />
      ) : (
        <>
          <div className="card ink">
            <div className="row between">
              <span className="label">Total balance</span>
              {testMode && <span className="pill warn">Test mode</span>}
            </div>
            <div className="amount lg" style={{ marginTop: 10 }}>
              {fx.rate !== null ? formatFiat(total, fx.rate, fx.currency) : `$${total.toFixed(2)}`}
            </div>
          </div>

          <div className="card flat">
            {bal.isLoading ? (
              <div className="col" style={{ padding: 16 }}><Skeleton h={28} /><Skeleton h={28} /></div>
            ) : (
              <>
                {nativeMon > 0n && (
                  <div className="kv" style={{ padding: '14px 16px' }}>
                    <span className="row">
                      <TokenChip symbol="MON" />
                      <span className="small muted">MON</span>
                    </span>
                    <span className="v">{formatToken(nativeMon, 18)}</span>
                  </div>
                )}
                {(bal.data ?? []).map((r) => (
                  <div key={r.key} className="kv" style={{ padding: '14px 16px' }}>
                    <span className="row">
                      <TokenChip symbol={r.token.displaySymbol} />
                      <span className="small muted">{r.token.isMock ? 'Test token' : r.token.symbol}</span>
                    </span>
                    <span className="v">
                      {formatToken(r.balance, r.token.decimals)}
                      {fx.rate !== null && r.token.usdPrice > 0 && (
                        <div className="small muted">
                          {formatFiat((Number(r.balance) / 10 ** r.token.decimals) * r.token.usdPrice, fx.rate, fx.currency)}
                        </div>
                      )}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>

          <div className="row">
            <button className="btn block" onClick={() => setAdd(true)}><Plus size={16} /> Add funds</button>
            {testMode && (
              <button className="btn soft block" onClick={faucet} disabled={busy}>
                {busy ? <Spinner size={14} /> : <Droplets size={16} />} Get test money
              </button>
            )}
          </div>

          <div className="card col gap-s">
            <div className="label row"><User size={14} /> Your account</div>
            <div className="kv"><span className="k">Name</span><span className="v">{profile.label}</span></div>
            <div className="kv">
              <span className="k">Account ID</span>
              <span className="v row" style={{ justifyContent: 'flex-end' }}>
                <span className="mono">{shortHex(profile.addresses.pay, 6)}</span>
                <CopyButton text={profile.addresses.pay} />
              </span>
            </div>
            <div className="small muted row"><KeyRound size={14} /> Protected by your passkey · created {new Date(profile.createdAt).toLocaleDateString()}</div>
          </div>
        </>
      )}

      <Sheet open={add} onClose={() => setAdd(false)} title="Add funds" icon={Plus}>
        {profile && (
          <div className="col center">
            <QrView payload={profile.addresses.pay} size={200} />
            <span className="mono">{profile.addresses.pay}</span>
            <CopyButton text={profile.addresses.pay} label="Copy account ID" small={false} />
          </div>
        )}
        <p>Send USDC or AUSD on <b>Monad</b> to this account ID.</p>
        <div className="notice warn">
          <AlertTriangle size={18} />
          <div>Only send on Monad. For other chains, use <b>Pay from another chain</b> at checkout. No need to move money first.</div>
        </div>
      </Sheet>
    </AppShell>
  );
}
