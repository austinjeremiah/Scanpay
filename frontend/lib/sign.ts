import type { Hex, LocalAccount } from 'viem';
import {
  buildIntentTypedData, buildInvoiceTypedData, buildPayoutUpdateTypedData, buildReceiveAuthTypedData,
  buildRegistrationTypedData, buildSignerRotationTypedData, fromWireIntent, intentDigest, receiveAuthForIntent,
  type InvoiceMessage, type PayoutUpdateMessage, type PrepareRes, type RegistrationMessage, type SignerRotationMessage,
} from './shared';

/** Customer: sign a prepared draft exactly as the API froze it. */
export async function signPrepared(pay: LocalAccount, prep: PrepareRes): Promise<{ payerSig: Hex; receiveAuthSig?: Hex }> {
  const intent = fromWireIntent(prep.intent);
  if (intent.payer.toLowerCase() !== pay.address.toLowerCase()) throw new Error('Prepared for a different account');
  const payerSig = await pay.signTypedData(buildIntentTypedData(prep.chainId, prep.vault, intent));
  if (!prep.signing.receiveAuth) return { payerSig };
  const msg = receiveAuthForIntent(intent, intentDigest(prep.chainId, prep.vault, intent), prep.vault);
  const receiveAuthSig = await pay.signTypedData(
    buildReceiveAuthTypedData(
      prep.chainId,
      {
        address: prep.signing.receiveAuth.token,
        eip712: prep.signing.receiveAuth.domain,
      },
      msg,
    ),
  );
  return { payerSig, receiveAuthSig };
}

/** Merchant setup: owner AND payout wallet sign the same Registration digest. */
export async function signRegistration(
  owner: LocalAccount,
  payout: LocalAccount,
  chainId: number,
  registry: Hex,
  reg: RegistrationMessage,
) {
  const td = buildRegistrationTypedData(chainId, registry, reg);
  return { ownerSig: await owner.signTypedData(td), payoutSig: await payout.signTypedData(td) };
}

export const signInvoice = (signer: LocalAccount, chainId: number, vault: Hex, inv: InvoiceMessage) =>
  signer.signTypedData(buildInvoiceTypedData(chainId, vault, inv));

export const signRotation = (owner: LocalAccount, chainId: number, registry: Hex, r: SignerRotationMessage) =>
  owner.signTypedData(buildSignerRotationTypedData(chainId, registry, r));

export async function signPayoutUpdate(
  owner: LocalAccount,
  payout: LocalAccount,
  chainId: number,
  registry: Hex,
  u: PayoutUpdateMessage,
) {
  const td = buildPayoutUpdateTypedData(chainId, registry, u);
  return { ownerSig: await owner.signTypedData(td), payoutSig: await payout.signTypedData(td) };
}
