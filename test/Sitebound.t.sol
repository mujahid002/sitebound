// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {Sitebound, IERC20} from "../src/Sitebound.sol";
import {MockToken} from "./utils/MockToken.sol";
import {P256Verifier} from "./utils/P256Verifier.sol";

contract SiteboundTest is Test {
    Sitebound sb;
    MockToken usdt;

    string constant FRAME = "http://localhost:8002";
    string constant SHOP = "http://127.0.0.1:8001";
    string constant EVIL = "https://evil.example";
    uint64 constant DELAY = 1 hours;

    uint256 attestorKey = 0xA77E57;
    uint256 walletKey = 0xB0B;
    uint256 passkey = 0xC0FFEE;
    address wallet;
    address shopWallet = address(0x5409);
    address evilWallet = address(0xBAD);
    address relayer = address(0xFEE);
    bytes32 cred = keccak256("credential-id");
    uint256 px;
    uint256 py;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.etch(address(0x100), address(new P256Verifier()).code);
        usdt = new MockToken();
        address[] memory att = new address[](1);
        att[0] = vm.addr(attestorKey);
        sb = new Sitebound(IERC20(address(usdt)), FRAME, sha256("localhost"), att, DELAY);
        wallet = vm.addr(walletKey);
        (px, py) = vm.publicKeyP256(passkey);
        usdt.mint(wallet, 1000e6);
        vm.prank(wallet);
        usdt.approve(address(sb), type(uint256).max);
        _register(SHOP, shopWallet);
        _bind(walletKey, 50e6, 100e6, uint64(block.timestamp + 30 days));
    }

    // ------------------------------------------------------------- helpers

    function _domain() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Sitebound"),
                keccak256("1"),
                block.chainid,
                address(sb)
            )
        );
    }

    function _sign(uint256 key, bytes32 structHash) internal view returns (uint8, bytes32, bytes32) {
        return vm.sign(key, keccak256(abi.encodePacked("\x19\x01", _domain(), structHash)));
    }

    function _attest(string memory site, address payout, uint256 key, uint64 deadline) internal {
        bytes32 siteHash = keccak256(bytes(site));
        (, , , , uint256 nonce) = sb.sites(siteHash);
        bytes32 sh = keccak256(
            abi.encode(
                keccak256("Attest(bytes32 siteHash,address payout,uint256 nonce,uint64 deadline)"),
                siteHash,
                payout,
                nonce,
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = _sign(key, sh);
        sb.register(site, payout, deadline, vm.addr(attestorKey), v, r, s);
    }

    function _register(string memory site, address payout) internal {
        _attest(site, payout, attestorKey, uint64(block.timestamp + 1 days));
    }

    function _bindStruct(uint256 key, address w, uint256 perPay, uint256 total, uint64 expiry)
        internal
        view
        returns (uint8, bytes32, bytes32)
    {
        bytes32 sh = keccak256(
            abi.encode(
                keccak256(
                    "Bind(bytes32 credentialHash,uint256 pubX,uint256 pubY,uint256 perPayCap,uint256 totalCap,uint64 expiry,uint256 nonce)"
                ),
                cred,
                px,
                py,
                perPay,
                total,
                expiry,
                sb.bindNonce(w)
            )
        );
        return _sign(key, sh);
    }

    function _bind(uint256 key, uint256 perPay, uint256 total, uint64 expiry) internal {
        address w = vm.addr(key);
        (uint8 v, bytes32 r, bytes32 s) = _bindStruct(key, w, perPay, total, expiry);
        sb.bind(cred, px, py, perPay, total, expiry, w, v, r, s);
    }

    struct Opts {
        string typ;
        string origin;
        string top;
        bool crossOrigin;
        bool withTop;
        bytes32 orderId;
        uint256 amount;
        uint256 fee;
        uint256 deadline;
    }

    function _opts(bytes32 orderId) internal view returns (Opts memory o) {
        o = Opts("webauthn.get", FRAME, SHOP, true, true, orderId, 10e6, 0, block.timestamp + 10 minutes);
    }

    function _b64(bytes32 v) internal pure returns (string memory) {
        bytes memory b = bytes(vm.toBase64URL(abi.encodePacked(v)));
        while (b[b.length - 1] == "=") assembly { mstore(b, sub(mload(b), 1)) }
        return string(b);
    }

    function _find(bytes memory h, bytes memory n) internal pure returns (uint256) {
        for (uint256 i; i + n.length <= h.length; i++) {
            bool ok = true;
            for (uint256 j; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return i;
        }
        revert("needle not found");
    }

    /// Builds clientDataJSON and signs it with the passkey, like Chrome does for the frame.
    function _input(Opts memory o) internal view returns (Sitebound.PayInput memory p) {
        bytes32 challenge = keccak256(
            abi.encode(block.chainid, address(sb), keccak256(bytes(o.top)), o.orderId, o.amount, o.fee, o.deadline)
        );
        string memory json = string.concat(
            '{"type":"', o.typ, '","challenge":"', _b64(challenge), '","origin":"', o.origin, '","crossOrigin":',
            o.crossOrigin ? "true" : "false"
        );
        if (o.withTop) json = string.concat(json, ',"topOrigin":"', o.top, '"');
        json = string.concat(json, "}");
        bytes memory jb = bytes(json);

        bytes memory auth = abi.encodePacked(sha256("localhost"), bytes1(0x05), uint32(1));
        bytes32 digest = sha256(bytes.concat(auth, sha256(jb)));
        (bytes32 r, bytes32 s) = vm.signP256(passkey, digest);

        p.credentialHash = cred;
        p.authenticatorData = auth;
        p.clientDataJSON = json;
        p.typeIdx = _find(jb, '"type":');
        p.challengeIdx = _find(jb, '"challenge":');
        p.originIdx = _find(jb, '"origin":');
        p.crossOriginIdx = _find(jb, '"crossOrigin":');
        p.topOriginIdx = o.withTop ? _find(jb, '"topOrigin":') : 0;
        p.r = uint256(r);
        p.s = uint256(s);
        p.orderId = o.orderId;
        p.amount = o.amount;
        p.relayerFee = o.fee;
        p.deadline = o.deadline;
    }

    function _pay(Opts memory o) internal returns (bytes32) {
        return sb.pay(_input(o));
    }

    // --------------------------------------------------------------- pay

    function test_pay_reaches_registry_payout() public {
        bytes32 id = _pay(_opts("A1"));
        assertEq(usdt.balanceOf(shopWallet), 10e6);
        assertEq(usdt.balanceOf(wallet), 990e6);
        (address w,, uint256 amt,) = sb.payments(id);
        assertEq(w, wallet);
        assertEq(amt, 10e6);
    }

    function test_relayer_fee_goes_to_submitter() public {
        Opts memory o = _opts("A2");
        o.fee = 1e6;
        Sitebound.PayInput memory p = _input(o);
        vm.prank(relayer);
        sb.pay(p);
        assertEq(usdt.balanceOf(relayer), 1e6);
        assertEq(usdt.balanceOf(shopWallet), 10e6);
    }

    function test_hacked_page_cannot_redirect_payee() public {
        // A hacked shop page can only change what it signs for: a different topOrigin means a different
        // site's registry entry. The shop's payout stays untouched.
        _register(EVIL, evilWallet);
        Opts memory o = _opts("A3");
        o.top = EVIL;
        _pay(o);
        assertEq(usdt.balanceOf(evilWallet), 10e6);
        assertEq(usdt.balanceOf(shopWallet), 0);
    }

    function test_calldata_topOrigin_swap_after_signing_reverts() public {
        _register(EVIL, evilWallet);
        Sitebound.PayInput memory p = _input(_opts("A4"));
        p.clientDataJSON = string(bytes(p.clientDataJSON)); // same bytes
        bytes memory jb = bytes(p.clientDataJSON);
        string memory swapped = string.concat(
            string(_slice(jb, 0, p.topOriginIdx)), '"topOrigin":"', EVIL, '"}'
        );
        p.clientDataJSON = swapped;
        vm.expectRevert("bad challenge");
        sb.pay(p);
    }

    function _slice(bytes memory b, uint256 from, uint256 to) internal pure returns (bytes memory out) {
        out = new bytes(to - from);
        for (uint256 i; i < out.length; i++) out[i] = b[from + i];
    }

    function test_unregistered_site_reverts() public {
        Opts memory o = _opts("A5");
        o.top = "https://nobody.example";
        Sitebound.PayInput memory p = _input(o);
        vm.expectRevert("site not registered");
        sb.pay(p);
    }

    function test_wrong_origin_reverts() public {
        Opts memory o = _opts("B1");
        o.origin = "https://evil-frame.example";
        Sitebound.PayInput memory p = _input(o);
        vm.expectRevert("bad origin");
        sb.pay(p);
    }

    function test_origin_that_only_starts_like_the_frame_reverts() public {
        Opts memory o = _opts("B5");
        o.origin = string.concat(FRAME, ".evil.com");
        Sitebound.PayInput memory p = _input(o);
        vm.expectRevert("bad origin");
        sb.pay(p);
    }

    function test_key_not_after_brace_or_comma_reverts() public {
        Sitebound.PayInput memory p = _input(_opts("B6"));
        p.typeIdx = p.typeIdx + 1;
        vm.expectRevert("bad type");
        sb.pay(p);
    }

    function test_not_cross_origin_reverts() public {
        Opts memory o = _opts("B2");
        o.crossOrigin = false;
        Sitebound.PayInput memory p = _input(o);
        vm.expectRevert("not cross-origin");
        sb.pay(p);
    }

    function test_missing_topOrigin_reverts() public {
        Opts memory o = _opts("B3");
        o.withTop = false;
        Sitebound.PayInput memory p = _input(o);
        vm.expectRevert("no topOrigin");
        sb.pay(p);
    }

    function test_wrong_type_reverts() public {
        Opts memory o = _opts("B4");
        o.typ = "webauthn.create";
        Sitebound.PayInput memory p = _input(o);
        vm.expectRevert("bad type");
        sb.pay(p);
    }

    function test_order_replay_reverts() public {
        _pay(_opts("C1"));
        Sitebound.PayInput memory p = _input(_opts("C1"));
        vm.expectRevert("order used");
        sb.pay(p);
    }

    function test_expired_deadline_reverts() public {
        Opts memory o = _opts("C2");
        Sitebound.PayInput memory p = _input(o);
        vm.warp(o.deadline + 1);
        vm.expectRevert("deadline passed");
        sb.pay(p);
    }

    function test_over_per_pay_cap_reverts() public {
        Opts memory o = _opts("C3");
        o.amount = 50e6;
        o.fee = 1;
        Sitebound.PayInput memory p = _input(o);
        vm.expectRevert("over per-pay cap");
        sb.pay(p);
    }

    function test_over_total_cap_reverts() public {
        Opts memory o = _opts("C4");
        o.amount = 50e6;
        _pay(o);
        o = _opts("C5");
        o.amount = 50e6;
        _pay(o);
        Sitebound.PayInput memory p = _input(_opts("C6"));
        vm.expectRevert("over total cap");
        sb.pay(p);
    }

    function test_expired_binding_reverts() public {
        Sitebound.PayInput memory p = _input(_opts("C7"));
        vm.warp(block.timestamp + 31 days);
        vm.expectRevert("binding expired");
        sb.pay(p);
    }

    function test_tampered_amount_reverts() public {
        Sitebound.PayInput memory p = _input(_opts("C8"));
        p.amount = 11e6;
        vm.expectRevert("bad challenge");
        sb.pay(p);
    }

    function test_signature_from_other_passkey_reverts() public {
        Opts memory o = _opts("C9");
        Sitebound.PayInput memory p = _input(o);
        bytes32 digest = sha256(bytes.concat(p.authenticatorData, sha256(bytes(p.clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(0xDEAD, digest);
        p.r = uint256(r);
        p.s = uint256(s);
        vm.expectRevert("bad passkey signature");
        sb.pay(p);
    }

    function test_missing_user_verification_reverts() public {
        Sitebound.PayInput memory p = _input(_opts("C10"));
        p.authenticatorData = abi.encodePacked(sha256("localhost"), bytes1(0x01), uint32(1));
        vm.expectRevert("need UP and UV");
        sb.pay(p);
    }

    function test_wrong_rpId_reverts() public {
        Sitebound.PayInput memory p = _input(_opts("C11"));
        p.authenticatorData = abi.encodePacked(sha256("other"), bytes1(0x05), uint32(1));
        vm.expectRevert("bad rpId");
        sb.pay(p);
    }

    // ------------------------------------------------------------ binding

    function test_bind_without_wallet_signature_reverts() public {
        vm.prank(address(0xA11));
        (uint8 v, bytes32 r, bytes32 s) = _bindStruct(0xBAD1, wallet, 5e6, 5e6, uint64(block.timestamp + 1 days));
        vm.expectRevert("bad binding signature");
        sb.bind(cred, px, py, 5e6, 5e6, uint64(block.timestamp + 1 days), wallet, v, r, s);
    }

    function test_other_wallet_cannot_take_bound_credential() public {
        uint256 otherKey = 0x0711;
        address other = vm.addr(otherKey);
        (uint8 v, bytes32 r, bytes32 s) = _bindStruct(otherKey, other, 5e6, 5e6, uint64(block.timestamp + 1 days));
        vm.expectRevert("credential taken");
        sb.bind(cred, px, py, 5e6, 5e6, uint64(block.timestamp + 1 days), other, v, r, s);
    }

    function test_binding_signature_cannot_be_replayed() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        (uint8 v, bytes32 r, bytes32 s) = _bindStruct(walletKey, wallet, 5e6, 5e6, expiry);
        sb.bind(cred, px, py, 5e6, 5e6, expiry, wallet, v, r, s);
        vm.expectRevert("bad binding signature");
        sb.bind(cred, px, py, 5e6, 5e6, expiry, wallet, v, r, s);
    }

    function test_unbind_stops_payments() public {
        Sitebound.PayInput memory p = _input(_opts("D1"));
        vm.prank(wallet);
        sb.unbind(cred);
        vm.expectRevert("not bound");
        sb.pay(p);
    }

    function test_old_binding_signature_cannot_revive_after_unbind() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        (uint8 v, bytes32 r, bytes32 s) = _bindStruct(walletKey, wallet, 5e6, 5e6, expiry);
        sb.bind(cred, px, py, 5e6, 5e6, expiry, wallet, v, r, s);
        vm.prank(wallet);
        sb.unbind(cred);
        vm.expectRevert("bad binding signature");
        sb.bind(cred, px, py, 5e6, 5e6, expiry, wallet, v, r, s);
    }

    function test_only_wallet_can_unbind() public {
        vm.expectRevert("not wallet");
        sb.unbind(cred);
    }

    // ----------------------------------------------------------- registry

    function test_register_needs_attestor() public {
        bytes32 siteHash = keccak256(bytes(EVIL));
        bytes32 sh = keccak256(
            abi.encode(
                keccak256("Attest(bytes32 siteHash,address payout,uint256 nonce,uint64 deadline)"),
                siteHash, evilWallet, uint256(0), uint64(block.timestamp + 1 days)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = _sign(0x1337, sh);
        vm.expectRevert("not attestor");
        sb.register(EVIL, evilWallet, uint64(block.timestamp + 1 days), vm.addr(0x1337), v, r, s);
        vm.expectRevert("bad attestation");
        sb.register(EVIL, evilWallet, uint64(block.timestamp + 1 days), vm.addr(attestorKey), v, r, s);
    }

    function test_payout_change_waits_for_delay() public {
        address newWallet = address(0x2222);
        _register(SHOP, newWallet);
        _pay(_opts("E1"));
        assertEq(usdt.balanceOf(shopWallet), 10e6);
        assertEq(usdt.balanceOf(newWallet), 0);
        vm.warp(block.timestamp + DELAY);
        Opts memory o = _opts("E2");
        _pay(o);
        assertEq(usdt.balanceOf(newWallet), 10e6);
    }

    function test_freeze_blocks_payments_and_pending_change() public {
        _register(SHOP, address(0x2222));
        vm.prank(shopWallet);
        sb.freeze(keccak256(bytes(SHOP)));
        Opts memory o3 = _opts("E3");
        o3.deadline = block.timestamp + 2 days;
        Sitebound.PayInput memory p = _input(o3);
        vm.expectRevert("frozen");
        sb.pay(p);
        vm.warp(block.timestamp + DELAY + 1);
        vm.expectRevert("frozen");
        sb.pay(p);
        vm.prank(shopWallet);
        sb.unfreeze(keccak256(bytes(SHOP)));
        sb.pay(p);
        assertEq(usdt.balanceOf(shopWallet), 10e6);
    }

    function test_new_attestation_while_frozen_reverts() public {
        vm.prank(shopWallet);
        sb.freeze(keccak256(bytes(SHOP)));
        bytes32 siteHash = keccak256(bytes(SHOP));
        (, , , , uint256 nonce) = sb.sites(siteHash);
        uint64 dl = uint64(block.timestamp + 1 days);
        bytes32 sh = keccak256(
            abi.encode(keccak256("Attest(bytes32 siteHash,address payout,uint256 nonce,uint64 deadline)"), siteHash, evilWallet, nonce, dl)
        );
        (uint8 v, bytes32 r, bytes32 s) = _sign(attestorKey, sh);
        vm.expectRevert("frozen");
        sb.register(SHOP, evilWallet, dl, vm.addr(attestorKey), v, r, s);
    }

    function test_only_payout_can_freeze() public {
        vm.expectRevert("not payout");
        sb.freeze(keccak256(bytes(SHOP)));
    }

    // ------------------------------------------------------------- refund

    function test_refund_goes_to_payer_and_is_capped() public {
        bytes32 id = _pay(_opts("F1"));
        vm.prank(shopWallet);
        usdt.approve(address(sb), type(uint256).max);
        vm.prank(shopWallet);
        sb.refund(id, 4e6);
        assertEq(usdt.balanceOf(wallet), 994e6);
        vm.prank(shopWallet);
        vm.expectRevert("over refund");
        sb.refund(id, 7e6);
        vm.prank(shopWallet);
        sb.refund(id, 6e6);
        assertEq(usdt.balanceOf(wallet), 1000e6);
    }

    function test_refund_only_by_payout() public {
        bytes32 id = _pay(_opts("F2"));
        vm.expectRevert("not payout");
        sb.refund(id, 1e6);
    }

    function test_contract_holds_no_funds() public {
        _pay(_opts("F3"));
        assertEq(usdt.balanceOf(address(sb)), 0);
    }
}
