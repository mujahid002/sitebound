// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import {SiteboundV2, IERC20} from "../src/SiteboundV2.sol";

/// Deploys SiteboundV2. Settings come from the environment; the signer is whatever
/// `forge script --account <keystore>` (or --ledger) provides. No key is read here.
///   ATTESTORS     comma-separated, sorted ascending (the constructor rejects any other order)
///   THRESHOLD     signatures needed per registration and rotation (default 1)
///   FRAME_ORIGIN  e.g. https://sitebound-pay.pages.dev
///   RP_ID         e.g. sitebound-pay.pages.dev
///   DELAY         seconds before payout, split, operator, quote-signer, admin and attestor-set changes take
///                 effect (default 3600; the constructor requires 1 s to 30 days)
///   GUARDIAN      may pause new payments only (default address(0): no one can pause)
contract Deploy is Script {
    address constant USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;

    function run() external {
        address[] memory attestors = vm.envAddress("ATTESTORS", ",");
        uint256 threshold = vm.envOr("THRESHOLD", uint256(1));
        string memory frameOrigin = vm.envString("FRAME_ORIGIN");
        bytes32 rpIdHash = sha256(bytes(vm.envString("RP_ID")));
        uint64 delay = uint64(vm.envOr("DELAY", uint256(1 hours)));
        address guardian = vm.envOr("GUARDIAN", address(0));
        vm.startBroadcast();
        SiteboundV2 sb = new SiteboundV2(IERC20(USDT), frameOrigin, rpIdHash, attestors, threshold, delay, guardian);
        vm.stopBroadcast();
        console.log("SiteboundV2", address(sb));
        console.log("threshold", threshold, "of", attestors.length);
        console.log("delay", delay);
        console.log("maxRelayerFee", sb.maxRelayerFee());
        console.log("guardian", guardian);
    }
}
