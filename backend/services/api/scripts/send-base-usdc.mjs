import { createPublicClient, createWalletClient, http, parseUnits, erc20Abi } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const operatorKey = '0xbf6cf339ed6c78c48f47b76cc5e156f01cfedd6e10864f09e8daf020ad713507';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const to = '0x9216Ce70Bb7f64Ec1542F5b3d4baaC92Cafa01C6';
const amount = parseUnits('4', 6);

const account = privateKeyToAccount(operatorKey);
const pub = createPublicClient({ chain: base, transport: http() });
const wallet = createWalletClient({ account, chain: base, transport: http() });

const before = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
console.log(`Operator USDC before: ${Number(before) / 1e6} USDC`);

const hash = await wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: 'transfer', args: [to, amount] });
console.log('tx:', hash);
await pub.waitForTransactionReceipt({ hash });

const after = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [to] });
console.log(`Recipient USDC after: ${Number(after) / 1e6} USDC`);
console.log('done: https://basescan.org/tx/' + hash);
