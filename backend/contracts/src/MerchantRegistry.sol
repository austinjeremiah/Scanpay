// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {IMerchantRegistry} from "./interfaces/IMerchantRegistry.sol";
import "./libraries/ScanPayTypes.sol";

/// @title MerchantRegistry — proof of merchant for ScanPay Guard
/// @notice Stores role-separated merchant keys (owner, payout wallet, invoice signer) derived by the merchant app
///         from ONE Mera passkey. Every key/payout change bumps keyVersion, invalidating old invoices.
contract MerchantRegistry is IMerchantRegistry, EIP712, AccessControl {
    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");

    mapping(bytes32 merchantId => Merchant) private _merchants;
    mapping(address token => bool) private _payoutTokenAllowed;
    mapping(address owner => uint256) private _ownerNonce;

    constructor(address admin) EIP712("ScanPayRegistry", "1") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CONFIG_ROLE, admin);
        _grantRole(VERIFIER_ROLE, admin);
    }

    // ------------------------------------------------------------------ merchant actions (relayed)

    /// @inheritdoc IMerchantRegistry
    function registerMerchant(Registration calldata r, bytes calldata ownerSig, bytes calldata payoutSig)
        external
        returns (bytes32 merchantId)
    {
        if (block.timestamp > r.deadline) revert SignatureExpired();
        if (r.owner == address(0) || r.payoutWallet == address(0) || r.invoiceSigner == address(0)) {
            revert ZeroAddress();
        }
        if (!_payoutTokenAllowed[r.payoutToken]) revert PayoutTokenNotAllowed(r.payoutToken);
        _useNonce(r.owner, r.nonce);

        merchantId = ScanPayTypes.computeMerchantId(r.owner, r.salt);
        if (_merchants[merchantId].status != MERCHANT_NONE) revert MerchantAlreadyExists(merchantId);

        bytes32 digest = _hashTypedDataV4(ScanPayTypes.hashRegistration(r));
        if (!SignatureChecker.isValidSignatureNow(r.owner, digest, ownerSig)) revert InvalidOwnerSignature();
        if (!SignatureChecker.isValidSignatureNow(r.payoutWallet, digest, payoutSig)) revert InvalidPayoutSignature();

        _merchants[merchantId] = Merchant({
            owner: r.owner,
            payoutWallet: r.payoutWallet,
            invoiceSigner: r.invoiceSigner,
            payoutToken: r.payoutToken,
            keyVersion: 1,
            status: MERCHANT_PENDING,
            registeredAt: uint64(block.timestamp),
            metadataHash: r.metadataHash
        });

        emit MerchantRegistered(
            merchantId, r.owner, r.salt, r.payoutWallet, r.invoiceSigner, r.payoutToken, r.metadataHash
        );
        emit MerchantStatusChanged(merchantId, MERCHANT_NONE, MERCHANT_PENDING, msg.sender);
    }

    /// @inheritdoc IMerchantRegistry
    function rotateInvoiceSigner(SignerRotation calldata r, bytes calldata ownerSig) external {
        Merchant storage m = _live(r.merchantId);
        if (block.timestamp > r.deadline) revert SignatureExpired();
        if (r.newSigner == address(0)) revert ZeroAddress();
        _useNonce(m.owner, r.nonce);

        bytes32 digest = _hashTypedDataV4(ScanPayTypes.hashSignerRotation(r));
        if (!SignatureChecker.isValidSignatureNow(m.owner, digest, ownerSig)) revert InvalidOwnerSignature();

        m.invoiceSigner = r.newSigner;
        m.keyVersion += 1;
        emit InvoiceSignerRotated(r.merchantId, r.newSigner, m.keyVersion);
    }

    /// @inheritdoc IMerchantRegistry
    function updatePayout(PayoutUpdate calldata u, bytes calldata ownerSig, bytes calldata payoutSig) external {
        Merchant storage m = _live(u.merchantId);
        if (block.timestamp > u.deadline) revert SignatureExpired();
        if (u.payoutWallet == address(0)) revert ZeroAddress();
        if (!_payoutTokenAllowed[u.payoutToken]) revert PayoutTokenNotAllowed(u.payoutToken);
        _useNonce(m.owner, u.nonce);

        bytes32 digest = _hashTypedDataV4(ScanPayTypes.hashPayoutUpdate(u));
        if (!SignatureChecker.isValidSignatureNow(m.owner, digest, ownerSig)) revert InvalidOwnerSignature();
        if (!SignatureChecker.isValidSignatureNow(u.payoutWallet, digest, payoutSig)) revert InvalidPayoutSignature();

        m.payoutWallet = u.payoutWallet;
        m.payoutToken = u.payoutToken;
        m.keyVersion += 1;
        emit PayoutUpdated(u.merchantId, u.payoutWallet, u.payoutToken, m.keyVersion);
    }

    // ------------------------------------------------------------------ verifier / config

    /// @inheritdoc IMerchantRegistry
    function setMerchantStatus(bytes32 merchantId, uint8 newStatus) external onlyRole(VERIFIER_ROLE) {
        Merchant storage m = _merchants[merchantId];
        uint8 prev = m.status;
        if (prev == MERCHANT_NONE) revert MerchantNotFound(merchantId);
        if (!_validTransition(prev, newStatus)) revert InvalidStatusTransition(prev, newStatus);
        m.status = newStatus;
        emit MerchantStatusChanged(merchantId, prev, newStatus, msg.sender);
    }

    /// @inheritdoc IMerchantRegistry
    function setPayoutTokenAllowed(address token, bool allowed) external onlyRole(CONFIG_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        _payoutTokenAllowed[token] = allowed;
        emit PayoutTokenAllowed(token, allowed);
    }

    // ------------------------------------------------------------------ views

    function getMerchant(bytes32 merchantId) external view returns (Merchant memory) {
        return _merchants[merchantId];
    }

    function isPayoutTokenAllowed(address token) external view returns (bool) {
        return _payoutTokenAllowed[token];
    }

    function ownerNonce(address owner) external view returns (uint256) {
        return _ownerNonce[owner];
    }

    function computeMerchantId(address owner, bytes32 salt) external pure returns (bytes32) {
        return ScanPayTypes.computeMerchantId(owner, salt);
    }

    function hashRegistration(Registration calldata r) external view returns (bytes32 digest) {
        return _hashTypedDataV4(ScanPayTypes.hashRegistration(r));
    }

    function hashSignerRotation(SignerRotation calldata r) external view returns (bytes32 digest) {
        return _hashTypedDataV4(ScanPayTypes.hashSignerRotation(r));
    }

    function hashPayoutUpdate(PayoutUpdate calldata u) external view returns (bytes32 digest) {
        return _hashTypedDataV4(ScanPayTypes.hashPayoutUpdate(u));
    }

    // ------------------------------------------------------------------ internal

    function _useNonce(address owner, uint256 provided) private {
        uint256 expected = _ownerNonce[owner];
        if (provided != expected) revert BadNonce(expected, provided);
        _ownerNonce[owner] = expected + 1;
    }

    /// @dev Merchant must exist and not be revoked (suspended merchants may still rotate keys / fix payout).
    function _live(bytes32 merchantId) private view returns (Merchant storage m) {
        m = _merchants[merchantId];
        if (m.status == MERCHANT_NONE) revert MerchantNotFound(merchantId);
        if (m.status == MERCHANT_REVOKED) revert MerchantIsRevoked(merchantId);
    }

    function _validTransition(uint8 from, uint8 to) private pure returns (bool) {
        if (from == MERCHANT_PENDING) return to == MERCHANT_ACTIVE || to == MERCHANT_REVOKED;
        if (from == MERCHANT_ACTIVE) return to == MERCHANT_SUSPENDED || to == MERCHANT_REVOKED;
        if (from == MERCHANT_SUSPENDED) return to == MERCHANT_ACTIVE || to == MERCHANT_REVOKED;
        return false;
    }
}
