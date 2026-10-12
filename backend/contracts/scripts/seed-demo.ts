// Usage: OPERATOR_PRIVATE_KEY=0x… tsx scripts/seed-demo.ts <chainId>
// The operator key pays gas, approves the merchant (VERIFIER) and mints test tokens (MINTER). Testnet/local only.
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry, monadTestnet } from 'viem/chains';
import {
  buildIntentTypedData, buildInvoiceTypedData, buildReceiveAuthTypedData, buildRegistrationTypedData,
  computeMerchantId, getDeployment, getToken, intentDigest, keccak256Utf8, merchantRegistryAbi, intentVaultAbi,
  mockStableTokenAbi, randomBytes32, randomNonce, receiveAuthForIntent, splitSignature, ROUTE, MERCHANT_STATUS, ZERO_BYTES32,
} from './seed-imports';

const chainId = Number(process.argv[2] ?? '31337');
const chain = chainId === 10143 ? monadTestnet : foundry;
const rpc = chainId === 10143 ? process.env.MONAD_TESTNET_RPC! : 'http://127.0.0.1:8545';
const d = getDeployment(chainId);
const operator = privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY as Hex);
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ chain, transport: http(rpc), account: operator });

async function send(req: Parameters<typeof wallet.writeContract>[0]) {
  const { request } = await pub.simulateContract({ ...(req as any), account: operator });
  const gas = await pub.estimateContractGas({ ...(req as any), account: operator });
  const hash = await wallet.writeContract({ ...(request as any), gas: (gas * 12n) / 10n }); // Monad bills the limit
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`reverted ${hash}`);
  return hash;
}

const owner = privateKeyToAccount(generatePrivateKey());
const payout = privateKeyToAccount(generatePrivateKey());
const signer = privateKeyToAccount(generatePrivateKey());
const payer = privateKeyToAccount(generatePrivateKey());
const usdc = getToken(chainId, 'USDC');
const registry = d.contracts.MerchantRegistry.address;
const vault = d.contracts.IntentVault.address;

// 1. register (owner + payout sign the same digest)
const salt = randomBytes32();
const reg = {
  owner: owner.address, salt, payoutWallet: payout.address, invoiceSigner: signer.address, payoutToken: usdc.address,
  metadataHash: keccak256Utf8('{"displayName":"Seed Cafe"}'), nonce: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
};
const regTd = buildRegistrationTypedData(chainId, registry, reg);
await send({ address: registry, abi: merchantRegistryAbi, functionName: 'registerMerchant',
  args: [reg, await owner.signTypedData(regTd), await payout.signTypedData(regTd)] });
const merchantId = computeMerchantId(owner.address, salt);
await send({ address: registry, abi: merchantRegistryAbi, functionName: 'setMerchantStatus', args: [merchantId, MERCHANT_STATUS.ACTIVE] });
console.log('merchant', merchantId);

// 2. fund payer, pay 1.23 tUSDC DIRECT
await send({ address: usdc.address, abi: mockStableTokenAbi, functionName: 'mint', args: [payer.address, 5_000_000n] });
const now = BigInt(Math.floor(Date.now() / 1000));
const invoice = { merchantId, invoiceId: randomBytes32(), payoutToken: usdc.address, amount: 1_230_000n, expiresAt: now + 900n, keyVersion: 1 };
const intent = {
  merchantId, invoiceId: invoice.invoiceId, payer: payer.address, payoutToken: usdc.address, amountOut: invoice.amount,
  route: ROUTE.DIRECT, inputToken: usdc.address, maxAmountIn: invoice.amount, quoteHash: ZERO_BYTES32,
  refundTo: payer.address, expiresAt: now + 600n, nonce: randomNonce(), keyVersion: 1,
};
const merchantSig = await signer.signTypedData(buildInvoiceTypedData(chainId, vault, invoice));
const payerSig = await payer.signTypedData(buildIntentTypedData(chainId, vault, intent));
const auth = splitSignature(await payer.signTypedData(
  buildReceiveAuthTypedData(chainId, usdc, receiveAuthForIntent(intent, intentDigest(chainId, vault, intent), vault))));
const tx = await send({ address: vault, abi: intentVaultAbi, functionName: 'payDirect', args: [intent, invoice, merchantSig, payerSig, auth] });
console.log('payDirect', tx);
