// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// Pays a website's registered wallet, and only that wallet. The site comes from the browser:
/// the passkey signs clientDataJSON, which carries "topOrigin" (the site the buyer is on).
contract Sitebound {
    struct Site {
        address payout;
        address pendingPayout;
        uint64 activeAt;
        bool frozen;
        uint256 nonce;
    }

    struct Buyer {
        address wallet;
        uint256 pubX;
        uint256 pubY;
        uint256 perPayCap;
        uint256 totalCap;
        uint256 spent;
        uint64 expiry;
    }

    struct Payment {
        address wallet;
        bytes32 siteHash;
        uint256 amount;
        uint256 refunded;
    }

    struct PayInput {
        bytes32 credentialHash;
        bytes authenticatorData;
        string clientDataJSON;
        uint256 typeIdx;
        uint256 challengeIdx;
        uint256 originIdx;
        uint256 crossOriginIdx;
        uint256 topOriginIdx;
        uint256 r;
        uint256 s;
        bytes32 orderId;
        uint256 amount;
        uint256 relayerFee;
        uint256 deadline;
    }

    bytes32 constant BIND_TYPEHASH = keccak256(
        "Bind(bytes32 credentialHash,uint256 pubX,uint256 pubY,uint256 perPayCap,uint256 totalCap,uint64 expiry,uint256 nonce)"
    );
    bytes32 constant ATTEST_TYPEHASH = keccak256("Attest(bytes32 siteHash,address payout,uint256 nonce,uint64 deadline)");
    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 constant P256N_HALF = 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8;

    IERC20 public immutable token;
    bytes32 public immutable rpIdHash;
    uint64 public immutable delay;
    bytes32 immutable frameOriginHash;
    string frameOrigin;
    mapping(address => bool) public isAttestor;

    mapping(bytes32 => Site) public sites;
    mapping(bytes32 => Buyer) public buyers;
    mapping(address => uint256) public bindNonce;
    mapping(bytes32 => mapping(bytes32 => bool)) public orderUsed;
    mapping(bytes32 => Payment) public payments;

    event Registered(bytes32 indexed siteHash, string site, address payout);
    event PayoutProposed(bytes32 indexed siteHash, address pendingPayout, uint64 activeAt);
    event Frozen(bytes32 indexed siteHash);
    event Unfrozen(bytes32 indexed siteHash);
    event Bound(bytes32 indexed credentialHash, address indexed wallet, uint256 perPayCap, uint256 totalCap, uint64 expiry);
    event Unbound(bytes32 indexed credentialHash, address indexed wallet);
    event Paid(
        bytes32 indexed paymentId,
        bytes32 indexed siteHash,
        string site,
        bytes32 orderId,
        address indexed wallet,
        address payout,
        uint256 amount
    );
    event Refunded(bytes32 indexed paymentId, address indexed wallet, uint256 amount);

    constructor(IERC20 token_, string memory frameOrigin_, bytes32 rpIdHash_, address[] memory attestors, uint64 delay_) {
        token = token_;
        frameOrigin = frameOrigin_;
        frameOriginHash = keccak256(bytes(frameOrigin_));
        rpIdHash = rpIdHash_;
        delay = delay_;
        for (uint256 i; i < attestors.length; i++) isAttestor[attestors[i]] = true;
    }

    // ---------------------------------------------------------------- registry

    /// A DNS-TXT attestation from a fixed attestor sets the payout. A new site is live at once;
    /// an existing site's payout only changes after `delay`, and never while frozen.
    function register(string calldata site, address payout, uint64 deadline, address attestor, uint8 v, bytes32 r, bytes32 s)
        external
    {
        require(payout != address(0), "payout 0");
        require(block.timestamp <= deadline, "attestation expired");
        require(isAttestor[attestor], "not attestor");
        bytes32 siteHash = keccak256(bytes(site));
        Site storage st = sites[siteHash];
        bytes32 digest = _digest(keccak256(abi.encode(ATTEST_TYPEHASH, siteHash, payout, st.nonce, deadline)));
        require(_recover(digest, v, r, s) == attestor, "bad attestation");
        st.nonce++;

        if (st.payout == address(0)) {
            st.payout = payout;
            emit Registered(siteHash, site, payout);
            return;
        }
        require(!st.frozen, "frozen");
        _promote(st);
        st.pendingPayout = payout;
        st.activeAt = uint64(block.timestamp) + delay;
        emit PayoutProposed(siteHash, payout, st.activeAt);
    }

    function freeze(bytes32 siteHash) external {
        Site storage st = sites[siteHash];
        _promote(st);
        require(msg.sender == st.payout, "not payout");
        st.frozen = true;
        st.pendingPayout = address(0);
        emit Frozen(siteHash);
    }

    function unfreeze(bytes32 siteHash) external {
        Site storage st = sites[siteHash];
        require(msg.sender == st.payout, "not payout");
        st.frozen = false;
        emit Unfrozen(siteHash);
    }

    function _promote(Site storage st) internal {
        if (st.pendingPayout != address(0) && block.timestamp >= st.activeAt) {
            st.payout = st.pendingPayout;
            st.pendingPayout = address(0);
        }
    }

    // ----------------------------------------------------------------- binding

    /// Ties a passkey to a wallet with caps and an expiry. Only the wallet's own EIP-712 signature
    /// counts: without it anyone could bind their passkey to someone else's allowance.
    function bind(
        bytes32 credentialHash,
        uint256 pubX,
        uint256 pubY,
        uint256 perPayCap,
        uint256 totalCap,
        uint64 expiry,
        address wallet,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(expiry > block.timestamp, "expired");
        Buyer storage b = buyers[credentialHash];
        require(b.wallet == address(0) || b.wallet == wallet, "credential taken");
        bytes32 digest = _digest(
            keccak256(
                abi.encode(BIND_TYPEHASH, credentialHash, pubX, pubY, perPayCap, totalCap, expiry, bindNonce[wallet])
            )
        );
        require(_recover(digest, v, r, s) == wallet, "bad binding signature");
        bindNonce[wallet]++;
        buyers[credentialHash] = Buyer(wallet, pubX, pubY, perPayCap, totalCap, 0, expiry);
        emit Bound(credentialHash, wallet, perPayCap, totalCap, expiry);
    }

    function unbind(bytes32 credentialHash) external {
        Buyer storage b = buyers[credentialHash];
        require(b.wallet == msg.sender, "not wallet");
        bindNonce[msg.sender]++;
        delete buyers[credentialHash];
        emit Unbound(credentialHash, msg.sender);
    }

    // --------------------------------------------------------------------- pay

    /// Permissionless: anyone can submit, the signature fixes site, order, amount and fee.
    /// The payout is never an input; it comes from the registry entry of the signed topOrigin.
    function pay(PayInput calldata p) external returns (bytes32 paymentId) {
        Buyer storage b = buyers[p.credentialHash];
        _spend(b, p.amount + p.relayerFee);
        bytes32 siteHash = _verify(p, b);
        return _settle(p, b.wallet, siteHash);
    }

    function _spend(Buyer storage b, uint256 total) internal {
        require(b.wallet != address(0), "not bound");
        require(block.timestamp <= b.expiry, "binding expired");
        require(total <= b.perPayCap, "over per-pay cap");
        require(b.spent + total <= b.totalCap, "over total cap");
        b.spent += total;
    }

    /// Checks the passkey assertion and returns the siteHash of the browser-reported topOrigin.
    function _verify(PayInput calldata p, Buyer storage b) internal returns (bytes32 siteHash) {
        require(p.authenticatorData.length >= 37, "short authData");
        require(bytes32(p.authenticatorData[0:32]) == rpIdHash, "bad rpId");
        require(p.authenticatorData[32] & 0x05 == 0x05, "need UP and UV");

        bytes calldata cd = bytes(p.clientDataJSON);
        require(_at(cd, p.typeIdx, '"type":"webauthn.get"'), "bad type");
        require(_at(cd, p.originIdx, bytes.concat('"origin":"', bytes(frameOrigin), '"')), "bad origin");
        require(_at(cd, p.crossOriginIdx, '"crossOrigin":true'), "not cross-origin");
        require(_at(cd, p.topOriginIdx, '"topOrigin":"'), "no topOrigin");
        siteHash = _siteHash(cd, p.topOriginIdx + 13);

        require(block.timestamp <= p.deadline, "deadline passed");
        bytes32 challenge = keccak256(
            abi.encode(
                block.chainid, address(this), siteHash, p.orderId, p.amount, p.relayerFee, p.deadline
            )
        );
        require(_at(cd, p.challengeIdx, bytes.concat('"challenge":"', _b64url(challenge), '"')), "bad challenge");

        require(!orderUsed[siteHash][p.orderId], "order used");
        orderUsed[siteHash][p.orderId] = true;

        bytes32 hash = sha256(bytes.concat(p.authenticatorData, sha256(bytes(p.clientDataJSON))));
        require(_p256(hash, p.r, p.s, b.pubX, b.pubY), "bad passkey signature");
    }

    function _settle(PayInput calldata p, address wallet, bytes32 siteHash) internal returns (bytes32 paymentId) {
        Site storage st = sites[siteHash];
        require(st.payout != address(0), "site not registered");
        require(!st.frozen, "frozen");
        _promote(st);

        _transferFrom(wallet, st.payout, p.amount);
        if (p.relayerFee > 0) _transferFrom(wallet, msg.sender, p.relayerFee);

        paymentId = keccak256(abi.encode(siteHash, p.orderId));
        payments[paymentId] = Payment(wallet, siteHash, p.amount, 0);
        bytes calldata cd = bytes(p.clientDataJSON);
        uint256 from = p.topOriginIdx + 13;
        emit Paid(paymentId, siteHash, string(cd[from:_quote(cd, from)]), p.orderId, wallet, st.payout, p.amount);
    }

    // ------------------------------------------------------------------ refund

    /// The site's current payout wallet returns money to the ORIGINAL payer only, up to what was paid.
    /// The shop approves this contract for the token once.
    function refund(bytes32 paymentId, uint256 amount) external {
        Payment storage pm = payments[paymentId];
        require(pm.wallet != address(0), "no such payment");
        Site storage st = sites[pm.siteHash];
        _promote(st);
        require(msg.sender == st.payout, "not payout");
        require(pm.refunded + amount <= pm.amount, "over refund");
        pm.refunded += amount;
        _transferFrom(msg.sender, pm.wallet, amount);
        emit Refunded(paymentId, pm.wallet, amount);
    }

    // ----------------------------------------------------------------- helpers

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("Sitebound"), keccak256("1"), block.chainid, address(this))
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _recover(bytes32 digest, uint8 v, bytes32 r, bytes32 s) internal pure returns (address) {
        require(uint256(s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0, "high s");
        address a = ecrecover(digest, v, r, s);
        require(a != address(0), "bad signature");
        return a;
    }

    /// True when `want` appears in `data` exactly at `idx`.
    function _at(bytes calldata data, uint256 idx, bytes memory want) internal pure returns (bool) {
        if (idx + want.length > data.length) return false;
        return keccak256(data[idx:idx + want.length]) == keccak256(want);
    }

    function _quote(bytes calldata data, uint256 from) internal pure returns (uint256 i) {
        for (i = from; i < data.length; i++) {
            if (data[i] == '"') return i;
        }
        revert("unterminated");
    }

    function _siteHash(bytes calldata data, uint256 from) internal pure returns (bytes32) {
        return keccak256(data[from:_quote(data, from)]);
    }

    function _b64url(bytes32 v) internal pure returns (bytes memory out) {
        bytes memory T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        out = new bytes(43);
        uint256 o;
        for (uint256 i; i < 30; i += 3) {
            uint256 n = (uint256(uint8(v[i])) << 16) | (uint256(uint8(v[i + 1])) << 8) | uint8(v[i + 2]);
            out[o++] = T[n >> 18];
            out[o++] = T[(n >> 12) & 63];
            out[o++] = T[(n >> 6) & 63];
            out[o++] = T[n & 63];
        }
        uint256 last = (uint256(uint8(v[30])) << 8) | uint8(v[31]);
        out[o++] = T[last >> 10];
        out[o++] = T[(last >> 4) & 63];
        out[o++] = T[(last << 2) & 63];
    }

    function _p256(bytes32 hash, uint256 r, uint256 s, uint256 x, uint256 y) internal view returns (bool) {
        (bool ok, bytes memory out) = address(0x100).staticcall(abi.encode(hash, r, s, x, y));
        return ok && out.length == 32 && abi.decode(out, (uint256)) == 1;
    }

    function _transferFrom(address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer failed");
    }
}
