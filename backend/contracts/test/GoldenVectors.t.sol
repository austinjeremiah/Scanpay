// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import "../src/libraries/ScanPayTypes.sol";

contract GoldenVectorsTest is Test {
    bytes32 constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant RWA_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    uint256 constant CHAIN_ID = 10143;
    address constant VAULT = 0x1111111111111111111111111111111111111111;
    address constant REGISTRY = 0x2222222222222222222222222222222222222222;
    address constant TOKEN = 0x3333333333333333333333333333333333333333;
    string constant TOKEN_NAME = "ScanPay Test USDC";
    string constant TOKEN_VERSION = "1";
    uint256 constant PAYER_KEY = 0xA11CE;
    uint256 constant MERCHANT_SIGNER_KEY = 0xB0B;
    uint256 constant OWNER_KEY = 0xC0FFEE;

    function _domain(string memory name, string memory version, address verifying) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), CHAIN_ID, verifying)
        );
    }

    function _digest(bytes32 domainSep, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_writeGoldenVectors() public {
        address payer = vm.addr(PAYER_KEY);
        address owner = vm.addr(OWNER_KEY);
        bytes32 vaultDomain = _domain("ScanPayGuard", "1", VAULT);
        bytes32 registryDomain = _domain("ScanPayRegistry", "1", REGISTRY);
        bytes32 tokenDomain = _domain(TOKEN_NAME, TOKEN_VERSION, TOKEN);

        bytes32 salt = keccak256("salt-1");
        bytes32 merchantId = ScanPayTypes.computeMerchantId(owner, salt);

        Invoice memory inv = Invoice({
            merchantId: merchantId,
            invoiceId: keccak256("invoice-1"),
            payoutToken: TOKEN,
            amount: 12_000_000,
            expiresAt: 1_800_000_000,
            keyVersion: 3
        });
        bytes32 invStruct = ScanPayTypes.hashInvoice(inv);
        bytes32 invDigest = _digest(vaultDomain, invStruct);

        PaymentIntent memory p = PaymentIntent({
            merchantId: merchantId,
            invoiceId: inv.invoiceId,
            payer: payer,
            payoutToken: TOKEN,
            amountOut: 12_000_000,
            route: ROUTE_DIRECT,
            inputToken: TOKEN,
            maxAmountIn: 12_000_000,
            quoteHash: bytes32(0),
            refundTo: payer,
            expiresAt: 1_800_000_000,
            nonce: 0xdeadbeef,
            keyVersion: 3
        });
        bytes32 pStruct = ScanPayTypes.hashIntent(p);
        bytes32 pDigest = _digest(vaultDomain, pStruct);
        bytes32 intentId = ScanPayTypes.computeIntentId(p);

        Registration memory reg = Registration({
            owner: owner,
            salt: salt,
            payoutWallet: address(0xBEEF),
            invoiceSigner: vm.addr(MERCHANT_SIGNER_KEY),
            payoutToken: TOKEN,
            metadataHash: keccak256("profile"),
            nonce: 0,
            deadline: 1_800_000_000
        });
        bytes32 regDigest = _digest(registryDomain, ScanPayTypes.hashRegistration(reg));

        bytes32 rwaStruct = keccak256(abi.encode(RWA_TYPEHASH, payer, VAULT, uint256(12_000_000), uint256(0), uint256(1_800_000_000), pDigest));
        bytes32 rwaDigest = _digest(tokenDomain, rwaStruct);

        // ---- JSON (all numbers as strings to avoid JS precision loss) ----
        string memory o = "v";
        vm.serializeString(o, "chainId", vm.toString(CHAIN_ID));
        vm.serializeAddress(o, "vault", VAULT);
        vm.serializeAddress(o, "registry", REGISTRY);
        vm.serializeAddress(o, "token", TOKEN);
        vm.serializeString(o, "tokenName", TOKEN_NAME);
        vm.serializeString(o, "tokenVersion", TOKEN_VERSION);
        vm.serializeBytes32(o, "payerKey", bytes32(PAYER_KEY));
        vm.serializeBytes32(o, "merchantSignerKey", bytes32(MERCHANT_SIGNER_KEY));
        vm.serializeBytes32(o, "ownerKey", bytes32(OWNER_KEY));
        vm.serializeAddress(o, "payer", payer);
        vm.serializeAddress(o, "owner", owner);
        vm.serializeBytes32(o, "salt", salt);
        vm.serializeBytes32(o, "merchantId", merchantId);
        vm.serializeBytes32(o, "invoiceId", inv.invoiceId);
        vm.serializeBytes32(o, "invoiceStructHash", invStruct);
        vm.serializeBytes32(o, "invoiceDigest", invDigest);
        vm.serializeBytes(o, "merchantSig", _sig(MERCHANT_SIGNER_KEY, invDigest));
        vm.serializeBytes32(o, "intentStructHash", pStruct);
        vm.serializeBytes32(o, "intentDigest", pDigest);
        vm.serializeBytes32(o, "intentId", intentId);
        vm.serializeBytes(o, "payerSig", _sig(PAYER_KEY, pDigest));
        vm.serializeBytes32(o, "registrationDigest", regDigest);
        vm.serializeBytes(o, "ownerRegSig", _sig(OWNER_KEY, regDigest));
        vm.serializeBytes32(o, "receiveAuthDigest", rwaDigest);
        string memory json = vm.serializeBytes(o, "receiveAuthSig", _sig(PAYER_KEY, rwaDigest));
        vm.writeJson(json, "../packages/shared/test-vectors/eip712.json");
    }
}
