// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Invoice, PaymentIntent, Auth3009, IntentRecord} from "../libraries/ScanPayTypes.sol";
import {IMerchantRegistry} from "./IMerchantRegistry.sol";

interface IIntentVault {
    event IntentCommitted(
        bytes32 indexed intentId,
        bytes32 indexed merchantId,
        address indexed payer,
        bytes32 invoiceId,
        uint8 route,
        address inputToken,
        address payoutToken,
        uint256 amountOut,
        address forwarder,
        address payoutWallet,
        uint64 expiresAt,
        bytes32 quoteHash
    );
    event PaymentSettled(
        bytes32 indexed intentId,
        bytes32 indexed merchantId,
        address indexed payer,
        bytes32 invoiceId,
        uint8 route,
        address payoutToken,
        uint256 amountOut,
        uint256 fee,
        address payoutWallet,
        address inputToken,
        uint256 inputAmount,
        uint256 excessRefunded
    );
    event IntentRefunded(bytes32 indexed intentId, address indexed refundTo, address token, uint256 amount);
    event ForwarderRescued(bytes32 indexed intentId, address indexed to, address token, uint256 amount);
    event SourceAttested(
        bytes32 indexed intentId, uint256 sourceChainId, bytes32 sourceTxHash, bytes32 providerRef, address indexed attester
    );
    event FeeUpdated(uint16 feeBps, address feeRecipient);
    event SwapAdapterUpdated(address adapter);
    event RefundDelayUpdated(uint64 refundDelay);
    event AmountCapUpdated(address indexed token, uint256 cap);
    event InputTokenAllowed(address indexed token, uint8 route, bool allowed);
    event CrossChainInputTokenUpdated(address token);

    error MerchantNotActive(bytes32 merchantId, uint8 status);
    error KeyVersionMismatch(uint32 expected, uint32 provided);
    error InvoiceMismatch();
    error PayoutTokenMismatch();
    error PayoutTokenNotAllowed(address token);
    error AmountMismatch();
    error InvoiceExpired();
    error IntentExpired();
    error InvalidMerchantSignature();
    error InvalidPayerSignature();
    error NonceAlreadyUsed(address payer, uint256 nonce);
    error InvoiceNotOpen(uint8 state);
    error RouteMismatch(uint8 expected, uint8 provided);
    error InputTokenNotAllowed(address token, uint8 route);
    error AmountAboveCap(uint256 amount, uint256 cap);
    error Underpaid(uint256 received, uint256 required);
    error SwapOutputTooLow(uint256 out, uint256 required);
    error IntentNotCommitted(bytes32 intentId);
    error IntentAlreadyExists(bytes32 intentId);
    error RefundNotYetAllowed(uint256 allowedAt);
    error IntentNotTerminal(bytes32 intentId);
    error AlreadyAttested(bytes32 intentId);
    error NoSwapAdapter();
    error InvalidFee(uint16 feeBps);
    error ZeroAddress();

    // ---- payments ----
    function payDirect(
        PaymentIntent calldata intent,
        Invoice calldata invoice,
        bytes calldata merchantSig,
        bytes calldata payerSig,
        Auth3009 calldata auth
    ) external returns (bytes32 intentId);

    function paySwap(
        PaymentIntent calldata intent,
        Invoice calldata invoice,
        bytes calldata merchantSig,
        bytes calldata payerSig,
        bytes calldata swapData
    ) external returns (bytes32 intentId);

    function commitCrossChain(
        PaymentIntent calldata intent,
        Invoice calldata invoice,
        bytes calldata merchantSig,
        bytes calldata payerSig
    ) external returns (bytes32 intentId, address forwarder);

    function settleCrossChain(bytes32 intentId, bytes calldata swapData) external;
    function refundCrossChain(bytes32 intentId) external;
    function rescue(bytes32 intentId, address token) external;
    function attestSource(bytes32 intentId, uint256 sourceChainId, bytes32 sourceTxHash, bytes32 providerRef) external;

    // ---- config (CONFIG_ROLE / PAUSER_ROLE) ----
    function setFee(uint16 feeBps_, address feeRecipient_) external;
    function setSwapAdapter(address adapter) external;
    function setRefundDelay(uint64 refundDelay_) external;
    function setAmountCap(address token, uint256 cap) external;
    function setInputTokenAllowed(address token, uint8 route, bool allowed) external;
    function setCrossChainInputToken(address token) external;
    function pause() external;
    function unpause() external;

    // ---- views ----
    function registry() external view returns (IMerchantRegistry);
    function forwarderImplementation() external view returns (address);
    function feeBps() external view returns (uint16);
    function feeRecipient() external view returns (address);
    function swapAdapter() external view returns (address);
    function refundDelay() external view returns (uint64);
    function crossChainInputToken() external view returns (address);
    function amountCap(address token) external view returns (uint256);
    function isInputTokenAllowed(address token, uint8 route) external view returns (bool);
    function usedNonce(address payer, uint256 nonce) external view returns (bool);
    function invoiceState(bytes32 merchantId, bytes32 invoiceId) external view returns (uint8);
    function getIntent(bytes32 intentId) external view returns (IntentRecord memory);
    function forwarderOf(bytes32 intentId) external view returns (address);
    function hashInvoice(Invoice calldata invoice) external view returns (bytes32 digest);
    function hashIntent(PaymentIntent calldata intent) external view returns (bytes32 digest);
    function computeIntentId(PaymentIntent calldata intent) external pure returns (bytes32);
}
