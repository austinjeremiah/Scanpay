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
  try {
    const stored = localStorage.getItem('scanpay.currency');
    if (stored && stored !== 'AUTO') return stored;
  } catch { /* ignore */ }
  const region = (Intl.DateTimeFormat().resolvedOptions().locale.split('-')[1] ?? '').toUpperCase();
  const map: Record<string, string> = {
    IN: 'INR', US: 'USD', GB: 'GBP', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', JP: 'JPY', SG: 'SGD',
    AE: 'AED', AU: 'AUD', CA: 'CAD', BR: 'BRL', KR: 'KRW',
  };
  return map[region] ?? 'USD';
}

export const flagEmoji = (cc: string) =>
  cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '';

export const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum', 10: 'Optimism', 56: 'BNB Chain', 137: 'Polygon', 8453: 'Base', 42161: 'Arbitrum',
};
