# ScanPay Guard — Frontend: Page-by-Page Build Spec (Mera Passkey PWA)

> **Scan. Verify. Pay. Know it arrived.**
> Monad Metropolis · Track 02 Consumer Products & Payments · build doc for the **Frontend** engineer (one person).
> Companions: **Backend A — Chain**, **Backend B — Services**. You own only `apps/web/`.

| | |
|---|---|
| Starting point | **Your UI template is already set up** (layout, components, styling). This doc says, for **every page**, exactly what goes on it — each element, icon, text, state, data field, API call and action — plus the small **wiring layer** (`lib/`) that connects pages to Mera, the API and Monad. |
| You receive | `@scanpay/shared` (I0: ABIs, EIP-712 builders, API zod schemas), B's local API (Sat night), testnet (I2), deployed API URL (I5) |
| You hand off | production PWA URL + the ≤ 3:00 demo video |
| Deadline | **Tue 13 Oct 2026, 23:59 ET = Wed 14 Oct 09:29 IST** |
| Your freeze | **Tue 13 Oct 18:00 IST** → record video → submit |
| Assumed template stack | React + Next.js App Router + Tailwind. Icons named from **lucide** (`lucide-react`). If your template uses another icon set, use the closest equivalent — the names below say what the icon must mean. |

---

## Table of contents

- [Part I — Rules for every page](#part-i--rules-for-every-page)
- [Part II — Wiring layer (`apps/web/lib/`) — build once, used by every page](#part-ii--wiring-layer)
- [Part III — App shell & global components](#part-iii--app-shell--global-components)
- [Part IV — Customer pages (P1–P9)](#part-iv--customer-pages)
- [Part V — Merchant pages (M1–M7)](#part-v--merchant-pages)
- [Part VI — Other pages (Attack Lab, Admin, Settings, system pages)](#part-vi--other-pages)
- [Part VII — Build order with exit checks](#part-vii--build-order-with-exit-checks)
- [Part VIII — Demo video script (≤ 3:00)](#part-viii--demo-video-script)
- [Part IX — Troubleshooting](#part-ix--troubleshooting)
- [Part X — Final checklist](#part-x--final-checklist)

---

## Part I — Rules for every page

### I.1 Copy rules ("a payments app that never mentions a blockchain")

Track 02's first example is literally *"A payments app that never mentions a blockchain to the person using it."*

| Never show in normal UI | Show instead |
|---|---|
| blockchain, on-chain, crypto, Web3, gas, wallet, seed phrase | "payment", "account", "network fee: **Free**", "passkey" |
| transaction hash, `0x…` addresses, contract names | inside a collapsed **"Technical details"** row only (`Code2` icon) |
| "sign", "signature" | "Confirm with Face ID" / "Confirm with passkey" |
| "testnet", "mainnet" | **Test mode** (amber pill) / **Live** (green pill) |
| "intent", "invoice id", "nonce" | "order", "payment", "QR" |
| "revert", "error 0x…" | the API's `error.message` (already human — B maps every contract error) |

Allowed exceptions: the **Attack Lab** and the **Receipt → Technical details** section (judges want proof there),
and the About section in Settings ("Settles on Monad in under a second").

### I.2 Visual language (apply your template's tokens to these meanings)

| Meaning | Color token | Icon |
|---|---|---|
| Verified / paid / safe | success (green) | `BadgeCheck`, `CheckCircle2`, `ShieldCheck` |
| Danger / not verified / blocked attack | danger (red) | `ShieldAlert`, `XCircle`, `OctagonX` |
| Waiting / in progress | info (blue) | `Loader2` (spinning), `Clock` |
| Warning / test mode / expiring | warning (amber) | `AlertTriangle`, `FlaskConical`, `Timer` |
| Neutral info | muted | `Info` |

Token display: each token gets a round chip with its `displaySymbol` (from `deployment.tokens[KEY].displaySymbol`):
`USDC`, `AUSD`, `MON`, `ETH`. Use your template's token icons if it has them; otherwise a colored circle with the
symbol's first letter (USDC blue, AUSD teal, MON purple, ETH slate). On the cross-chain picker show the **source
chain** as a small badge on the token chip (Base / Arbitrum / Ethereum / Optimism / Polygon / BNB).

### I.3 Numbers

- All token amounts arrive as **decimal strings in base units** (ICD wire rule). Convert with `formatToken()`
  (Part II). Never `Number()` a token amount.
- Stablecoins: 2 decimals in UI (`12.00 USDC`). MON/ETH: up to 4 significant decimals (`482.4 MON`).
- Fiat: `Intl.NumberFormat(locale, { style: 'currency', currency })` with the rate from `GET /v1/fx`.
- Times: countdowns `mm:ss`; history `Today 14:02`, `Yesterday`, `12 Oct`.

### I.4 Mera / passkey rules

| Rule | Why |
|---|---|
| Passkeys are bound to the **domain** (`NEXT_PUBLIC_RP_ID`). Decide the production domain before creating any real passkey. | A passkey made on `localhost` doesn't work on Vercel and vice versa. Vercel **preview** URLs never work — demo only on production. |
| Never store private keys, mnemonics or PRF output. Store only public addresses + the credential id. | "No custody backend" is a bounty rule. |
| Customer payments: **Face ID every payment**. Merchant invoice key: Face ID once, then kept **in memory** 30 min. Owner actions: Face ID every time. | Role-separated keys = "Many Keys" story. |
| PRF works on iOS 18+, Android Chrome, macOS Safari 18+ / Chrome 132+, 1Password. Fails on desktop Chrome local profile, Bitwarden, Dashlane. | Show the `PRF_UNAVAILABLE` sheet (Part III) and demo on phones. |
| WebAuthn needs HTTPS or `localhost`. | Phone testing of local dev needs a tunnel (Part VII). |

### I.5 "One Passkey, Many Keys" key map (used by Part II `keys.ts`)

One passkey → PRF output (32 bytes) → BIP-39 mnemonic (in memory only) → BIP-44 `m/44'/60'/0'/0/<index>`:

| Role | Index | Signs | Prompt |
|---|---|---|---|
| Pay account (customer) | `0` | `PaymentIntent`, EIP-3009 `ReceiveWithAuthorization`, one-time `approve` | every payment |
| Merchant owner | `1` | `Registration`, `SignerRotation`, `PayoutUpdate` | every owner action |
| Merchant payout wallet | `2` | co-signs `Registration`, `PayoutUpdate`; receives money | setup / payout change |
| Invoice signer **v k** | `100 + k` | every `Invoice` | once per 30-min terminal session |
| Receipt vault key | HKDF(PRF, `scanpay/receipts/v1`) | AES-GCM of local receipt history | when opening Activity |

---

## Part II — Wiring layer

Build these files once (≈ 3 hours, Sat night). Pages only call these — they never call `fetch`, Mera or viem directly.
That is what keeps the frontend free of wiring bugs: every signature is built by `@scanpay/shared` (golden-vector
tested against Solidity) and every API response is validated by B's zod schemas.

### II.1 Packages and config

Add to `apps/web/package.json` (keep your template's existing deps):

```json
{
  "name": "@scanpay/web",
  "dependencies": {
    "@scanpay/shared": "workspace:*",
    "@category-labs/mera": "latest",
    "@scure/bip32": "^1.5.0",
    "@scure/bip39": "^1.4.0",
    "@tanstack/react-query": "^5.59.0",
    "viem": "^2.40.0",
    "zod": "^3.23.8",
    "qrcode": "^1.5.4",
    "qr-scanner": "^1.4.2",
    "lucide-react": "^0.454.0",
    "sonner": "^1.5.0"
  },
  "devDependencies": { "@types/qrcode": "^1.5.5", "vitest": "^2.1.4" }
}
```

> After `pnpm install`, replace `"latest"` for Mera with the exact version installed (`pnpm why @category-labs/mera`)
> so the build is reproducible.

`apps/web/next.config.mjs` — merge into your template's config:

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@scanpay/shared'], // shared is TypeScript source, no build step
  async headers() {
    return [{
      source: '/(.*)',
      headers: [{ key: 'Permissions-Policy', value: 'camera=(self), publickey-credentials-get=(self), publickey-credentials-create=(self)' }],
    }];
  },
};
export default nextConfig;
```

`apps/web/.env.local` (FE-only variables; `NEXT_PUBLIC_API_URL` is the ICD one):

```dotenv
NEXT_PUBLIC_API_URL=http://localhost:8787
NEXT_PUBLIC_RP_ID=localhost
NEXT_PUBLIC_RP_NAME=ScanPay
NEXT_PUBLIC_DEFAULT_CHAIN_ID=31337
NEXT_PUBLIC_RPC_10143=https://testnet-rpc.monad.xyz
NEXT_PUBLIC_RPC_143=https://rpc.monad.xyz
```

### II.2 `lib/env.ts`

```ts
// NEXT_PUBLIC_* must be referenced literally so Next inlines them.
export const ENV = {
  API_URL: (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787').replace(/\/$/, ''),
  RP_ID: process.env.NEXT_PUBLIC_RP_ID ?? 'localhost',
  RP_NAME: process.env.NEXT_PUBLIC_RP_NAME ?? 'ScanPay',
  DEFAULT_CHAIN_ID: Number(process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID ?? 10143),
  RPC: {
    31337: 'http://127.0.0.1:8545',
    10143: process.env.NEXT_PUBLIC_RPC_10143 ?? 'https://testnet-rpc.monad.xyz',
    143: process.env.NEXT_PUBLIC_RPC_143 ?? 'https://rpc.monad.xyz',
  } as Record<number, string>,
};
```

### II.3 `lib/api.ts` — every endpoint, typed by B's schemas

```ts
import type { ZodTypeAny, z } from 'zod';
import {
  zAdminActionRes, zAllowanceRes, zAttackResult, zConfigRes, zDripRes, zFaucetRes, zFxRes, zInvoiceCreatedRes,
  zInvoiceListRes, zInvoiceRequestListRes, zInvoiceRequestRes, zInvoiceView, zIntentView, zKeyChangeRes, zKeyEventsRes,
  zMerchantView, zMerchantsRes, zPaymentsRes, zPrepareRes, zProtocolStatsRes, zQrResolveRes, zQuoteRes, zRegisterRes,
  zRoutesRes, zScenariosRes, zStatsRes, zSubmitRes, zTxRes, zVerifyRes,
  type zCreateInvoiceReq, type zInvoiceRequestReq, type zPayoutReq, type zPrepareReq, type zQuoteReq, type zRegisterReq,
  type zRotateReq, type zSubmitReq, type ScenarioId,
} from '@scanpay/shared';
import { ENV } from './env';

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: unknown,
    public requestId?: string,
  ) {
    super(message);
  }
}

async function call<S extends ZodTypeAny>(
  method: 'GET' | 'POST',
  path: string,
  schema: S | null,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<z.infer<S>> {
  let r: Response;
  try {
    r = await fetch(`${ENV.API_URL}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('NETWORK', 'No connection. Check your internet and try again.', 0);
  }
  const text = await r.text();
  const json = text ? JSON.parse(text) : {};
  if (!r.ok) {
    const e = json.error ?? {};
    throw new ApiError(e.code ?? 'INTERNAL', e.message ?? 'Something went wrong.', r.status, e.details, e.requestId);
  }
  return schema ? schema.parse(json) : json;
}

const q = (o: Record<string, string | number | undefined>) =>
  '?' + Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

export const api = {
  // config + fx
  config: () => call('GET', '/v1/config', zConfigRes),
  fx: (quote: string) => call('GET', `/v1/fx${q({ quote })}`, zFxRes),
  stats: (chainId: number) => call('GET', `/v1/stats/${chainId}`, zProtocolStatsRes),

  // merchants
  registerMerchant: (b: z.input<typeof zRegisterReq>) => call('POST', '/v1/merchants/register', zRegisterRes, b),
  rotateSigner: (b: z.input<typeof zRotateReq>) => call('POST', '/v1/merchants/rotate-signer', zKeyChangeRes, b),
  updatePayout: (b: z.input<typeof zPayoutReq>) => call('POST', '/v1/merchants/update-payout', zKeyChangeRes, b),
  merchant: (chainId: number, id: string) => call('GET', `/v1/merchants/${chainId}/${id}`, zMerchantView),
  merchantsByOwner: (chainId: number, owner: string) => call('GET', `/v1/merchants/by-owner/${chainId}/${owner}`, zMerchantsRes),
  merchantPayments: (chainId: number, id: string, limit = 25, offset = 0) =>
    call('GET', `/v1/merchants/${chainId}/${id}/payments${q({ limit, offset })}`, zPaymentsRes),
  merchantStats: (chainId: number, id: string, days = 14) => call('GET', `/v1/merchants/${chainId}/${id}/stats${q({ days })}`, zStatsRes),
  merchantKeys: (chainId: number, id: string) => call('GET', `/v1/merchants/${chainId}/${id}/keys`, zKeyEventsRes),
  merchantInvoices: (chainId: number, id: string) => call('GET', `/v1/merchants/${chainId}/${id}/invoices`, zInvoiceListRes),
  merchantRequests: (chainId: number, id: string) => call('GET', `/v1/merchants/${chainId}/${id}/invoice-requests`, zInvoiceRequestListRes),

  // invoices + QR
  createInvoice: (b: z.input<typeof zCreateInvoiceReq>) => call('POST', '/v1/invoices', zInvoiceCreatedRes, b),
  invoice: (code: string) => call('GET', `/v1/invoices/${code}`, zInvoiceView),
  createInvoiceRequest: (b: z.input<typeof zInvoiceRequestReq>) => call('POST', '/v1/invoice-requests', zInvoiceRequestRes, b),
  invoiceRequest: (id: string) => call('GET', `/v1/invoice-requests/${id}`, zInvoiceRequestRes),
  qrResolve: (data: string) => call('GET', `/v1/qr/resolve${q({ data })}`, zQrResolveRes),

  // paying
  routes: (shortCode: string) => call('GET', `/v1/routes${q({ shortCode })}`, zRoutesRes),
  quote: (b: z.input<typeof zQuoteReq>) => call('POST', '/v1/quotes', zQuoteRes, b),
  prepare: (b: z.input<typeof zPrepareReq>) => call('POST', '/v1/intents/prepare', zPrepareRes, b),
  submit: (b: z.input<typeof zSubmitReq>) => call('POST', '/v1/intents/submit', zSubmitRes, b, { 'idempotency-key': b.draftId }),
  intent: (chainId: number, id: string) => call('GET', `/v1/intents/${chainId}/${id}`, zIntentView),
  sourceTx: (chainId: number, id: string, txHash: string) => call('POST', `/v1/intents/${chainId}/${id}/source-tx`, null, { txHash }),
  simulateDeposit: (chainId: number, id: string, amount?: string) =>
    call('POST', `/v1/intents/${chainId}/${id}/simulate-deposit`, zTxRes, amount ? { amount } : {}),
  verify: (chainId: number, id: string) => call('GET', `/v1/verify/${chainId}/${id}`, zVerifyRes),

  // account helpers
  allowance: (chainId: number, token: string, owner: string) => call('GET', `/v1/allowance${q({ chainId, token, owner })}`, zAllowanceRes),
  drip: (chainId: number, address: string, tokenKey: string) => call('POST', '/v1/gas/drip', zDripRes, { chainId, address, tokenKey }),
  faucet: (chainId: number, address: string) => call('POST', '/v1/faucet', zFaucetRes, { chainId, address }),

  // attack lab
  attackScenarios: (chainId: number) => call('GET', `/v1/attack-lab/scenarios${q({ chainId })}`, zScenariosRes),
  attackRun: (chainId: number, scenario: ScenarioId, broadcast = false) => call('POST', '/v1/attack-lab/run', zAttackResult, { chainId, scenario, broadcast }),

  // admin (token from the Admin page input, kept in sessionStorage)
  adminMerchants: (token: string, chainId: number, status?: string) =>
    call('GET', `/v1/admin/merchants${q({ chainId, status })}`, zMerchantsRes, undefined, { authorization: `Bearer ${token}` }),
  adminAction: (token: string, chainId: number, merchantId: string, action: 'approve' | 'reactivate' | 'suspend' | 'revoke') =>
    call('POST', `/v1/admin/merchants/${chainId}/${merchantId}/${action}`, zAdminActionRes, {}, { authorization: `Bearer ${token}` }),
};
```

### II.4 `lib/config.tsx` — network (Test mode / Live) + deployment

```tsx
'use client';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Deployment, TokenInfo, TokenKey } from '@scanpay/shared';
import { api } from './api';
import { ENV } from './env';

type ChainEntry = { chainId: number; deployment: Deployment; features: { direct: boolean; swap: boolean; crosschain: 'live' | 'simulated' | 'off'; faucet: boolean; attackLab: boolean; indexer: boolean } };
type Ctx = {
  ready: boolean;
  chains: ChainEntry[];
  chainId: number;
  setChainId: (id: number) => void;
  chain: ChainEntry | null;
  publicAppUrl: string;
  get: (chainId: number) => ChainEntry | null;
  isLive: (chainId: number) => boolean;
};
const ConfigCtx = createContext<Ctx | null>(null);
const LS_KEY = 'scanpay.chainId';

export function ConfigProvider({ children }: { children: ReactNode }) {
  const { data } = useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: 5 * 60_000 });
  const [chainId, setChainIdState] = useState<number>(ENV.DEFAULT_CHAIN_ID);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(LS_KEY));
      if (v) setChainIdState(v);
    } catch { /* private mode */ }
  }, []);
  const value = useMemo<Ctx>(() => {
    const chains = (data?.chains ?? []) as ChainEntry[];
    const get = (id: number) => chains.find((c) => c.chainId === id) ?? null;
    const effective = get(chainId) ? chainId : chains[0]?.chainId ?? chainId;
    return {
      ready: Boolean(data),
      chains,
      chainId: effective,
      setChainId: (id) => {
        setChainIdState(id);
        try { localStorage.setItem(LS_KEY, String(id)); } catch { /* ignore */ }
      },
      chain: get(effective),
      publicAppUrl: data?.publicAppUrl ?? '',
      get,
      isLive: (id) => id === 143,
    };
  }, [data, chainId]);
  return <ConfigCtx.Provider value={value}>{children}</ConfigCtx.Provider>;
}

export function useConfig() {
  const c = useContext(ConfigCtx);
  if (!c) throw new Error('useConfig outside ConfigProvider');
  return c;
}

export function findToken(d: Deployment | undefined, address: string | null | undefined): { key: TokenKey; token: TokenInfo } | null {
  if (!d || !address) return null;
  for (const [key, token] of Object.entries(d.tokens) as [TokenKey, TokenInfo][]) {
    if (token.address.toLowerCase() === address.toLowerCase()) return { key, token };
  }
  return null;
}
```

Wrap the template's root layout: `<QueryClientProvider client={qc}><ConfigProvider><SessionProvider>{children}<Toaster /></SessionProvider></ConfigProvider></QueryClientProvider>`.

### II.5 `lib/format.ts`

```ts
import { formatUnits, parseUnits } from 'viem';

export function formatToken(amount: string | bigint | null | undefined, decimals: number, opts: { stable?: boolean } = {}): string {
  if (amount === null || amount === undefined) return '—';
  const s = formatUnits(BigInt(amount), decimals);
  const n = Number(s);
  if (opts.stable ?? decimals <= 6) return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toLocaleString(undefined, { maximumSignificantDigits: 6 });
}

/** "12.5" -> 12500000n for 6 decimals. Returns null for invalid input. */
export function parseTokenInput(input: string, decimals: number): bigint | null {
  const clean = input.replace(/,/g, '').trim();
  if (!/^\d*\.?\d*$/.test(clean) || clean === '' || clean === '.') return null;
  try {
    return parseUnits(clean, decimals);
  } catch {
    return null;
  }
}

export function formatFiat(usd: number, rate: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(usd * rate);
}

export const shortHex = (h?: string | null, n = 4) => (h ? `${h.slice(0, 2 + n)}…${h.slice(-n)}` : '');

export function countdown(secondsLeft: number): string {
  if (secondsLeft <= 0) return '0:00';
  const m = Math.floor(secondsLeft / 60);
  const s = secondsLeft % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function when(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const today = new Date();
  const y = new Date(Date.now() - 86400_000);
  const t = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today ${t}`;
  if (d.toDateString() === y.toDateString()) return `Yesterday ${t}`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Local currency guess for fiat display (invoice.fiat wins when present). */
export function localCurrency(): string {
  const region = (Intl.DateTimeFormat().resolvedOptions().locale.split('-')[1] ?? '').toUpperCase();
  const map: Record<string, string> = { IN: 'INR', US: 'USD', GB: 'GBP', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', JP: 'JPY', SG: 'SGD', AE: 'AED', AU: 'AUD', CA: 'CAD', BR: 'BRL', KR: 'KRW' };
  return map[region] ?? 'USD';
}

export const flagEmoji = (cc: string) =>
  cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '';
```

### II.6 `lib/mera.ts` — the only file that touches the Mera SDK

```ts
import { createPasskeyWithPrfOutput, getPasskeyPrfOutput, createSecp256k1SigningSession, isMeraError } from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import type { LocalAccount } from 'viem';
import { ENV } from './env';

export interface StoredCredential {
  credentialId: string;
  transports?: string[];
}

const bytes = (x: ArrayBuffer | Uint8Array): Uint8Array => (x instanceof Uint8Array ? x : new Uint8Array(x));

/** Creates a passkey and returns its PRF output (32 bytes). One Face ID. */
export async function createPasskey(label: string): Promise<{ cred: StoredCredential; prf: Uint8Array }> {
  const r: any = await createPasskeyWithPrfOutput({
    rp: { id: ENV.RP_ID, name: ENV.RP_NAME },
    user: { name: label, displayName: label },
  });
  return { cred: { credentialId: r.credentialId, transports: r.transports }, prf: bytes(r.prfOutput) };
}

/** Re-derives the same PRF output from an existing passkey. One Face ID. */
export async function getPrf(cred: StoredCredential): Promise<Uint8Array> {
  const r: any = await getPasskeyPrfOutput({
    rpId: ENV.RP_ID,
    credential: { id: cred.credentialId, transports: cred.transports },
  });
  return bytes(r.prfOutput);
}

/** Wraps a derived private key in a Mera signing session and returns a viem LocalAccount. */
export async function accountFor(privateKey: Uint8Array): Promise<{ account: LocalAccount; end: () => void }> {
  const session: any = await createSecp256k1SigningSession({ privateKey });
  const account = toViemAccount(session) as LocalAccount;
  return { account, end: () => session.end?.() };
}

export function passkeyErrorMessage(e: unknown): { code: string; message: string } {
  if (isMeraError(e)) {
    const code = (e as any).code as string;
    const message = {
      PRF_UNAVAILABLE: "This device's passkey manager can't be used for payments. Use an iPhone (iOS 18+), an Android phone, or 1Password.",
      PASSKEY_OPERATION_FAILED: 'Face ID was cancelled or failed. Try again.',
      CRYPTO_UNAVAILABLE: 'This browser is missing secure features. Open the app in Safari or Chrome.',
      SESSION_ENDED: 'Your secure session ended. Try again.',
    }[code] ?? 'Passkey error. Try again.';
    return { code, message };
  }
  if ((e as any)?.name === 'NotAllowedError') return { code: 'CANCELLED', message: 'Face ID was cancelled.' };
  return { code: 'UNKNOWN', message: 'Something went wrong with your passkey.' };
}
```

> **Check once against the installed SDK** (open `node_modules/@category-labs/mera` types): the exact parameter
> shape of `getPasskeyPrfOutput` (`credential` object vs `credentialId`), whether `prfOutput` is `Uint8Array` or
> `ArrayBuffer`, and whether `createSecp256k1SigningSession` takes `privateKey` as bytes or hex. If anything differs,
> fix it **here only** — the rest of the app only sees `createPasskey`, `getPrf`, `accountFor`.

### II.7 `lib/keys.ts` — One Passkey, Many Keys

```ts
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import type { LocalAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { toHex } from 'viem';
import { accountFor } from './mera';

export const KEY_INDEX = { PAY: 0, OWNER: 1, PAYOUT: 2, INVOICE_BASE: 100 } as const;
export type Role = 'pay' | 'owner' | 'payout' | 'invoice';
const indexOf = (role: Role, keyVersion = 1) =>
  role === 'pay' ? KEY_INDEX.PAY : role === 'owner' ? KEY_INDEX.OWNER : role === 'payout' ? KEY_INDEX.PAYOUT : KEY_INDEX.INVOICE_BASE + keyVersion;

/** Holds the HD root in memory for ONE operation; call wipe() when done. */
export class KeyRing {
  private root: HDKey;
  private ends: (() => void)[] = [];
  private prf: Uint8Array;

  constructor(prf: Uint8Array) {
    if (prf.length !== 32) throw new Error('PRF output must be 32 bytes');
    this.prf = prf;
    const mnemonic = entropyToMnemonic(prf, wordlist); // 24 words, never leaves memory
    this.root = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
  }

  private priv(role: Role, keyVersion?: number): Uint8Array {
    const k = this.root.derive(`m/44'/60'/0'/0/${indexOf(role, keyVersion)}`);
    if (!k.privateKey) throw new Error('derivation failed');
    return k.privateKey;
  }

  /** Public address only (no Mera session needed). */
  address(role: Role, keyVersion?: number): `0x${string}` {
    return privateKeyToAccount(toHex(this.priv(role, keyVersion))).address;
  }

  /** Signing account backed by a Mera secp256k1 session. */
  async account(role: Role, keyVersion?: number): Promise<LocalAccount> {
    const { account, end } = await accountFor(this.priv(role, keyVersion));
    this.ends.push(end);
    return account;
  }

  /** AES-GCM key for the local receipt vault (5th key from the same passkey). */
  async vaultKey(): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey('raw', this.prf, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('scanpay'), info: new TextEncoder().encode('scanpay/receipts/v1') },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  wipe() {
    for (const e of this.ends) e();
    this.ends = [];
    this.prf.fill(0);
    this.root.wipePrivateData();
  }
}
```

**Unit test `apps/web/lib/keys.test.ts`** (run `pnpm --filter @scanpay/web exec vitest run lib`):

```ts
import { describe, expect, it } from 'vitest';
import { KeyRing } from './keys';

describe('KeyRing', () => {
  it('is deterministic and role-separated', () => {
    const prf = new Uint8Array(32).fill(7);
    const a = new KeyRing(prf.slice());
    const b = new KeyRing(prf.slice());
    expect(a.address('pay')).toBe(b.address('pay'));
    const set = new Set([a.address('pay'), a.address('owner'), a.address('payout'), a.address('invoice', 1), a.address('invoice', 2)]);
    expect(set.size).toBe(5);
  });
});
```

### II.8 `lib/store.ts` — what the device remembers (public data only)

```ts
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
  try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : null; } catch { return null; }
};
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

export const store = {
  profile: () => read<LocalProfile>(K.profile),
  setProfile: (p: LocalProfile) => write(K.profile, p),
  merchants: () => read<LocalMerchant[]>(K.merchants) ?? [],
  merchantFor: (chainId: number) => (read<LocalMerchant[]>(K.merchants) ?? []).find((m) => m.chainId === chainId) ?? null,
  upsertMerchant: (m: LocalMerchant) => write(K.merchants, [...(read<LocalMerchant[]>(K.merchants) ?? []).filter((x) => x.chainId !== m.chainId), m]),
  vaultBlob: () => read<{ iv: string; data: string }[]>(K.vault) ?? [],
  setVaultBlob: (b: { iv: string; data: string }[]) => write(K.vault, b),
  mode: () => (read<'customer' | 'merchant'>(K.mode) ?? 'customer'),
  setMode: (m: 'customer' | 'merchant') => write(K.mode, m),
  forgetDevice: () => Object.values(K).forEach((k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } }),
};
```

### II.9 `lib/vault.ts` — encrypted receipt history

```ts
import type { ReceiptEntry } from './store';
import { store } from './store';

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function addReceipt(key: CryptoKey, r: ReceiptEntry) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(r))));
  store.setVaultBlob([{ iv: b64(iv), data: b64(data) }, ...store.vaultBlob()].slice(0, 200));
}

export async function readReceipts(key: CryptoKey): Promise<ReceiptEntry[]> {
  const out: ReceiptEntry[] = [];
  for (const e of store.vaultBlob()) {
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.iv) }, key, unb64(e.data));
      out.push(JSON.parse(new TextDecoder().decode(pt)));
    } catch { /* entry from another passkey — skip */ }
  }
  return out;
}
```

### II.10 `lib/session.tsx` — Face ID orchestration (used by every signing button)

```tsx
'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { LocalAccount } from 'viem';
import { createPasskey, getPrf, passkeyErrorMessage } from './mera';
import { KeyRing } from './keys';
import { store, type LocalMerchant, type LocalProfile } from './store';
import { addReceipt } from './vault';
import type { ReceiptEntry } from './store';

type Prompt = { reason: string } | null;
type Ctx = {
  profile: LocalProfile | null;
  prompt: Prompt;                                   // shell shows the "Confirm with Face ID" overlay while set
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
  constructor(public code: string, message: string) { super(message); }
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
        credentialId: cred.credentialId, transports: cred.transports, label, createdAt: Date.now(),
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

  const withKeys = useCallback(async <T,>(reason: string, fn: (ring: KeyRing) => Promise<T>) => {
    const ring = await unlock(reason);
    try {
      return await fn(ring);
    } finally {
      ring.wipe();
    }
  }, [unlock]);

  /**
   * keyVersion = the registry's current keyVersion; expectedSigner = the registry's current invoiceSigner.
   * A payout update bumps keyVersion WITHOUT changing the signer, so we find the derivation index whose
   * address equals expectedSigner (walking down from keyVersion). See M5.
   */
  const invoiceSigner = useCallback(async (keyVersion: number, expectedSigner: string) => {
    const s = signer.current;
    if (s && s.keyVersion === keyVersion && s.account.address.toLowerCase() === expectedSigner.toLowerCase() && Date.now() < s.until) {
      return s.account;
    }
    s?.ring.wipe();
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
  }, [unlock]);

  const value: Ctx = {
    profile,
    prompt,
    onboard,
    withKeys,
    invoiceSigner,
    invoiceSignerUnlockedUntil: signer.current?.until ?? null,
    lockTerminal: () => { signer.current?.ring.wipe(); signer.current = null; force((x) => x + 1); },
    saveReceipt: async (r, ring) => addReceipt(await ring.vaultKey(), r),
    merchant: (chainId) => store.merchantFor(chainId),
    setMerchant: (m) => { store.upsertMerchant(m); force((x) => x + 1); },
    forgetDevice: () => { signer.current?.ring.wipe(); signer.current = null; store.forgetDevice(); setProfile(null); },
  };
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSession() {
  const c = useContext(SessionCtx);
  if (!c) throw new Error('useSession outside SessionProvider');
  return c;
}
```

### II.11 `lib/sign.ts` — every signature the app makes (all via `@scanpay/shared`)

```ts
import type { Hex, LocalAccount } from 'viem';
import {
  buildIntentTypedData, buildInvoiceTypedData, buildPayoutUpdateTypedData, buildReceiveAuthTypedData,
  buildRegistrationTypedData, buildSignerRotationTypedData, fromWireIntent, intentDigest, receiveAuthForIntent,
  type InvoiceMessage, type PayoutUpdateMessage, type PrepareRes, type RegistrationMessage, type SignerRotationMessage,
} from '@scanpay/shared';

/** Customer: sign a prepared draft exactly as B froze it. */
export async function signPrepared(pay: LocalAccount, prep: PrepareRes): Promise<{ payerSig: Hex; receiveAuthSig?: Hex }> {
  const intent = fromWireIntent(prep.intent);
  if (intent.payer.toLowerCase() !== pay.address.toLowerCase()) throw new Error('Prepared for a different account');
  const payerSig = await pay.signTypedData(buildIntentTypedData(prep.chainId, prep.vault, intent));
  if (!prep.signing.receiveAuth) return { payerSig };
  const msg = receiveAuthForIntent(intent, intentDigest(prep.chainId, prep.vault, intent), prep.vault);
  const receiveAuthSig = await pay.signTypedData(
    buildReceiveAuthTypedData(prep.chainId, { address: prep.signing.receiveAuth.token, eip712: prep.signing.receiveAuth.domain }, msg),
  );
  return { payerSig, receiveAuthSig };
}

/** Merchant setup: owner AND payout wallet sign the same Registration digest. */
export async function signRegistration(owner: LocalAccount, payout: LocalAccount, chainId: number, registry: Hex, reg: RegistrationMessage) {
  const td = buildRegistrationTypedData(chainId, registry, reg);
  return { ownerSig: await owner.signTypedData(td), payoutSig: await payout.signTypedData(td) };
}

export const signInvoice = (signer: LocalAccount, chainId: number, vault: Hex, inv: InvoiceMessage) =>
  signer.signTypedData(buildInvoiceTypedData(chainId, vault, inv));

export const signRotation = (owner: LocalAccount, chainId: number, registry: Hex, r: SignerRotationMessage) =>
  owner.signTypedData(buildSignerRotationTypedData(chainId, registry, r));

export async function signPayoutUpdate(owner: LocalAccount, payout: LocalAccount, chainId: number, registry: Hex, u: PayoutUpdateMessage) {
  const td = buildPayoutUpdateTypedData(chainId, registry, u);
  return { ownerSig: await owner.signTypedData(td), payoutSig: await payout.signTypedData(td) };
}
```

### II.12 `lib/chain.ts` — the few direct reads/writes from the browser

```ts
import { createPublicClient, createWalletClient, erc20Abi, http, maxUint256, type Hex, type LocalAccount } from 'viem';
import { foundry, monad, monadTestnet } from 'viem/chains';
import { merchantRegistryAbi } from '@scanpay/shared';
import { ENV } from './env';

const CHAINS = { 31337: foundry, 10143: monadTestnet, 143: monad } as const;
const clients = new Map<number, ReturnType<typeof createPublicClient>>();

export function publicClient(chainId: number) {
  let c = clients.get(chainId);
  if (!c) {
    c = createPublicClient({ chain: CHAINS[chainId as keyof typeof CHAINS], transport: http(ENV.RPC[chainId]) });
    clients.set(chainId, c);
  }
  return c;
}

export async function tokenBalance(chainId: number, token: Hex, owner: Hex): Promise<bigint> {
  return publicClient(chainId).readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
}

export async function ownerNonce(chainId: number, registry: Hex, owner: Hex): Promise<bigint> {
  return publicClient(chainId).readContract({ address: registry, abi: merchantRegistryAbi, functionName: 'ownerNonce', args: [owner] }) as Promise<bigint>;
}

/** The ONLY transaction the browser sends: one-time approve for the SWAP route (gas dripped by B). */
export async function approveMax(chainId: number, account: LocalAccount, token: Hex, spender: Hex): Promise<Hex> {
  const chain = CHAINS[chainId as keyof typeof CHAINS];
  const pub = publicClient(chainId);
  const wallet = createWalletClient({ account, chain, transport: http(ENV.RPC[chainId]) });
  const gas = await pub.estimateContractGas({ address: token, abi: erc20Abi, functionName: 'approve', args: [spender, maxUint256], account });
  const hash = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [spender, maxUint256], gas: (gas * 12n) / 10n, chain, account });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}
```

### II.13 `lib/sse.ts` — live updates

```ts
'use client';
import { useEffect, useRef } from 'react';
import type { SseEvent } from '@scanpay/shared';
import { ENV } from './env';

const TYPES = ['intent.updated', 'payment.settled', 'invoice.updated', 'invoice_request.created', 'merchant.updated'] as const;

/** Subscribe to one B stream path, e.g. `/v1/intents/10143/0x…/stream`. Pass null to disconnect. */
export function useSse(path: string | null, onEvent: (ev: SseEvent) => void, onReconnect?: () => void) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (!path) return;
    const es = new EventSource(`${ENV.API_URL}${path}`);
    const handler = (m: MessageEvent) => cb.current(JSON.parse(m.data) as SseEvent);
    TYPES.forEach((t) => es.addEventListener(t, handler as EventListener));
    es.onopen = () => onReconnect?.(); // resync via REST after (re)connect
    return () => es.close();
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
}
```

### II.14 `lib/hooks.ts` — small shared hooks

```ts
'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { localCurrency } from './format';

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** USD -> local fiat for display. `preferred` = invoice.fiat.currency when present. */
export function useFx(preferred?: string | null) {
  const currency = preferred ?? localCurrency();
  const q = useQuery({ queryKey: ['fx', currency], queryFn: () => api.fx(currency), staleTime: 10 * 60_000, enabled: currency !== 'USD' });
  return { currency, rate: currency === 'USD' ? 1 : q.data?.rate ?? null };
}

export const vibrate = (ms = 60) => { try { navigator.vibrate?.(ms); } catch { /* ignore */ } };
```

**Exit checks for Part II**
- [ ] `pnpm --filter @scanpay/web exec tsc --noEmit` passes
- [ ] `vitest run lib` → KeyRing test passes
- [ ] A scratch button calling `api.config()` against B's local API logs chain 31337 features

---

## Part III — App shell & global components

Map each item onto your template's existing components (top bar, bottom nav, sheet/drawer, card, button, badge,
toast, skeleton). Where the template has nothing, build the small component described.

### G1 — App shell

| Element | Icon | Spec |
|---|---|---|
| Top bar · left | `ShieldCheck` + wordmark **ScanPay** | tap → `/` (customer) or `/merchant` (merchant mode) |
| Top bar · center | — | page title (given per page below); hidden on Home |
| Top bar · right 1 | — | **Network pill** (G2) |
| Top bar · right 2 | `ArrowLeftRight` | mode switch: customer ⇄ merchant (`store.setMode`). In merchant mode without a merchant profile on this network → goes to `/merchant/setup` |
| Bottom nav (customer) | `Home` · `ScanLine` (raised, center, primary color) · `Receipt` · `Wallet` | Home `/` · Scan `/scan` · Activity `/activity` · Wallet `/wallet` |
| Bottom nav (merchant) | `Store` · `BarChart3` · `KeyRound` · `Settings` | Checkout `/merchant` · History `/merchant/history` · Keys `/merchant/keys` · Settings `/merchant/settings` |
| Bottom nav hidden on | `/pay/*`, `/payment/*`, `/m/*` full-screen flows, `/merchant/qr` (print) | |
| Offline banner | `WifiOff` | top, amber: "You're offline. Payments need a connection." (`navigator.onLine` + `online/offline` events) |
| Toaster | — | `sonner` bottom-center; success `CheckCircle2`, error `XCircle`, info `Info` |

### G2 — Network pill + network sheet

| State | Look | Text |
|---|---|---|
| chain 10143 / 31337 | amber pill, `FlaskConical` | **Test mode** |
| chain 143 | green pill, `CircleDot` | **Live** |

Tap → bottom sheet "Network":
- One row per `config.chains` entry: radio, title (Test mode / Live / Local), subtitle (Test mode: "Free test money. Try everything." · Live: "Real money. Payments are capped at 25 USD."), right side `Check` when selected.
- Switching to Live shows a confirm: `AlertTriangle` "You're switching to real money." [Cancel] [Switch].
- Calls `config.setChainId(id)`; invalidate all React Query caches (`queryClient.invalidateQueries()`).
- Pages that carry their own chain (pay links, receipts) **ignore** the pill and show a small pill for *their* chain.

### G3 — Face ID overlay (global, driven by `session.prompt`)

Full-screen dim overlay while `prompt !== null`:
- Center icon `ScanFace` (64 px, pulsing ring animation).
- Title: `prompt.reason` (e.g. "Pay 12.00 USDC to Chai Point").
- Subtitle: "Confirm with Face ID or your fingerprint."
- No buttons (the OS sheet handles cancel). Disappears automatically.

### G4 — Passkey error sheet

Shown when any action throws `PasskeyError`:

| code | Icon | Title | Body | Action |
|---|---|---|---|---|
| `CANCELLED` / `PASSKEY_OPERATION_FAILED` | `ScanFace` | Not confirmed | "Nothing was paid. Try again when you're ready." | [Try again] |
| `PRF_UNAVAILABLE` | `Smartphone` | This device can't be used | the message from `passkeyErrorMessage` | [Open on my phone] → shows a QR of the current URL |
| `CRYPTO_UNAVAILABLE` | `ShieldOff` | Browser not supported | message | [Copy link] |
| `NO_PROFILE` | `UserPlus` | Create your passkey first | "Takes 5 seconds. No passwords." | [Create passkey] → G10 |

### G5 — Shared display components (build if the template lacks them)

| Component | Icon | Props → render |
|---|---|---|
| `TokenChip` | — | `{symbol, chain?}` → circle + symbol; optional chain badge (Base/Arbitrum/…) bottom-right |
| `Amount` | — | `{value(base units string), decimals, symbol, size}` → big number via `formatToken` + `TokenChip` |
| `FiatLine` | `≈` text | `{usd(number), currency}` → "≈ ₹1,003.42" (hidden if no rate) |
| `MerchantAvatar` | `Store` fallback | `{logoUrl, displayName}` → image or initials on tinted circle |
| `VerifiedBadge` | `BadgeCheck` / `ShieldAlert` | `{verified}` → green "Verified merchant" / red "Not verified" |
| `QrView` | — | `{payload, size}` → `QRCode.toDataURL(payload, {margin:1, width:size, errorCorrectionLevel:'M'})`, white padding, rounded |
| `CopyButton` | `Copy` → `Check` (1.5 s) | copies text, toast "Copied" |
| `Countdown` | `Timer` | `{until(unix)}` → `mm:ss`; amber < 120 s, red < 30 s; calls `onExpire` |
| `StepList` | per step | `{steps:[{label, state:'done'|'active'|'todo'|'error'}]}` → `CheckCircle2` / `Loader2` spin / `Circle` / `XCircle` |
| `TechDetails` | `Code2` + `ChevronDown` | collapsed by default; rows `{label, value, href?}` with `CopyButton` and `ExternalLink` |
| `ErrorState` | given | `{icon, title, message, action?}` centered |
| `EmptyState` | given | `{icon, title, message, action?}` |
| `IndexedTag` | `Database` | small muted tag "Indexed by Envio" when an API response has `source:"envio"` |

### G6 — Install banner (PWA)

- Show on Home after the first successful payment or merchant setup, if `beforeinstallprompt` fired (Android) or iOS
  Safari not standalone.
- Icon `Download`; text "Add ScanPay to your home screen"; [Install] (Android: `prompt()`); iOS: sheet with
  `Share` icon → "Tap Share, then **Add to Home Screen**". Dismiss `X` (remember 7 days).
- Manifest (template likely has one — check fields): `name: "ScanPay"`, `short_name: "ScanPay"`, `display: "standalone"`,
  `start_url: "/"`, `theme_color`/`background_color` from your template, icons 192/512 + maskable.

### G7 — Onboarding sheet (inline; also used by `/welcome`)

Triggered whenever a signing action needs a profile and none exists.

| # | Element | Icon | Content |
|---|---|---|---|
| 1 | Hero icon | `Fingerprint` (48 px) | |
| 2 | Title | — | "Pay with your face. That's it." |
| 3 | Bullets | `KeyRound`, `EyeOff`, `Zap` | "No passwords or recovery words" · "Your keys never leave this phone" · "No fees to pay" |
| 4 | Name input | `User` | label "Your name (shown only on this device)"; default "My ScanPay" |
| 5 | Primary button | `ScanFace` | **Create passkey** → `session.onboard(name)` |
| 6 | Footer | `Info` | "Uses your phone's passkey (iCloud Keychain / Google Password Manager)." |

On success: toast "You're set" + continue the action that triggered the sheet.

---

## Part IV — Customer pages

Page format: **Route · Purpose · Load (API calls) · Layout (top → bottom) · States · Actions · Acceptance.**

### P1 — Home `/`

**Purpose:** first screen; get to "Scan" in one tap; show trust + test-mode helpers.
**Load:** `api.config()` (provider), `api.stats(chainId)` (optional), balances of the pay account if a profile exists
(`tokenBalance` for USDC/AUSD on the selected chain).

| # | Element | Icon | Content / binding | Behavior |
|---|---|---|---|---|
| 1 | Greeting | — | "Hi {profile.label}" or "Welcome to ScanPay" | |
| 2 | Balance card | `Wallet` | "Your balance" + USDC and AUSD amounts (`formatToken`) + fiat total (`FiatLine`) | tap → `/wallet`; if no profile: card shows [Create passkey] (G7) |
| 3 | Big Scan button | `ScanLine` | "Scan to pay" (full-width, primary, 64 px tall) | → `/scan` |
| 4 | Secondary row | `ClipboardPaste` · `Store` | "Paste a payment link" (sheet with input → `/scan?data=`) · "I'm a merchant" → merchant mode | |
| 5 | Test mode card (chain ≠ 143) | `FlaskConical` | "Test mode — get free test money" | [Get test money] → `api.faucet(chainId, pay)` → toast "Added 100 USDC, 100 AUSD, 2,000 MON" |
| 6 | "Why it's safe" card | `ShieldCheck` | 3 lines with icons: `BadgeCheck` "Every shop is verified" · `Lock` "The amount is locked when you confirm" · `CheckCircle2` "You get proof the money arrived" | tap → `/attack-lab` ("See attacks we block") |
| 7 | Recent payments (max 3) | `Receipt` | from Activity vault if unlocked this session, else hidden | → `/activity` |
| 8 | Footer | `Zap` | "Settles in under a second · Built on Monad" (muted, small) | |
| 9 | Install banner | `Download` | G6 | |

**States:** config loading → skeleton for card 2; API down → `ErrorState(CloudOff, "Can't reach ScanPay", "Check your connection.")`.
**Acceptance:** Scan reachable in 1 tap; faucet works on test mode and is hidden on Live.

### P2 — Welcome `/welcome`

Full-page version of G7 (used from Home when no profile and from deep links). After success → `next` query param
or `/`. Add a small "Already have a passkey on this phone?" link → calls `session.withKeys('Restore', async r => …)`
**only if** a profile exists in storage; if storage was cleared, the user simply creates a new passkey (addresses are
derived from the passkey, so the same passkey always gives the same accounts — explain: "Lost this phone? Your
passkey syncs via iCloud/Google; sign in on a new phone with the same passkey." and implement restore as:
`navigator.credentials.get` through `getPrf` with an **empty** credential list is not supported by all SDKs — skip
restore for the hackathon; show the text only).

### P3 — Scan `/scan`

**Purpose:** camera → resolve → route to the right page, warning on anything suspicious.
**Load:** nothing until a code is read. If `?data=` is present, skip the camera and resolve it.

| # | Element | Icon | Content | Behavior |
|---|---|---|---|---|
| 1 | Camera viewport | — | full-width video, rounded; dark overlay with a square cut-out + animated scan line | `new QrScanner(video, r => onResult(r.data), { returnDetailedScanResult: true, highlightScanRegion: true, preferredCamera: 'environment' })` |
| 2 | Torch toggle | `Flashlight` / `FlashlightOff` | only if `scanner.hasFlash()` | `scanner.toggleFlash()` |
| 3 | Helper text | — | "Point at a ScanPay QR" | |
| 4 | Paste link | `ClipboardPaste` | "Paste a link instead" | input sheet → resolve |
| 5 | Camera denied state | `CameraOff` | "Allow camera access to scan" + [Try again] + paste option | |

**Actions — on a scanned string:**

```ts
scanner.stop(); vibrate(30);
const r = await api.qrResolve(data);
if (r.kind === 'invoice' && r.verified) router.push(`/pay/${r.shortCode}`);
else if (r.kind === 'merchant' && r.verified) router.push(`/m/${r.chainId}/${r.merchantId}`);
else openWarningSheet(r); // never auto-continue on warnings
```

**Warning sheet** (`ShieldAlert`, red): title "This QR isn't safe to pay", list `r.warnings` (each with
`AlertTriangle`), merchant card if known; buttons [Scan again] (primary) and, only when `r.kind === 'invoice'` and
the merchant exists but is not ACTIVE, a muted "Show details" (opens `/pay/{code}` in read-only mode). No "pay anyway".

**Acceptance:** an `evil.example/pay/...` link shows the warning sheet with "points to evil.example"; an unregistered
static QR shows "not registered".

### P4 — Pay `/pay/[code]` (the most important screen)

**Purpose:** show who/what, choose how, confirm with Face ID. After submit, navigate to P9 (live status).
**Load (parallel):** `api.invoice(code)` → `InvoiceView`; `api.routes(code)`; `useFx(invoice.fiat?.currency)`;
if profile: `tokenBalance` of the pay account for the payout token and every `routes.swap.tokens`.

**Layout**

| # | Element | Icon | Content / binding | Behavior |
|---|---|---|---|---|
| 1 | Top bar | `ArrowLeft` | title "Pay"; right: small network pill for `invoice.chainId` | back → `/scan` |
| 2 | Merchant card | `MerchantAvatar` | `merchant.profile.displayName`; second line `category · city {flagEmoji(country)}` | tap → "Why you can trust this" sheet |
| 3 | Verified badge (in card) | `BadgeCheck` green / `ShieldAlert` red | verified = `merchant.status === 'ACTIVE' && merchant.profileVerified` | |
| 4 | Amount | — | `Amount(invoice.amount, decimals, payoutToken.displaySymbol, 'xl')` e.g. **12.00 USDC** | |
| 5 | Fiat line | — | `invoice.fiat` if set ("₹1,000.00 bill") else `FiatLine(amount, fx)` | |
| 6 | Memo | `StickyNote` | `invoice.memo` (if any) | |
| 7 | Expiry | `Timer` | `Countdown(until = invoice.expiresAt)`; "Expires in 14:32" | on expire → state **Expired** |
| 8 | Section title | — | "Pay with" | |
| 9 | Option A — DIRECT | `Zap` | title "{USDC} balance"; subtitle "Instant · no fees"; right: "You have 52.10" | shown if `routes.direct.available`; disabled + "Not enough — Add funds" link if balance < amount |
| 10 | Option B — SWAP | `ArrowLeftRight` | title "Another token"; subtitle the list `MON, AUSD…` from `routes.swap.tokens` | opens **Token sheet** (P4.1); after pick shows "482.4 MON" |
| 11 | Option C — CROSSCHAIN | `Globe` | title "Another chain"; subtitle "Base, Arbitrum, Ethereum…"; tag `FlaskConical` "Simulated" when `routes.crosschain.mode === 'simulated'` | opens **Chain sheet** (P4.2) |
| 12 | Summary card (after an option is chosen) | `ReceiptText` | rows: "You pay" (`≈ estimatedIn` for swap/cc, exact for direct) · "Max you can pay" (`maxAmountIn`, only swap/cc, muted, `Info` tooltip "Unused amount is returned automatically") · "{merchant} receives" (`amountOut`) · "Network fee" **Free** · "Price valid for" `Countdown(quote.expiresAt)` | quote refreshes automatically when it hits 0 |
| 13 | Primary button | `ScanFace` | "Pay with Face ID" (or "Create passkey to pay" when no profile → G7) | runs **Pay action** |
| 14 | Lock footnote | `Lock` | "The shop, amount and where the money goes are locked by your confirmation." | |
| 15 | Technical details | `Code2` | rows: Merchant id, Order id (`invoice.invoiceId`), Payout token address, Network | |

**"Why you can trust this" sheet** (`ShieldCheck`): rows with `CheckCircle2`:
"Registered and verified by ScanPay" (status ACTIVE) · "Payout account is locked on-chain" · "This QR was signed by
the shop's checkout key (version {keyVersion})" · "Shop details match what they registered" (profileVerified).
Technical details: merchantId, registry link (explorer), owner, payout wallet.

#### P4.1 — Token sheet (SWAP)

| Element | Icon | Content |
|---|---|---|
| Title | `ArrowLeftRight` | "Pay with another token" |
| Rows (one per `routes.swap.tokens`) | `TokenChip` | symbol · "You have {balance}" · right: quote "≈ {estimatedIn}" (loads per row via `api.quote({shortCode, route:'SWAP', inputTokenKey, payer})`, `Loader2` while loading) |
| Disabled row | — | balance < `maxAmountIn` → muted + "Not enough" |
| Note | `Info` | "First time with a token? You'll give a one-time permission. Still confirmed with Face ID every time." |

Pick → close sheet, set option B, store the quote (summary card 12).

#### P4.2 — Chain sheet (CROSSCHAIN)

| Element | Icon | Content |
|---|---|---|
| Title | `Globe` | "Pay from another chain" |
| Test-mode banner | `FlaskConical` | "Test mode: delivery is simulated — you'll tap a button instead of sending real funds." |
| Groups by `originAssets[].blockchain` | chain logo/badge | headers: Base · Arbitrum · Ethereum · Optimism · Polygon · BNB Chain |
| Rows | `TokenChip(symbol, chain)` | symbol · right: quote "≈ {originAmountIn formatted with origin decimals}" (from `api.quote({…route:'CROSSCHAIN', originAssetId, payer})`) |
| Footer | `Clock` | "Usually arrives in 1–3 minutes. If it doesn't, you're refunded automatically." |

Pick → set option C with `originAssetId`; ask for **refund address** only in Live mode: input "Your {chain} address
(for refunds)" with `Wallet` icon, validated `/^0x[0-9a-fA-F]{40}$/` (prefill the pay address — it's a valid EVM
address on every chain and the same passkey controls it). In Test mode, use the pay address silently.

#### P4.3 — One-time permission sheet (SWAP, only if `prep.swap.needsApproval`)

| Element | Icon | Content |
|---|---|---|
| Icon | `ShieldCheck` | |
| Title | — | "Allow {MON} for ScanPay payments" |
| Body | — | "One time only. ScanPay can only move {MON} when you confirm a payment with Face ID." |
| Detail rows | `Check` ×2 | "We cover the small network cost" · "You can remove it anytime" |
| Button | `ScanFace` | "Allow and pay" → continues the Pay action (same Face ID does approve + sign) |

**Pay action (exact sequence)**

```ts
async function pay(choice: { route: 'DIRECT' | 'SWAP' | 'CROSSCHAIN'; inputTokenKey?: TokenKey; originAssetId?: string; refundTo?: string }) {
  setBusy(true);
  try {
    // 1) freeze terms server-side (no keys needed; payer = public pay address)
    const prep = await api.prepare({
      shortCode: code,
      route: choice.route,
      inputTokenKey: choice.inputTokenKey,
      origin: choice.route === 'CROSSCHAIN' ? { assetId: choice.originAssetId!, refundTo: choice.refundTo ?? profile!.addresses.pay } : undefined,
      payer: profile!.addresses.pay,
    });
    if (prep.swap?.needsApproval && !(await confirmPermissionSheet())) return; // P4.3

    // 2) ONE Face ID: approve (if needed) + sign + submit + save receipt
    await session.withKeys(`Pay ${amountLabel} to ${merchantName}`, async (ring) => {
      const acct = await ring.account('pay');
      if (prep.swap?.needsApproval) {
        if (prep.swap.dripAvailable) await api.drip(prep.chainId, acct.address, choice.inputTokenKey!);
        await approveMax(prep.chainId, acct, prep.intent.inputToken as Hex, prep.swap.spender as Hex);
      }
      const sigs = await signPrepared(acct, prep);
      const res = await api.submit({ draftId: prep.draftId, ...sigs });
      await session.saveReceipt({
        chainId: prep.chainId, intentId: prep.intentId, merchantName, amount: prep.intent.amountOut,
        tokenSymbol: payoutSymbol, route: choice.route, at: Math.floor(Date.now() / 1000),
      }, ring);
      vibrate(res.lifecycle === 'SETTLED' ? 80 : 30);
      router.replace(`/payment/${prep.chainId}/${prep.intentId}`);
    });
  } catch (e) {
    showError(e); // PasskeyError -> G4; ApiError -> failure card with e.message (+ code in TechDetails)
  } finally {
    setBusy(false);
  }
}
```

**States**

| State | Trigger | Render |
|---|---|---|
| Loading | queries pending | skeleton card + amount + 3 option skeletons |
| Not found | `INVOICE_NOT_FOUND` | `ErrorState(SearchX, "This payment link doesn't exist", "Ask the shop for a new QR.")` |
| Expired | `invoice.state === 'EXPIRED'` or countdown 0 | `ErrorState(Clock, "This QR expired", "Ask the shop to show a new one.")` + [Scan again] |
| Already paid | `state === 'PAID'` | `ErrorState(CheckCircle2 green, "Already paid", "")` + [View receipt] if `paidIntentId` → `/receipt/{chainId}/{paidIntentId}` |
| In progress | `state === 'RESERVED'` | `ErrorState(Loader2, "Someone is paying this QR right now", "If it was you, check Activity.")` |
| Unverified merchant | `merchant.status !== 'ACTIVE'` | red banner `ShieldAlert` "This shop isn't verified. Don't pay." + options hidden |
| Busy | `pay()` running | button `Loader2` "Confirming…"; options disabled |
| Failure | ApiError | inline red card `XCircle` + `e.message` + [Try again] (re-runs prepare) + TechDetails (`code`, `requestId`, `details.errorName`) |
| Insufficient funds | DIRECT balance < amount | option A disabled with "Add funds" → Wallet sheet (P8.1); in Test mode also [Get test money] |

**Acceptance:** DIRECT on test mode: scan → Pay → one Face ID → status page shows "Paid" in ≈ 1–2 s.
Tampering is impossible from the UI (all amounts come from the draft).

### P5 — Shop QR (static) `/m/[chainId]/[merchantId]`

**Purpose:** printed counter QR. Customer types the amount; the merchant's terminal signs the invoice; customer
continues to P4.
**Load:** `api.merchant(chainId, merchantId)`; `useFx()`.

| # | Element | Icon | Content | Behavior |
|---|---|---|---|---|
| 1 | Merchant card | `MerchantAvatar` + `VerifiedBadge` | as P4 #2–3 | |
| 2 | Amount keypad | `Delete` (backspace) | big display in merchant's payout token (`USDC`/`AUSD`), fiat line below; keypad 1–9, `.`, 0, backspace | max 2 decimals |
| 3 | Note input | `StickyNote` | optional "What's it for?" (≤ 140) | |
| 4 | Button | `Send` | "Ask {shop} for a payment QR" | `api.createInvoiceRequest({ chainId, merchantId, amount: parseTokenInput(v, 6).toString(), note })` |
| 5 | Waiting card (after send) | `Loader2` | "Waiting for {shop} to confirm… Show this screen at the counter." + `Countdown(expiresAt)` | subscribe `useSse('/v1/invoice-requests/{id}/stream')`; poll `api.invoiceRequest(id)` every 3 s as fallback; on `shortCode` → `router.replace('/pay/' + shortCode)` |
| 6 | Expired | `Clock` | "The shop didn't respond. Try again or scan their screen." | [Try again] |

Unverified merchant → same red banner as P4, keypad hidden.

### P6 — Receipt & verification `/receipt/[chainId]/[intentId]` (public, shareable)

**Purpose:** "Know it arrived." Three proofs, recomputed by the server from chain data. Judges will open this.
**Load:** `api.verify(chainId, intentId)`; `api.intent(chainId, intentId)` (may 404 for payments made outside the app
— then hide amount rows); `api.merchant(chainId, intent.merchantId)` for name/logo.

| # | Element | Icon | Content |
|---|---|---|---|
| 1 | Verdict banner | VERIFIED `ShieldCheck` green "Payment verified" · PENDING `Loader2` blue "Payment in progress" · REFUNDED `Undo2` amber "Refunded" · FAILED `ShieldAlert` red "Verification failed" · NOT_FOUND `SearchX` "No such payment" | subtitle `when(settledAt)` |
| 2 | Summary | `MerchantAvatar` | "{amountOut} {symbol} to {shop}"; "Shop received {netToMerchant}" (muted, `Info`: "after the shop's 0.3% fee") ; route chip: `Zap` Direct / `ArrowLeftRight` Swapped from {input} / `Globe` From {chain} |
| 3 | Proof card 1 | `Store` | **Who you paid** — rows from `proofs.merchant.checks` |
| 4 | Proof card 2 | `FileSignature` | **What you approved** — rows from `proofs.intent.checks` |
| 5 | Proof card 3 | `Landmark` | **Where the money went** — rows from `proofs.settlement.checks` |
| 6 | Check row | `CheckCircle2` green (ok true) · `XCircle` red (false) · `CircleDashed` grey (null) | `label` bold + `detail` muted (truncate hex with `shortHex`, full on tap) |
| 7 | Trust notes | `Info` | each `trustNotes[]` line (muted) |
| 8 | Share | `Share2` | `navigator.share({ title: 'Payment receipt', url: location.href })` / copy |
| 9 | Verify yourself | `Terminal` | code block: `pnpm --filter @scanpay/api verify-receipt {chainId} {intentId}` + `CopyButton` + text "Checks the network directly — no need to trust us." |
| 10 | Technical details | `Code2` | Payment id, commit tx (`links.commitTx`, `ExternalLink`), settle tx (`links.settleTx`), vault, registry, network |

Each proof card header shows a status dot: green if `section.ok === true`, red if false, grey if null.
**PENDING** refetches every 3 s (or subscribe to the intent stream) until terminal.

### P7 — Activity `/activity`

**Purpose:** the customer's private history (encrypted on device with the 5th key).
**Load:** nothing until unlocked.

| # | Element | Icon | Content | Behavior |
|---|---|---|---|---|
| 1 | Locked state | `Lock` | "Your history is encrypted on this phone." | [Unlock with Face ID] → `withKeys('Open your history', r => readReceipts(await r.vaultKey()))` → keep the list in component state (not storage) |
| 2 | List row | route icon (`Zap`/`ArrowLeftRight`/`Globe`) | shop name · `when(at)` · amount + symbol · status chip (fetched lazily via `api.intent` for the first 20 rows: Paid `CheckCircle2` / Pending `Loader2` / Refunded `Undo2` / Failed `XCircle`) | tap → status page P9 if pending, else receipt P6 |
| 3 | Empty | `Receipt` | "No payments yet" + [Scan to pay] | |
| 4 | Lock again | `Lock` | top-right | clears list from memory |

### P8 — Wallet `/wallet`

**Purpose:** see balances, add money, test-mode faucet.
**Load:** `tokenBalance` for every token in `chain.deployment.tokens` for `profile.addresses.pay` (refetch every 15 s).

| # | Element | Icon | Content | Behavior |
|---|---|---|---|---|
| 1 | Total card | `Wallet` | fiat total (stables at 1 USD, others × `usdPrice`) + "Test mode" pill when relevant | |
| 2 | Token rows | `TokenChip` | symbol, name, balance, fiat | |
| 3 | Add funds | `Plus` | opens **P8.1** | |
| 4 | Get test money | `Droplets` | only test mode: `api.faucet(...)` | toast with amounts; errors `FAUCET_LIMIT` → "Already used today" |
| 5 | Your account | `User` | `profile.label`; "Account ID" `shortHex(pay)` + Copy (this is the only place the address shows — labelled "Account ID") | |
| 6 | Passkey info | `KeyRound` | "Protected by your passkey · created {date}" | |

**P8.1 Add funds sheet** (`Plus`): QR of the pay address (`QrView(pay)`), Copy button, text:
"Send USDC or AUSD on **Monad** to this account ID." Warning `AlertTriangle`: "Only send on Monad. For other chains,
use **Pay from another chain** at checkout — no need to move money first."

### P9 — Payment status `/payment/[chainId]/[intentId]` (live)

**Purpose:** what happens after Face ID — instant for DIRECT/SWAP, minutes for CROSSCHAIN (deposit instructions here).
**Load:** `api.intent(chainId, intentId)` → `IntentView`; `useSse('/v1/intents/{chainId}/{intentId}/stream', ev => ev.type === 'intent.updated' && setIntent(ev.intent), refetch)`;
`api.merchant(chainId, intent.merchantId)`.

**Common layout**

| # | Element | Icon | Content |
|---|---|---|---|
| 1 | Shop + amount header | `MerchantAvatar` | "{amount} {symbol} to {shop}" |
| 2 | Step list | `StepList` | per route (below) |
| 3 | Big result (terminal states) | see below | |
| 4 | Technical details | `Code2` | intent id, submit/commit/settle/refund/attest tx links (`explorer + /tx/`), forwarder |

**DIRECT / SWAP steps:** `ScanFace` Confirmed → `ShieldCheck` Checked shop & amount → `Send` Sending → `CheckCircle2` Paid.
`SUBMITTED` = steps 1–3 done, 4 active; `SETTLED` = all done.

**CROSSCHAIN steps:** `Lock` Order locked (`COMMITTED`/`AWAITING_DEPOSIT`) → `ArrowDownToLine` Deposit received
(`PROCESSING` or `crosschain.received ≥ required`) → `RefreshCw` Converting & delivering → `CheckCircle2` Paid.

**CROSSCHAIN deposit panel** (shown while `AWAITING_DEPOSIT` / `PROCESSING` / `UNDERPAID` / `EXPIRED`):

| # | Element | Icon | Content | Behavior |
|---|---|---|---|---|
| a | Instruction | `Send` | "Send exactly **{originAmountIn} {originSymbol}** on **{chain}**" | amount `CopyButton` |
| b | Deposit address | `Copy` | `crosschain.depositAddress` in mono, wrapped | `CopyButton` |
| c | QR | — | Live + EVM origin: EIP-681 URI `ethereum:{tokenContract}@{evmChainId}/transfer?address={deposit}&uint256={originAmountIn}` (native ETH: `ethereum:{deposit}@{evmChainId}?value={amount}`); otherwise the plain address. `tokenContract`/`evmChainId` come from the origin asset picked in P4.2 — save it in `sessionStorage['scanpay.origin.'+intentId]` right after `prepare`; if missing (page reopened elsewhere), show the plain address QR | for scanning with any wallet app |
| d | Deadline | `Timer` | `Countdown(intent.expiresAt)` — "Send within 24:10" | |
| e | Warning | `AlertTriangle` | "Only {originSymbol} on {chain}. Other tokens or chains can't be recovered." | |
| f | "I've sent it" | `Link2` | input "Paste the transaction link or hash" + [Submit] | `api.sourceTx(chainId, intentId, hashFromInput)` (extract `0x…64` from a pasted explorer link) → toast "Thanks — we're watching for it" |
| g | Progress bar | — | `received / required` from `intent.crosschain` (formatted in USDC) — "Received 0.00 of 12.04 USDC" | |
| h | **Test mode only** | `Sparkles` | [Simulate delivery] (primary) and small link "Simulate partial (50%)" | `api.simulateDeposit(chainId, intentId)` / with `amount = required/2` |

**Lifecycle → copy (big result / banner)**

| lifecycle | Icon | Title | Body |
|---|---|---|---|
| `SUBMITTED` | `Loader2` | Sending… | "This takes about a second." |
| `AWAITING_DEPOSIT` | `Clock` | Waiting for your deposit | deposit panel |
| `PROCESSING` | `RefreshCw` (spin) | Deposit seen — converting | "Usually 1–3 minutes." |
| `UNDERPAID` | `AlertTriangle` amber | Not enough arrived | "Received {received} of {required}. Send the rest, or wait — you'll be refunded automatically at {refundableAt time}." |
| `RECONCILIATION_REQUIRED` | `ShieldAlert` amber | We're double-checking | "The exchange said it's done, but the money hasn't arrived. The shop isn't marked paid. If it doesn't arrive, you're refunded at {time}." |
| `EXPIRED` | `Timer` amber | Time's up | "If you already sent it, it will still complete. Otherwise you'll be refunded at {time}." |
| `SETTLED` | `CheckCircle2` green (animated, confetti optional) | **Paid** | "{shop} received {amount} {symbol}" + [View receipt] (`Receipt`) → P6 + [Done] → `/` ; `vibrate(80)` |
| `REFUNDED` | `Undo2` | Refunded | "{refundAmount} returned to your account." + [Done] |
| `FAILED` | `XCircle` red | Payment didn't go through | `intent.error.message` + "Nothing was charged." + [Try again] → `/pay/{invoiceShortCode}` |

**Acceptance:** test-mode cross-chain: Simulate delivery → steps animate to Paid within ~5 s; partial → amber
UNDERPAID → second partial → Paid.

---

## Part V — Merchant pages

**Entering merchant mode (all merchant pages):**

```ts
// on mount of any /merchant/* page
let m = session.merchant(chainId);
if (!m && session.profile) {
  const { merchants } = await api.merchantsByOwner(chainId, session.profile.addresses.owner); // restore on a new device / cleared storage
  if (merchants[0]) {
    const v = merchants[0];
    m = { chainId, merchantId: v.merchantId, keyVersion: v.keyVersion, invoiceSigner: v.invoiceSigner, payoutTokenKey: v.payoutTokenKey ?? 'USDC', displayName: v.profile?.displayName ?? 'My shop' };
    session.setMerchant(m);
  }
}
if (!m) router.replace('/merchant/setup');
```

Always also load `api.merchant(chainId, m.merchantId)` (React Query key `['merchant', chainId, id]`, refetch on
`merchant.updated` SSE) — the **chain is the truth** for status and `keyVersion`; if it differs from local, update local.

### M1 — Shop setup `/merchant/setup` (3 steps)

**Purpose:** create the shop with **three keys from one Face ID** and register it (owner + payout signatures).
**Load:** `chain.deployment.tokens` (payout options = tokens whose `roles` include `"payout"`), `ownerNonce` at submit.

**Step indicator** at top: `1 Shop` → `2 Keys` → `3 Done` (`Circle`/`CheckCircle2`).

**Step 1 — Your shop**

| # | Element | Icon | Content | Validation |
|---|---|---|---|---|
| 1 | Shop name | `Store` | input, placeholder "Chai Point" | 1–60 chars |
| 2 | Category | `Tag` | select: Food & drink · Retail · Services · Travel · Other | required |
| 3 | City | `MapPin` | input | ≤ 60 |
| 4 | Country | `Globe2` | select with flag emoji (ISO-2, default from locale) | `^[A-Z]{2}$` |
| 5 | Logo URL (optional) | `Image` | input; live preview `MerchantAvatar` | valid URL or empty |
| 6 | Get paid in | `Banknote` | two radio cards: **USDC** "US dollar stablecoin" / **AUSD** "Agora dollar — great for cross-border" (only tokens with `payout` role) | required |
| 7 | Preview card | — | how customers will see the shop (P4 merchant card) | |
| 8 | Next | `ArrowRight` | "Continue" | |

**Step 2 — Your keys** (the Many-Keys moment — make it visual)

| # | Element | Icon | Content |
|---|---|---|---|
| 1 | Title | `Fingerprint` | "One Face ID creates your shop's keys" |
| 2 | Key cards (3, animated in after Face ID) | `KeyRound` Owner key · `Landmark` Payout account · `QrCode` Checkout key v1 | role sentence each: "Approves changes to your shop" · "Receives your money" · "Signs every QR you show — can be replaced anytime" ; after derivation show `shortHex(address)` under each |
| 3 | Explainer | `Info` | "All three come from your passkey. Nothing is stored on our servers." |
| 4 | Button | `ScanFace` | "Create my shop" → **Setup action** |

**Setup action**

```ts
await session.withKeys('Create your shop', async (ring) => {
  const owner = await ring.account('owner');
  const payout = await ring.account('payout');
  const invoiceSigner = ring.address('invoice', 1);
  setDerived({ owner: owner.address, payout: payout.address, invoiceSigner }); // animate key cards
  const registry = chain.deployment.contracts.MerchantRegistry.address;
  const profileObj = { displayName, category, city, country, logoUrl }; // exactly these 5 keys
  const reg = {
    owner: owner.address, salt: randomBytes32(), payoutWallet: payout.address, invoiceSigner,
    payoutToken: chain.deployment.tokens[payoutKey]!.address, metadataHash: profileHash(profileObj),
    nonce: await ownerNonce(chainId, registry, owner.address), deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  };
  const { ownerSig, payoutSig } = await signRegistration(owner, payout, chainId, registry, reg);
  const res = await api.registerMerchant({ chainId, registration: toWireRegistration(reg), ownerSig, payoutSig, profile: profileObj });
  session.setMerchant({ chainId, merchantId: res.merchantId, keyVersion: 1, invoiceSigner, payoutTokenKey: payoutKey, displayName });
  setResult(res); // step 3
});
```

**Step 3 — Done**

| Status | Icon | Title | Body | Buttons |
|---|---|---|---|---|
| `ACTIVE` (test mode auto-approves) | `BadgeCheck` green | "Your shop is verified" | "Customers see the green check when they scan you." | [Open checkout] → `/merchant` · [Print shop QR] → `/merchant/qr` |
| `PENDING` (Live) | `Clock` amber | "Waiting for verification" | "We review new shops within minutes during the demo." | [Open checkout] (shows pending state) |

Technical details: merchant id, register tx, approve tx (`res.approveTxHash`), owner/payout/checkout addresses.

**Errors:** `PROFILE_HASH_MISMATCH` (shouldn't happen — the same object is hashed and sent; if it does, log both),
`BAD_NONCE` → auto-retry once, `MERCHANT_EXISTS` → run the restore code above, `PAYOUT_TOKEN_NOT_ALLOWED` → re-pick.

### M2 — Checkout terminal `/merchant` (merchant home)

**Purpose:** type amount → show signed QR → see "Paid ✓" within a second. Also the inbox for static-QR requests.
**Load:** merchant view; `useSse('/v1/merchants/{chainId}/{merchantId}/stream', onEvent)`; `useFx()`;
`api.merchantRequests(...)` once on mount (then SSE).

**Header strip**

| Element | Icon | Content |
|---|---|---|
| Shop name + badge | `MerchantAvatar`, `VerifiedBadge` | |
| Checkout lock status | `Unlock` green "Checkout unlocked · 24 min" / `Lock` "Locked" | from `session.invoiceSignerUnlockedUntil`; tap Lock → `session.lockTerminal()` |
| Pending banner (status PENDING) | `Clock` amber | "Waiting for verification — you can't take payments yet." (keypad disabled) |
| Suspended/Revoked banner | `ShieldAlert` red | "Your shop is suspended. Contact support." |

**State A — Keypad**

| # | Element | Icon | Content | Behavior |
|---|---|---|---|---|
| 1 | Amount display | — | big "0.00" + payout `TokenChip`; fiat line underneath | |
| 2 | Keypad | `Delete` | 1–9, `.`, 0, backspace; long-press backspace clears | max 2 decimals; max amount 1,000,000 (test) / cap from `deployment.config.amountCaps` (Live: 25) — show `AlertTriangle` "Live payments are capped at 25" |
| 3 | Note | `StickyNote` | optional "Add a note" (≤ 140) | |
| 4 | Fiat bill toggle | `Banknote` | "Bill in ₹" switch: type the amount in local currency → converted with fx to token units (rounded up to cents), and `fiat:{currency, amount}` is attached to the invoice | |
| 5 | Primary | `QrCode` | "Show QR" (disabled at 0) | **Create invoice action** |
| 6 | Inbox chip | `BellRing` + count | "2 customers waiting" when requests exist | opens inbox sheet (State D) |

**Create invoice action**

```ts
async function showQr(amount: bigint, opts: { memo?: string; fiat?: { currency: string; amount: string }; requestId?: string }) {
  const m = session.merchant(chainId)!;
  const v = merchantView!; // api.merchant(chainId, m.merchantId) — chain truth for keyVersion, signer, payout token
  try {
    const signer = await session.invoiceSigner(v.keyVersion, v.invoiceSigner); // Face ID only if locked/expired
    const vault = chain.deployment.contracts.IntentVault.address;
    const inv = {
      merchantId: m.merchantId, invoiceId: randomBytes32(), payoutToken: v.payoutToken,
      amount, expiresAt: BigInt(Math.floor(Date.now() / 1000) + 15 * 60), keyVersion: v.keyVersion,
    };
    const merchantSig = await signInvoice(signer, chainId, vault, inv);
    const res = await api.createInvoice({ chainId, invoice: toWireInvoice(inv), merchantSig, memo: opts.memo, fiat: opts.fiat, requestId: opts.requestId });
    setCurrent({ ...res, amount, invoiceId: inv.invoiceId }); // -> State B
  } catch (e) {
    if (e instanceof ApiError && e.code === 'MERCHANT_KEYS_CHANGED') {
      const v = await api.merchant(chainId, m.merchantId);
      session.lockTerminal();
      session.setMerchant({ ...m, keyVersion: v.keyVersion, invoiceSigner: v.invoiceSigner });
      toast.error('Your checkout key changed. Unlock again.');
    } else showError(e);
  }
}
```

**State B — Showing QR**

| # | Element | Icon | Content | Behavior |
|---|---|---|---|---|
| 1 | Amount | — | big amount + token + fiat | |
| 2 | QR | — | `QrView(res.qrPayload, 300)` on white, max brightness hint | |
| 3 | Short code | `Link2` | `res.shortCode` in mono (customers can type it at `/pay/<code>`) + Copy | |
| 4 | Countdown | `Timer` | `Countdown(res.expiresAt)` | at 0 → State A with toast "QR expired" |
| 5 | Waiting line | `Loader2` | "Waiting for payment…" → "Customer is paying…" when an `invoice.updated` with RESERVED arrives (subscribe `useSse('/v1/invoices/{shortCode}/stream')`) | |
| 6 | Cancel | `X` | "New sale" | back to State A (the QR simply expires unused) |
| 7 | Share | `Share2` | share the URL (remote payments) | |

**State C — Paid overlay** (on SSE `payment.settled` with `payment.invoiceId === current.invoiceId`, or `invoice.updated` PAID)

| Element | Icon | Content |
|---|---|---|
| Full-screen success | `CheckCircle2` (96 px, scale-in) | **Paid {amount} {symbol}** |
| Route line | `Zap` / `ArrowLeftRight` / `Globe` | "Direct" / "Customer paid in {input symbol}" / "From another chain" |
| Net line | `Landmark` | "You received {netToMerchant}" (after 0.3% fee) |
| Time | `Clock` | "Confirmed in {settledAt − shownAt} s" (shows Monad speed — keep it) |
| Buttons | `Receipt` · `Plus` | [Receipt] → `/receipt/{chainId}/{intentId}` · [New sale] (auto after 8 s) |
| Feedback | — | `vibrate([60,40,60])` + short chime (WebAudio 880 Hz 120 ms) |

Other `payment.settled` events (not the current QR) → toast `CheckCircle2` "Received {amount} {symbol}".

**State D — Inbox sheet (static-QR requests)** — opened by the chip or automatically when `invoice_request.created`
arrives while in State A.

| Element | Icon | Content | Behavior |
|---|---|---|---|
| Title | `BellRing` | "Customers asking to pay" | |
| Row | `User` | amount + token, fiat, note, `Countdown(expiresAt)` | [Accept] → `showQr(BigInt(req.amount), { memo: req.note, requestId: req.requestId })` → the customer's phone jumps to P4 automatically; the terminal goes to State B for that invoice |
| Empty | `Inbox` | "No requests" | |

**Acceptance:** first QR asks Face ID; the next ones within 30 min don't. Customer DIRECT payment flips State C in
≈ 1 s on testnet.

### M3 — History `/merchant/history`

**Load:** `api.merchantStats(chainId, id, 14)`, `api.merchantPayments(chainId, id, 25, offset)`; SSE `payment.settled`
→ prepend + invalidate stats.

| # | Element | Icon | Content |
|---|---|---|---|
| 1 | Stat tiles (3) | `TrendingUp` Sales today · `Hash` Payments · `Landmark` Received (net) | from stats (`settledVolume`, `paymentCount`, `netReceived`) and today's `daily` entry |
| 2 | 14-day bar chart | `BarChart3` | bars = `daily[].volume` (simple divs or the template's chart); x labels day-of-month; tap a bar → tooltip amount + count |
| 3 | `IndexedTag` | `Database` | "Indexed by Envio" when `source === 'envio'` |
| 4 | List rows | route icon | amount (`amountOut`) · "net {netToMerchant}" · `when(settledAt ?? committedAt)` · status chip (Paid / Pending / Refunded) · source chain badge for cross-chain (from `sourceChainId`: 8453 Base, 42161 Arbitrum, 1 Ethereum, 10 Optimism, 137 Polygon, 56 BNB) |
| 5 | Row tap | `ChevronRight` | → `/receipt/{chainId}/{intentId}` |
| 6 | Load more | `ChevronDown` | offset += 25 |
| 7 | Empty | `Receipt` | "No payments yet — show your first QR" + [Open checkout] |

### M4 — Keys `/merchant/keys` ("One Passkey, Many Keys")

**Load:** merchant view; `api.merchantKeys(chainId, id)`; `session.profile`.

**Key map card** (vertical tree, root at top):

| Node | Icon | Title | Sub | Right side |
|---|---|---|---|---|
| Root | `Fingerprint` | Your passkey | "Face ID · on this phone · synced by iCloud/Google" | — |
| 1 | `KeyRound` | Owner key | "Approves changes to your shop" | `shortHex(owner)` |
| 2 | `Landmark` | Payout account | "Receives your money" | `shortHex(payoutWallet)` |
| 3 | `QrCode` | Checkout key **v{keyVersion}** | "Signs every QR. Replace it if a phone is lost." | status `Unlock` "Unlocked · 12 min" / `Lock` "Locked" |
| 4 | `Wallet` | Personal pay account | "Pays other shops" | `shortHex(pay)` |
| 5 | `Lock` | History vault key | "Encrypts your history on this phone" | "Never leaves the phone" |

Footnote `Info`: "All five come from one passkey. ScanPay never sees or stores any of them."

**Replace checkout key** button (`RefreshCw`, secondary-danger) → confirm sheet: `AlertTriangle` "All QR codes you
showed before stop working immediately." [Cancel] [Replace key] → **Rotate action**:

```ts
await session.withKeys('Replace your checkout key', async (ring) => {
  const owner = await ring.account('owner');
  const registry = chain.deployment.contracts.MerchantRegistry.address;
  const newSigner = ring.address('invoice', m.keyVersion + 1);
  const rot = { merchantId: m.merchantId, newSigner, nonce: await ownerNonce(chainId, registry, owner.address), deadline: BigInt(Math.floor(Date.now() / 1000) + 600) };
  const ownerSig = await signRotation(owner, chainId, registry, rot);
  const r = await api.rotateSigner({ chainId, rotation: toWireSignerRotation(rot), ownerSig });
  session.lockTerminal();
  session.setMerchant({ ...m, keyVersion: r.keyVersion, invoiceSigner: newSigner });
  toast.success(`Checkout key v${r.keyVersion} active. Old QR codes are dead.`);
});
```

**Key history timeline** (from `merchantKeys.events`, oldest → newest), `IndexedTag` when from Envio:

| kind | Icon | Text |
|---|---|---|
| `REGISTERED` | `Sparkles` | "Shop created · checkout key v1" |
| `STATUS` | `BadgeCheck` (to ACTIVE) / `PauseCircle` (SUSPENDED) / `Ban` (REVOKED) | "Verified" / "Suspended" / "Revoked" |
| `SIGNER_ROTATED` | `RefreshCw` | "Checkout key replaced → v{keyVersion}" |
| `PAYOUT_UPDATED` | `Landmark` | "Payout changed to {symbol}" |

Each row: `when(timestamp)` + TechDetails (tx link).

**Demo moment (put in the video):** show a QR → rotate key → customer tries to pay the old QR → P4 shows
`MERCHANT_KEYS_CHANGED`: "The merchant updated their keys. Ask for a new QR."

### M5 — Shop settings `/merchant/settings`

| # | Element | Icon | Content | Behavior |
|---|---|---|---|---|
| 1 | Shop card | `MerchantAvatar` | name, category, city, country, status chip | read-only (profile edits = new shop in this version; say so in small text) |
| 2 | Get paid in | `Banknote` | current payout token; [Change] → sheet with USDC/AUSD radio | **Payout action** (below) |
| 3 | Shop link | `Link2` | `${publicAppUrl}/m/${chainId}/${merchantId}` + Copy + `Share2` | |
| 4 | Print shop QR | `Printer` | → `/merchant/qr` | |
| 5 | Lock checkout now | `Lock` | `session.lockTerminal()` | toast "Checkout locked" |
| 6 | Switch to customer | `ArrowLeftRight` | `store.setMode('customer')` → `/` | |
| 7 | Technical details | `Code2` | merchantId, owner, payout wallet, checkout signer, keyVersion, registry link | |

**Payout action** (same payout account, new token — needs owner **and** payout signatures):

```ts
await session.withKeys('Change how you get paid', async (ring) => {
  const owner = await ring.account('owner');
  const payout = await ring.account('payout');
  const registry = chain.deployment.contracts.MerchantRegistry.address;
  const u = { merchantId: m.merchantId, payoutWallet: payout.address, payoutToken: chain.deployment.tokens[newKey]!.address, nonce: await ownerNonce(chainId, registry, owner.address), deadline: BigInt(Math.floor(Date.now() / 1000) + 600) };
  const { ownerSig, payoutSig } = await signPayoutUpdate(owner, payout, chainId, registry, u);
  const r = await api.updatePayout({ chainId, update: toWirePayoutUpdate(u), ownerSig, payoutSig });
  session.lockTerminal(); // keyVersion bumped -> checkout key index changes too
  session.setMerchant({ ...m, keyVersion: r.keyVersion, payoutTokenKey: newKey, invoiceSigner: m.invoiceSigner });
});
```

> ⚠ Why `session.invoiceSigner(keyVersion, expectedSigner)` takes two arguments: a payout update bumps `keyVersion`
> on-chain **but keeps the same checkout key**. The invoice must carry the registry's current `keyVersion` (the vault
> checks it), while the signing key is whichever derivation index produces the registry's current `invoiceSigner`.
> `session.invoiceSigner` walks the index down from `keyVersion` to find it (II.10). Rotation always uses
> `index = keyVersion + 1`, which is unused because `keyVersion` only grows.

### M6 — Printable shop QR `/merchant/qr`

Print-optimized page (no shell; `@media print` hides buttons):

| # | Element | Icon | Content |
|---|---|---|---|
| 1 | Logo + name | `MerchantAvatar` | shop name large |
| 2 | Verified line | `BadgeCheck` | "Verified ScanPay merchant" |
| 3 | QR | — | `QrView(`${publicAppUrl}/m/${chainId}/${merchantId}`, 560)` |
| 4 | Caption | `ScanLine` | "Scan to pay · any token · any chain · no fees" |
| 5 | Test badge | `FlaskConical` | "TEST MODE" when chain ≠ 143 |
| 6 | Print button | `Printer` | `window.print()` (hidden in print) |
| 7 | Back | `ArrowLeft` | hidden in print |

Layout: A5 portrait, centered, 2 cm margins.

### M7 — Pending / suspended / not-owner states (shared by all merchant pages)

| Condition | Render |
|---|---|
| merchant view `PENDING` | M2 header pending banner; History/Keys still work |
| `SUSPENDED` / `REVOKED` | red banner on every merchant page, keypad disabled |
| `WRONG_PASSKEY` error | `ErrorState(UserX, "This passkey doesn't own this shop", "Use the phone you set the shop up with.")` |
| no profile | G7 onboarding, then back to setup |

---

## Part VI — Other pages

### O1 — Attack Lab `/attack-lab` (judges' favorite — make it look serious)

**Purpose:** run real attacks against the deployed contracts and show that each is stopped, by which proof layer.
**Load:** `api.attackScenarios(chainId)` (test mode only).

| # | Element | Icon | Content | Behavior |
|---|---|---|---|---|
| 1 | Hero | `ShieldAlert` | title "Try to break it"; sub "Real attacks against the test network. Every one is stopped by the payment contract — not by our server." | |
| 2 | Live-mode guard | `FlaskConical` | on Live: `EmptyState("Attack Lab runs in Test mode", [Switch to Test mode])` | |
| 3 | Run all | `PlayCircle` | "Run all 8 attacks" | sequential `api.attackRun` for each; progress "3/8" |
| 4 | Score | `ShieldCheck` | after a run: "8 of 8 attacks blocked" (green) | |
| 5 | "Record on-chain" switch | `Link2` | off by default; on → `broadcast:true` (sends the failing tx for an explorer link; slower) | |
| 6 | Group headers | `Store` Proof of merchant · `FileSignature` Proof of intent · `Landmark` Proof of settlement | scenarios grouped by `proofLayer` | |
| 7 | Scenario card | `Bug` (attack) / `ShieldCheck` (defense) | **title**; "Attack: {attack}"; "Defense: {defense}"; expected error chip (mono) | |
| 8 | Card button | `Play` | "Run attack" → `Loader2` while running | `api.attackRun(chainId, id, broadcast)` |
| 9 | Result — blocked | `ShieldCheck` green badge **BLOCKED** | `observed.errorName` (mono) · `observed.apiCode` · `observed.message` · `{durationMs} ms`; if `explorerUrl`: `ExternalLink` "View the failed attempt" | |
| 10 | Result — not blocked | `OctagonX` red **NOT BLOCKED** | message (should never happen; tell B/A immediately) | |
| 11 | Footer | `Terminal` | "Each scenario is also a Foundry test in the repo (`contracts/test/Attacks.t.sol`)." | |

Scenario ids and copy come from the API (B owns them) — don't hard-code texts; only map `proofLayer` → icon.

### O2 — Admin (verifier) `/admin`

**Purpose:** approve merchants on Live (test mode auto-approves). Not linked from the nav — open by URL.

| # | Element | Icon | Content | Behavior |
|---|---|---|---|---|
| 1 | Token gate | `KeyRound` | password input "Admin token" | saved in `sessionStorage['scanpay.admin']`; wrong token → `UNAUTHORIZED` toast |
| 2 | Network select | `Globe` | chains from config | |
| 3 | Tabs | `Clock` Pending · `BadgeCheck` Active · `PauseCircle` Suspended · `Ban` Revoked | `api.adminMerchants(token, chainId, status)` | |
| 4 | Row | `MerchantAvatar` | name, city/country, `when(registeredAt)`, profile verified tick (`CheckCircle2`/`XCircle`), owner `shortHex` | |
| 5 | Actions | `BadgeCheck` Approve · `PauseCircle` Suspend · `PlayCircle` Reactivate · `Ban` Revoke | only valid transitions shown (PENDING: approve/revoke; ACTIVE: suspend/revoke; SUSPENDED: reactivate/revoke) | confirm sheet → `api.adminAction(...)` → toast + tx in TechDetails → refetch |

### O3 — Settings `/settings` (customer; merchants have M5)

| # | Element | Icon | Content | Behavior |
|---|---|---|---|---|
| 1 | Network | `Globe` | G2 rows inline | |
| 2 | Display currency | `Banknote` | select: Auto (locale) · INR · USD · EUR · GBP · SGD · AED · JPY | store `localStorage['scanpay.currency']`; `useFx` uses it when an invoice has no `fiat` |
| 3 | Passkey | `Fingerprint` | "{label} · created {date}"; text "Your passkey lives in iCloud Keychain / Google Password Manager." | |
| 4 | How you're protected | `ShieldCheck` | 3 bullets (same as Home #6) + link to Attack Lab | |
| 5 | Forget this device | `LogOut` (red) | confirm: "Removes ScanPay data from this phone. Your passkey stays in your password manager." | `session.forgetDevice()` → `/welcome` |
| 6 | About | `Info` | "ScanPay Guard · settles on Monad in under a second · open source" + GitHub link (`Github`) + version | |

### O4 — System pages

| Page | Icon | Content |
|---|---|---|
| 404 | `SearchX` | "Page not found" + [Home] |
| Error boundary | `TriangleAlert` | "Something broke" + [Reload] + requestId if present |
| Unsupported browser (no `PublicKeyCredential`) | `ShieldOff` | "Open ScanPay in Safari (iPhone) or Chrome (Android)." + Copy link |
| `/dev/passkey` (temporary, delete before submit) | `Wrench` | create passkey → show the 5 addresses → sign a test Invoice and verify with `recoverTypedDataAddress` — your F2 smoke test |

---

## Part VII — Build order with exit checks

Each step lists the backend pieces it needs. Commit after each step (`feat(web): …`) — commit history is judged.

### F0 — Decisions (15 min, before writing code)

- [ ] Production domain chosen (e.g. `scanpay-guard.vercel.app`) → this is `NEXT_PUBLIC_RP_ID` in production and B's `PUBLIC_APP_URL`. Tell B now.
- [ ] Demo devices: one iPhone (iOS 18+) as customer, one Android or second iPhone as merchant terminal. Both signed into a passkey provider that supports PRF.
- [ ] Local dev uses `RP_ID=localhost` on your laptop browser (Safari/Chrome on macOS with iCloud/Google passkeys, or 1Password).

### F1 — Wiring layer part 1 (Part II.1–II.5) · needs I0

- [ ] Packages installed, `transpilePackages` set, providers wrapped in the root layout
- [ ] `api.config()` against B's local API prints chain 31337 (or use B's Railway URL later)
- **Commit:** `feat(web): shared SDK, api client, config provider`

### F2 — Wiring layer part 2 (II.6–II.14) + `/dev/passkey` smoke page

- [ ] `vitest run lib` → KeyRing test passes
- [ ] `/dev/passkey`: Face ID → 5 distinct addresses; a second unlock gives the **same** addresses
- [ ] Signing a test invoice with `ring.account('invoice',1)` and recovering it gives the same address
- **Commit:** `feat(web): mera passkeys, one-passkey-many-keys keyring, session, signing`

### F3 — App shell & globals (Part III)

- [ ] Bottom nav switches between customer/merchant modes; network pill toggles chains; Face ID overlay appears during prompts
- **Commit:** `feat(web): app shell, network toggle, face id overlay, shared components`

### F4 — Home, Welcome, Wallet (P1, P2, P8) · needs B17 for faucet

- [ ] Create passkey → Home shows the balance card; [Get test money] adds funds (local/testnet)
- **Commit:** `feat(web): home, onboarding, wallet + faucet`

### F5 — Shop setup (M1) · needs B8

- [ ] Setup on local → step 3 shows "Your shop is verified"; reload restores the merchant via `merchantsByOwner`
- **Commit:** `feat(web): merchant setup with three keys from one passkey`

### F6 — Checkout terminal + printable QR (M2 states A/B, M6) · needs B12

- [ ] Typing 12 → Show QR asks Face ID once; a second QR within 30 min doesn't
- [ ] Short code opens `/pay/<code>` on another device
- **Commit:** `feat(web): checkout terminal and printable shop QR`

### F7 — Scan + Pay DIRECT + live status (P3, P4, P9) + Paid overlay (M2 state C) · needs B15, B16, B22

- [ ] Phone A scans phone B's QR → Pay with Face ID → phone B shows **Paid** within ~1–2 s
- [ ] Paying the same QR again → "Already paid" with receipt link
- [ ] An `evil.example` link → warning sheet
- **Commit:** `feat(web): scan, pay (direct), live status, paid overlay`

### F8 — SWAP + CROSSCHAIN (P4.1–P4.3, P9 deposit panel) · needs B17–B21

- [ ] SWAP with tMON: permission sheet appears once; payment completes; second SWAP skips the sheet
- [ ] CROSSCHAIN (test mode): Simulate delivery → Paid; partial → UNDERPAID → second partial → Paid
- [ ] AUSD merchant receives AUSD from a cross-chain payment
- **Commit:** `feat(web): pay with another token and from another chain`

### F9 — Shop QR flow (P5 + M2 state D) · needs B12 requests + B22

- [ ] Customer scans printed QR → types 5 → terminal inbox shows the request → Accept → customer jumps to P4 automatically
- **Commit:** `feat(web): static shop QR with live request handshake`

### F10 — Receipt + Activity (P6, P7) · needs B23

- [ ] Receipt shows VERIFIED with all three proof cards green; Share works
- [ ] Activity unlock with Face ID shows the history; lock clears it
- **Commit:** `feat(web): verifiable receipt and encrypted activity`

### F11 — Merchant History, Keys, Settings (M3, M4, M5) · needs B11 (+ I3 for Envio tag)

- [ ] History chart + list; on testnet shows "Indexed by Envio"
- [ ] Keys page shows 5 keys; Replace checkout key → old QR fails with "The merchant updated their keys"
- [ ] Payout change USDC→AUSD works and the terminal still signs (index walk)
- **Commit:** `feat(web): merchant history, many-keys page with rotation, settings`

### F12 — Attack Lab, Admin, Settings (O1–O3) · needs B25, B9

- [ ] Run all → 8/8 blocked on testnet; "Record on-chain" gives a failed-tx explorer link
- [ ] Admin approves a PENDING merchant (use Live or a manual suspend/reactivate on test)
- **Commit:** `feat(web): attack lab, admin, settings`

### F13 — Deploy (Vercel) + device pass · needs I5

1. Vercel → New Project → import repo → **Root Directory `apps/web`** (keep "Include files outside the root directory"
   on, so `packages/shared` builds) → Framework Next.js → install/build defaults (pnpm detected from the root lockfile).
2. Production env vars: `NEXT_PUBLIC_API_URL=<Railway URL>`, `NEXT_PUBLIC_RP_ID=<production domain, no https://>`,
   `NEXT_PUBLIC_RP_NAME=ScanPay`, `NEXT_PUBLIC_DEFAULT_CHAIN_ID=10143`, RPC vars.
3. Ask B to set `PUBLIC_APP_URL=https://<domain>` and add it to `CORS_ORIGINS`; redeploy B.
4. Device pass on **production URL** (not preview):

| Check | iPhone (customer) | Android (merchant) |
|---|---|---|
| Create passkey | ☐ | ☐ |
| Install to home screen, opens standalone | ☐ | ☐ |
| Camera scan | ☐ | ☐ |
| DIRECT pay → terminal Paid | ☐ | ☐ |
| SWAP pay incl. permission | ☐ | |
| Cross-chain simulated | ☐ | |
| Receipt share link opens on the other phone | ☐ | ☐ |
| Attack Lab run all | ☐ | |

Local phone testing (optional): `cloudflared tunnel --url http://localhost:3000` gives an HTTPS URL; set
`NEXT_PUBLIC_RP_ID` to that host for the session (passkeys made there only work there).

- **Commit:** `chore(web): production config`

### F14 — Live run, copy audit, polish (with B31)

- [ ] Switch to **Live**; merchant setup on mainnet (AUSD); B approves; customer pays from Base USDC via "Another chain"; record the screen
- [ ] Copy audit: search the codebase for `blockchain|crypto|gas|wallet|0x|transaction|testnet|mainnet` in user-visible strings → replace per I.1 (except Attack Lab/Technical details)
- [ ] Every button has a loading state; every API error shows `e.message`; no raw JSON on screen
- [ ] Lighthouse PWA installable ✓; first load of `/pay/<code>` < 2 s on 4G
- [ ] Delete `/dev/passkey`
- **Commit:** `feat(web): live mode polish and copy audit`

---

## Part VIII — Demo video script (≤ 3:00)

Record on two phones side by side (screen-record both + one overhead camera). Use Test mode except segment 4.

| Time | Segment | Screen | Voice-over (keep it this short) |
|---|---|---|---|
| 0:00–0:15 | Hook | P1 Home → Scan | "Scan, verify, pay — and know it arrived. ScanPay Guard lets any shop take payments in any token, from any chain, and proves where the money went." |
| 0:15–0:40 | Shop in 20 s | M1 steps 1–3 | "A shop signs up with one Face ID. One passkey creates three separate keys — owner, payout and checkout — and the shop is verified on Monad." |
| 0:40–1:05 | Pay | P3 → P4 → Face ID → M2 Paid overlay | "The customer scans, sees a verified shop and the exact amount, pays with Face ID. No fees, no seed phrase — and the shop's screen confirms in under a second." |
| 1:05–1:35 | Any chain (Live) | P4.2 Base USDC → P9 deposit → Paid; M3 history entry "From Base" | "On mainnet: a tourist pays from Base with USDC through Aurora Intents. The shop gets paid in Agora's AUSD, converted on Monad by Kuru." |
| 1:35–2:00 | Know it arrived | P6 receipt, three green cards; flash the CLI | "Every receipt proves three things: who you paid, what you approved, and where the money went — recomputed from the chain, verifiable by anyone." |
| 2:00–2:35 | Try to break it | O1 Run all → 8/8 blocked; M4 rotate → old QR fails | "We attack it live: changed amounts, redirected funds, replays, fake shops, fake 'paid' messages — all blocked by the contract. A lost phone? Replace the checkout key and every old QR dies." |
| 2:35–3:00 | Close | M3 chart (Indexed by Envio) → title card | "Built on Monad for sub-second settlement, with Mera passkeys, Aurora Intents, Kuru, Agora AUSD and Envio. ScanPay Guard." |

Recording tips: 1080×1920 per phone, composite side by side; speed up only the cross-chain wait (label "sped up");
show the network pill once in each segment; keep captions on.

---

## Part IX — Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `PRF_UNAVAILABLE` on laptop | desktop Chrome local profile / Bitwarden | use Safari with iCloud Keychain, Chrome with Google Password Manager, or 1Password; demo on phones |
| Passkey prompt never appears | page not HTTPS / RP_ID ≠ current host | `NEXT_PUBLIC_RP_ID` must equal the hostname exactly; never use Vercel preview URLs |
| Different addresses on second unlock | PRF output not normalized (ArrayBuffer vs Uint8Array) or salt changed in SDK call | fix `bytes()` in `lib/mera.ts`; keep SDK version pinned |
| `Module not found: @scanpay/shared/...` | missing `transpilePackages` or Vercel root excludes packages | add `transpilePackages`; enable "Include files outside root directory" |
| zod parse error on an API response | B changed a response shape | `@scanpay/shared/api.ts` is the contract — pull latest; tell B if a field is missing |
| `INVALID_MERCHANT_SIGNATURE` creating QR | wrong chain/vault in domain, or wrong checkout key index | use `chain.deployment.contracts.IntentVault.address` of the **merchant's** chain; `invoiceSigner(keyVersion, expectedSigner)` |
| `MERCHANT_KEYS_CHANGED` on new QRs | local keyVersion stale | refetch `api.merchant` (M2 handles it) |
| `INVALID_PAYER_SIGNATURE` on submit | signed with a different account than `prep.intent.payer` | always `ring.account('pay')`; `signPrepared` throws early if mismatch |
| `TOKEN_AUTHORIZATION_FAILED` | receiveAuth built from a modified intent | sign exactly `fromWireIntent(prep.intent)`; never edit the draft |
| `ALLOWANCE_REQUIRED` | approve tx not mined yet | `approveMax` waits for the receipt — make sure you `await` it |
| Approve fails "insufficient funds" | no MON for gas | call `api.drip` first (`prep.swap.dripAvailable`) |
| SSE never fires | CORS origin missing / proxy buffering | B adds your origin to `CORS_ORIGINS`; check Network tab → EventStream |
| Camera black on iOS | not in a user gesture / permissions | start the scanner after a tap ("Start camera" button) on iOS standalone |
| QR links point to localhost | B's `PUBLIC_APP_URL` not set | B sets it to the production domain |
| Paid overlay doesn't show | listening to a different merchant id or chain | check SSE path uses the **merchant's** chain |
| Numbers like `1.2e+21` | used `Number()` on base units | use `formatToken` |

---

## Part X — Final checklist

**Product**
- [ ] Customer: onboard → scan → pay (DIRECT, SWAP, CROSSCHAIN) → status → receipt → activity
- [ ] Merchant: setup → checkout QR → Paid overlay → static QR inbox → history → keys + rotation → payout change
- [ ] Attack Lab 8/8 blocked on testnet; Admin works
- [ ] Copy audit passed (no blockchain words outside Technical details / Attack Lab)
- [ ] Loading, empty, error states on every page (Part IV/V tables)

**Mera bounties**
- [ ] Mera is the only account system (customer + merchant); no other wallet connectors anywhere
- [ ] Keys page shows 5 role keys from one passkey; rotation demoed
- [ ] No private keys / mnemonics / PRF output in storage (DevTools → Application → Local Storage shows only public data + encrypted receipts)

**Deploy**
- [ ] Production URL works on iPhone and Android; installable PWA
- [ ] `NEXT_PUBLIC_RP_ID` = production host; `NEXT_PUBLIC_API_URL` = Railway
- [ ] Live mode: one real cross-chain payment and one DIRECT payment done and recorded

**Submission**
- [ ] Video ≤ 3:00 uploaded (unlisted YouTube / Loom) and linked in README
- [ ] README "Frontend" section (send to A): screens list, how to run (`pnpm --filter @scanpay/web dev`), env vars, device requirements, AI tools disclosure for your part
- [ ] Commits spread across the build window
