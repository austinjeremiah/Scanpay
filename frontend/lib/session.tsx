'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { LocalAccount } from 'viem';
import { createPasskey, getPrf, passkeyErrorMessage } from './mera';
import { KeyRing } from './keys';
import { store, type LocalMerchant, type LocalProfile, type ReceiptEntry } from './store';
import { addReceipt } from './vault';

type Prompt = { reason: string } | null;
type Ctx = {
  profile: LocalProfile | null;
  /** the shell shows the "Confirm with Face ID" overlay while set */
  prompt: Prompt;
  onboard: (label: string) => Promise<LocalProfile>;
  withKeys: <T>(reason: string, fn: (ring: KeyRing) => Promise<T>) => Promise<T>;
  invoiceSigner: (keyVersion: number, expectedSigner: string) => Promise<LocalAccount>;
  invoiceSignerUnlockedUntil: number | null;
  lockTerminal: () => void;
  saveReceipt: (r: ReceiptEntry, ring: KeyRing) => Promise<void>;
  merchant: (chainId: number) => LocalMerchant | null;
  setMerchant: (m: LocalMerchant) => void;
  forgetDevice: () => void;
};
const SessionCtx = createContext<Ctx | null>(null);
const TERMINAL_TTL_MS = 30 * 60_000;

export class PasskeyError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<LocalProfile | null>(null);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [, force] = useState(0);
  const signer = useRef<{ keyVersion: number; ring: KeyRing; account: LocalAccount; until: number } | null>(null);

  useEffect(() => setProfile(store.profile()), []);
  useEffect(() => {
    const t = setInterval(() => {
      if (signer.current && Date.now() > signer.current.until) {
        signer.current.ring.wipe();
        signer.current = null;
        force((x) => x + 1);
      }
    }, 10_000);
    return () => clearInterval(t);
  }, []);

  const unlock = useCallback(async (reason: string): Promise<KeyRing> => {
    const p = store.profile();
    if (!p) throw new PasskeyError('NO_PROFILE', 'Create your passkey first.');
    setPrompt({ reason });
    try {
      const prf = await getPrf({ credentialId: p.credentialId, transports: p.transports });
      return new KeyRing(prf);
    } catch (e) {
      const m = passkeyErrorMessage(e);
      throw new PasskeyError(m.code, m.message);
    } finally {
      setPrompt(null);
    }
  }, []);

  const onboard = useCallback(async (label: string) => {
    setPrompt({ reason: 'Create your passkey' });
    try {
      const { cred, prf } = await createPasskey(label);
      const ring = new KeyRing(prf);
      const p: LocalProfile = {
        credentialId: cred.credentialId,
        transports: cred.transports,
        label,
        createdAt: Date.now(),
        addresses: { pay: ring.address('pay'), owner: ring.address('owner'), payout: ring.address('payout') },
      };
      ring.wipe();
      store.setProfile(p);
      setProfile(p);
      return p;
    } catch (e) {
      const m = passkeyErrorMessage(e);
      throw new PasskeyError(m.code, m.message);
    } finally {
      setPrompt(null);
    }
  }, []);

  const withKeys = useCallback(
    async <T,>(reason: string, fn: (ring: KeyRing) => Promise<T>) => {
      const ring = await unlock(reason);
      try {
        return await fn(ring);
      } finally {
        ring.wipe();
      }
    },
    [unlock],
  );

  /**
   * keyVersion = the registry's current keyVersion; expectedSigner = the registry's current invoiceSigner.
   * A payout update bumps keyVersion WITHOUT changing the signer, so we find the derivation index whose
   * address equals expectedSigner (walking down from keyVersion).
   */
  const invoiceSigner = useCallback(
    async (keyVersion: number, expectedSigner: string) => {
      const s = signer.current;
      if (s && s.keyVersion === keyVersion && s.account.address.toLowerCase() === expectedSigner.toLowerCase() && Date.now() < s.until) {
        return s.account;
      }
      s?.ring.wipe();
      signer.current = null;
      const ring = await unlock('Unlock your checkout for 30 minutes');
      let idx = keyVersion;
      while (idx > 0 && ring.address('invoice', idx).toLowerCase() !== expectedSigner.toLowerCase()) idx--;
      if (idx === 0) {
        ring.wipe();
        throw new PasskeyError('WRONG_PASSKEY', 'This passkey does not control this shop.');
      }
      const account = await ring.account('invoice', idx);
      signer.current = { keyVersion, ring, account, until: Date.now() + TERMINAL_TTL_MS };
      force((x) => x + 1);
      return account;
    },
    [unlock],
  );

  const value: Ctx = {
    profile,
    prompt,
    onboard,
    withKeys,
    invoiceSigner,
    invoiceSignerUnlockedUntil: signer.current?.until ?? null,
    lockTerminal: () => {
      signer.current?.ring.wipe();
      signer.current = null;
      force((x) => x + 1);
    },
    saveReceipt: async (r, ring) => addReceipt(await ring.vaultKey(), r),
    merchant: (chainId) => store.merchantFor(chainId),
    setMerchant: (m) => {
      store.upsertMerchant(m);
      force((x) => x + 1);
    },
    forgetDevice: () => {
      signer.current?.ring.wipe();
      signer.current = null;
      store.forgetDevice();
      setProfile(null);
    },
  };
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSession() {
  const c = useContext(SessionCtx);
  if (!c) throw new Error('useSession outside SessionProvider');
  return c;
}
