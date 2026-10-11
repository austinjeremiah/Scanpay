import { getDeployment } from '../src/generated/deployments';
const chainId = Number(process.argv[2] ?? '10143');
const d = getDeployment(chainId);
console.log(JSON.stringify({ chainId, contracts: d.contracts, tokens: Object.fromEntries(Object.entries(d.tokens).map(([k, t]) => [k, t!.address])) }, null, 2));
