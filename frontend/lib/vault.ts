import type { ReceiptEntry } from './store';
import { store } from './store';

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function addReceipt(key: CryptoKey, r: ReceiptEntry) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(r))),
  );
  store.setVaultBlob([{ iv: b64(iv), data: b64(data) }, ...store.vaultBlob()].slice(0, 200));
}

export async function readReceipts(key: CryptoKey): Promise<ReceiptEntry[]> {
  const out: ReceiptEntry[] = [];
  for (const e of store.vaultBlob()) {
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unb64(e.iv) as BufferSource },
        key,
        unb64(e.data) as BufferSource,
      );
      out.push(JSON.parse(new TextDecoder().decode(pt)));
    } catch { /* entry from another passkey — skip */ }
  }
  return out;
}
