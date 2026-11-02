// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ExperimentalOrderAmendments} from "../ExperimentalOrderAmendments.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPreregisteredCriteria} from "../../vendor/erc8412/PreregisteredCriteria.sol";

/// @author Ted (@haot3x)
/// @dev Test-only 8412 composition: one required, non-waivable obligation, fixed
/// verifier, and criteria expiry equal to the signed order deadline. The registry
/// author is this contract; no EOA receives a unilateral supersession function.
/// Documents/evidence are checked off-chain. This is not a full 8412 verifier.
contract CriteriaOrderFixture is ExperimentalOrderAmendments {
    IPreregisteredCriteria public immutable criteriaRegistry;
    address public immutable criteriaVerifier;
    mapping(bytes32 => bytes32) public currentRegistration;

    constructor(IERC20 token, IPreregisteredCriteria registry, address verifier)
        ExperimentalOrderAmendments(token)
    {
        require(address(registry).code.length != 0 && verifier != address(0) && verifier != address(this), "CRITERIA_CONFIG");
        criteriaRegistry = registry;
        criteriaVerifier = verifier;
    }

    function taskRef(bytes32 orderId) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), orderId));
    }

    /// @dev Anyone can register the already mutually accepted initial terms;
    /// callers cannot select a digest, verifier, expiry or superseded record.
    function registerInitial(bytes32 orderId) external nonReentrant returns (bytes32) {
        Order memory order = this.getOrder(orderId);
        require(order.status == OrderStatus.Active && order.revision == 0, "INITIAL_STATE");
        require(currentRegistration[orderId] == bytes32(0), "ALREADY_REGISTERED");
        return _register(orderId, order.terms, bytes32(0));
    }

    function _register(bytes32 orderId, Terms memory terms, bytes32 prior) private returns (bytes32 next) {
        next = criteriaRegistry.preregister(terms.acceptanceHash, taskRef(orderId), 1, hex"40",
            terms.deadline, criteriaVerifier, prior);
        currentRegistration[orderId] = next;
    }

    function _beforeAmendment(AmendmentData memory d, Order storage current) internal override {
        bytes32 prior = currentRegistration[d.orderId];
        require(prior != bytes32(0), "CRITERIA_NOT_REGISTERED");
        // This fixture only exercises criteria-changing amendments. Ordinary
        // price-only changes remain supported by the unextended base contract.
        require(d.newTerms.acceptanceHash != current.terms.acceptanceHash, "CRITERIA_UNCHANGED");
        _register(d.orderId, d.newTerms, prior);
    }
}
