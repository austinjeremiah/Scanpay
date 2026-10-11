// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

uint8 constant ROUTE_DIRECT = 0;
uint8 constant ROUTE_SWAP = 1;
uint8 constant ROUTE_CROSSCHAIN = 2;

uint8 constant INTENT_NONE = 0;
uint8 constant INTENT_COMMITTED = 1;
uint8 constant INTENT_SETTLED = 2;
uint8 constant INTENT_REFUNDED = 3;

uint8 constant INVOICE_OPEN = 0;
uint8 constant INVOICE_RESERVED = 1;
uint8 constant INVOICE_PAID = 2;

uint8 constant MERCHANT_NONE = 0;
uint8 constant MERCHANT_PENDING = 1;
uint8 constant MERCHANT_ACTIVE = 2;
uint8 constant MERCHANT_SUSPENDED = 3;
uint8 constant MERCHANT_REVOKED = 4;

struct Invoice {
    bytes32 merchantId;
    bytes32 invoiceId;
    address payoutToken;
    uint256 amount;
    uint64 expiresAt;
    uint32 keyVersion;
}

struct PaymentIntent {
    bytes32 merchantId;
    bytes32 invoiceId;
    address payer;
    address payoutToken;
    uint256 amountOut;
    uint8 route;
    address inputToken;
    uint256 maxAmountIn;
    bytes32 quoteHash;
    address refundTo;
    uint64 expiresAt;
    uint256 nonce;
    uint32 keyVersion;
}

struct Auth3009 {
    uint8 v;
    bytes32 r;
    bytes32 s;
}

struct Merchant {
    address owner;
    address payoutWallet;
    address invoiceSigner;
    address payoutToken;
    uint32 keyVersion;
    uint8 status;
    uint64 registeredAt;
    bytes32 metadataHash;
}

struct Registration {
    address owner;
    bytes32 salt;
    address payoutWallet;
    address invoiceSigner;
    address payoutToken;
    bytes32 metadataHash;
    uint256 nonce;
    uint64 deadline;
}

struct SignerRotation {
    bytes32 merchantId;
    address newSigner;
    uint256 nonce;
    uint64 deadline;
}

struct PayoutUpdate {
    bytes32 merchantId;
    address payoutWallet;
    address payoutToken;
    uint256 nonce;
    uint64 deadline;
}

struct IntentRecord {
    address payer;
    uint8 route;
    uint8 status;
    uint64 expiresAt;
    uint64 committedAt;
    uint64 settledAt;
    bytes32 merchantId;
    bytes32 invoiceId;
    address payoutToken;
    address inputToken;
    address payoutWallet;
    address refundTo;
    uint256 amountOut;
    uint256 inputAmount;
    uint256 fee;
    bytes32 quoteHash;
    uint256 sourceChainId;
    bytes32 sourceTxHash;
}

library ScanPayTypes {
    bytes32 internal constant INVOICE_TYPEHASH = keccak256(
        "Invoice(bytes32 merchantId,bytes32 invoiceId,address payoutToken,uint256 amount,uint64 expiresAt,uint32 keyVersion)"
    );
    bytes32 internal constant PAYMENT_INTENT_TYPEHASH = keccak256(
        "PaymentIntent(bytes32 merchantId,bytes32 invoiceId,address payer,address payoutToken,uint256 amountOut,uint8 route,address inputToken,uint256 maxAmountIn,bytes32 quoteHash,address refundTo,uint64 expiresAt,uint256 nonce,uint32 keyVersion)"
    );
    bytes32 internal constant REGISTRATION_TYPEHASH = keccak256(
        "Registration(address owner,bytes32 salt,address payoutWallet,address invoiceSigner,address payoutToken,bytes32 metadataHash,uint256 nonce,uint64 deadline)"
    );
    bytes32 internal constant SIGNER_ROTATION_TYPEHASH =
        keccak256("SignerRotation(bytes32 merchantId,address newSigner,uint256 nonce,uint64 deadline)");
    bytes32 internal constant PAYOUT_UPDATE_TYPEHASH =
        keccak256("PayoutUpdate(bytes32 merchantId,address payoutWallet,address payoutToken,uint256 nonce,uint64 deadline)");

    function hashInvoice(Invoice memory i) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(INVOICE_TYPEHASH, i.merchantId, i.invoiceId, i.payoutToken, i.amount, i.expiresAt, i.keyVersion)
        );
    }

    function hashIntent(PaymentIntent memory p) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                PAYMENT_INTENT_TYPEHASH,
                p.merchantId,
                p.invoiceId,
                p.payer,
                p.payoutToken,
                p.amountOut,
                p.route,
                p.inputToken,
                p.maxAmountIn,
                p.quoteHash,
                p.refundTo,
                p.expiresAt,
                p.nonce,
                p.keyVersion
            )
        );
    }

    function hashRegistration(Registration memory r) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                REGISTRATION_TYPEHASH,
                r.owner,
                r.salt,
                r.payoutWallet,
                r.invoiceSigner,
                r.payoutToken,
                r.metadataHash,
                r.nonce,
                r.deadline
            )
        );
    }

    function hashSignerRotation(SignerRotation memory r) internal pure returns (bytes32) {
        return keccak256(abi.encode(SIGNER_ROTATION_TYPEHASH, r.merchantId, r.newSigner, r.nonce, r.deadline));
    }

    function hashPayoutUpdate(PayoutUpdate memory u) internal pure returns (bytes32) {
        return keccak256(abi.encode(PAYOUT_UPDATE_TYPEHASH, u.merchantId, u.payoutWallet, u.payoutToken, u.nonce, u.deadline));
    }

    function computeIntentId(PaymentIntent memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode(p.merchantId, p.invoiceId, p.payer, p.nonce));
    }

    function computeMerchantId(address owner, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt));
    }
}
