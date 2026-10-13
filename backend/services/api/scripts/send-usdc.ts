import { createPublicClient, createWalletClient, http, parseUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getDeployment } from '@scanpay/shared';

const dep = getDeployment(143);
const usdc = dep.tokens.USDC!;
const rpc = process.env.MONAD_MAINNET_RPC!;
const operatorKey = process.env.OPERATOR_PRIVATE_KEY_MAINNET as Hex;
const operator = privateKeyToAccount(operatorKey);

const monad = { id: 143, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as any;
const pub = createPublicClient({ transport: http(rpc) });
const wallet = createWalletClient({ account: operator, chain: monad, transport: http(rpc) });

const erc20Abi = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

const opBal = await pub.readContract({ address: usdc.address as Address, abi: erc20Abi, functionName: 'balanceOf', args: [operator.address] }) as bigint;
console.log('operator USDC:', Number(opBal) / 1e6);

const amount = parseUnits('1', usdc.decimals);
const to = '0x9216Ce70Bb7f64Ec1542F5b3d4baaC92Cafa01C6' as Address;
const hash = await wallet.writeContract({ address: usdc.address as Address, abi: erc20Abi, functionName: 'transfer', args: [to, amount] });
console.log('tx:', hash);
await pub.waitForTransactionReceipt({ hash });
const newBal = await pub.readContract({ address: usdc.address as Address, abi: erc20Abi, functionName: 'balanceOf', args: [to] }) as bigint;
console.log('recipient USDC:', Number(newBal) / 1e6);
console.log('done: https://monadscan.com/tx/' + hash);
