'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight, Banknote, BadgeCheck, Clock, Globe2, Image as ImageIcon, Info, KeyRound, Landmark, MapPin,
  QrCode, ScanFace, Store, Tag,
} from 'lucide-react';
import { AppShell } from '@/components/app/shell';
import { useApp } from '@/components/app/providers';
import { MerchantAvatar, Notice, Spinner, TechDetails, VerifiedBadge } from '@/components/app/ui';
import { api, ApiError } from '@/lib/api';
import { ownerNonce } from '@/lib/chain';
import { explorerTx, useConfig } from '@/lib/config';
import { flagEmoji, shortHex } from '@/lib/format';
import { useSession } from '@/lib/session';
import { signRegistration } from '@/lib/sign';
import { profileHash, randomBytes32, toWireRegistration, type TokenKey } from '@/lib/shared';
import { store } from '@/lib/store';

const CATEGORIES = ['Food & drink', 'Retail', 'Services', 'Travel', 'Other'];
const COUNTRIES = ['IN', 'US', 'GB', 'DE', 'FR', 'ES', 'IT', 'NL', 'SG', 'AE', 'JP', 'AU', 'CA', 'BR', 'KR'];
const PAYOUT_LABEL: Record<string, string> = { USDC: 'US dollar stablecoin', AUSD: 'Agora dollar — great for cross-border' };

function defaultCountry() {
  try {
    const r = (Intl.DateTimeFormat().resolvedOptions().locale.split('-')[1] ?? '').toUpperCase();
    return COUNTRIES.includes(r) ? r : 'IN';
  } catch {
    return 'IN';
  }
}

/** M1 — three keys from one Face ID, then registration (owner + payout wallet signatures). */
export default function MerchantSetupPage() {
  const cfg = useConfig();
  const session = useSession();
  const { report, ensureProfile } = useApp();
  const router = useRouter();
  const chain = cfg.chain;

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState('');
  const [category, setCategory] = useState(CATEGORIES[0]!);
  const [city, setCity] = useState('');
  const [country, setCountry] = useState(defaultCountry);
  const [logoUrl, setLogoUrl] = useState('');
  const [payoutKey, setPayoutKey] = useState<TokenKey>('USDC');
  const [derived, setDerived] = useState<{ owner: string; payout: string; signer: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ merchantId: string; txHash: string; approveTxHash: string | null; status: string } | null>(null);

  const payoutOptions = useMemo(
    () => (Object.entries(chain?.deployment.tokens ?? {}) as [TokenKey, NonNullable<NonNullable<typeof chain>['deployment']['tokens'][TokenKey]>][])
      .filter(([, t]) => t.roles.includes('payout')),
    [chain],
  );
  const logoOk = logoUrl === '' || /^https?:\/\/\S+$/.test(logoUrl);
  const valid = name.trim().length > 0 && name.trim().length <= 60 && city.length <= 60 && logoOk;

  const setup = async () => {
    if (!chain) return;
    setBusy(true);
    setErr(null);
    try {
      await ensureProfile();
      const profile = { displayName: name.trim(), category, city: city.trim(), country, logoUrl: logoUrl.trim() };
      await session.withKeys('Create your shop', async (ring) => {
        const owner = await ring.account('owner');
        const payout = await ring.account('payout');
        const signer = ring.address('invoice', 1);
        setDerived({ owner: owner.address, payout: payout.address, signer });
        const registry = chain.deployment.contracts.MerchantRegistry.address;
        const payoutToken = chain.deployment.tokens[payoutKey]!.address;
        const reg = {
          owner: owner.address,
          salt: randomBytes32(),
          payoutWallet: payout.address,
          invoiceSigner: signer,
          payoutToken,
          metadataHash: profileHash(profile),
          nonce: await ownerNonce(chain.chainId, registry, owner.address),
          deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
        };
        const { ownerSig, payoutSig } = await signRegistration(owner, payout, chain.chainId, registry, reg);
        const res = await api.registerMerchant({
          chainId: chain.chainId,
          registration: toWireRegistration(reg),
          ownerSig,
          payoutSig,
          profile,
        });
        session.setMerchant({
          chainId: chain.chainId,
          merchantId: res.merchantId as `0x${string}`,
          keyVersion: 1,
          invoiceSigner: signer,
          payoutTokenKey: payoutKey,
          displayName: profile.displayName,
        });
        store.setMode('merchant');
        setResult({ merchantId: res.merchantId, txHash: res.txHash, approveTxHash: res.approveTxHash, status: res.status });
        setStep(3);
      });
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'MERCHANT_EXISTS') {
          setErr('This passkey already has a shop on this network. Opening it…');
          router.replace('/merchant');
          return;
        }
        setErr(e.message);
      } else if ((e as Error)?.message !== 'dismissed') report(e);
    } finally {
      setBusy(false);
    }
  };

  const Step = ({ n, label }: { n: number; label: string }) => (
    <span className={`pill ${step === n ? 'ink' : step > n ? 'ok' : ''}`}>{n} {label}</span>
  );

  return (
    <AppShell title="Set up your shop" nav="none" back="/app">
      <div className="row wrap" style={{ gap: 6 }}>
        <Step n={1} label="Shop" /><Step n={2} label="Keys" /><Step n={3} label="Done" />
      </div>

      {step === 1 && (
        <>
          <h1 className="display">Your <span className="hl">shop</span></h1>
          <label className="field">
            <span className="label">Shop name</span>
            <span className="input-wrap"><Store size={18} />
              <input className="input" placeholder="Chai Point" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            </span>
          </label>
          <label className="field">
            <span className="label">Category</span>
            <span className="input-wrap"><Tag size={18} />
              <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </span>
          </label>
          <div className="row">
            <label className="field grow">
              <span className="label">City</span>
              <span className="input-wrap"><MapPin size={18} />
                <input className="input" maxLength={60} value={city} onChange={(e) => setCity(e.target.value)} />
              </span>
            </label>
            <label className="field grow">
              <span className="label">Country</span>
              <span className="input-wrap"><Globe2 size={18} />
                <select className="input" value={country} onChange={(e) => setCountry(e.target.value)}>
                  {COUNTRIES.map((c) => <option key={c} value={c}>{flagEmoji(c)} {c}</option>)}
                </select>
              </span>
            </label>
          </div>
          <label className="field">
            <span className="label">Logo URL (optional)</span>
            <span className="input-wrap"><ImageIcon size={18} />
              <input className="input" placeholder="https://…" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} />
            </span>
            {!logoOk && <span className="err">Enter a full link starting with https://</span>}
          </label>
          <div className="field">
            <span className="label row"><Banknote size={14} /> Get paid in</span>
            <div className="col gap-s">
              {payoutOptions.map(([key, t]) => (
                <button key={key} type="button" className={`opt ${payoutKey === key ? 'sel' : ''}`} onClick={() => setPayoutKey(key)}>
                  <span className="ico"><Banknote size={20} /></span>
                  <span className="grow">
                    <div className="t">{t.displaySymbol}</div>
                    <div className="s">{PAYOUT_LABEL[key] ?? t.symbol}</div>
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="card line">
            <div className="label" style={{ marginBottom: 8 }}>How customers will see you</div>
            <div className="row">
              <MerchantAvatar logoUrl={logoOk ? logoUrl : ''} name={name} />
              <div className="grow">
                <div className="h3">{name || 'Your shop'}</div>
                <div className="small muted">{[category, city].filter(Boolean).join(' · ')}</div>
              </div>
              <VerifiedBadge verified />
            </div>
          </div>
          <button className="btn big block" disabled={!valid || !chain} onClick={() => setStep(2)}>
            Continue <ArrowRight size={18} />
          </button>
        </>
      )}

      {step === 2 && (
        <>
          <h1 className="display">One Face ID. <span className="hl">Three keys.</span></h1>
          <div className="tree">
            {[
              { icon: KeyRound, t: 'Owner key', s: 'Approves changes to your shop', a: derived?.owner },
              { icon: Landmark, t: 'Payout account', s: 'Receives your money', a: derived?.payout },
              { icon: QrCode, t: 'Checkout key v1', s: 'Signs every QR you show. Can be replaced anytime.', a: derived?.signer },
            ].map((k) => (
              <div className="card row" key={k.t}>
                <span className="avatar sm"><k.icon size={16} /></span>
                <div className="grow">
                  <div className="h3">{k.t}</div>
                  <div className="small muted">{k.s}</div>
                </div>
                {k.a && <span className="mono">{shortHex(k.a)}</span>}
              </div>
            ))}
          </div>
          <p className="help row"><Info size={14} /> All three come from your passkey. Nothing is stored on our servers.</p>
          {err && <Notice tone="bad"><b>{err}</b></Notice>}
          <button className="btn neon big block" disabled={busy} onClick={setup}>
            {busy ? <Spinner /> : <ScanFace size={22} />} Create my shop
          </button>
          <button className="btn ghost block" disabled={busy} onClick={() => setStep(1)}>Back</button>
        </>
      )}

      {step === 3 && result && (
        <>
          {result.status === 'ACTIVE' ? (
            <div className="verdict ok">
              <BadgeCheck size={56} />
              <div className="vt">Your shop is verified</div>
              <div>Customers see the green check when they scan you.</div>
            </div>
          ) : (
            <div className="verdict warn">
              <Clock size={56} />
              <div className="vt">Waiting for verification</div>
              <div>We review new shops within minutes during the demo.</div>
            </div>
          )}
          <button className="btn big block" onClick={() => router.push('/merchant')}>Open checkout</button>
          {result.status === 'ACTIVE' && (
            <button className="btn ghost block" onClick={() => router.push('/merchant/qr')}>Print shop QR</button>
          )}
          <TechDetails
            rows={[
              { label: 'Merchant id', value: result.merchantId },
              { label: 'Register tx', value: result.txHash, href: explorerTx(chain?.deployment, result.txHash) },
              { label: 'Approve tx', value: result.approveTxHash, href: explorerTx(chain?.deployment, result.approveTxHash) },
              { label: 'Owner', value: derived?.owner },
              { label: 'Payout account', value: derived?.payout },
              { label: 'Checkout key', value: derived?.signer },
            ]}
          />
        </>
      )}
    </AppShell>
  );
}
