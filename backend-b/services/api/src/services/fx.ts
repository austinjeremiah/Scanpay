import { ApiError } from '../errors.js';

type Rate = { rate: number; asOf: string; source: string; fetchedAt: number };
const cache = new Map<string, Rate>();
const TTL_MS = 10 * 60 * 1000;

async function fetchJson(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json() as Promise<any>;
}

export async function usdTo(quote: string) {
  const q = quote.toUpperCase();
  if (!/^[A-Z]{3}$/.test(q)) throw new ApiError('VALIDATION_ERROR', 'quote must be a 3-letter currency code');
  if (q === 'USD') return { base: 'USD' as const, quote: q, rate: 1, asOf: new Date().toISOString(), source: 'identity', stale: false };
  const hit = cache.get(q);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return { base: 'USD' as const, quote: q, ...pick(hit), stale: false };
  try {
    const j = await fetchJson(`https://api.frankfurter.app/latest?from=USD&to=${q}`);
    const rate = Number(j.rates?.[q]);
    if (!rate) throw new Error('no rate');
    const v = { rate, asOf: String(j.date), source: 'frankfurter (ECB)', fetchedAt: Date.now() };
    cache.set(q, v);
    return { base: 'USD' as const, quote: q, ...pick(v), stale: false };
  } catch {
    try {
      const j = await fetchJson('https://open.er-api.com/v6/latest/USD');
      const rate = Number(j.rates?.[q]);
      if (!rate) throw new Error('no rate');
      const v = { rate, asOf: String(j.time_last_update_utc), source: 'open.er-api.com', fetchedAt: Date.now() };
      cache.set(q, v);
      return { base: 'USD' as const, quote: q, ...pick(v), stale: false };
    } catch {
      if (hit) return { base: 'USD' as const, quote: q, ...pick(hit), stale: true };
      throw new ApiError('PROVIDER_UNAVAILABLE', 'FX rate unavailable');
    }
  }
}

const pick = (r: Rate) => ({ rate: r.rate, asOf: r.asOf, source: r.source });
