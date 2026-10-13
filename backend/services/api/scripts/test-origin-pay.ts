/**
 * Proves the gasless origin-chain payment: a wallet holding ONLY USDC on Base — no ETH —
 * signs an EIP-3009 authorization, our relayer submits it, and the USDC moves.
 *
 * Usage: tsx --env-file=../../../.env scripts/test-origin-pay.ts <to> <amountUsdc>
 */
import { createPublicClient, http, parseUnits, formatUnits, type Hex, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildTransferAuthTypedData, randomBytes32 } from '@scanpay/shared';
import { relayOriginTransfer, ORIGIN_CHAINS } from '../src/services/originChains.js';

const to = (process.argv[2] ?? '') as Address;
const amount = process.argv[3] ?? '0.05';
if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('usage: test-origin-pay.ts <toAddress> [amountUsdc]');

const CHAIN_ID = 8453;
const chain = ORIGIN_CHAINS[CHAIN_ID]!;
const token = chain.tokens.USDC;
const rpc = process.env.BASE_RPC!;
const pub = createPublicClient({ transport: http(rpc) });

const erc20 = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
const bal = (a: Address) => pub.readContract({ address: token.address, abi: erc20, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;

// The customer: a passkey-style wallet that holds USDC and NOT ONE WEI of ETH.
const payer = privateKeyToAccount(process.env.MAINNET_PAYER_PRIVATE_KEY as Hex);

const value = parseUnits(amount, token.decimals);
console.log(`origin chain : ${chain.name} (${CHAIN_ID})`);
console.log(`payer        : ${payer.address}`);
console.log(`  USDC       : ${formatUnits(await bal(payer.address), 6)}`);
console.log(`  ETH        : ${formatUnits(await pub.getBalance({ address: payer.address }), 18)}   <- gas it will NOT need`);
console.log(`sending      : ${amount} USDC -> ${to}`);

const now = BigInt(Math.floor(Date.now() / 1000));
const message = {
  from: payer.address,
  to,
  value,
  validAfter: 0n,
  validBefore: now + 3600n,
  nonce: randomBytes32(),
};

// The customer signs. No transaction, no gas, no chain interaction.
const signature = await payer.signTypedData(buildTransferAuthTypedData(CHAIN_ID, token, message) as any);
console.log(`signed       : ${signature.slice(0, 20)}…`);

const before = await bal(to);
const res = await relayOriginTransfer(CHAIN_ID, { ...message, signature });
const after = await bal(to);

console.log(`relayed      : ${res.hash}  status=${res.status}`);
console.log(`recipient    : ${formatUnits(before, 6)} -> ${formatUnits(after, 6)} USDC  (+${formatUnits(after - before, 6)})`);
console.log(`explorer     : ${res.explorer}`);
console.log(`payer ETH after: ${formatUnits(await pub.getBalance({ address: payer.address }), 18)}  (unchanged — relayer paid)`);
