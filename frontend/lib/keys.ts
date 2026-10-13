import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
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

  /** Public address only (no signing session needed). */
  address(role: Role, keyVersion?: number): `0x${string}` {
    return privateKeyToAccount(toHex(this.priv(role, keyVersion))).address;
  }

  /** Signing account backed by a Mera secp256k1 session. */
  async account(role: Role, keyVersion?: number): Promise<LocalAccount> {
    const { account, end } = accountFor(this.priv(role, keyVersion));
    this.ends.push(end);
    return account;
  }

  /** AES-GCM key for the local receipt vault (5th key from the same passkey). */
  async vaultKey(): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey('raw', this.prf as BufferSource, 'HKDF', false, ['deriveKey']);
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
