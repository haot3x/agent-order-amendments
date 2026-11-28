// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ExperimentalOrderAmendments} from "../ExperimentalOrderAmendments.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @author Ted (@haot3x)
/// @dev Test-only ERC-8505 source: mirrors the order lifecycle as events whose
/// first indexed parameter is the task id, `uint256(orderId)`, so a descriptor
/// can declare them. `brief` is the order's terms hash. An applied amendment
/// emits `TaskSupplemented` inside the isolated application call, next to
/// `OrderAmendmentApplied`, so a failed application leaves no such log.
/// The buyer is the only evaluator of this fixture and it has no reject path.
contract WorkRecordOrderFixture is ExperimentalOrderAmendments {
    event TaskFunded(uint256 indexed task, address indexed client, uint256 amount, bytes32 brief);
    event WorkerAssigned(uint256 indexed task, address indexed worker);
    event TaskSupplemented(uint256 indexed task, uint256 amount, bytes32 brief);
    event WorkDelivered(uint256 indexed task, address indexed worker, bytes32 result);
    event Verdict(uint256 indexed task, address indexed evaluator, bool accepted, bytes32 ref);
    event TaskPaid(uint256 indexed task, address indexed worker, address indexed to, uint256 amount, uint256 fee);
    event TaskRefunded(uint256 indexed task, address indexed to, uint256 amount);

    constructor(IERC20 token) ExperimentalOrderAmendments(token) {}

    function _afterOffered(bytes32 id, Order storage o) internal override {
        emit TaskFunded(uint256(id), o.buyer, o.escrow, o.termsHash);
    }
    /// @dev Only the provider can activate, so this is the worker's own act.
    function _afterActivated(bytes32 id, Order storage o) internal override {
        emit WorkerAssigned(uint256(id), o.provider);
    }
    /// @dev `supplement` is zero for an amendment that leaves the price unchanged.
    function _afterAmended(bytes32 id, Order storage o, uint256 supplement) internal override {
        emit TaskSupplemented(uint256(id), supplement, o.termsHash);
    }
    function _afterSubmitted(bytes32 id, Order storage o) internal override {
        emit WorkDelivered(uint256(id), o.provider, o.resultHash);
    }
    /// @dev `acceptDelivery` is the only verdict and it always accepts; `ref`
    /// is the terms hash the buyer accepted against.
    function _afterPaid(bytes32 id, Order storage o, uint256 amount) internal override {
        emit Verdict(uint256(id), o.buyer, true, o.termsHash);
        emit TaskPaid(uint256(id), o.provider, o.provider, amount, 0);
    }
    function _afterRefunded(bytes32 id, Order storage o, uint256 amount) internal override {
        emit TaskRefunded(uint256(id), o.buyer, amount);
    }
}
