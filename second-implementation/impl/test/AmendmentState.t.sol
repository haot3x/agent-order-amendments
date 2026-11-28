// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.30;

import "./Base.sol";

/// ERC-8448 "Amendment state view" and "Scope and authoritative order".
contract AmendmentStateTest is Base {
    bytes32 internal constant OFFERED = keccak256("order-offered");

    function test_view_unknownOrderReverts() public {
        bytes32 id = keccak256("never created");
        vm.expectRevert(abi.encodeWithSelector(IOrderAmendments.UnknownOrder.selector, id));
        coord.getAmendmentState(id);
    }

    function test_view_unusedZeroIdReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IOrderAmendments.UnknownOrder.selector, bytes32(0)));
        coord.getAmendmentState(bytes32(0));
    }

    function test_view_selectorAndReturnLayout() public view {
        bytes4 selector = bytes4(keccak256("getAmendmentState(bytes32)"));
        assertEq(selector, IOrderAmendments.getAmendmentState.selector);
        (bool ok, bytes memory ret) = address(coord).staticcall(abi.encodeWithSelector(selector, ORDER));
        assertTrue(ok);
        // 6 head words + 4 inline Terms words + 1 bool: fully static, no offsets.
        assertEq(ret.length, 11 * 32);
        (
            address b,
            address p,
            address asset,
            uint64 rev,
            bytes32 th,
            uint256 nonce,
            bytes32 scope,
            bytes32 acc,
            uint256 price,
            uint64 deadline,
            bool eligible
        ) = abi.decode(
            ret, (address, address, address, uint64, bytes32, uint256, bytes32, bytes32, uint256, uint64, bool)
        );
        assertEq(b, buyer);
        assertEq(p, provider);
        assertEq(asset, address(token));
        assertEq(rev, 0);
        assertEq(nonce, 0);
        assertEq(scope, SCOPE_A);
        assertEq(acc, ACCEPT_A);
        assertEq(price, 100);
        assertEq(deadline, DEADLINE);
        assertTrue(eligible);
        assertEq(th, keccak256(abi.encode(TERMS_TYPEHASH, scope, acc, price, deadline)));
    }

    function test_view_unknownOrderErrorSelector() public pure {
        assertEq(IOrderAmendments.UnknownOrder.selector, bytes4(keccak256("UnknownOrder(bytes32)")));
    }

    function test_view_callableByAnyAddress() public {
        vm.prank(stranger);
        (address b,,,,,,,) = coord.getAmendmentState(ORDER);
        assertEq(b, buyer);
    }

    function test_view_activeOrderIsEligibleWithAuthoritativeState() public view {
        S memory s = _state(ORDER);
        assertEq(s.buyer, buyer);
        assertEq(s.provider, provider);
        assertTrue(s.buyer != s.provider && s.buyer != address(0) && s.provider != address(0));
        assertEq(s.asset, address(token));
        assertEq(s.revision, 0);
        assertEq(s.nonce, 0);
        assertEq(s.termsHash, _hashTerms(s.terms));
        assertTrue(s.eligible);
    }

    function test_view_offeredOrderIsKnownButIneligible() public {
        _createOffered(OFFERED, 50, DEADLINE);
        S memory s = _state(OFFERED);
        assertEq(s.buyer, buyer);
        assertEq(s.provider, provider);
        assertEq(s.terms.totalPrice, 50);
        assertEq(s.termsHash, _hashTerms(s.terms));
        // it holds tokens, but that alone does not make it eligible
        assertEq(token.balanceOf(address(coord)), 150);
        assertFalse(s.eligible);
    }

    function test_view_submittedOrderIneligible() public {
        _submit(ORDER);
        S memory s = _state(ORDER);
        assertFalse(s.eligible);
        assertEq(s.terms.totalPrice, 100);
        assertEq(s.termsHash, _hashTerms(s.terms));
    }

    function test_view_cancelledOrderIneligible() public {
        _createOffered(OFFERED, 50, DEADLINE);
        vm.prank(buyer);
        coord.cancelOrder(OFFERED);
        S memory s = _state(OFFERED);
        assertFalse(s.eligible);
        assertEq(s.buyer, buyer);
        assertEq(s.termsHash, _hashTerms(s.terms));
    }

    function test_view_settledOrderIneligible() public {
        _submit(ORDER);
        vm.prank(buyer);
        coord.acceptAndPay(ORDER);
        S memory s = _state(ORDER);
        assertFalse(s.eligible);
        assertEq(s.provider, provider);
        assertEq(s.terms.totalPrice, 100);
    }

    function test_view_refundedOrderIneligible() public {
        vm.warp(DEADLINE);
        vm.prank(buyer);
        coord.refundAfterDeadline(ORDER);
        vm.warp(T0); // even "before the deadline" a terminal order stays ineligible
        assertFalse(_state(ORDER).eligible);
    }

    function test_view_deadlineEqualityIsIneligible() public {
        vm.warp(DEADLINE - 1);
        assertTrue(_state(ORDER).eligible);
        vm.warp(DEADLINE);
        S memory s = _state(ORDER);
        assertFalse(s.eligible);
        assertEq(s.terms.deadline, DEADLINE); // still readable
        vm.warp(DEADLINE + 1);
        assertFalse(_state(ORDER).eligible);
    }

    function test_view_usesAmendedDeadlineAfterExtension() public {
        uint64 extended = DEADLINE + 5_000;
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, extended));
        (bool ok,) = _execute(ih, p);
        assertTrue(ok);

        vm.warp(DEADLINE); // the old deadline no longer matters
        S memory s = _state(ORDER);
        assertTrue(s.eligible);
        assertEq(s.terms.deadline, extended);
        vm.warp(extended - 1);
        assertTrue(_state(ORDER).eligible);
        vm.warp(extended);
        assertFalse(_state(ORDER).eligible);
    }

    function test_view_invalidationAdvancesOnlyNonce() public {
        S memory before = _state(ORDER);
        vm.prank(provider);
        coord.invalidateAmendments(ORDER);
        S memory afterS = _state(ORDER);
        assertEq(afterS.nonce, before.nonce + 1);
        assertEq(afterS.revision, before.revision);
        assertEq(afterS.termsHash, before.termsHash);
        assertEq(keccak256(abi.encode(afterS.terms)), keccak256(abi.encode(before.terms)));
        assertTrue(afterS.eligible);
    }

    function test_view_eligibilityIgnoresBalancesAndAllowances() public {
        vm.startPrank(buyer);
        token.approve(address(coord), 0);
        token.transfer(stranger, token.balanceOf(buyer));
        vm.stopPrank();
        assertEq(token.balanceOf(buyer), 0);
        assertTrue(_state(ORDER).eligible);
    }

    function test_view_eligibilityIgnoresPendingProposals() public {
        _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        S memory s = _state(ORDER);
        assertTrue(s.eligible);
        assertEq(s.revision, 0);
        assertEq(s.nonce, 0);
        assertEq(s.terms.totalPrice, 100);
    }

    function test_view_termsHashMatchesTermsAfterAmendment() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE + 1));
        _execute(ih, p);
        S memory s = _state(ORDER);
        assertEq(s.termsHash, _hashTerms(s.terms));
        assertEq(s.terms.scopeHash, SCOPE_B);
        // identity, counterparties and asset are untouched by an amendment
        assertEq(s.buyer, buyer);
        assertEq(s.provider, provider);
        assertEq(s.asset, address(token));
    }
}
