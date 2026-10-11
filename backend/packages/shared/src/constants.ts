export const ICD_VERSION = 1 as const;

export const ROUTE = { DIRECT: 0, SWAP: 1, CROSSCHAIN: 2 } as const;
export type RouteName = keyof typeof ROUTE;
export const ROUTE_NAME: Record<number, RouteName> = { 0: 'DIRECT', 1: 'SWAP', 2: 'CROSSCHAIN' };

export const INTENT_STATUS = { NONE: 0, COMMITTED: 1, SETTLED: 2, REFUNDED: 3 } as const;
export const INTENT_STATUS_NAME: Record<number, keyof typeof INTENT_STATUS> = {
  0: 'NONE', 1: 'COMMITTED', 2: 'SETTLED', 3: 'REFUNDED',
};

export const INVOICE_STATE = { OPEN: 0, RESERVED: 1, PAID: 2 } as const;

export const MERCHANT_STATUS = { NONE: 0, PENDING: 1, ACTIVE: 2, SUSPENDED: 3, REVOKED: 4 } as const;
export const MERCHANT_STATUS_NAME: Record<number, keyof typeof MERCHANT_STATUS> = {
  0: 'NONE', 1: 'PENDING', 2: 'ACTIVE', 3: 'SUSPENDED', 4: 'REVOKED',
};

export const CHAIN_IDS = { local: 31337, testnet: 10143, mainnet: 143 } as const;
export type NetworkName = keyof typeof CHAIN_IDS;

export const VAULT_DOMAIN_NAME = 'ScanPayGuard' as const;
export const REGISTRY_DOMAIN_NAME = 'ScanPayRegistry' as const;
export const DOMAIN_VERSION = '1' as const;

export const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/** keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)") */
export const RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
  '0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8' as const;
