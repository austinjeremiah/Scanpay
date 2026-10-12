export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('canonicalJson: non-finite number');
    return v;
  }
  if (Array.isArray(v)) return v.map(normalize);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    const val = (v as Record<string, unknown>)[k];
    if (val === undefined) continue;
    out[k] = normalize(val);
  }
  return out;
}
