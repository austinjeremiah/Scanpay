import { createPublicClient, createWalletClient, http, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const rpc = process.env.MONAD_MAINNET_RPC!;
const operatorKey = process.env.OPERATOR_PRIVATE_KEY_MAINNET as Hex;
const operator = privateKeyToAccount(operatorKey);

const monad = { id: 143, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as any;
const pub = createPublicClient({ transport: http(rpc) });
const wallet = createWalletClient({ account: operator, chain: monad, transport: http(rpc) });

const to = '0x9216Ce70Bb7f64Ec1542F5b3d4baaC92Cafa01C6' as const;
const amount = parseEther('3');

const before = await pub.getBalance({ address: operator.address });
console.log('operator MON before:', Number(before) / 1e18);

const hash = await wallet.sendTransaction({ to, value: amount });
console.log('tx:', hash);
await pub.waitForTransactionReceipt({ hash });

const after = await pub.getBalance({ address: to });
console.log('recipient MON:', Number(after) / 1e18);
console.log('done: https://monadexplorer.com/tx/' + hash);
