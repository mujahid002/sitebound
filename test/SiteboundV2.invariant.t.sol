// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {SiteboundV2, IERC20} from "../src/SiteboundV2.sol";
import {MockToken} from "./utils/MockToken.sol";
import {P256Verifier} from "./utils/P256Verifier.sol";

/// Random pays (two buyers, a 70/20/10 split site and a single-wallet site), refunds by owners and an operator,
/// owner drops of split recipients, and attempts that must fail. Ghost totals let the invariants below compare
/// every balance with what was authorised; a model of each site's split (`shareOf`) follows the drops independently
/// of the contract.
contract Handler is Test {
    SiteboundV2 public sb;
    MockToken public usdt;
    string constant FRAME = "http://localhost:8002";
    string constant A = "https://a.example";
    string constant B = "https://b.example";
    uint256 constant ATTESTOR = 0xA77E57;

    address[] public tracked; // every address that can hold tokens
    address[] public recipients; // payout wallets of A then B
    address public constant OP = address(0x0FF1CE);
    address public constant RELAYER = address(0xFEE);
    address public constant STRANGER = address(0x5778);
    uint256[2] buyerKey = [uint256(0xB0B), 0xB0C];
    uint256[2] passkey = [uint256(0xC0FFEE), 0xC0FFEF];
    bytes32[2] cred = [keccak256("cred-0"), keccak256("cred-1")];

    bytes32[] public ids;
    mapping(bytes32 => uint256) public amountOf;
    mapping(bytes32 => uint256) public refundedOf;
    mapping(bytes32 => address) public payerOf;
    mapping(address => uint256) public minted;
    mapping(address => uint256) public paidBy; // amount + fee
    mapping(address => uint256) public refundsTo;
    mapping(address => uint256) public refundsPaidBy;
    uint256 public sumAmounts;
    uint256 public sumFees;
    uint256 public broken; // count of attempts that should have failed but did not, or checks that did not hold
    uint256 orderSeq;
    address public constant OWNER_A = address(0xA0);
    mapping(address => uint256) public shareOf; // model: bps of each wallet in its site's current split, 0 if none
    mapping(address => uint256) public expectedReceived; // model: what each wallet should have been paid by pay()
    mapping(address => bool) public isDropped;
    mapping(address => uint256) public balanceAtDrop;
    uint256 public drops;

    constructor() {
        vm.etch(address(0x100), address(new P256Verifier()).code);
        usdt = new MockToken();
        address[] memory att = new address[](1);
        att[0] = vm.addr(ATTESTOR);
        sb = new SiteboundV2(IERC20(address(usdt)), FRAME, sha256("localhost"), att, 1, 1 hours, address(0));

        address[] memory toA = new address[](3);
        uint16[] memory bpsA = new uint16[](3);
        (toA[0], toA[1], toA[2], bpsA[0], bpsA[1], bpsA[2]) = (address(0xA0), address(0xA1), address(0xA2), 7000, 2000, 1000);
        address[] memory toB = new address[](1);
        uint16[] memory bpsB = new uint16[](1);
        (toB[0], bpsB[0]) = (address(0xB0), 10_000);
        _register(A, toA, bpsA);
        _register(B, toB, bpsB);
        (shareOf[toA[0]], shareOf[toA[1]], shareOf[toA[2]], shareOf[toB[0]]) = (7000, 2000, 1000, 10_000);
        for (uint256 i; i < 3; i++) recipients.push(toA[i]);
        recipients.push(toB[0]);

        for (uint256 i; i < 2; i++) {
            address w = vm.addr(buyerKey[i]);
            _fund(w, 1_000_000e6);
            (uint256 x, uint256 y) = vm.publicKeyP256(passkey[i]);
            _bind(i, w, x, y);
            tracked.push(w);
        }
        for (uint256 i; i < recipients.length; i++) {
            _fund(recipients[i], 1_000_000e6);
            tracked.push(recipients[i]);
        }
        _fund(OP, 1_000_000e6);
        tracked.push(OP);
        tracked.push(RELAYER);
        tracked.push(STRANGER);
        tracked.push(address(sb));

        vm.prank(address(0xA0));
        sb.setRefundOperator(keccak256(bytes(A)), OP);
        vm.warp(block.timestamp + 1 hours);
    }

    function trackedCount() external view returns (uint256) {
        return tracked.length;
    }

    function recipientCount() external view returns (uint256) {
        return recipients.length;
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function _fund(address a, uint256 n) internal {
        usdt.mint(a, n);
        minted[a] += n;
        vm.prank(a);
        usdt.approve(address(sb), type(uint256).max);
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Sitebound"), keccak256("1"), block.chainid, address(sb)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _register(string memory site, address[] memory to, uint16[] memory bps) internal {
        bytes32 siteHash = keccak256(bytes(site));
        (,,,, uint256 nonce) = sb.sites(siteHash);
        (uint256 setId,) = sb.quorum();
        uint64 deadline = uint64(block.timestamp + 1 days);
        bytes32 sh = keccak256(
            abi.encode(
                keccak256("Attest(bytes32 siteHash,address[] to,uint16[] bps,uint256 nonce,uint256 setId,uint64 deadline)"),
                siteHash, keccak256(abi.encodePacked(to)), keccak256(abi.encodePacked(bps)), nonce, setId, deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTOR, _digest(sh));
        SiteboundV2.Sig[] memory sigs = new SiteboundV2.Sig[](1);
        sigs[0] = SiteboundV2.Sig(deadline, v, r, s);
        sb.register(site, to, bps, sigs);
    }

    function _bind(uint256 i, address w, uint256 x, uint256 y) internal {
        uint64 expiry = uint64(block.timestamp + 3650 days);
        bytes32 sh = keccak256(
            abi.encode(
                keccak256(
                    "Bind(bytes32 credentialHash,uint256 pubX,uint256 pubY,uint256 perPayCap,uint256 totalCap,uint64 expiry,uint256 nonce)"
                ),
                cred[i], x, y, uint256(50e6), type(uint256).max, expiry, sb.bindNonce(w)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerKey[i], _digest(sh));
        sb.bind(cred[i], x, y, 50e6, type(uint256).max, expiry, w, v, r, s);
    }

    function _b64(bytes32 v) internal pure returns (string memory) {
        bytes memory b = bytes(vm.toBase64URL(abi.encodePacked(v)));
        while (b[b.length - 1] == "=") assembly { mstore(b, sub(mload(b), 1)) }
        return string(b);
    }

    function _input(uint256 i, string memory top, bytes32 orderId, uint256 amount, uint256 fee)
        internal
        view
        returns (SiteboundV2.PayInput memory p)
    {
        uint256 deadline = block.timestamp + 10 minutes;
        bytes32 siteHash = keccak256(bytes(top));
        bytes32 challenge = keccak256(
            abi.encode(block.chainid, address(sb), siteHash, sb.configVersion(siteHash), orderId, amount, fee, deadline)
        );
        string memory head = string.concat('{"type":"webauthn.get","challenge":"', _b64(challenge), '","origin":"', FRAME);
        string memory json = string.concat(head, '","crossOrigin":true,"topOrigin":"', top, '"}');
        bytes memory auth = abi.encodePacked(sha256("localhost"), bytes1(0x05), uint32(1));
        (bytes32 r, bytes32 s) = vm.signP256(passkey[i], sha256(bytes.concat(auth, sha256(bytes(json)))));
        p.credentialHash = cred[i];
        p.authenticatorData = auth;
        p.clientDataJSON = json;
        p.typeIdx = 1;
        p.challengeIdx = 23;
        p.originIdx = 23 + 13 + 43 + 2;
        p.crossOriginIdx = p.originIdx + 12 + bytes(FRAME).length;
        p.topOriginIdx = p.crossOriginIdx + 19;
        (p.r, p.s, p.orderId, p.amount, p.relayerFee, p.deadline) = (uint256(r), uint256(s), orderId, amount, fee, deadline);
    }

    // ---------------------------------------------------------------- actions

    function pay(uint256 buyerSeed, bool toA, uint256 amount, uint256 fee) external {
        uint256 i = buyerSeed % 2;
        amount = bound(amount, 1, 30e6);
        fee = bound(fee, 0, 1e6);
        bytes32 orderId = bytes32(++orderSeq);
        string memory site = toA ? A : B;
        SiteboundV2.PayInput memory p = _input(i, site, orderId, amount, fee);
        vm.prank(RELAYER);
        bytes32 id = sb.pay(p);
        address w = vm.addr(buyerKey[i]);
        ids.push(id);
        amountOf[id] = amount;
        payerOf[id] = w;
        paidBy[w] += amount + fee;
        sumAmounts += amount;
        sumFees += fee;
        if (toA) {
            // the model's split: each later wallet its floor share, the owner the rest
            uint256 rest = amount;
            for (uint256 n = 1; n < 3; n++) {
                address r = recipients[n];
                uint256 part = amount * shareOf[r] / 10_000;
                expectedReceived[r] += part;
                rest -= part;
            }
            expectedReceived[OWNER_A] += rest;
        } else {
            expectedReceived[address(0xB0)] += amount;
        }
    }

    function refund(uint256 idSeed, uint256 amount, bool byOperator) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        uint256 left = amountOf[id] - refundedOf[id];
        if (left == 0) return;
        amount = bound(amount, 1, left);
        (, bytes32 siteHash,,) = sb.payments(id);
        (address owner,,,,) = sb.sites(siteHash);
        address by = byOperator && siteHash == keccak256(bytes(A)) ? OP : owner;
        vm.prank(by);
        sb.refund(id, amount);
        refundedOf[id] += amount;
        refundsTo[payerOf[id]] += amount;
        refundsPaidBy[by] += amount;
    }

    function overRefund(uint256 idSeed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        (, bytes32 siteHash,,) = sb.payments(id);
        (address owner,,,,) = sb.sites(siteHash);
        vm.prank(owner);
        try sb.refund(id, amountOf[id] - refundedOf[id] + 1) { broken++; } catch {}
    }

    function strangerRefund(uint256 idSeed, uint256 amount) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        amount = bound(amount, 0, amountOf[id] - refundedOf[id]);
        vm.prank(STRANGER);
        try sb.refund(id, amount) { broken++; } catch {}
        vm.prank(address(0xA1)); // a split recipient that is not the owner
        try sb.refund(id, amount) { broken++; } catch {}
    }

    function replayPay(uint256 idSeed) external {
        // the same order again, freshly signed: must fail ("order used")
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        (, bytes32 siteHash,,) = sb.payments(id);
        string memory site = siteHash == keccak256(bytes(A)) ? A : B;
        uint256 i = payerOf[id] == vm.addr(buyerKey[0]) ? 0 : 1;
        SiteboundV2.PayInput memory p = _input(i, site, bytes32(_orderOf(id, siteHash)), 1e6, 0);
        try sb.pay(p) { broken++; } catch {}
    }

    function _orderOf(bytes32 id, bytes32 siteHash) internal view returns (uint256) {
        for (uint256 n = 1; n <= orderSeq; n++) if (keccak256(abi.encode(siteHash, bytes32(n))) == id) return n;
        revert("unknown");
    }

    function tamperedPay(uint256 amount, bool which) external {
        // signed for one amount and submitted with another, or signed by the other buyer's passkey
        amount = bound(amount, 1, 30e6);
        SiteboundV2.PayInput memory p = _input(0, B, bytes32(uint256(1 << 200) + ++orderSeq), amount, 0);
        if (which) p.amount = amount + 1;
        else p.credentialHash = cred[1];
        try sb.pay(p) { broken++; } catch {}
    }

    function stalePay(uint256 amount) external {
        // signed, then the site's config changes (freeze + unfreeze), then submitted: must fail
        amount = bound(amount, 1, 30e6);
        SiteboundV2.PayInput memory p = _input(1, B, bytes32(uint256(2 << 200) + ++orderSeq), amount, 0);
        bytes32 siteHash = keccak256(bytes(B));
        vm.prank(address(0xB0));
        sb.freeze(siteHash);
        vm.prank(address(0xB0));
        sb.unfreeze(siteHash);
        try sb.pay(p) { broken++; } catch {}
    }

    /// The owner of A drops a recipient: a live one (must succeed and give its share to the owner) or one already
    /// dropped (must revert).
    function dropRecipient(uint256 seed) external {
        _drop(seed % 2 == 0 ? address(0xA1) : address(0xA2));
    }

    function _drop(address target) internal {
        bytes32 siteHash = keccak256(bytes(A));
        uint256 dropShare = shareOf[target];
        if (dropShare == 0) {
            vm.prank(OWNER_A);
            try sb.dropRecipient(siteHash, target) { broken++; } catch {}
            return;
        }
        uint256 before0 = shareOf[OWNER_A];
        uint256 v = sb.configVersion(siteHash);
        vm.prank(OWNER_A);
        sb.dropRecipient(siteHash, target);
        if (sb.configVersion(siteHash) != v + 1) broken++;
        shareOf[OWNER_A] = before0 + dropShare;
        shareOf[target] = 0;
        isDropped[target] = true;
        balanceAtDrop[target] = usdt.balanceOf(target);
        drops++;
        if (!splitMatchesModel()) broken++;
    }

    /// The registered split of A is exactly the model: the owner first with its share, each live recipient with its
    /// share, no dropped wallet, shares summing to 10000.
    function splitMatchesModel() public view returns (bool) {
        (address[] memory to, uint16[] memory bps,,,) = sb.splitOf(keccak256(bytes(A)));
        uint256 live;
        for (uint256 n; n < 3; n++) if (shareOf[recipients[n]] != 0) live++;
        if (to.length != live || to[0] != OWNER_A) return false;
        uint256 sum;
        for (uint256 i; i < to.length; i++) {
            if (bps[i] != shareOf[to[i]] || isDropped[to[i]]) return false;
            sum += bps[i];
        }
        return sum == 10_000;
    }

    /// Drops that must fail: the owner itself, wallets outside the split, and anyone but the owner as the caller.
    function badDrop(uint256 seed) external {
        bytes32 siteHash = keccak256(bytes(A));
        uint256 mode = seed % 3;
        if (mode == 0) {
            vm.prank(OWNER_A);
            try sb.dropRecipient(siteHash, OWNER_A) { broken++; } catch {}
        } else if (mode == 1) {
            address[4] memory outside = [STRANGER, address(0xB0), address(sb), address(0)];
            vm.prank(OWNER_A);
            try sb.dropRecipient(siteHash, outside[(seed / 3) % 4]) { broken++; } catch {}
        } else {
            address[4] memory callers = [STRANGER, address(0xA1), address(0xA2), OP];
            address[2] memory targets = [address(0xA1), address(0xA2)];
            vm.prank(callers[(seed / 3) % 4]);
            try sb.dropRecipient(siteHash, targets[(seed / 12) % 2]) { broken++; } catch {}
        }
    }

    /// Signed for A, then a recipient is dropped, then submitted: must fail (the config version moved).
    function stalePayAfterDrop(uint256 buyerSeed, uint256 amount, uint256 seed) external {
        address target = seed % 2 == 0 ? address(0xA1) : address(0xA2);
        if (shareOf[target] == 0) return;
        amount = bound(amount, 1, 30e6);
        SiteboundV2.PayInput memory p = _input(buyerSeed % 2, A, bytes32(uint256(3 << 200) + ++orderSeq), amount, 0);
        _drop(target);
        vm.prank(RELAYER);
        try sb.pay(p) { broken++; } catch {}
    }

    function wait(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 2 hours));
    }
}

/// Each call can verify a P-256 signature in the Solidity verifier etched at 0x100, which is slow; these settings
/// keep the suite to about 20 seconds.
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 50
contract SiteboundV2InvariantTest is Test {
    Handler h;

    function setUp() public {
        h = new Handler();
        targetContract(address(h));
    }

    /// No payment can choose an arbitrary payee: every token is still at a tracked address (buyers, the sites'
    /// payout wallets, the refund operator, the relayer), the contract holds none, and the stranger got none.
    function invariant_no_arbitrary_payee() public view {
        MockToken t = h.usdt();
        uint256 sum;
        uint256 mintedSum;
        for (uint256 i; i < h.trackedCount(); i++) {
            address a = h.tracked(i);
            sum += t.balanceOf(a);
            mintedSum += h.minted(a);
        }
        assertEq(sum, mintedSum);
        assertEq(t.balanceOf(address(h.sb())), 0);
        assertEq(t.balanceOf(h.STRANGER()), 0);
    }

    /// What the payout wallets received equals the authorised amounts, and the relayer got exactly the fees.
    function invariant_split_transfers_plus_fee_equal_authorised() public view {
        MockToken t = h.usdt();
        uint256 received;
        for (uint256 i; i < h.recipientCount(); i++) {
            address r = h.recipients(i);
            received += t.balanceOf(r) + h.refundsPaidBy(r) - h.minted(r);
        }
        assertEq(received, h.sumAmounts());
        assertEq(t.balanceOf(h.RELAYER()), h.sumFees());
    }

    /// Across drops, each payout wallet received exactly what the model split says (so the owner got its old share
    /// plus every dropped share, and a dropped wallet got nothing after its drop), the registered split is that model,
    /// and a dropped wallet's balance has not moved since the drop.
    function invariant_split_follows_drops() public view {
        MockToken t = h.usdt();
        for (uint256 i; i < h.recipientCount(); i++) {
            address r = h.recipients(i);
            assertEq(t.balanceOf(r) + h.refundsPaidBy(r) - h.minted(r), h.expectedReceived(r));
            if (h.isDropped(r)) assertEq(t.balanceOf(r), h.balanceAtDrop(r));
        }
        assertTrue(h.splitMatchesModel());
    }

    /// Refunds never exceed the payment, and only the original payer receives them.
    function invariant_refunds_capped_and_only_to_payer() public view {
        MockToken t = h.usdt();
        for (uint256 i; i < h.idCount(); i++) {
            bytes32 id = h.ids(i);
            (address w,, uint256 amount, uint256 refunded) = h.sb().payments(id);
            assertEq(w, h.payerOf(id));
            assertLe(refunded, amount);
            assertEq(refunded, h.refundedOf(id));
        }
        for (uint256 i; i < 2; i++) {
            address b = h.tracked(i);
            assertEq(t.balanceOf(b), h.minted(b) - h.paidBy(b) + h.refundsTo(b));
        }
    }

    /// Over-refunds, refunds by others, replayed orders, tampered or wrongly signed payments, payments signed
    /// before a config change or a drop, and drops by the wrong caller or of the wrong wallet all failed.
    function invariant_bad_attempts_never_execute() public view {
        assertEq(h.broken(), 0);
    }
}

/// Targeted checks of dropRecipient on the handler's site A (owner 0xA0, then 0xA1 at 20% and 0xA2 at 10%).
contract SiteboundV2DropTest is Handler {
    bytes32 siteA = keccak256(bytes(A));

    function _payA(bytes32 orderId, uint256 amount, uint256 fee) internal returns (bytes32) {
        SiteboundV2.PayInput memory p = _input(0, A, orderId, amount, fee);
        vm.prank(RELAYER);
        return sb.pay(p);
    }

    function _split() internal view returns (bytes memory) {
        (address[] memory to, uint16[] memory bps,,,) = sb.splitOf(siteA);
        return abi.encode(to, bps);
    }

    function _two(address a, address b, uint16 x, uint16 y) internal pure returns (bytes memory) {
        address[] memory to = new address[](2);
        uint16[] memory bps = new uint16[](2);
        (to[0], to[1], bps[0], bps[1]) = (a, b, x, y);
        return abi.encode(to, bps);
    }

    function test_drop_middle_recipient_moves_its_share_to_the_owner() public {
        uint256 v = sb.configVersion(siteA);
        vm.expectEmit(true, true, false, false);
        emit SiteboundV2.RecipientDropped(siteA, address(0xA1));
        vm.prank(OWNER_A);
        sb.dropRecipient(siteA, address(0xA1));
        assertEq(_split(), _two(OWNER_A, address(0xA2), 9000, 1000)); // 7000 + 2000 to the owner
        assertEq(sb.configVersion(siteA), v + 1);

        uint256 a0 = usdt.balanceOf(OWNER_A);
        uint256 a1 = usdt.balanceOf(address(0xA1));
        uint256 a2 = usdt.balanceOf(address(0xA2));
        _payA(bytes32(uint256(77)), 10e6, 1e6);
        assertEq(usdt.balanceOf(OWNER_A), a0 + 9e6);
        assertEq(usdt.balanceOf(address(0xA2)), a2 + 1e6);
        assertEq(usdt.balanceOf(address(0xA1)), a1); // the dropped wallet gets nothing
        assertEq(usdt.balanceOf(RELAYER), 1e6);
        assertEq(usdt.balanceOf(address(sb)), 0);
    }

    function test_drop_of_the_owner_or_a_stranger_reverts() public {
        bytes memory before = _split();
        vm.startPrank(OWNER_A);
        vm.expectRevert("not a recipient");
        sb.dropRecipient(siteA, OWNER_A);
        vm.expectRevert("not a recipient");
        sb.dropRecipient(siteA, STRANGER);
        vm.stopPrank();
        assertEq(_split(), before);
        // dropping the same wallet twice: the second time it is no longer a recipient
        vm.startPrank(OWNER_A);
        sb.dropRecipient(siteA, address(0xA2));
        vm.expectRevert("not a recipient");
        sb.dropRecipient(siteA, address(0xA2));
        vm.stopPrank();
    }

    function test_only_the_owner_can_drop() public {
        bytes memory before = _split();
        address[4] memory callers = [STRANGER, address(0xA1), address(0xA2), OP]; // OP is the refund operator
        for (uint256 i; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert("not payout");
            sb.dropRecipient(siteA, address(0xA1));
        }
        vm.prank(address(0xB0)); // the owner of another site
        vm.expectRevert("not payout");
        sb.dropRecipient(siteA, address(0xA1));
        assertEq(_split(), before);
    }

    function test_payment_signed_before_a_drop_fails_and_a_fresh_one_works() public {
        SiteboundV2.PayInput memory stale = _input(1, A, bytes32(uint256(88)), 5e6, 0);
        vm.prank(OWNER_A);
        sb.dropRecipient(siteA, address(0xA1));
        vm.prank(RELAYER);
        vm.expectRevert("bad challenge");
        sb.pay(stale);
        uint256 a0 = usdt.balanceOf(OWNER_A);
        _payA(bytes32(uint256(88)), 5e6, 0); // same order id, signed for the new version
        assertEq(usdt.balanceOf(OWNER_A), a0 + 4.5e6 + 0); // 9000 bps of 5e6 = 4.5e6 (0xA2 gets 0.5e6)
    }
}
