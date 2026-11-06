// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import {Sitebound, IERC20} from "../src/Sitebound.sol";

/// FRAME_ORIGIN, RP_ID and ATTESTOR come from the environment; the signer is whatever
/// `forge script --account <keystore>` (or --ledger) provides. No key is read here.
contract Deploy is Script {
    address constant USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;

    function run() external {
        address[] memory attestors = new address[](1);
        attestors[0] = vm.envAddress("ATTESTOR");
        vm.startBroadcast();
        Sitebound sb = new Sitebound(
            IERC20(USDT),
            vm.envString("FRAME_ORIGIN"),
            sha256(bytes(vm.envString("RP_ID"))),
            attestors,
            uint64(vm.envOr("DELAY", uint256(1 hours)))
        );
        vm.stopBroadcast();
        console.log("Sitebound", address(sb));
    }
}
