// One import surface for the shared package (typed data, wire helpers, ids, ABIs, deployments and the API schemas).
// Pages import from here only; the package itself lives at backend/packages/shared.
export {
  buildIntentTypedData, buildInvoiceTypedData, buildPayoutUpdateTypedData, buildReceiveAuthTypedData,
  buildRegistrationTypedData, buildSignerRotationTypedData, fromWireIntent, intentDigest, receiveAuthForIntent,
  toWireInvoice, toWireRegistration, toWireSignerRotation, toWirePayoutUpdate, randomBytes32, merchantRegistryAbi,
  profileHash,
} from '@scanpay/shared';
export type {
  InvoiceMessage, PayoutUpdateMessage, RegistrationMessage, SignerRotationMessage, Deployment, TokenInfo,
} from '@scanpay/shared';
export * from '@scanpay/shared';
