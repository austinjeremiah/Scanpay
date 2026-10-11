// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VaultBase} from "./utils/VaultBase.sol";
import {IntentVault} from "../src/IntentVault.sol";
import {MockStableToken} from "../src/mocks/MockStableToken.sol";
import "../src/libraries/ScanPayTypes.sol";

/// Random sequences of: direct pay, cross-chain commit, deposit, settle, refund, time travel.
contract VaultHandler is Test {
    IntentVault internal vault;
    MockStableToken internal usdc;
    address internal admin;
    bytes32 internal merchantId;
    uint32 internal keyVersion;
    uint256 internal signerPk;
    uint256 internal payerPk;
    address internal payer;

    bytes32[] public openCross;
    uint256 public ghostSettledAmountOut;
    uint256 public ghostIn; // everything that entered from payer/solver for settled or refunded intents
    uint256 public ghostOutToMerchantAndFee;
    uint256 public ghostRefunded;
    uint256 internal salt;

    constructor(
        IntentVault v,
        MockStableToken u,
        address admin_,
        bytes32 mId,
        uint32 kv,
        uint256 sPk,
        uint256 pPk
    ) {
        vault = v;
        usdc = u;
        admin = admin_;
        merchantId = mId;
        keyVersion = kv;
        signerPk = sPk;
        payerPk = pPk;
        payer = vm.addr(pPk);
    }

    function _sig(uint256 pk, bytes32 d) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d);
        return abi.encodePacked(r, s, v);
    }

    function _build(uint256 amount, uint8 route) internal returns (Invoice memory inv, PaymentIntent memory p) {
        salt++;
        inv = Invoice(merchantId, keccak256(abi.encode("h", salt)), address(usdc), amount, uint64(block.timestamp + 900), keyVersion);
        p = PaymentIntent(
            merchantId, inv.invoiceId, payer, address(usdc), amount, route, address(usdc), amount,
            route == ROUTE_DIRECT ? bytes32(0) : keccak256("q"), payer, uint64(block.timestamp + 600), salt, keyVersion
        );
    }

    function payDirect(uint256 amount) external {
        amount = bound(amount, 1, 50e6);
        (Invoice memory inv, PaymentIntent memory p) = _build(amount, ROUTE_DIRECT);
        vm.prank(admin);
        usdc.mint(payer, amount);
        bytes32 digest = vault.hashIntent(p);
        bytes32 rwa = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), payer, address(vault), amount, uint256(0), uint256(p.expiresAt), digest))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerPk, rwa);
        vault.payDirect(p, inv, _sig(signerPk, vault.hashInvoice(inv)), _sig(payerPk, digest), Auth3009(v, r, s));
        ghostSettledAmountOut += amount;
        ghostIn += amount;
        ghostOutToMerchantAndFee += amount;
    }

    function commit(uint256 amount) external {
        amount = bound(amount, 1, 50e6);
        (Invoice memory inv, PaymentIntent memory p) = _build(amount, ROUTE_CROSSCHAIN);
        (bytes32 id,) =
            vault.commitCrossChain(p, inv, _sig(signerPk, vault.hashInvoice(inv)), _sig(payerPk, vault.hashIntent(p)));
        openCross.push(id);
    }

    function deposit(uint256 idx, uint256 amount) external {
        if (openCross.length == 0) return;
        bytes32 id = openCross[idx % openCross.length];
        amount = bound(amount, 0, 60e6);
        vm.prank(admin);
        usdc.mint(vault.forwarderOf(id), amount);
    }

    function settle(uint256 idx) external {
        if (openCross.length == 0) return;
        uint256 i = idx % openCross.length;
        bytes32 id = openCross[i];
        IntentRecord memory r = vault.getIntent(id);
        uint256 bal = usdc.balanceOf(vault.forwarderOf(id));
        if (bal < r.inputAmount) return;
        vault.settleCrossChain(id, "");
        ghostSettledAmountOut += r.amountOut;
        ghostIn += bal;
        ghostOutToMerchantAndFee += r.amountOut;
        ghostRefunded += bal - r.amountOut;
        _remove(i);
    }

    function refund(uint256 idx) external {
        if (openCross.length == 0) return;
        uint256 i = idx % openCross.length;
        bytes32 id = openCross[i];
        IntentRecord memory r = vault.getIntent(id);
        uint256 allowedAt = uint256(r.expiresAt) + vault.refundDelay();
        if (block.timestamp < allowedAt) vm.warp(allowedAt);
        uint256 bal = usdc.balanceOf(vault.forwarderOf(id));
        vault.refundCrossChain(id);
        ghostIn += bal;
        ghostRefunded += bal;
        _remove(i);
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 300));
    }

    function _remove(uint256 i) internal {
        openCross[i] = openCross[openCross.length - 1];
        openCross.pop();
    }
}

contract InvariantTest is VaultBase {
    VaultHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new VaultHandler(
            vault, usdc, admin, merchantId, registry.getMerchant(merchantId).keyVersion, SIGNER_PK, PAYER_PK
        );
        // NOTE: hoist MINTER_ROLE() out of the grantRole() argument list. vm.prank applies to the NEXT
        // call only, and the inner usdc.MINTER_ROLE() view call would consume it, leaving grantRole to
        // run as the test contract (AccessControlUnauthorizedAccount).
        bytes32 minterRole = usdc.MINTER_ROLE();
        vm.prank(admin);
        usdc.grantRole(minterRole, address(handler));
        // handler mints through `admin` prank; MINTER also granted for safety
        targetContract(address(handler));
    }

    function invariant_vaultNeverHoldsFunds() public view {
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function invariant_conservation() public view {
        // everything in = merchant net + fees + refunds (to payer)
        assertEq(handler.ghostIn(), handler.ghostOutToMerchantAndFee() + handler.ghostRefunded());
    }

    function invariant_merchantPlusFeeEqualsSettled() public view {
        assertEq(usdc.balanceOf(payoutWallet) + usdc.balanceOf(feeRecipient), handler.ghostSettledAmountOut());
    }
}
