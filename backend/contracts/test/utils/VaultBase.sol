// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RegistryBase} from "./RegistryBase.sol";
import "../../src/libraries/ScanPayTypes.sol";
import {IntentVault} from "../../src/IntentVault.sol";
import {IMerchantRegistry} from "../../src/interfaces/IMerchantRegistry.sol";
import {MockStableToken} from "../../src/mocks/MockStableToken.sol";
import {MockSwapAdapter} from "../../src/adapters/MockSwapAdapter.sol";

abstract contract VaultBase is RegistryBase {
    uint16 internal constant FEE_BPS = 30; // 0.30%
    uint64 internal constant REFUND_DELAY = 600;
    uint256 internal constant AMOUNT = 12_000_000; // 12.00 (6 dec)
    uint256 internal constant FEE = (AMOUNT * FEE_BPS) / 10_000; // 36_000

    IntentVault internal vault;
    MockSwapAdapter internal adapter;
    bytes32 internal merchantId; // ACTIVE, payout tUSDC
    uint256 internal nextNonce = 1;

    function setUp() public virtual override {
        super.setUp();
        vm.startPrank(admin);
        vault = new IntentVault(admin, IMerchantRegistry(address(registry)), feeRecipient, FEE_BPS, REFUND_DELAY);
        adapter = new MockSwapAdapter(admin, address(vault));

        vault.grantRole(vault.ATTESTER_ROLE(), operator);
        vault.setSwapAdapter(address(adapter));
        vault.setInputTokenAllowed(address(usdc), ROUTE_DIRECT, true);
        vault.setInputTokenAllowed(address(ausd), ROUTE_DIRECT, true);
        vault.setInputTokenAllowed(address(usdc), ROUTE_SWAP, true);
        vault.setInputTokenAllowed(address(ausd), ROUTE_SWAP, true);
        vault.setInputTokenAllowed(address(mon), ROUTE_SWAP, true);
        vault.setCrossChainInputToken(address(usdc));

        adapter.setRate(address(mon), address(usdc), 25_000);
        adapter.setRate(address(mon), address(ausd), 25_000);
        adapter.setRate(address(usdc), address(ausd), 1e18);
        adapter.setRate(address(ausd), address(usdc), 1e18);

        usdc.mint(address(adapter), 1_000_000e6);
        ausd.mint(address(adapter), 1_000_000e6);
        usdc.mint(payer, 1_000e6);
        ausd.mint(payer, 1_000e6);
        mon.mint(payer, 100_000e18);
        vm.stopPrank();

        merchantId = _registerAndApprove(SALT, address(usdc));
    }

    // ---------------------------------------------------------------- builders

    function _invoiceFor(bytes32 mId, bytes32 invoiceId, address token, uint256 amount)
        internal
        view
        returns (Invoice memory)
    {
        return Invoice({
            merchantId: mId,
            invoiceId: invoiceId,
            payoutToken: token,
            amount: amount,
            expiresAt: uint64(block.timestamp + 15 minutes),
            keyVersion: registry.getMerchant(mId).keyVersion
        });
    }

    function _invoice(bytes32 invoiceId) internal view returns (Invoice memory) {
        return _invoiceFor(merchantId, invoiceId, address(usdc), AMOUNT);
    }

    function _intent(Invoice memory inv, uint8 route, address inputToken, uint256 maxIn)
        internal
        returns (PaymentIntent memory p)
    {
        p = PaymentIntent({
            merchantId: inv.merchantId,
            invoiceId: inv.invoiceId,
            payer: payer,
            payoutToken: inv.payoutToken,
            amountOut: inv.amount,
            route: route,
            inputToken: inputToken,
            maxAmountIn: maxIn,
            quoteHash: route == ROUTE_DIRECT ? bytes32(0) : keccak256("quote"),
            refundTo: payer,
            expiresAt: uint64(block.timestamp + 10 minutes),
            nonce: nextNonce++,
            keyVersion: inv.keyVersion
        });
    }

    function _merchantSig(Invoice memory inv) internal view returns (bytes memory) {
        return _sign(SIGNER_PK, vault.hashInvoice(inv));
    }

    function _payerSig(PaymentIntent memory p) internal view returns (bytes memory) {
        return _sign(PAYER_PK, vault.hashIntent(p));
    }

    /// @dev EIP-3009 ReceiveWithAuthorization bound to the intent digest (ICD §0.5).
    function _auth(PaymentIntent memory p) internal view returns (Auth3009 memory a) {
        MockStableToken t = MockStableToken(p.payoutToken);
        bytes32 structHash = keccak256(
            abi.encode(
                t.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                p.payer,
                address(vault),
                p.amountOut,
                uint256(0),
                uint256(p.expiresAt),
                vault.hashIntent(p)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", t.DOMAIN_SEPARATOR(), structHash));
        (a.v, a.r, a.s) = vm.sign(PAYER_PK, digest);
    }

    function _direct(bytes32 invoiceId) internal returns (Invoice memory inv, PaymentIntent memory p) {
        inv = _invoice(invoiceId);
        p = _intent(inv, ROUTE_DIRECT, address(usdc), AMOUNT);
    }

    function _payDirect(Invoice memory inv, PaymentIntent memory p) internal returns (bytes32) {
        return vault.payDirect(p, inv, _merchantSig(inv), _payerSig(p), _auth(p));
    }
}
