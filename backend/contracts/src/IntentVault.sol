// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IIntentVault} from "./interfaces/IIntentVault.sol";
import {IMerchantRegistry} from "./interfaces/IMerchantRegistry.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {DepositForwarder} from "./DepositForwarder.sol";
import "./libraries/ScanPayTypes.sol";

/// @title IntentVault — ScanPay Guard settlement contract
/// @notice Proof of intent: merchant-signed Invoice + payer-signed PaymentIntent, one-time nonce, one-time invoice.
///         Proof of settlement: funds can only reach the merchant's registered payout wallet, exactly amountOut − fee.
contract IntentVault is IIntentVault, EIP712, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");
    bytes32 public constant ATTESTER_ROLE = keccak256("ATTESTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    uint16 public constant MAX_FEE_BPS = 100;

    IMerchantRegistry public immutable registry;
    address public immutable forwarderImplementation;

    uint16 public feeBps;
    address public feeRecipient;
    address public swapAdapter;
    uint64 public refundDelay;
    address public crossChainInputToken;

    mapping(address token => uint256) public amountCap;
    mapping(address payer => mapping(uint256 nonce => bool)) public usedNonce;
    mapping(bytes32 merchantId => mapping(bytes32 invoiceId => uint8)) public invoiceState;
    mapping(address token => mapping(uint8 route => bool)) private _inputAllowed;
    mapping(bytes32 intentId => IntentRecord) private _intents;

    constructor(
        address admin,
        IMerchantRegistry registry_,
        address feeRecipient_,
        uint16 feeBps_,
        uint64 refundDelay_
    ) EIP712("ScanPayGuard", "1") {
        if (admin == address(0) || address(registry_) == address(0) || feeRecipient_ == address(0)) {
            revert ZeroAddress();
        }
        if (feeBps_ > MAX_FEE_BPS) revert InvalidFee(feeBps_);

        registry = registry_;
        forwarderImplementation = address(new DepositForwarder(address(this)));
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        refundDelay = refundDelay_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CONFIG_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);

        emit FeeUpdated(feeBps_, feeRecipient_);
        emit RefundDelayUpdated(refundDelay_);
    }

    // =====================================================================================================
    // Payments
    // =====================================================================================================

    /// @notice DIRECT: payer's EIP-3009 ReceiveWithAuthorization (nonce = intent digest) moves exactly amountOut.
    function payDirect(
        PaymentIntent calldata intent,
        Invoice calldata invoice,
        bytes calldata merchantSig,
        bytes calldata payerSig,
        Auth3009 calldata auth
    ) external whenNotPaused nonReentrant returns (bytes32 intentId) {
        bytes32 digest;
        address payoutWallet;
        (intentId, digest, payoutWallet) = _verify(intent, invoice, merchantSig, payerSig, ROUTE_DIRECT);
        _openRecord(intentId, intent, payoutWallet, address(0));

        IERC20 token = IERC20(intent.payoutToken);
        uint256 before = token.balanceOf(address(this));
        // Reverts from the token bubble up unchanged -> B maps them to TOKEN_AUTHORIZATION_FAILED.
        IERC3009(intent.payoutToken).receiveWithAuthorization(
            intent.payer, address(this), intent.amountOut, 0, intent.expiresAt, digest, auth.v, auth.r, auth.s
        );
        uint256 received = token.balanceOf(address(this)) - before;
        if (received < intent.amountOut) revert Underpaid(received, intent.amountOut);

        _settle(intentId, received, received);
    }

    /// @notice SWAP: payer pre-approved the vault for inputToken. The signature authorizes pulling maxAmountIn,
    ///         swapping via the adapter to exactly >= amountOut, and refunding unused input to refundTo.
    ///         If inputToken == payoutToken, pulls exactly amountOut (allowance-based fallback for non-3009 tokens).
    function paySwap(
        PaymentIntent calldata intent,
        Invoice calldata invoice,
        bytes calldata merchantSig,
        bytes calldata payerSig,
        bytes calldata swapData
    ) external whenNotPaused nonReentrant returns (bytes32 intentId) {
        address payoutWallet;
        (intentId,, payoutWallet) = _verify(intent, invoice, merchantSig, payerSig, ROUTE_SWAP);

        if (intent.inputToken == intent.payoutToken) {
            _openRecord(intentId, intent, payoutWallet, address(0));
            IERC20(intent.payoutToken).safeTransferFrom(intent.payer, address(this), intent.amountOut);
            _settle(intentId, intent.amountOut, intent.amountOut);
            return intentId;
        }

        address adapter = swapAdapter;
        if (adapter == address(0)) revert NoSwapAdapter();
        _openRecord(intentId, intent, payoutWallet, address(0));

        IERC20 inToken = IERC20(intent.inputToken);
        inToken.safeTransferFrom(intent.payer, adapter, intent.maxAmountIn);
        uint256 refundBefore = inToken.balanceOf(intent.refundTo); // measured AFTER the pull (works if refundTo == payer)
        uint256 out = _swap(
            adapter, intent.inputToken, intent.payoutToken, intent.maxAmountIn, intent.amountOut, swapData, intent.refundTo
        );
        uint256 leftover = inToken.balanceOf(intent.refundTo) - refundBefore;

        _settle(intentId, out, intent.maxAmountIn - leftover);
    }

    /// @notice CROSSCHAIN step 1: lock the intent and deploy its deposit forwarder (the Aurora recipient).
    function commitCrossChain(
        PaymentIntent calldata intent,
        Invoice calldata invoice,
        bytes calldata merchantSig,
        bytes calldata payerSig
    ) external whenNotPaused nonReentrant returns (bytes32 intentId, address forwarder) {
        address payoutWallet;
        (intentId,, payoutWallet) = _verify(intent, invoice, merchantSig, payerSig, ROUTE_CROSSCHAIN);
        if (intent.inputToken != intent.payoutToken && swapAdapter == address(0)) revert NoSwapAdapter();

        forwarder = Clones.cloneDeterministic(forwarderImplementation, intentId);
        _openRecord(intentId, intent, payoutWallet, forwarder);
    }

    /// @notice CROSSCHAIN step 2 (permissionless): settle from the forwarder balance. No off-chain claim can
    ///         settle an intent — only tokens actually sitting in the forwarder.
    function settleCrossChain(bytes32 intentId, bytes calldata swapData) external whenNotPaused nonReentrant {
        IntentRecord storage r = _intents[intentId];
        if (r.route != ROUTE_CROSSCHAIN || r.status != INTENT_COMMITTED) revert IntentNotCommitted(intentId);

        DepositForwarder fwd = DepositForwarder(forwarderOf(intentId));
        address inputToken = r.inputToken;
        uint256 required = r.inputAmount; // = maxAmountIn while COMMITTED
        uint256 bal = IERC20(inputToken).balanceOf(address(fwd));
        if (bal < required) revert Underpaid(bal, required);

        if (inputToken == r.payoutToken) {
            fwd.sweep(inputToken, address(this));
            _settle(intentId, bal, bal);
        } else {
            address adapter = swapAdapter;
            if (adapter == address(0)) revert NoSwapAdapter();
            address refundTo = r.refundTo;
            fwd.sweep(inputToken, adapter);
            uint256 refundBefore = IERC20(inputToken).balanceOf(refundTo);
            uint256 out = _swap(adapter, inputToken, r.payoutToken, bal, r.amountOut, swapData, refundTo);
            uint256 leftover = IERC20(inputToken).balanceOf(refundTo) - refundBefore;
            _settle(intentId, out, bal - leftover);
        }
    }

    /// @notice CROSSCHAIN escape hatch (permissionless, works while paused): after expiresAt + refundDelay,
    ///         return whatever reached the forwarder to refundTo and reopen the invoice.
    function refundCrossChain(bytes32 intentId) external nonReentrant {
        IntentRecord storage r = _intents[intentId];
        if (r.route != ROUTE_CROSSCHAIN || r.status != INTENT_COMMITTED) revert IntentNotCommitted(intentId);
        uint256 allowedAt = uint256(r.expiresAt) + refundDelay;
        if (block.timestamp < allowedAt) revert RefundNotYetAllowed(allowedAt);

        r.status = INTENT_REFUNDED;
        invoiceState[r.merchantId][r.invoiceId] = INVOICE_OPEN;
        uint256 amount = DepositForwarder(forwarderOf(intentId)).sweep(r.inputToken, r.refundTo);
        emit IntentRefunded(intentId, r.refundTo, r.inputToken, amount);
    }

    /// @notice Late or wrong-token deposits to a finished intent's forwarder always go to refundTo (permissionless).
    function rescue(bytes32 intentId, address token) external nonReentrant {
        IntentRecord storage r = _intents[intentId];
        if (r.route != ROUTE_CROSSCHAIN || (r.status != INTENT_SETTLED && r.status != INTENT_REFUNDED)) {
            revert IntentNotTerminal(intentId);
        }
        uint256 amount = DepositForwarder(forwarderOf(intentId)).sweep(token, r.refundTo);
        emit ForwarderRescued(intentId, r.refundTo, token, amount);
    }

    /// @notice Operator attestation of which source-chain tx funded the deposit (the one trusted statement).
    ///         Does NOT change status and can't move funds.
    function attestSource(bytes32 intentId, uint256 sourceChainId, bytes32 sourceTxHash, bytes32 providerRef)
        external
        onlyRole(ATTESTER_ROLE)
    {
        IntentRecord storage r = _intents[intentId];
        if (r.route != ROUTE_CROSSCHAIN || r.status == INTENT_NONE) revert IntentNotCommitted(intentId);
        if (r.sourceTxHash != bytes32(0)) revert AlreadyAttested(intentId);
        r.sourceChainId = sourceChainId;
        r.sourceTxHash = sourceTxHash;
        emit SourceAttested(intentId, sourceChainId, sourceTxHash, providerRef, msg.sender);
    }

    // =====================================================================================================
    // Config
    // =====================================================================================================

    function setFee(uint16 feeBps_, address feeRecipient_) external onlyRole(CONFIG_ROLE) {
        if (feeBps_ > MAX_FEE_BPS) revert InvalidFee(feeBps_);
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        emit FeeUpdated(feeBps_, feeRecipient_);
    }

    /// @dev address(0) disables SWAP route and cross-token cross-chain settles.
    function setSwapAdapter(address adapter) external onlyRole(CONFIG_ROLE) {
        swapAdapter = adapter;
        emit SwapAdapterUpdated(adapter);
    }

    function setRefundDelay(uint64 refundDelay_) external onlyRole(CONFIG_ROLE) {
        refundDelay = refundDelay_;
        emit RefundDelayUpdated(refundDelay_);
    }

    /// @dev cap = 0 means unlimited. Mainnet sets small caps (A23).
    function setAmountCap(address token, uint256 cap) external onlyRole(CONFIG_ROLE) {
        amountCap[token] = cap;
        emit AmountCapUpdated(token, cap);
    }

    /// @dev Only DIRECT (0) and SWAP (1). CROSSCHAIN input is configured with setCrossChainInputToken.
    function setInputTokenAllowed(address token, uint8 route, bool allowed) external onlyRole(CONFIG_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        if (route > ROUTE_SWAP) revert RouteMismatch(ROUTE_SWAP, route);
        _inputAllowed[token][route] = allowed;
        emit InputTokenAllowed(token, route, allowed);
    }

    function setCrossChainInputToken(address token) external onlyRole(CONFIG_ROLE) {
        crossChainInputToken = token;
        emit CrossChainInputTokenUpdated(token);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // =====================================================================================================
    // Views
    // =====================================================================================================

    function isInputTokenAllowed(address token, uint8 route) public view returns (bool) {
        if (route == ROUTE_CROSSCHAIN) return token != address(0) && token == crossChainInputToken;
        return _inputAllowed[token][route];
    }

    function getIntent(bytes32 intentId) external view returns (IntentRecord memory) {
        return _intents[intentId];
    }

    function forwarderOf(bytes32 intentId) public view returns (address) {
        return Clones.predictDeterministicAddress(forwarderImplementation, intentId, address(this));
    }

    function hashInvoice(Invoice calldata invoice) external view returns (bytes32 digest) {
        return _hashTypedDataV4(ScanPayTypes.hashInvoice(invoice));
    }

    function hashIntent(PaymentIntent calldata intent) external view returns (bytes32 digest) {
        return _hashTypedDataV4(ScanPayTypes.hashIntent(intent));
    }

    function computeIntentId(PaymentIntent calldata intent) external pure returns (bytes32) {
        return ScanPayTypes.computeIntentId(intent);
    }

    // =====================================================================================================
    // Internal
    // =====================================================================================================

    function _verify(
        PaymentIntent calldata p,
        Invoice calldata inv,
        bytes calldata merchantSig,
        bytes calldata payerSig,
        uint8 route
    ) internal returns (bytes32 intentId, bytes32 intentDigest, address payoutWallet) {
        // 1. shape
        if (p.route != route) revert RouteMismatch(route, p.route);
        if (p.merchantId != inv.merchantId || p.invoiceId != inv.invoiceId) revert InvoiceMismatch();
        if (p.payoutToken != inv.payoutToken) revert PayoutTokenMismatch();
        if (p.amountOut != inv.amount || inv.amount == 0) revert AmountMismatch();
        if (p.refundTo == address(0)) revert ZeroAddress();

        // 2. time
        if (block.timestamp > inv.expiresAt) revert InvoiceExpired();
        if (block.timestamp > p.expiresAt) revert IntentExpired();

        // 3. merchant (registry is the single source of truth for keys + payout)
        Merchant memory m = registry.getMerchant(inv.merchantId);
        if (m.status != MERCHANT_ACTIVE) revert MerchantNotActive(inv.merchantId, m.status);
        if (inv.keyVersion != m.keyVersion) revert KeyVersionMismatch(m.keyVersion, inv.keyVersion);
        if (p.keyVersion != m.keyVersion) revert KeyVersionMismatch(m.keyVersion, p.keyVersion);
        if (inv.payoutToken != m.payoutToken) revert PayoutTokenMismatch();
        if (!registry.isPayoutTokenAllowed(inv.payoutToken)) revert PayoutTokenNotAllowed(inv.payoutToken);
        uint256 cap = amountCap[inv.payoutToken];
        if (cap != 0 && inv.amount > cap) revert AmountAboveCap(inv.amount, cap);

        // 4. input token
        if (!isInputTokenAllowed(p.inputToken, route)) revert InputTokenNotAllowed(p.inputToken, route);
        if (route == ROUTE_DIRECT && p.inputToken != p.payoutToken) revert InputTokenNotAllowed(p.inputToken, route);
        if (p.inputToken == p.payoutToken ? p.maxAmountIn < p.amountOut : p.maxAmountIn == 0) {
            revert AmountMismatch();
        }

        // 5. signatures (EOA or ERC-1271)
        bytes32 invoiceDigest = _hashTypedDataV4(ScanPayTypes.hashInvoice(inv));
        if (!SignatureChecker.isValidSignatureNow(m.invoiceSigner, invoiceDigest, merchantSig)) {
            revert InvalidMerchantSignature();
        }
        intentDigest = _hashTypedDataV4(ScanPayTypes.hashIntent(p));
        if (!SignatureChecker.isValidSignatureNow(p.payer, intentDigest, payerSig)) revert InvalidPayerSignature();

        // 6. one-time use
        if (usedNonce[p.payer][p.nonce]) revert NonceAlreadyUsed(p.payer, p.nonce);
        uint8 st = invoiceState[inv.merchantId][inv.invoiceId];
        if (st != INVOICE_OPEN) revert InvoiceNotOpen(st);
        intentId = ScanPayTypes.computeIntentId(p);
        if (_intents[intentId].status != INTENT_NONE) revert IntentAlreadyExists(intentId);

        usedNonce[p.payer][p.nonce] = true;
        payoutWallet = m.payoutWallet;
    }

    function _openRecord(bytes32 id, PaymentIntent calldata p, address payoutWallet, address forwarder) internal {
        IntentRecord storage r = _intents[id];
        r.payer = p.payer;
        r.route = p.route;
        r.status = INTENT_COMMITTED;
        r.expiresAt = p.expiresAt;
        r.committedAt = uint64(block.timestamp);
        r.merchantId = p.merchantId;
        r.invoiceId = p.invoiceId;
        r.payoutToken = p.payoutToken;
        r.inputToken = p.inputToken;
        r.payoutWallet = payoutWallet;
        r.refundTo = p.refundTo;
        r.amountOut = p.amountOut;
        r.inputAmount = p.maxAmountIn;
        r.quoteHash = p.quoteHash;

        invoiceState[p.merchantId][p.invoiceId] = INVOICE_RESERVED;

        emit IntentCommitted(
            id,
            p.merchantId,
            p.payer,
            p.invoiceId,
            p.route,
            p.inputToken,
            p.payoutToken,
            p.amountOut,
            forwarder,
            payoutWallet,
            p.expiresAt,
            p.quoteHash
        );
    }

    /// @param available payout-token amount the vault received for this intent in this tx (>= amountOut).
    /// @param inputUsed input-token amount actually consumed (for the record + event).
    function _settle(bytes32 id, uint256 available, uint256 inputUsed) internal {
        IntentRecord storage r = _intents[id];
        uint256 amountOut = r.amountOut;
        uint256 fee = (amountOut * feeBps) / 10_000;
        uint256 excess = available - amountOut; // callers guarantee available >= amountOut

        r.status = INTENT_SETTLED;
        r.settledAt = uint64(block.timestamp);
        r.fee = fee;
        r.inputAmount = inputUsed;
        invoiceState[r.merchantId][r.invoiceId] = INVOICE_PAID;

        IERC20 token = IERC20(r.payoutToken);
        token.safeTransfer(r.payoutWallet, amountOut - fee);
        if (fee != 0) token.safeTransfer(feeRecipient, fee);
        if (excess != 0) token.safeTransfer(r.refundTo, excess);

        emit PaymentSettled(
            id,
            r.merchantId,
            r.payer,
            r.invoiceId,
            r.route,
            r.payoutToken,
            amountOut,
            fee,
            r.payoutWallet,
            r.inputToken,
            inputUsed,
            excess
        );
    }

    /// @dev Adapter already holds amountIn. Output is measured by balance delta (vault holds nothing between txs).
    function _swap(
        address adapter,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata data,
        address leftoverTo
    ) internal returns (uint256 out) {
        IERC20 outToken = IERC20(tokenOut);
        uint256 before = outToken.balanceOf(address(this));
        ISwapAdapter(adapter).swap(tokenIn, tokenOut, amountIn, minOut, data, address(this), leftoverTo);
        out = outToken.balanceOf(address(this)) - before;
        if (out < minOut) revert SwapOutputTooLow(out, minOut);
    }
}
