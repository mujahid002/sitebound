// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Test-only stand-in for the RIP-7212 precompile at 0x100 (forge has none). Slow, textbook affine math.
contract P256Verifier {
    uint256 constant P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff;
    uint256 constant N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;
    uint256 constant GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296;
    uint256 constant GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5;

    fallback(bytes calldata input) external returns (bytes memory) {
        if (input.length != 160) return "";
        (bytes32 h, uint256 r, uint256 s, uint256 x, uint256 y) = abi.decode(input, (bytes32, uint256, uint256, uint256, uint256));
        if (r == 0 || r >= N || s == 0 || s >= N) return "";
        uint256 w = _inv(s, N);
        (uint256 ax, uint256 ay) = _mul(mulmod(uint256(h), w, N), GX, GY);
        (uint256 bx, uint256 by) = _mul(mulmod(r, w, N), x, y);
        (uint256 rx,) = _add(ax, ay, bx, by);
        return rx % N == r ? abi.encode(uint256(1)) : bytes("");
    }

    function _inv(uint256 a, uint256 m) internal view returns (uint256 out) {
        (bool ok, bytes memory ret) = address(5).staticcall(abi.encode(32, 32, 32, a, m - 2, m));
        require(ok);
        out = abi.decode(ret, (uint256));
    }

    function _add(uint256 x1, uint256 y1, uint256 x2, uint256 y2) internal view returns (uint256, uint256) {
        if (x1 == 0 && y1 == 0) return (x2, y2);
        if (x2 == 0 && y2 == 0) return (x1, y1);
        uint256 l;
        if (x1 == x2) {
            if (y1 != y2 || y1 == 0) return (0, 0);
            l = mulmod(addmod(mulmod(3, mulmod(x1, x1, P), P), P - 3, P), _inv(mulmod(2, y1, P), P), P);
        } else {
            l = mulmod(addmod(y2, P - y1, P), _inv(addmod(x2, P - x1, P), P), P);
        }
        uint256 x3 = addmod(addmod(mulmod(l, l, P), P - x1, P), P - x2, P);
        uint256 y3 = addmod(mulmod(l, addmod(x1, P - x3, P), P), P - y1, P);
        return (x3, y3);
    }

    function _mul(uint256 k, uint256 x, uint256 y) internal view returns (uint256 rx, uint256 ry) {
        for (uint256 i = 256; i > 0; i--) {
            (rx, ry) = _add(rx, ry, rx, ry);
            if ((k >> (i - 1)) & 1 == 1) (rx, ry) = _add(rx, ry, x, y);
        }
    }
}
