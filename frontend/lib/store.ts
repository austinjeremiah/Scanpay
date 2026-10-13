export interface LocalProfile {
  credentialId: string;
  transports?: string[];
  label: string;
  createdAt: number;
  addresses: { pay: `0x${string}`; owner: `0x${string}`; payout: `0x${string}` };
}
export interface LocalMerchant {
  chainId: number;
  merchantId: `0x${string}`;
  keyVersion: number;
  invoiceSigner: `0x${string}`;
  payoutTokenKey: string;
  displayName: string;
}
export interface ReceiptEntry {
  chainId: number;
  intentId: string;
  merchantName: string;
  amount: string;
  tokenSymbol: string;
  route: string;
  at: number;
}

const K = { profile: 'scanpay.profile', merchants: 'scanpay.merchants', vault: 'scanpay.receipts.v1', mode: 'scanpay.mode' };
const read = <T,>(k: string): T | null => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch { /* ignore */ }
};

export const store = {
  profile: () => read<LocalProfile>(K.profile),
  setProfile: (p: LocalProfile) => write(K.profile, p),
  merchants: () => read<LocalMerchant[]>(K.merchants) ?? [],
  merchantFor: (chainId: number) => (read<LocalMerchant[]>(K.merchants) ?? []).find((m) => m.chainId === chainId) ?? null,
  upsertMerchant: (m: LocalMerchant) =>
    write(K.merchants, [...(read<LocalMerchant[]>(K.merchants) ?? []).filter((x) => x.chainId !== m.chainId), m]),
  vaultBlob: () => read<{ iv: string; data: string }[]>(K.vault) ?? [],
  setVaultBlob: (b: { iv: string; data: string }[]) => write(K.vault, b),
  mode: () => read<'customer' | 'merchant'>(K.mode) ?? 'customer',
  setMode: (m: 'customer' | 'merchant') => write(K.mode, m),
  forgetDevice: () =>
    Object.values(K).forEach((k) => {
      try {
        localStorage.removeItem(k);
      } catch { /* ignore */ }
    }),
};
