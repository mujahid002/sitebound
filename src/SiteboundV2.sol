// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/// Pays a website's registered wallet, and only that wallet. The site comes from the browser:
/// the passkey signs clientDataJSON, which carries "topOrigin" (the site the buyer is on).
/// v2: a site registration needs `threshold` distinct attestors, and the attestor set changes only
/// when the current set's quorum signs a new one, which takes effect after `delay`. There is no owner.
/// A site's payout can be split between up to 5 wallets; the first one is the site's owner.
contract SiteboundV2 {
    uint256 public constant MAX_RECIPIENTS = 5;
    uint256 public constant MAX_ADMINS = 3;
    /// How long an admin's freeze stops payments, unless the owner lifts it sooner.
    uint64 public constant ADMIN_FREEZE = 72 hours;
    uint64 public constant MAX_DELAY = 30 days;
    uint256 constant BPS = 10_000;

    /// Who gets paid, in basis points summing to 10000. to[0] owns the site (freeze, unfreeze, refund)
    /// and gets the rounding dust.
    struct Split {
        address[] to;
        uint16[] bps;
    }

    struct Site {
        Split payout;
        Split pending;
        uint64 activeAt;
        bool frozen;
        uint256 nonce;
        address refundOperator;
        address pendingOperator;
        uint64 operatorAt; // 0: no operator change pending
        /// When set, every payment needs a Quote this key signed (EOA or ERC-1271 contract).
        address quoteSigner;
        address pendingQuoteSigner;
        uint64 quoteSignerAt; // 0: no quote signer change pending
        /// Up to MAX_ADMINS. An admin may refund and freeze payments for ADMIN_FREEZE, nothing else.
        Admin[] admins;
        uint64 adminFrozenUntil;
        /// Bumped by every change to the site's split, refund operator, quote signer, admins or frozen state,
        /// including a pending change taking effect. The buyer signs it, so a payment signed before a change
        /// cannot execute after it.
        uint256 version;
    }

    struct Admin {
        address who;
        uint64 from; // rights start here
        bool counted; // its activation has bumped the site's version
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

    /// One attestor's EIP-712 signature. Each attestor picks its own deadline; the signer is recovered.
    struct Sig {
        uint64 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    bytes32 constant BIND_TYPEHASH = keccak256(
        "Bind(bytes32 credentialHash,uint256 pubX,uint256 pubY,uint256 perPayCap,uint256 totalCap,uint64 expiry,uint256 nonce)"
    );
    bytes32 constant ATTEST_TYPEHASH =
        keccak256("Attest(bytes32 siteHash,address[] to,uint16[] bps,uint256 nonce,uint256 setId,uint64 deadline)");
    bytes32 constant ROTATE_TYPEHASH =
        keccak256("Rotate(address[] attestors,uint256 threshold,uint256 setId,uint64 deadline)");
    bytes32 constant QUOTE_TYPEHASH =
        keccak256("Quote(bytes32 siteHash,bytes32 orderId,address token,uint256 amount,uint64 expiry)");
    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    IERC20 public immutable token;
    bytes32 public immutable rpIdHash;
    uint64 public immutable delay;
    /// On-chain cap on the relayer fee, on top of the buyer signing the exact fee: one whole token.
    uint256 public immutable maxRelayerFee;
    /// Can pause and unpause new payments, and nothing else. address(0): no one can.
    address public immutable guardian;
    string frameOrigin; // slot 0, as in v1
    bool public paused;

    /// Attestor sets by id. Set 1 comes from the constructor; each proposal gets the next id.
    mapping(uint256 => mapping(address => bool)) public inSet;
    uint256 public setCount;
    uint256 activeSet;
    uint256 activeThreshold;
    uint256 pendingSet;
    uint256 pendingThreshold;
    uint64 pendingSetAt;

    mapping(bytes32 => Site) internal _sites;
    uint256 private _lock = 1;
    mapping(bytes32 => Buyer) public buyers;
    mapping(address => uint256) public bindNonce;
    /// One wallet per passkey: the challenge does not name the payer, so a key bound twice could be charged on the wrong wallet.
    mapping(bytes32 => bytes32) public pubKeyOwner;
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
    /// Every registration: the split, and when it takes effect (now for a new site).
    event SplitSet(bytes32 indexed siteHash, address[] to, uint16[] bps, uint64 activeAt);
    /// One per recipient, only for a payment split between more than one wallet. Paid.payout is then to[0].
    event PayoutSplit(bytes32 indexed paymentId, address indexed to, uint256 amount);
    event RefundedBy(bytes32 indexed paymentId, address indexed by);
    event RefundOperatorProposed(bytes32 indexed siteHash, address operator, uint64 activeAt);
    event Paused(bool paused);
    event QuoteSignerProposed(bytes32 indexed siteHash, address signer, uint64 activeAt);
    event AdminAdded(bytes32 indexed siteHash, address indexed admin, uint64 activeAt);
    event AdminRemoved(bytes32 indexed siteHash, address indexed admin);
    event AdminFrozen(bytes32 indexed siteHash, address indexed admin, uint64 until);
    event RecipientDropped(bytes32 indexed siteHash, address indexed recipient);
    event AttestorsProposed(uint256 indexed setId, address[] attestors, uint256 threshold, uint64 activeAt);

    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(
        IERC20 token_,
        string memory frameOrigin_,
        bytes32 rpIdHash_,
        address[] memory attestors,
        uint256 threshold_,
        uint64 delay_,
        address guardian_
    ) {
        require(address(token_).code.length > 0, "token has no code");
        require(delay_ > 0 && delay_ <= MAX_DELAY, "bad delay");
        uint8 decimals = token_.decimals();
        require(decimals <= 36, "bad decimals");
        token = token_;
        maxRelayerFee = 10 ** decimals;
        frameOrigin = frameOrigin_;
        rpIdHash = rpIdHash_;
        delay = delay_;
        guardian = guardian_;
        activeSet = _newSet(attestors, threshold_);
        activeThreshold = threshold_;
    }

    // --------------------------------------------------------------- attestors

    /// The attestor set and threshold in force now, counting a proposal whose delay has passed.
    function quorum() public view returns (uint256 setId, uint256 threshold) {
        if (pendingSet != 0 && block.timestamp >= pendingSetAt) return (pendingSet, pendingThreshold);
        return (activeSet, activeThreshold);
    }

    function isAttestor(address a) external view returns (bool) {
        (uint256 id,) = quorum();
        return inSet[id][a];
    }

    function pendingAttestors() external view returns (uint256 setId, uint256 threshold, uint64 activeAt) {
        return (pendingSet, pendingThreshold, pendingSetAt);
    }

    /// The current quorum proposes a new set; it takes effect after `delay`. A later proposal replaces a
    /// pending one. Signatures name the id the new set will get, so they cannot be replayed.
    function proposeAttestors(address[] calldata attestors, uint256 threshold_, Sig[] calldata sigs) external {
        _promoteSet();
        uint256 id = setCount + 1;
        _quorum(abi.encode(ROTATE_TYPEHASH, keccak256(abi.encodePacked(attestors)), threshold_, id), sigs);
        _newSet(attestors, threshold_);
        pendingSet = id;
        pendingThreshold = threshold_;
        pendingSetAt = uint64(block.timestamp) + delay;
        emit AttestorsProposed(id, attestors, threshold_, pendingSetAt);
    }

    /// Attestors must be sorted ascending: that makes them distinct, so `threshold` really means distinct keys.
    function _newSet(address[] memory attestors, uint256 threshold_) internal returns (uint256 id) {
        require(threshold_ > 0 && threshold_ <= attestors.length, "bad threshold");
        id = ++setCount;
        for (uint256 i; i < attestors.length; i++) {
            require(attestors[i] != address(0) && (i == 0 || attestors[i] > attestors[i - 1]), "attestors not sorted");
            inSet[id][attestors[i]] = true;
        }
    }

    function _promoteSet() internal {
        if (pendingSet != 0 && block.timestamp >= pendingSetAt) {
            activeSet = pendingSet;
            activeThreshold = pendingThreshold;
            pendingSet = 0;
            pendingThreshold = 0;
        }
    }

    /// At least `threshold` signatures over `head` + each one's own deadline, by distinct members of the
    /// active set, sorted by signer address. Call _promoteSet() first.
    function _quorum(bytes memory head, Sig[] calldata sigs) internal view {
        require(sigs.length >= activeThreshold, "too few attestations");
        address last;
        for (uint256 i; i < sigs.length; i++) {
            require(block.timestamp <= sigs[i].deadline, "attestation expired");
            bytes32 digest = _digest(keccak256(bytes.concat(head, abi.encode(sigs[i].deadline))));
            address a = _recover(digest, sigs[i].v, sigs[i].r, sigs[i].s);
            require(inSet[activeSet][a], "not attestor");
            require(a > last, "attestors not sorted");
            last = a;
        }
    }

    // ---------------------------------------------------------------- registry

    /// DNS-TXT attestations from `threshold` attestors set the payout split. Each signature names the active
    /// attestor set's id, so a signature made for an earlier set does not count after a rotation. A new site is live at once;
    /// an existing site's split only changes after `delay`, and never while frozen.
    function register(string calldata site, address[] calldata to, uint16[] calldata bps, Sig[] calldata sigs) external {
        _checkSplit(to, bps);
        _promoteSet();
        bytes32 siteHash = keccak256(bytes(site));
        Site storage st = _sites[siteHash];
        _quorum(
            abi.encode(
                ATTEST_TYPEHASH, siteHash, keccak256(abi.encodePacked(to)), keccak256(abi.encodePacked(bps)), st.nonce, activeSet
            ),
            sigs
        );
        st.nonce++;
        st.version++;

        if (st.payout.to.length == 0) {
            st.payout = Split(to, bps);
            emit Registered(siteHash, site, to[0]);
            emit SplitSet(siteHash, to, bps, uint64(block.timestamp));
            return;
        }
        require(!st.frozen, "frozen");
        _promote(st);
        st.pending = Split(to, bps);
        st.activeAt = uint64(block.timestamp) + delay;
        emit PayoutProposed(siteHash, to[0], st.activeAt);
        emit SplitSet(siteHash, to, bps, st.activeAt);
    }

    function _checkSplit(address[] calldata to, uint16[] calldata bps) internal view {
        require(to.length > 0 && to.length <= MAX_RECIPIENTS && bps.length == to.length, "bad split");
        uint256 sum;
        for (uint256 i; i < to.length; i++) {
            require(to[i] != address(0) && to[i] != address(this) && bps[i] > 0, "bad split");
            for (uint256 j; j < i; j++) require(to[j] != to[i], "bad split");
            sum += bps[i];
        }
        require(sum == BPS, "bad split");
    }

    /// v1's getter shape: the first wallet of the current and of the pending split.
    function sites(bytes32 siteHash)
        external
        view
        returns (address payout, address pendingPayout, uint64 activeAt, bool frozen, uint256 nonce)
    {
        Site storage st = _sites[siteHash];
        bool adminFrozen = block.timestamp < st.adminFrozenUntil && !_ownerChangeDue(st);
        return (_first(st.payout), _first(st.pending), st.activeAt, st.frozen || adminFrozen, st.nonce);
    }

    /// The owner's freeze (until it unfreezes) and an admin's (until `adminUntil`, if in the future).
    function freezeOf(bytes32 siteHash) external view returns (bool ownerFrozen, uint64 adminUntil) {
        Site storage st = _sites[siteHash];
        return (st.frozen, _ownerChangeDue(st) ? 0 : st.adminFrozenUntil);
    }

    function splitOf(bytes32 siteHash)
        external
        view
        returns (address[] memory to, uint16[] memory bps, address[] memory pendingTo, uint16[] memory pendingBps, uint64 activeAt)
    {
        Site storage st = _sites[siteHash];
        return (st.payout.to, st.payout.bps, st.pending.to, st.pending.bps, st.activeAt);
    }

    /// The owner's freeze lasts until the owner unfreezes: payments and split changes stop, and a pending split
    /// change is dropped.
    /// An admin's freeze only stops payments, for ADMIN_FREEZE, and leaves a pending split change alone. So an admin
    /// can buy the owner time but cannot cancel a change the attestors approved, such as a recovery after the owner's
    /// key is lost; when that change makes someone else the owner, every admin is removed.
    function freeze(bytes32 siteHash) external {
        Site storage st = _sites[siteHash];
        _promote(st);
        if (msg.sender == _first(st.payout)) {
            st.frozen = true;
            delete st.pending;
            emit Frozen(siteHash);
        } else {
            require(isAdmin(siteHash, msg.sender), "not payout");
            st.adminFrozenUntil = uint64(block.timestamp) + ADMIN_FREEZE;
            emit AdminFrozen(siteHash, msg.sender, st.adminFrozenUntil);
        }
        st.version++;
    }

    /// Lifts the owner's freeze and any admin's.
    function unfreeze(bytes32 siteHash) external {
        Site storage st = _owned(siteHash);
        st.frozen = false;
        st.adminFrozenUntil = 0;
        st.version++;
        emit Unfrozen(siteHash);
    }

    /// Owner only, immediate: takes a recipient other than the owner out of the current split and gives its share
    /// to the owner, e.g. when the token refuses transfers to it, which makes every payment revert. It can only
    /// remove; adding a recipient or moving a share anywhere but to the owner still needs the attestors and `delay`.
    function dropRecipient(bytes32 siteHash, address recipient) external {
        Site storage st = _owned(siteHash);
        address[] storage to = st.payout.to;
        uint16[] storage bps = st.payout.bps;
        for (uint256 i = 1; i < to.length; i++) {
            if (to[i] != recipient) continue;
            bps[0] += bps[i];
            to[i] = to[to.length - 1];
            bps[i] = bps[bps.length - 1];
            to.pop();
            bps.pop();
            st.version++;
            emit RecipientDropped(siteHash, recipient);
            emit SplitSet(siteHash, to, bps, uint64(block.timestamp));
            return;
        }
        revert("not a recipient");
    }

    /// Applies due changes, then requires the caller to be the owner.
    function _owned(bytes32 siteHash) internal returns (Site storage st) {
        st = _sites[siteHash];
        _promote(st);
        require(msg.sender == _first(st.payout), "not payout");
    }

    function _first(Split storage sp) internal view returns (address) {
        return sp.to.length == 0 ? address(0) : sp.to[0];
    }

    /// The owner names a wallet that may also refund; it takes effect after `delay`. address(0) removes it.
    function setRefundOperator(bytes32 siteHash, address operator) external {
        Site storage st = _owned(siteHash);
        st.pendingOperator = operator;
        st.operatorAt = uint64(block.timestamp) + delay;
        st.version++;
        emit RefundOperatorProposed(siteHash, operator, st.operatorAt);
    }

    function refundOperatorOf(bytes32 siteHash) external view returns (address operator, address pending, uint64 activeAt) {
        Site storage st = _sites[siteHash];
        return (st.refundOperator, st.pendingOperator, st.operatorAt);
    }

    /// The owner names the key that must sign each payment's Quote (its merchant backend); it takes effect
    /// after `delay`. address(0) stops requiring quotes, also after `delay`.
    function setQuoteSigner(bytes32 siteHash, address signer) external {
        Site storage st = _owned(siteHash);
        st.pendingQuoteSigner = signer;
        st.quoteSignerAt = uint64(block.timestamp) + delay;
        st.version++;
        emit QuoteSignerProposed(siteHash, signer, st.quoteSignerAt);
    }

    function quoteSignerOf(bytes32 siteHash) external view returns (address signer, address pending, uint64 activeAt) {
        Site storage st = _sites[siteHash];
        return (st.quoteSigner, st.pendingQuoteSigner, st.quoteSignerAt);
    }

    /// Up to MAX_ADMINS per site. Adding waits `delay`; removing is immediate. Owner only. Both, and an added
    /// admin's rights starting, bump the config version.
    function addAdmin(bytes32 siteHash, address admin) external {
        Site storage st = _owned(siteHash);
        require(admin != address(0) && _adminIndex(st, admin) == type(uint256).max, "bad admin");
        require(st.admins.length < MAX_ADMINS, "too many admins");
        uint64 at = uint64(block.timestamp) + delay;
        st.admins.push(Admin(admin, at, false));
        st.version++;
        emit AdminAdded(siteHash, admin, at);
    }

    function removeAdmin(bytes32 siteHash, address admin) external {
        Site storage st = _owned(siteHash);
        uint256 i = _adminIndex(st, admin);
        require(i != type(uint256).max, "not admin");
        st.admins[i] = st.admins[st.admins.length - 1];
        st.admins.pop();
        st.version++;
        emit AdminRemoved(siteHash, admin);
    }

    function isAdmin(bytes32 siteHash, address a) public view returns (bool) {
        Site storage st = _sites[siteHash];
        uint256 i = _adminIndex(st, a);
        return i != type(uint256).max && block.timestamp >= st.admins[i].from && !_ownerChangeDue(st);
    }

    function adminsOf(bytes32 siteHash) external view returns (address[] memory who, uint64[] memory from) {
        Admin[] storage list = _sites[siteHash].admins;
        who = new address[](list.length);
        from = new uint64[](list.length);
        for (uint256 i; i < list.length; i++) {
            (who[i], from[i]) = (list[i].who, list[i].from);
        }
    }

    function _adminIndex(Site storage st, address a) internal view returns (uint256) {
        for (uint256 i; i < st.admins.length; i++) {
            if (st.admins[i].who == a) return i;
        }
        return type(uint256).max;
    }

    /// The version a payment must sign now: the stored one plus each pending change whose delay has passed,
    /// which the next transaction touching the site applies.
    function configVersion(bytes32 siteHash) external view returns (uint256 v) {
        Site storage st = _sites[siteHash];
        v = st.version;
        if (st.pending.to.length != 0 && block.timestamp >= st.activeAt) {
            v++;
            if (_ownerChangeDue(st)) return v; // _promote clears every role, so nothing below applies
        }
        if (st.operatorAt != 0 && block.timestamp >= st.operatorAt) v++;
        if (st.quoteSignerAt != 0 && block.timestamp >= st.quoteSignerAt) v++;
        for (uint256 i; i < st.admins.length; i++) {
            if (!st.admins[i].counted && block.timestamp >= st.admins[i].from) v++;
        }
    }

    /// A pending split whose delay has passed names a different owner (first wallet).
    function _ownerChangeDue(Site storage st) internal view returns (bool) {
        return st.pending.to.length != 0 && block.timestamp >= st.activeAt && st.pending.to[0] != _first(st.payout);
    }

    function _promote(Site storage st) internal {
        if (st.pending.to.length != 0 && block.timestamp >= st.activeAt) {
            // A new owner starts clean: the old owner's operator, quote signer, admins and admin freeze end here.
            if (_ownerChangeDue(st)) {
                (st.refundOperator, st.pendingOperator, st.operatorAt) = (address(0), address(0), 0);
                (st.quoteSigner, st.pendingQuoteSigner, st.quoteSignerAt) = (address(0), address(0), 0);
                delete st.admins;
                st.adminFrozenUntil = 0;
            }
            st.payout = st.pending;
            delete st.pending;
            st.version++;
        }
        if (st.operatorAt != 0 && block.timestamp >= st.operatorAt) {
            st.refundOperator = st.pendingOperator;
            st.pendingOperator = address(0);
            st.operatorAt = 0;
            st.version++;
        }
        if (st.quoteSignerAt != 0 && block.timestamp >= st.quoteSignerAt) {
            st.quoteSigner = st.pendingQuoteSigner;
            st.pendingQuoteSigner = address(0);
            st.quoteSignerAt = 0;
            st.version++;
        }
        for (uint256 i; i < st.admins.length; i++) {
            if (!st.admins[i].counted && block.timestamp >= st.admins[i].from) {
                st.admins[i].counted = true;
                st.version++;
            }
        }
    }

    /// Stops new pay() calls only. Refunds, registrations, freezes and bindings keep working.
    function setPaused(bool paused_) external {
        require(msg.sender == guardian, "not guardian");
        paused = paused_;
        emit Paused(paused_);
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
        bytes32 pk = keccak256(abi.encode(pubX, pubY));
        require(pubKeyOwner[pk] == bytes32(0) || pubKeyOwner[pk] == credentialHash, "pubkey taken");
        bytes32 digest = _digest(
            keccak256(
                abi.encode(BIND_TYPEHASH, credentialHash, pubX, pubY, perPayCap, totalCap, expiry, bindNonce[wallet])
            )
        );
        require(_recover(digest, v, r, s) == wallet, "bad binding signature");
        bindNonce[wallet]++;
        if (b.wallet != address(0)) delete pubKeyOwner[keccak256(abi.encode(b.pubX, b.pubY))];
        pubKeyOwner[pk] = credentialHash;
        buyers[credentialHash] = Buyer(wallet, pubX, pubY, perPayCap, totalCap, 0, expiry);
        emit Bound(credentialHash, wallet, perPayCap, totalCap, expiry);
    }

    function unbind(bytes32 credentialHash) external {
        Buyer storage b = buyers[credentialHash];
        require(b.wallet == msg.sender, "not wallet");
        bindNonce[msg.sender]++;
        delete pubKeyOwner[keccak256(abi.encode(b.pubX, b.pubY))];
        delete buyers[credentialHash];
        emit Unbound(credentialHash, msg.sender);
    }

    // --------------------------------------------------------------------- pay

    /// Permissionless: anyone can submit, the signature fixes site, the site's config version, order, amount
    /// and fee.
    /// The payout is never an input; it comes from the registry entry of the signed topOrigin.
    /// For a site without a quote signer.
    function pay(PayInput calldata p) external nonReentrant returns (bytes32 paymentId) {
        bytes32 siteHash;
        address wallet;
        (siteHash, wallet) = _check(p);
        require(_sites[siteHash].quoteSigner == address(0), "quote required");
        return _settle(p, wallet, siteHash);
    }

    /// For a site with a quote signer: its signature over Quote(siteHash, orderId, token, amount, expiry) fixes
    /// the amount for that order, so page code that changes the amount cannot get the payment through.
    function payWithQuote(PayInput calldata p, uint64 quoteExpiry, bytes calldata quoteSig)
        external
        nonReentrant
        returns (bytes32 paymentId)
    {
        bytes32 siteHash;
        address wallet;
        (siteHash, wallet) = _check(p);
        address signer = _sites[siteHash].quoteSigner;
        require(signer != address(0), "no quote signer");
        require(block.timestamp <= quoteExpiry, "quote expired");
        bytes32 digest =
            _digest(keccak256(abi.encode(QUOTE_TYPEHASH, siteHash, p.orderId, address(token), p.amount, quoteExpiry)));
        require(_validSig(signer, digest, quoteSig), "bad quote");
        return _settle(p, wallet, siteHash);
    }

    function _check(PayInput calldata p) internal returns (bytes32 siteHash, address wallet) {
        require(!paused, "paused");
        require(p.amount > 0, "zero amount");
        require(p.relayerFee <= maxRelayerFee, "fee over cap");
        Buyer storage b = buyers[p.credentialHash];
        _spend(b, p.amount + p.relayerFee);
        siteHash = _verify(p, b);
        wallet = b.wallet;
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
        Site storage st = _sites[siteHash];
        _promote(st); // so the version below counts any change whose delay has passed

        require(block.timestamp <= p.deadline, "deadline passed");
        bytes32 challenge = keccak256(
            abi.encode(
                block.chainid, address(this), siteHash, st.version, p.orderId, p.amount, p.relayerFee, p.deadline
            )
        );
        require(_at(cd, p.challengeIdx, bytes.concat('"challenge":"', _b64url(challenge), '"')), "bad challenge");

        require(!orderUsed[siteHash][p.orderId], "order used");
        orderUsed[siteHash][p.orderId] = true;

        bytes32 hash = sha256(bytes.concat(p.authenticatorData, sha256(bytes(p.clientDataJSON))));
        require(_p256(hash, p.r, p.s, b.pubX, b.pubY), "bad passkey signature");
    }

    function _settle(PayInput calldata p, address wallet, bytes32 siteHash) internal returns (bytes32 paymentId) {
        Site storage st = _sites[siteHash];
        require(st.payout.to.length != 0, "site not registered");
        require(!st.frozen && block.timestamp >= st.adminFrozenUntil, "frozen");

        paymentId = keccak256(abi.encode(siteHash, p.orderId));
        payments[paymentId] = Payment(wallet, siteHash, p.amount, 0);
        address[] storage to = st.payout.to;
        if (to.length == 1) {
            _transferFrom(wallet, to[0], p.amount);
        } else {
            // Each later wallet gets its floor share; the first gets the rest, so the parts sum to the amount.
            uint256 rest = p.amount;
            for (uint256 i = 1; i < to.length; i++) {
                uint256 part = p.amount * st.payout.bps[i] / BPS;
                rest -= part;
                if (part > 0) _transferFrom(wallet, to[i], part);
                emit PayoutSplit(paymentId, to[i], part);
            }
            _transferFrom(wallet, to[0], rest);
            emit PayoutSplit(paymentId, to[0], rest);
        }
        if (p.relayerFee > 0) _transferFrom(wallet, msg.sender, p.relayerFee);

        bytes calldata cd = bytes(p.clientDataJSON);
        uint256 from = p.topOriginIdx + 13;
        emit Paid(paymentId, siteHash, string(cd[from:_quote(cd, from)]), p.orderId, wallet, to[0], p.amount);
    }

    // ------------------------------------------------------------------ refund

    /// Refunds are paid by the refunder: the site's owner (its first payout wallet), its refund operator or an admin
    /// sends its own tokens, through its allowance to this contract, to the ORIGINAL payer only. Split
    /// recipients are never charged. The total refunded per payment is capped at the payment's amount; the
    /// relayer fee is not part of it and is not refundable.
    function refund(bytes32 paymentId, uint256 amount) external nonReentrant {
        Payment storage pm = payments[paymentId];
        require(pm.wallet != address(0), "no such payment");
        Site storage st = _sites[pm.siteHash];
        _promote(st);
        require(
            msg.sender == _first(st.payout) || msg.sender == st.refundOperator || isAdmin(pm.siteHash, msg.sender),
            "not refunder"
        );
        require(pm.refunded + amount <= pm.amount, "over refund");
        pm.refunded += amount;
        _transferFrom(msg.sender, pm.wallet, amount);
        emit Refunded(paymentId, pm.wallet, amount);
        emit RefundedBy(paymentId, msg.sender);
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

    /// An EOA's 65-byte (r, s, v) signature, or an ERC-1271 contract's answer.
    function _validSig(address signer, bytes32 digest, bytes calldata sig) internal view returns (bool) {
        if (signer.code.length > 0) {
            (bool ok, bytes memory ret) = signer.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, sig)));
            return ok && ret.length == 32 && abi.decode(ret, (bytes4)) == IERC1271.isValidSignature.selector;
        }
        if (sig.length != 65) return false;
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) return false;
        address a = ecrecover(digest, uint8(sig[64]), r, s);
        return a != address(0) && a == signer;
    }

    /// True when the JSON key pattern `want` sits exactly at `idx`, right after a `{` or `,`.
    function _at(bytes calldata data, uint256 idx, bytes memory want) internal pure returns (bool) {
        if (idx == 0 || idx + want.length > data.length) return false;
        if (data[idx - 1] != "{" && data[idx - 1] != ",") return false;
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
