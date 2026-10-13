import {
  createPasskeyWithPrfOutput, getPasskeyPrfOutput, createSecp256k1SigningSession, isMeraError,
} from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import type { LocalAccount } from 'viem';
import { ENV } from './env';

/** Public passkey metadata kept on the device. No secrets. */
export interface StoredCredential {
  credentialId: string;
  transports?: string[];
}

/** Creates a passkey and returns its PRF output (32 bytes). One Face ID. */
export async function createPasskey(label: string): Promise<{ cred: StoredCredential; prf: Uint8Array }> {
  const r = await createPasskeyWithPrfOutput({
    rp: { id: ENV.RP_ID, name: ENV.RP_NAME },
    user: { name: label, displayName: label },
  });
  return {
    cred: { credentialId: r.credentialId, transports: r.transports ? [...r.transports] : undefined },
    prf: new Uint8Array(r.prfOutput),
  };
}

/** Re-derives the same PRF output from an existing passkey. One Face ID. */
export async function getPrf(cred: StoredCredential): Promise<Uint8Array> {
  const r = await getPasskeyPrfOutput({
    rpId: ENV.RP_ID,
    credential: { credentialId: cred.credentialId, transports: cred.transports },
  });
  return new Uint8Array(r.prfOutput);
}

/** Wraps a derived private key in a Mera signing session and returns a viem LocalAccount. */
export function accountFor(privateKey: Uint8Array): { account: LocalAccount; end: () => void } {
  const session = createSecp256k1SigningSession({ privateKey });
  const account = toViemAccount(session) as unknown as LocalAccount;
  return { account, end: () => session.end() };
}

export function passkeyErrorMessage(e: unknown): { code: string; message: string } {
  if (isMeraError(e)) {
    const code = e.code as string;
    const map: Record<string, string> = {
      PRF_UNAVAILABLE:
        "This device's passkey manager can't be used for payments. Use an iPhone (iOS 18+), an Android phone, or 1Password.",
      PASSKEY_OPERATION_FAILED: 'Face ID was cancelled or failed. Try again.',
      CRYPTO_UNAVAILABLE: 'This browser is missing secure features. Open the app in Safari or Chrome.',
      SESSION_ENDED: 'Your secure session ended. Try again.',
    };
    return { code, message: map[code] ?? 'Passkey error. Try again.' };
  }
  if ((e as { name?: string } | null)?.name === 'NotAllowedError') return { code: 'CANCELLED', message: 'Face ID was cancelled.' };
  return { code: 'UNKNOWN', message: 'Something went wrong with your passkey.' };
}
