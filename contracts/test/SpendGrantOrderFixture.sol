// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ExperimentalOrderAmendments} from "../ExperimentalOrderAmendments.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestToken} from "./Fixtures.sol";

// ABI boundary only: the unmodified upstream contracts are compiled separately
// with their pinned Solidity 0.8.28 compiler.
interface IRegisteredGrantView {
    function executor() external view returns (address);
    function parties(bytes32 grantId) external view returns (address principal, address delegate);
}
interface IRegisteredGrantExecutor {
    function registry() external view returns (address);
    function spend(bytes32 grantId, address asset, uint256 amount, address recipient) external;
}

/// @dev Local integration fixture: one immutable buyer, registry and executor,
/// one grant bound once by that buyer, shared across this fixture's orders.
/// No generic forwarding or detached payment authorization is exposed.
contract SpendGrantOrderFixture is ExperimentalOrderAmendments {
    address public immutable fundingPrincipal;
    IRegisteredGrantView public immutable fundingRegistry;
    IRegisteredGrantExecutor public immutable fundingExecutor;
    bytes32 public fundingGrantId;

    constructor(IERC20 token, address principal, IRegisteredGrantView registry_)
        ExperimentalOrderAmendments(token)
    {
        require(principal != address(0), "FUNDING_PRINCIPAL");
        fundingPrincipal = principal;
        fundingRegistry = registry_;
        IRegisteredGrantExecutor executor_ = IRegisteredGrantExecutor(registry_.executor());
        require(address(executor_).code.length > 0 && executor_.registry() == address(registry_), "FUNDING_EXECUTOR");
        fundingExecutor = executor_;
    }

    /// @dev Registration follows deployment because its delegate is this contract.
    /// Initial order funding cannot proceed until this one-time binding exists.
    function bindFundingGrant(bytes32 grantId) external {
        require(msg.sender == fundingPrincipal, "FUNDING_PRINCIPAL");
        require(fundingGrantId == bytes32(0) && grantId != bytes32(0), "GRANT_ALREADY_BOUND");
        (address principal, address delegate) = fundingRegistry.parties(grantId);
        require(principal == fundingPrincipal && delegate == address(this), "GRANT_PARTIES");
        fundingGrantId = grantId;
    }

    function _collectFunding(address buyer, uint256 amount) internal override {
        require(buyer == fundingPrincipal, "FUNDING_PRINCIPAL");
        bytes32 grantId = fundingGrantId;
        require(grantId != bytes32(0), "GRANT_NOT_BOUND");
        // The base contract derives amount from the current order and sends
        // funding here only after validating eligibility and the agreed terms.
        // The executor authenticates this contract as delegate; it is also the
        // fixed escrow recipient. No caller can substitute a payment target.
        fundingExecutor.spend(grantId, address(asset), amount, address(this));
    }
}

/// @dev Deliberately short-delivers while reporting success, to exercise the
/// order's balance check after the upstream executor has already returned.
contract SpendGrantTestToken is TestToken {
    bool public shortDelivery;
    function setShortDelivery(bool value) external { shortDelivery = value; }
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool ok = super.transferFrom(from, to, amount);
        if (shortDelivery && amount > 0) _burn(to, 1);
        return ok;
    }
}
