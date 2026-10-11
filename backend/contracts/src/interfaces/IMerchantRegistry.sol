// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Merchant, Registration, SignerRotation, PayoutUpdate} from "../libraries/ScanPayTypes.sol";

interface IMerchantRegistry {
    event MerchantRegistered(
        bytes32 indexed merchantId,
        address indexed owner,
        bytes32 salt,
        address payoutWallet,
        address invoiceSigner,
        address payoutToken,
        bytes32 metadataHash
    );
    event MerchantStatusChanged(bytes32 indexed merchantId, uint8 previousStatus, uint8 newStatus, address indexed by);
    event InvoiceSignerRotated(bytes32 indexed merchantId, address invoiceSigner, uint32 keyVersion);
    event PayoutUpdated(bytes32 indexed merchantId, address payoutWallet, address payoutToken, uint32 keyVersion);
    event PayoutTokenAllowed(address indexed token, bool allowed);

    error MerchantAlreadyExists(bytes32 merchantId);
    error MerchantNotFound(bytes32 merchantId);
    error MerchantIsRevoked(bytes32 merchantId);
    error InvalidOwnerSignature();
    error InvalidPayoutSignature();
    error SignatureExpired();
    error BadNonce(uint256 expected, uint256 provided);
    error PayoutTokenNotAllowed(address token);
    error ZeroAddress();
    error InvalidStatusTransition(uint8 fromStatus, uint8 toStatus);

    function registerMerchant(Registration calldata r, bytes calldata ownerSig, bytes calldata payoutSig)
        external
        returns (bytes32 merchantId);
    function rotateInvoiceSigner(SignerRotation calldata r, bytes calldata ownerSig) external;
    function updatePayout(PayoutUpdate calldata u, bytes calldata ownerSig, bytes calldata payoutSig) external;
    function setMerchantStatus(bytes32 merchantId, uint8 newStatus) external;
    function setPayoutTokenAllowed(address token, bool allowed) external;

    function getMerchant(bytes32 merchantId) external view returns (Merchant memory);
    function isPayoutTokenAllowed(address token) external view returns (bool);
    function ownerNonce(address owner) external view returns (uint256);
    function computeMerchantId(address owner, bytes32 salt) external pure returns (bytes32);
    function hashRegistration(Registration calldata r) external view returns (bytes32 digest);
    function hashSignerRotation(SignerRotation calldata r) external view returns (bytes32 digest);
    function hashPayoutUpdate(PayoutUpdate calldata u) external view returns (bytes32 digest);
}
