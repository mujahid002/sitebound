// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {SiteboundV2, IERC20} from "../src/SiteboundV2.sol";
import {MockToken} from "./utils/MockToken.sol";
import {P256Verifier} from "./utils/P256Verifier.sol";

contract SiteboundV2Test is Test {
    SiteboundV2 sb;
    MockToken usdt;

    string constant FRAME = "http://localhost:8002";
    string constant SHOP = "http://127.0.0.1:8001";
    string constant EVIL = "https://evil.example";
    uint64 constant DELAY = 1 hours;
    address constant GUARDIAN = address(0x6A4D);
    bytes32 constant ATTEST =
        keccak256("Attest(bytes32 siteHash,address[] to,uint16[] bps,uint256 nonce,uint256 setId,uint64 deadline)");
    bytes32 constant ROTATE = keccak256("Rotate(address[] attestors,uint256 threshold,uint256 setId,uint64 deadline)");

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
    bytes32 rp = sha256("localhost"); // a precompile call: kept out of _deploy so expectRevert sees the constructor

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.etch(address(0x100), address(new P256Verifier()).code);
        usdt = new MockToken();
        sb = _deploy(_one(vm.addr(attestorKey)), 1);
        wallet = vm.addr(walletKey);
        (px, py) = vm.publicKeyP256(passkey);
        usdt.mint(wallet, 1000e6);
        vm.prank(wallet);
        usdt.approve(address(sb), type(uint256).max);
        _register(SHOP, shopWallet);
        _bind(walletKey, 50e6, 100e6, uint64(block.timestamp + 30 days));
    }

    // ------------------------------------------------------------- helpers

    function _deploy(address[] memory att, uint256 k) internal returns (SiteboundV2) {
        return new SiteboundV2(IERC20(address(usdt)), FRAME, rp, att, k, DELAY, GUARDIAN);
    }

    function _one(address a) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = a;
    }

    /// Keys sorted by their address, as the contract wants signers.
    function _byAddr(uint256[] memory keys) internal pure returns (uint256[] memory) {
        for (uint256 i; i < keys.length; i++) {
            for (uint256 j = i + 1; j < keys.length; j++) {
                if (vm.addr(keys[j]) < vm.addr(keys[i])) (keys[i], keys[j]) = (keys[j], keys[i]);
            }
        }
        return keys;
    }

    function _addrs(uint256[] memory keys) internal pure returns (address[] memory a) {
        a = new address[](keys.length);
        for (uint256 i; i < keys.length; i++) a[i] = vm.addr(keys[i]);
    }

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

    function _sig(uint256 key, bytes memory head, uint64 deadline) internal view returns (SiteboundV2.Sig memory) {
        (uint8 v, bytes32 r, bytes32 s) = _sign(key, keccak256(bytes.concat(head, abi.encode(deadline))));
        return SiteboundV2.Sig(deadline, v, r, s);
    }

    /// One signature per key, in the order given, all with the same deadline.
    function _sigs(uint256[] memory keys, bytes memory head, uint64 deadline)
        internal
        view
        returns (SiteboundV2.Sig[] memory out)
    {
        out = new SiteboundV2.Sig[](keys.length);
        for (uint256 i; i < keys.length; i++) out[i] = _sig(keys[i], head, deadline);
    }

    function _keys(uint256 a) internal pure returns (uint256[] memory k) {
        k = new uint256[](1);
        k[0] = a;
    }

    function _keys(uint256 a, uint256 b) internal pure returns (uint256[] memory k) {
        k = new uint256[](2);
        (k[0], k[1]) = (a, b);
    }

    function _full() internal pure returns (uint16[] memory b) {
        b = new uint16[](1);
        b[0] = 10_000;
    }

    function _attestHeadSplit(string memory site, address[] memory to, uint16[] memory bps)
        internal
        view
        returns (bytes memory)
    {
        bytes32 siteHash = keccak256(bytes(site));
        (,,,, uint256 nonce) = sb.sites(siteHash);
        (uint256 setId,) = sb.quorum();
        return abi.encode(
            ATTEST, siteHash, keccak256(abi.encodePacked(to)), keccak256(abi.encodePacked(bps)), nonce, setId
        );
    }

    function _attestHead(string memory site, address payout) internal view returns (bytes memory) {
        return _attestHeadSplit(site, _one(payout), _full());
    }

    /// register() for a single payout wallet.
    function _reg(string memory site, address payout, SiteboundV2.Sig[] memory sigs) internal {
        sb.register(site, _one(payout), _full(), sigs);
    }

    function _registerWith(uint256[] memory keys, string memory site, address payout) internal {
        _reg(site, payout, _sigs(keys, _attestHead(site, payout), uint64(block.timestamp + 1 days)));
    }

    function _registerSplit(string memory site, address[] memory to, uint16[] memory bps) internal {
        sb.register(site, to, bps, _sigs(_keys(attestorKey), _attestHeadSplit(site, to, bps), uint64(block.timestamp + 1 days)));
    }

    function _register(string memory site, address payout) internal {
        _registerWith(_keys(attestorKey), site, payout);
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
    function _input(Opts memory o) internal view returns (SiteboundV2.PayInput memory p) {
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

    // ------------------------------------------- real browser assertion

    /// Replays an assertion captured from Chromium inside a cross-origin iframe (test/fixtures).
    function test_replays_real_browser_assertion() public {
        string memory j = vm.readFile("test/fixtures/frame_assertion.json");
        address at = vm.parseJsonAddress(j, ".contract");
        vm.chainId(vm.parseJsonUint(j, ".chainId"));
        deployCodeTo(
            "SiteboundV2.sol:SiteboundV2",
            abi.encode(
                address(usdt),
                vm.parseJsonString(j, ".frameOrigin"),
                sha256(bytes(vm.parseJsonString(j, ".rpId"))),
                _one(vm.addr(attestorKey)),
                uint256(1),
                DELAY,
                GUARDIAN
            ),
            at
        );
        sb = SiteboundV2(at);
        vm.prank(wallet);
        usdt.approve(at, type(uint256).max);

        string memory top = vm.parseJsonString(j, ".topOrigin");
        _register(top, shopWallet);
        cred = keccak256(vm.parseJsonBytes(j, ".credId"));
        px = vm.parseJsonUint(j, ".pubX");
        py = vm.parseJsonUint(j, ".pubY");
        _bind(walletKey, 50e6, 100e6, uint64(block.timestamp + 30 days));

        string memory cd = vm.parseJsonString(j, ".clientDataJSON");
        bytes memory jb = bytes(cd);
        SiteboundV2.PayInput memory p;
        p.credentialHash = cred;
        p.authenticatorData = vm.parseJsonBytes(j, ".authenticatorData");
        p.clientDataJSON = cd;
        p.typeIdx = _find(jb, '"type":');
        p.challengeIdx = _find(jb, '"challenge":');
        p.originIdx = _find(jb, '"origin":');
        p.crossOriginIdx = _find(jb, '"crossOrigin":');
        p.topOriginIdx = _find(jb, '"topOrigin":');
        p.r = vm.parseJsonUint(j, ".r");
        p.s = vm.parseJsonUint(j, ".s");
        p.orderId = vm.parseJsonBytes32(j, ".orderId");
        p.amount = vm.parseJsonUint(j, ".amount");
        p.relayerFee = vm.parseJsonUint(j, ".relayerFee");
        p.deadline = vm.parseJsonUint(j, ".deadline");
        sb.pay(p);
        assertEq(usdt.balanceOf(shopWallet), 12e6);

        // the same assertion cannot pay twice, and changing one signed field breaks it
        vm.expectRevert("order used");
        sb.pay(p);
        p.orderId = bytes32(uint256(p.orderId) + 1);
        vm.expectRevert("bad challenge");
        sb.pay(p);
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
        SiteboundV2.PayInput memory p = _input(o);
        vm.prank(relayer);
        sb.pay(p);
        assertEq(usdt.balanceOf(relayer), 1e6);
        assertEq(usdt.balanceOf(shopWallet), 10e6);
    }

    function test_hacked_page_cannot_redirect_payee() public {
        // A hacked page can only change what it signs for: a different topOrigin means a different
        // site's registry entry. The real site's payout stays untouched.
        _register(EVIL, evilWallet);
        Opts memory o = _opts("A3");
        o.top = EVIL;
        _pay(o);
        assertEq(usdt.balanceOf(evilWallet), 10e6);
        assertEq(usdt.balanceOf(shopWallet), 0);
    }

    function test_calldata_topOrigin_swap_after_signing_reverts() public {
        _register(EVIL, evilWallet);
        SiteboundV2.PayInput memory p = _input(_opts("A4"));
        bytes memory jb = bytes(p.clientDataJSON);
        p.clientDataJSON = string.concat(string(_slice(jb, 0, p.topOriginIdx)), '"topOrigin":"', EVIL, '"}');
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
        SiteboundV2.PayInput memory p = _input(o);
        vm.expectRevert("site not registered");
        sb.pay(p);
    }

    function test_zero_amount_reverts() public {
        Opts memory o = _opts("B0");
        o.amount = 0;
        SiteboundV2.PayInput memory p = _input(o);
        vm.expectRevert("zero amount");
        sb.pay(p);
    }

    function test_token_without_code_reverts_at_deploy() public {
        address[] memory att = _one(vm.addr(attestorKey));
        bytes32 rp = sha256("localhost");
        vm.expectRevert("token has no code");
        new SiteboundV2(IERC20(address(0xdead)), FRAME, rp, att, 1, DELAY, GUARDIAN);
    }

    function test_wrong_origin_reverts() public {
        Opts memory o = _opts("B1");
        o.origin = "https://evil-frame.example";
        SiteboundV2.PayInput memory p = _input(o);
        vm.expectRevert("bad origin");
        sb.pay(p);
    }

    function test_origin_that_only_starts_like_the_frame_reverts() public {
        Opts memory o = _opts("B5");
        o.origin = string.concat(FRAME, ".evil.com");
        SiteboundV2.PayInput memory p = _input(o);
        vm.expectRevert("bad origin");
        sb.pay(p);
    }

    function test_key_not_after_brace_or_comma_reverts() public {
        SiteboundV2.PayInput memory p = _input(_opts("B6"));
        p.typeIdx = p.typeIdx + 1;
        vm.expectRevert("bad type");
        sb.pay(p);
    }

    function test_not_cross_origin_reverts() public {
        Opts memory o = _opts("B2");
        o.crossOrigin = false;
        SiteboundV2.PayInput memory p = _input(o);
        vm.expectRevert("not cross-origin");
        sb.pay(p);
    }

    function test_missing_topOrigin_reverts() public {
        Opts memory o = _opts("B3");
        o.withTop = false;
        SiteboundV2.PayInput memory p = _input(o);
        vm.expectRevert("no topOrigin");
        sb.pay(p);
    }

    function test_wrong_type_reverts() public {
        Opts memory o = _opts("B4");
        o.typ = "webauthn.create";
        SiteboundV2.PayInput memory p = _input(o);
        vm.expectRevert("bad type");
        sb.pay(p);
    }

    function test_order_replay_reverts() public {
        _pay(_opts("C1"));
        SiteboundV2.PayInput memory p = _input(_opts("C1"));
        vm.expectRevert("order used");
        sb.pay(p);
    }

    function test_expired_deadline_reverts() public {
        Opts memory o = _opts("C2");
        SiteboundV2.PayInput memory p = _input(o);
        vm.warp(o.deadline + 1);
        vm.expectRevert("deadline passed");
        sb.pay(p);
    }

    function test_over_per_pay_cap_reverts() public {
        Opts memory o = _opts("C3");
        o.amount = 50e6;
        o.fee = 1;
        SiteboundV2.PayInput memory p = _input(o);
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
        SiteboundV2.PayInput memory p = _input(_opts("C6"));
        vm.expectRevert("over total cap");
        sb.pay(p);
    }

    function test_expired_binding_reverts() public {
        SiteboundV2.PayInput memory p = _input(_opts("C7"));
        vm.warp(block.timestamp + 31 days);
        vm.expectRevert("binding expired");
        sb.pay(p);
    }

    function test_tampered_amount_reverts() public {
        SiteboundV2.PayInput memory p = _input(_opts("C8"));
        p.amount = 11e6;
        vm.expectRevert("bad challenge");
        sb.pay(p);
    }

    function test_signature_from_other_passkey_reverts() public {
        SiteboundV2.PayInput memory p = _input(_opts("C9"));
        bytes32 digest = sha256(bytes.concat(p.authenticatorData, sha256(bytes(p.clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(0xDEAD, digest);
        p.r = uint256(r);
        p.s = uint256(s);
        vm.expectRevert("bad passkey signature");
        sb.pay(p);
    }

    function test_missing_user_verification_reverts() public {
        SiteboundV2.PayInput memory p = _input(_opts("C10"));
        p.authenticatorData = abi.encodePacked(sha256("localhost"), bytes1(0x01), uint32(1));
        vm.expectRevert("need UP and UV");
        sb.pay(p);
    }

    function test_wrong_rpId_reverts() public {
        SiteboundV2.PayInput memory p = _input(_opts("C11"));
        p.authenticatorData = abi.encodePacked(sha256("other"), bytes1(0x05), uint32(1));
        vm.expectRevert("bad rpId");
        sb.pay(p);
    }

    function test_relayer_fee_is_capped_on_chain() public {
        Opts memory o = _opts("K1");
        o.fee = sb.MAX_RELAYER_FEE();
        SiteboundV2.PayInput memory p = _input(o);
        vm.prank(relayer);
        sb.pay(p);
        assertEq(usdt.balanceOf(relayer), 1e6);
        o = _opts("K2");
        o.fee = 1e6 + 1; // signed by the buyer and within the caps, but over the contract's cap
        p = _input(o);
        vm.expectRevert("fee over cap");
        sb.pay(p);
    }

    function test_guardian_pause_stops_only_new_payments() public {
        bytes32 id = _pay(_opts("P1"));
        bytes32 siteHash = keccak256(bytes(SHOP));
        vm.expectRevert("not guardian");
        sb.setPaused(true);
        vm.prank(GUARDIAN);
        sb.setPaused(true);
        SiteboundV2.PayInput memory p = _input(_opts("P2"));
        vm.expectRevert("paused");
        sb.pay(p);
        // everything else still works while paused
        _approve(shopWallet);
        vm.prank(shopWallet);
        sb.refund(id, 1e6);
        _register(EVIL, evilWallet);
        _register(SHOP, address(0x2222));
        vm.prank(shopWallet);
        sb.setRefundOperator(siteHash, address(0x0FF1CE));
        vm.prank(shopWallet);
        sb.freeze(siteHash);
        vm.prank(shopWallet);
        sb.unfreeze(siteHash);
        vm.prank(wallet);
        sb.unbind(cred);
        _bind(walletKey, 50e6, 100e6, uint64(block.timestamp + 30 days));
        vm.prank(GUARDIAN);
        sb.setPaused(false);
        sb.pay(_input(_opts("P2")));
    }

    function test_no_guardian_means_no_pause() public {
        sb = new SiteboundV2(IERC20(address(usdt)), FRAME, rp, _one(vm.addr(attestorKey)), 1, DELAY, address(0));
        vm.prank(address(0x6A4D));
        vm.expectRevert("not guardian");
        sb.setPaused(true);
    }

    // ------------------------------------------------------------ binding

    function test_bind_without_wallet_signature_reverts() public {
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
        SiteboundV2.PayInput memory p = _input(_opts("D1"));
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

    function test_same_passkey_cannot_be_bound_to_a_second_wallet() public {
        uint256 otherKey = 0x0711;
        address other = vm.addr(otherKey);
        bytes32 cred2 = keccak256("another-credential-id");
        uint64 expiry = uint64(block.timestamp + 1 days);
        bytes32 sh = keccak256(
            abi.encode(
                keccak256(
                    "Bind(bytes32 credentialHash,uint256 pubX,uint256 pubY,uint256 perPayCap,uint256 totalCap,uint64 expiry,uint256 nonce)"
                ),
                cred2, px, py, uint256(5e6), uint256(5e6), expiry, sb.bindNonce(other)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = _sign(otherKey, sh);
        vm.expectRevert("pubkey taken");
        sb.bind(cred2, px, py, 5e6, 5e6, expiry, other, v, r, s);

        vm.prank(wallet);
        sb.unbind(cred);
        sb.bind(cred2, px, py, 5e6, 5e6, expiry, other, v, r, s);
    }

    function test_only_wallet_can_unbind() public {
        vm.expectRevert("not wallet");
        sb.unbind(cred);
    }

    // ----------------------------------------------------------- registry

    function test_register_needs_attestor() public {
        bytes memory head = _attestHead(EVIL, evilWallet);
        SiteboundV2.Sig[] memory sigs = _sigs(_keys(0x1337), head, uint64(block.timestamp + 1 days));
        vm.expectRevert("not attestor");
        _reg(EVIL, evilWallet, sigs);
        vm.expectRevert("too few attestations");
        _reg(EVIL, evilWallet, new SiteboundV2.Sig[](0));
    }

    function test_attestation_for_other_payout_reverts() public {
        // signed for evilWallet, submitted for another payout: recovers some other address
        SiteboundV2.Sig[] memory sigs = _sigs(_keys(attestorKey), _attestHead(EVIL, evilWallet), uint64(block.timestamp + 1 days));
        vm.expectRevert("not attestor");
        _reg(EVIL, address(0x2222), sigs);
    }

    function test_expired_attestation_reverts() public {
        SiteboundV2.Sig[] memory sigs = _sigs(_keys(attestorKey), _attestHead(EVIL, evilWallet), uint64(block.timestamp + 1));
        vm.warp(block.timestamp + 2);
        vm.expectRevert("attestation expired");
        _reg(EVIL, evilWallet, sigs);
    }

    function test_used_attestation_cannot_be_replayed() public {
        SiteboundV2.Sig[] memory sigs = _sigs(_keys(attestorKey), _attestHead(EVIL, evilWallet), uint64(block.timestamp + 1 days));
        _reg(EVIL, evilWallet, sigs);
        vm.expectRevert("not attestor"); // the site nonce moved, so the old signature recovers another address
        _reg(EVIL, evilWallet, sigs);
    }

    function test_unused_attestation_dies_when_site_nonce_moves() public {
        bytes memory head = _attestHead(SHOP, address(0x3333));
        SiteboundV2.Sig[] memory stale = _sigs(_keys(attestorKey), head, uint64(block.timestamp + 1 days));
        _register(SHOP, address(0x2222)); // any later registration of the site bumps its nonce
        vm.expectRevert("not attestor");
        _reg(SHOP, address(0x3333), stale);
    }

    function test_payout_change_waits_for_delay() public {
        address newWallet = address(0x2222);
        _register(SHOP, newWallet);
        _pay(_opts("E1"));
        assertEq(usdt.balanceOf(shopWallet), 10e6);
        assertEq(usdt.balanceOf(newWallet), 0);
        vm.warp(block.timestamp + DELAY);
        _pay(_opts("E2"));
        assertEq(usdt.balanceOf(newWallet), 10e6);
    }

    function test_freeze_blocks_payments_and_pending_change() public {
        _register(SHOP, address(0x2222));
        vm.prank(shopWallet);
        sb.freeze(keccak256(bytes(SHOP)));
        Opts memory o3 = _opts("E3");
        o3.deadline = block.timestamp + 2 days;
        SiteboundV2.PayInput memory p = _input(o3);
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
        SiteboundV2.Sig[] memory sigs = _sigs(_keys(attestorKey), _attestHead(SHOP, evilWallet), uint64(block.timestamp + 1 days));
        vm.expectRevert("frozen");
        _reg(SHOP, evilWallet, sigs);
    }

    function test_only_payout_can_freeze() public {
        vm.expectRevert("not payout");
        sb.freeze(keccak256(bytes(SHOP)));
    }

    // ------------------------------------------------- threshold attestors

    function _twoOfThree() internal returns (uint256[] memory keys) {
        keys = new uint256[](3);
        (keys[0], keys[1], keys[2]) = (0xA1, 0xA2, 0xA3);
        keys = _byAddr(keys);
        sb = _deploy(_addrs(keys), 2);
    }

    function test_two_of_three_registers_with_two_distinct_attestors() public {
        uint256[] memory k = _twoOfThree();
        _registerWith(_keys(k[0], k[2]), EVIL, evilWallet);
        (address payout,,,,) = sb.sites(keccak256(bytes(EVIL)));
        assertEq(payout, evilWallet);
        (uint256 setId, uint256 threshold) = sb.quorum();
        assertEq(setId, 1);
        assertEq(threshold, 2);
    }

    function test_two_of_three_rejects_one_signature() public {
        uint256[] memory k = _twoOfThree();
        SiteboundV2.Sig[] memory sigs = _sigs(_keys(k[1]), _attestHead(EVIL, evilWallet), uint64(block.timestamp + 1 days));
        vm.expectRevert("too few attestations");
        _reg(EVIL, evilWallet, sigs);
    }

    function test_two_of_three_rejects_the_same_attestor_twice() public {
        uint256[] memory k = _twoOfThree();
        SiteboundV2.Sig[] memory sigs = _sigs(_keys(k[1], k[1]), _attestHead(EVIL, evilWallet), uint64(block.timestamp + 1 days));
        vm.expectRevert("attestors not sorted");
        _reg(EVIL, evilWallet, sigs);
    }

    function test_two_of_three_rejects_unsorted_signers() public {
        uint256[] memory k = _twoOfThree();
        SiteboundV2.Sig[] memory sigs = _sigs(_keys(k[2], k[0]), _attestHead(EVIL, evilWallet), uint64(block.timestamp + 1 days));
        vm.expectRevert("attestors not sorted");
        _reg(EVIL, evilWallet, sigs);
    }

    function test_two_of_three_rejects_an_outsider_as_second_signer() public {
        uint256[] memory k = _twoOfThree();
        uint256[] memory keys = _byAddr(_keys(k[0], 0x1337));
        SiteboundV2.Sig[] memory sigs = _sigs(keys, _attestHead(EVIL, evilWallet), uint64(block.timestamp + 1 days));
        vm.expectRevert("not attestor");
        _reg(EVIL, evilWallet, sigs);
    }

    function test_two_of_three_each_signature_has_its_own_deadline() public {
        uint256[] memory k = _twoOfThree();
        bytes memory head = _attestHead(EVIL, evilWallet);
        SiteboundV2.Sig[] memory sigs = new SiteboundV2.Sig[](2);
        sigs[0] = _sig(k[0], head, uint64(block.timestamp + 1 days));
        sigs[1] = _sig(k[1], head, uint64(block.timestamp + 10));
        vm.warp(block.timestamp + 11);
        vm.expectRevert("attestation expired");
        _reg(EVIL, evilWallet, sigs);
        sigs[1] = _sig(k[1], head, uint64(block.timestamp + 10));
        _reg(EVIL, evilWallet, sigs);
    }

    function test_constructor_rejects_bad_threshold_and_unsorted_set() public {
        uint256[] memory keys = _byAddr(_keys(0xA1, 0xA2));
        address[] memory sorted = _addrs(keys);
        vm.expectRevert("bad threshold");
        _deploy(sorted, 0);
        vm.expectRevert("bad threshold");
        _deploy(sorted, 3);
        address[] memory unsorted = new address[](2);
        (unsorted[0], unsorted[1]) = (sorted[1], sorted[0]);
        vm.expectRevert("attestors not sorted");
        _deploy(unsorted, 1);
        address[] memory dup = new address[](2);
        (dup[0], dup[1]) = (sorted[0], sorted[0]);
        vm.expectRevert("attestors not sorted");
        _deploy(dup, 1);
    }

    // ------------------------------------------------------ attestor rotation

    function _rotateHead(address[] memory set, uint256 k) internal view returns (bytes memory) {
        return abi.encode(ROTATE, keccak256(abi.encodePacked(set)), k, sb.setCount() + 1);
    }

    function _propose(uint256[] memory signers, address[] memory set, uint256 k) internal {
        sb.proposeAttestors(set, k, _sigs(signers, _rotateHead(set, k), uint64(block.timestamp + 1 days)));
    }

    function test_rotation_by_quorum_takes_effect_after_delay() public {
        uint256[] memory next = _byAddr(_keys(0xD4, 0xE5));
        _propose(_keys(attestorKey), _addrs(next), 1);

        // before the delay the old set still attests and the new one does not
        assertTrue(sb.isAttestor(vm.addr(attestorKey)));
        assertFalse(sb.isAttestor(vm.addr(0xD4)));
        SiteboundV2.Sig[] memory early = _sigs(_keys(0xD4), _attestHead(EVIL, evilWallet), uint64(block.timestamp + 2 days));
        vm.expectRevert("not attestor");
        _reg(EVIL, evilWallet, early);

        vm.warp(block.timestamp + DELAY);
        assertTrue(sb.isAttestor(vm.addr(0xD4)));
        assertFalse(sb.isAttestor(vm.addr(attestorKey)));
        (uint256 setId,) = sb.quorum();
        assertEq(setId, 2);
        vm.expectRevert("not attestor"); // `early` named set 1
        _reg(EVIL, evilWallet, early);
        _registerWith(_keys(0xD4), EVIL, evilWallet);
        SiteboundV2.Sig[] memory old = _sigs(_keys(attestorKey), _attestHead(SHOP, evilWallet), uint64(block.timestamp + 1 days));
        vm.expectRevert("not attestor");
        _reg(SHOP, evilWallet, old);
    }

    function test_rotation_needs_the_current_quorum() public {
        uint256[] memory k = _twoOfThree();
        address[] memory set = _addrs(_keys(0xD4));
        bytes memory head = _rotateHead(set, 1);
        SiteboundV2.Sig[] memory one = _sigs(_keys(k[0]), head, uint64(block.timestamp + 1 days));
        vm.expectRevert("too few attestations");
        sb.proposeAttestors(set, 1, one);
        SiteboundV2.Sig[] memory outsider = _sigs(_byAddr(_keys(k[0], 0x1337)), head, uint64(block.timestamp + 1 days));
        vm.expectRevert("not attestor");
        sb.proposeAttestors(set, 1, outsider);
        sb.proposeAttestors(set, 1, _sigs(_keys(k[0], k[1]), head, uint64(block.timestamp + 1 days)));
        (uint256 setId, uint256 threshold, uint64 activeAt) = sb.pendingAttestors();
        assertEq(setId, 2);
        assertEq(threshold, 1);
        assertEq(activeAt, block.timestamp + DELAY);
    }

    function test_rotation_signature_cannot_be_replayed_after_a_newer_proposal() public {
        address[] memory a = _addrs(_keys(0xD4));
        address[] memory b = _addrs(_keys(0xE5));
        SiteboundV2.Sig[] memory first = _sigs(_keys(attestorKey), _rotateHead(a, 1), uint64(block.timestamp + 1 days));
        sb.proposeAttestors(a, 1, first);
        _propose(_keys(attestorKey), b, 1); // replaces the pending proposal
        vm.expectRevert("not attestor"); // `first` named set id 2, the next id is now 4
        sb.proposeAttestors(a, 1, first);
        vm.warp(block.timestamp + DELAY);
        assertTrue(sb.isAttestor(vm.addr(0xE5)));
        assertFalse(sb.isAttestor(vm.addr(0xD4)));
    }

    function test_rotation_rejects_bad_threshold() public {
        address[] memory set = _addrs(_keys(0xD4));
        SiteboundV2.Sig[] memory sigs = _sigs(_keys(attestorKey), _rotateHead(set, 2), uint64(block.timestamp + 1 days));
        vm.expectRevert("bad threshold");
        sb.proposeAttestors(set, 2, sigs);
    }

    /// The Rotate signature below was made by ethers v6 `signTypedData` (worker/node_modules), for
    /// chain 31337 and the contract at 0x…5b7e02, so this checks the contract's EIP-712 array encoding.
    function test_rotate_signature_from_ethers_is_accepted() public {
        address at = 0x00000000000000000000000000000000005B7e02;
        deployCodeTo(
            "SiteboundV2.sol:SiteboundV2",
            abi.encode(address(usdt), FRAME, sha256("localhost"), _one(0x501D9b198010BC786D8b0DAc53ac700c8ACdc02d), uint256(1), DELAY, GUARDIAN),
            at
        );
        sb = SiteboundV2(at);
        assertEq(vm.addr(attestorKey), 0x501D9b198010BC786D8b0DAc53ac700c8ACdc02d);
        address[] memory set = new address[](2);
        set[0] = 0x26324733d604aBb6176cF18e4f4a0624CeedDC09;
        set[1] = 0xe5549f429A72BfA618Cf5C1aFDAc22A730dF6a1a;
        SiteboundV2.Sig[] memory sigs = new SiteboundV2.Sig[](1);
        sigs[0] = SiteboundV2.Sig(
            1_900_000_000,
            27,
            0x3c2afb3fdcd75f37b9853bc2f6d3d39b9738d77df82b6931005c18777b17fe62,
            0x12f042447199b4a7a2cdd69b3c98a81f6b3469a02707c826171d6dc767bd9547
        );
        sb.proposeAttestors(set, 1, sigs);
        (uint256 setId,,) = sb.pendingAttestors();
        assertEq(setId, 2);
    }

    function test_old_set_signature_does_not_count_after_rotation() public {
        // the same attestor stays in the new set, but a signature naming the old set id is refused
        address[] memory next = _byAddr2(vm.addr(attestorKey), vm.addr(0xD4));
        SiteboundV2.Sig[] memory oldSet = _sigs(_keys(attestorKey), _attestHead(EVIL, evilWallet), uint64(block.timestamp + 2 days));
        _propose(_keys(attestorKey), next, 1);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert("not attestor");
        _reg(EVIL, evilWallet, oldSet);
        _register(EVIL, evilWallet); // re-signed for set 2
    }

    function _byAddr2(address a, address b) internal pure returns (address[] memory l) {
        l = new address[](2);
        (l[0], l[1]) = a < b ? (a, b) : (b, a);
    }

    // ---------------------------------------------------------------- splits

    address constant R0 = address(0x7001);
    address constant R1 = address(0x2001);
    address constant R2 = address(0x1001);

    function _split3() internal pure returns (address[] memory to, uint16[] memory bps) {
        to = new address[](3);
        bps = new uint16[](3);
        (to[0], to[1], to[2]) = (R0, R1, R2);
        (bps[0], bps[1], bps[2]) = (7000, 2000, 1000);
    }

    function test_split_pays_each_wallet_and_dust_to_the_first() public {
        (address[] memory to, uint16[] memory bps) = _split3();
        _registerSplit(EVIL, to, bps);
        Opts memory o = _opts("S1");
        o.top = EVIL;
        o.amount = 10e6 + 7; // 7 base units of dust: 70/20/10 of 7 floor to 4/1/0, the first gets the rest
        o.fee = 3;
        SiteboundV2.PayInput memory p = _input(o);
        vm.prank(relayer);
        bytes32 id = sb.pay(p);
        assertEq(usdt.balanceOf(R1), 2e6 + 1);
        assertEq(usdt.balanceOf(R2), 1e6);
        assertEq(usdt.balanceOf(R0), 7e6 + 6);
        assertEq(usdt.balanceOf(relayer), 3);
        assertEq(usdt.balanceOf(wallet), 1000e6 - o.amount - 3);
        (,, uint256 amt,) = sb.payments(id);
        assertEq(amt, o.amount);
    }

    function test_split_emits_one_event_per_wallet_and_paid_names_the_first() public {
        (address[] memory to, uint16[] memory bps) = _split3();
        _registerSplit(EVIL, to, bps);
        Opts memory o = _opts("S2");
        o.top = EVIL;
        bytes32 id = keccak256(abi.encode(keccak256(bytes(EVIL)), o.orderId));
        vm.expectEmit(address(sb));
        emit SiteboundV2.PayoutSplit(id, R1, 2e6);
        vm.expectEmit(address(sb));
        emit SiteboundV2.PayoutSplit(id, R2, 1e6);
        vm.expectEmit(address(sb));
        emit SiteboundV2.PayoutSplit(id, R0, 7e6);
        vm.expectEmit(address(sb));
        emit SiteboundV2.Paid(id, keccak256(bytes(EVIL)), EVIL, o.orderId, wallet, R0, 10e6);
        _pay(o);
    }

    function test_bad_splits_revert() public {
        address[] memory to = new address[](2);
        uint16[] memory bps = new uint16[](2);
        SiteboundV2.Sig[] memory none = new SiteboundV2.Sig[](0);
        (to[0], to[1]) = (R0, R1);
        (bps[0], bps[1]) = (6000, 3000); // sums to 9000
        vm.expectRevert("bad split");
        sb.register(EVIL, to, bps, none);
        (bps[0], bps[1]) = (10_000, 0); // a zero share
        vm.expectRevert("bad split");
        sb.register(EVIL, to, bps, none);
        (to[1], bps[0], bps[1]) = (R0, 5000, 5000); // the same wallet twice
        vm.expectRevert("bad split");
        sb.register(EVIL, to, bps, none);
        (to[1]) = (address(0)); // zero address
        vm.expectRevert("bad split");
        sb.register(EVIL, to, bps, none);
        vm.expectRevert("bad split"); // lengths differ
        sb.register(EVIL, to, _full(), none);
        vm.expectRevert("bad split"); // empty
        sb.register(EVIL, new address[](0), new uint16[](0), none);
        address[] memory six = new address[](6);
        uint16[] memory sixBps = new uint16[](6);
        for (uint256 i; i < 6; i++) (six[i], sixBps[i]) = (address(uint160(0x9000 + i)), i == 0 ? 5000 : 1000);
        vm.expectRevert("bad split"); // more than 5
        sb.register(EVIL, six, sixBps, none);
    }

    function test_five_way_split_is_allowed() public {
        address[] memory to = new address[](5);
        uint16[] memory bps = new uint16[](5);
        for (uint256 i; i < 5; i++) (to[i], bps[i]) = (address(uint160(0x9000 + i)), 2000);
        _registerSplit(EVIL, to, bps);
        Opts memory o = _opts("S3");
        o.top = EVIL;
        _pay(o);
        for (uint256 i; i < 5; i++) assertEq(usdt.balanceOf(to[i]), 2e6);
    }

    function test_split_change_waits_for_delay_and_frozen_blocks_it() public {
        (address[] memory to, uint16[] memory bps) = _split3();
        _registerSplit(SHOP, to, bps); // SHOP is already registered to shopWallet: this is a pending change
        (,,,, uint16[] memory pendingBps, uint64 activeAt) = _splitOf(SHOP);
        assertEq(pendingBps.length, 3);
        assertEq(activeAt, block.timestamp + DELAY);
        _pay(_opts("S4"));
        assertEq(usdt.balanceOf(shopWallet), 10e6);
        vm.warp(block.timestamp + DELAY);
        _pay(_opts("S5"));
        assertEq(usdt.balanceOf(R0), 7e6);
        // R0 owns the site now: it can freeze, and no attestation changes a frozen split
        vm.prank(R0);
        sb.freeze(keccak256(bytes(SHOP)));
        SiteboundV2.Sig[] memory sigs = _sigs(_keys(attestorKey), _attestHead(SHOP, evilWallet), uint64(block.timestamp + 1 days));
        vm.expectRevert("frozen");
        _reg(SHOP, evilWallet, sigs);
    }

    function _splitOf(string memory site)
        internal
        view
        returns (address[] memory, uint16[] memory, address[] memory, address[] memory, uint16[] memory, uint64)
    {
        (address[] memory to, uint16[] memory bps, address[] memory pTo, uint16[] memory pBps, uint64 at) =
            sb.splitOf(keccak256(bytes(site)));
        return (to, bps, pTo, pTo, pBps, at);
    }

    /// For any amount, fee and 1 to 5 way split: the parts sum to the amount, each later wallet gets its floor
    /// share, the first gets the rest, the fee goes only to the submitter, and the contract keeps nothing.
    function testFuzz_split_parts_sum_to_amount(uint256 amount, uint256 fee, uint8 n, uint256 seed) public {
        n = uint8(bound(n, 1, 5));
        amount = bound(amount, 1, 30e6);
        fee = bound(fee, 0, 1e6); // MAX_RELAYER_FEE; amount + fee stays under the 50 USDT per-pay cap
        address[] memory to = new address[](n);
        uint16[] memory bps = new uint16[](n);
        uint256 left = 10_000;
        for (uint256 i = n; i > 0; i--) {
            uint256 k = i - 1;
            to[k] = address(uint160(0x9000 + k));
            // leave at least 1 bp for each wallet still to fill
            bps[k] = k == 0 ? uint16(left) : uint16(bound(uint256(keccak256(abi.encode(seed, k))), 1, left - k));
            left -= bps[k];
        }
        _registerSplit(EVIL, to, bps);
        Opts memory o = _opts("FZ");
        o.top = EVIL;
        o.amount = amount;
        o.fee = fee;
        uint256 before = usdt.balanceOf(wallet);
        SiteboundV2.PayInput memory p = _input(o);
        vm.prank(relayer);
        sb.pay(p);
        uint256 sum;
        for (uint256 i; i < n; i++) {
            uint256 got = usdt.balanceOf(to[i]);
            if (i > 0) assertEq(got, amount * bps[i] / 10_000);
            sum += got;
        }
        assertEq(sum, amount);
        assertEq(usdt.balanceOf(relayer), fee);
        assertEq(before - usdt.balanceOf(wallet), amount + fee);
        assertEq(usdt.balanceOf(address(sb)), 0);
    }

    /// The Attest signature below was made by ethers v6 `signTypedData` for chain 31337 and the contract at
    /// 0x…5B7e02, over to = [0x…7001, 0x…3001], bps = [7000, 3000], nonce 0, set 1.
    function test_attest_signature_from_ethers_is_accepted() public {
        address at = 0x00000000000000000000000000000000005B7e02;
        deployCodeTo(
            "SiteboundV2.sol:SiteboundV2",
            abi.encode(address(usdt), FRAME, sha256("localhost"), _one(0x501D9b198010BC786D8b0DAc53ac700c8ACdc02d), uint256(1), DELAY, GUARDIAN),
            at
        );
        sb = SiteboundV2(at);
        address[] memory to = new address[](2);
        uint16[] memory bps = new uint16[](2);
        (to[0], to[1], bps[0], bps[1]) = (address(0x7001), address(0x3001), 7000, 3000);
        SiteboundV2.Sig[] memory sigs = new SiteboundV2.Sig[](1);
        sigs[0] = SiteboundV2.Sig(
            1_900_000_000,
            28,
            0x8e25e63b82b12c9d3723f67ead73c8afd79fcb3a8733ad65102c441f6b9e5a84,
            0x0b4b34a696424de8461d803dae30b355bfcdecd89a64e2363e8e16c47772298d
        );
        sb.register("https://split.example", to, bps, sigs);
        (address payout,,,,) = sb.sites(keccak256("https://split.example"));
        assertEq(payout, address(0x7001));
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

    function test_refund_only_by_owner_or_operator() public {
        bytes32 id = _pay(_opts("F2"));
        vm.expectRevert("not refunder");
        sb.refund(id, 1e6);
    }

    function _approve(address a) internal {
        usdt.mint(a, 100e6);
        vm.prank(a);
        usdt.approve(address(sb), type(uint256).max);
    }

    function test_refund_operator_after_delay_refunds_to_payer_only() public {
        address op = address(0x0FF1CE);
        _approve(op);
        bytes32 siteHash = keccak256(bytes(SHOP));
        vm.expectRevert("not payout");
        sb.setRefundOperator(siteHash, op);
        vm.prank(shopWallet);
        sb.setRefundOperator(siteHash, op);
        bytes32 id = _pay(_opts("G1"));
        vm.prank(op);
        vm.expectRevert("not refunder"); // not yet
        sb.refund(id, 1e6);

        vm.warp(block.timestamp + DELAY);
        (address cur,,) = sb.refundOperatorOf(siteHash);
        assertEq(cur, address(0)); // promoted lazily, on the next call that touches the site
        uint256 payerBefore = usdt.balanceOf(wallet);
        vm.expectEmit(address(sb));
        emit SiteboundV2.Refunded(id, wallet, 4e6);
        vm.expectEmit(address(sb));
        emit SiteboundV2.RefundedBy(id, op);
        vm.prank(op);
        sb.refund(id, 4e6);
        assertEq(usdt.balanceOf(wallet), payerBefore + 4e6);
        assertEq(usdt.balanceOf(op), 96e6); // the operator paid it
        assertEq(usdt.balanceOf(shopWallet), 10e6); // the owner was not charged

        // owner and operator share one cap
        _approve(shopWallet);
        vm.prank(shopWallet);
        sb.refund(id, 5e6);
        vm.prank(op);
        vm.expectRevert("over refund");
        sb.refund(id, 2e6);
        vm.prank(op);
        sb.refund(id, 1e6);
        (,,, uint256 refunded) = sb.payments(id);
        assertEq(refunded, 10e6);

        // removing the operator also waits for the delay
        vm.prank(shopWallet);
        sb.setRefundOperator(siteHash, address(0));
        bytes32 id2 = _pay(_opts("G2"));
        vm.prank(op);
        sb.refund(id2, 1e6);
        vm.warp(block.timestamp + DELAY);
        vm.prank(op);
        vm.expectRevert("not refunder");
        sb.refund(id2, 1e6);
    }

    function test_refund_of_a_split_payment_is_paid_by_the_refunder_not_the_recipients() public {
        (address[] memory to, uint16[] memory bps) = _split3();
        _registerSplit(EVIL, to, bps);
        Opts memory o = _opts("G3");
        o.top = EVIL;
        o.fee = 1e5;
        SiteboundV2.PayInput memory p = _input(o);
        vm.prank(relayer);
        bytes32 id = sb.pay(p);
        assertEq(usdt.balanceOf(R0), 7e6);
        _approve(R0); // R0 owns the site; now holds 107 USDT
        vm.prank(R0);
        sb.refund(id, 3e6);
        vm.prank(R0);
        sb.refund(id, 6e6);
        vm.prank(R1); // a recipient that is not the owner cannot refund
        vm.expectRevert("not refunder");
        sb.refund(id, 1e6);
        vm.prank(R0);
        vm.expectRevert("over refund"); // 9 + 2 > 10: the 0.1 fee is not refundable
        sb.refund(id, 2e6);
        vm.prank(R0);
        sb.refund(id, 1e6);
        assertEq(usdt.balanceOf(wallet), 1000e6 - 1e5); // all of the amount back, the fee not
        assertEq(usdt.balanceOf(R0), 107e6 - 10e6);
        assertEq(usdt.balanceOf(R1), 2e6); // not clawed back
        assertEq(usdt.balanceOf(R2), 1e6);
        assertEq(usdt.balanceOf(relayer), 1e5);
    }

    function test_pay_and_refund_cannot_be_reentered() public {
        ReentrantToken bad = new ReentrantToken();
        address[] memory att = _one(vm.addr(attestorKey));
        sb = new SiteboundV2(IERC20(address(bad)), FRAME, rp, att, 1, DELAY, GUARDIAN);
        usdt = MockToken(address(bad));
        bad.mint(wallet, 1000e6);
        vm.prank(wallet);
        bad.approve(address(sb), type(uint256).max);
        _register(SHOP, shopWallet);
        _bind(walletKey, 50e6, 100e6, uint64(block.timestamp + 30 days));
        SiteboundV2.PayInput memory p = _input(_opts("H1"));
        bad.arm(abi.encodeCall(SiteboundV2.pay, (_input(_opts("H2")))));
        bytes32 id = sb.pay(p);
        assertEq(bad.reason(), "reentrant");
        _approve(shopWallet);
        bad.arm(abi.encodeCall(SiteboundV2.refund, (id, 1e6)));
        vm.prank(shopWallet);
        sb.refund(id, 1e6);
        assertEq(bad.reason(), "reentrant");
    }

    function test_contract_holds_no_funds() public {
        _pay(_opts("F3"));
        assertEq(usdt.balanceOf(address(sb)), 0);
    }
}

/// On transferFrom, calls back into the caller once with `armed` and records the revert reason.
contract ReentrantToken is MockToken {
    bytes armed;
    string public reason;

    function arm(bytes calldata data) external {
        armed = data;
        reason = "";
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        if (armed.length != 0) {
            bytes memory data = armed;
            delete armed;
            (bool ok, bytes memory ret) = msg.sender.call(data);
            if (!ok && ret.length >= 68) {
                assembly { ret := add(ret, 4) }
                reason = abi.decode(ret, (string));
            } else {
                reason = ok ? "reentered" : "reverted without reason";
            }
        }
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
