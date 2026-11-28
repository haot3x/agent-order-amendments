// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.30;

import "./Base.sol";

/// The application-defined order API, and the ERC-8448 submission rules it has to satisfy.
contract OrderLifecycleTest is Base {
    bytes32 internal constant NEW = keccak256("new order");

    function _st(bytes32 id) internal view returns (AgentOrderAmendments.OrderStatus st) {
        (st,,) = coord.getOrder(id);
    }

    // ------------------------------------------------------------------ creation and agreement

    function test_create_fundsEscrowAndIsOffered() public {
        Terms memory t = _terms(SCOPE_A, 70, DEADLINE);
        vm.expectEmit(true, true, true, true, address(coord));
        emit AgentOrderAmendments.OrderCreated(NEW, buyer, provider, address(token), _hashTerms(t), t);
        vm.prank(buyer);
        coord.createOrder(NEW, provider, address(token), t);
        assertEq(uint8(_st(NEW)), uint8(AgentOrderAmendments.OrderStatus.Offered));
        assertEq(token.balanceOf(address(coord)), 170);
        (, uint256 escrowed,) = coord.getOrder(NEW);
        assertEq(escrowed, 70);
    }

    function test_create_rejectsInvalidParameters() public {
        Terms memory ok = _terms(SCOPE_A, 70, DEADLINE);
        bytes4 err = AgentOrderAmendments.InvalidOrderParameters.selector;

        vm.startPrank(buyer);
        vm.expectRevert(err); // zero id
        coord.createOrder(bytes32(0), provider, address(token), ok);
        vm.expectRevert(err); // buyer == provider
        coord.createOrder(NEW, buyer, address(token), ok);
        vm.expectRevert(err); // zero provider
        coord.createOrder(NEW, address(0), address(token), ok);
        vm.expectRevert(err); // zero asset
        coord.createOrder(NEW, provider, address(0), ok);
        vm.expectRevert(err); // asset without code
        coord.createOrder(NEW, provider, address(0xC0DE), ok);
        vm.expectRevert(err); // zero price
        coord.createOrder(NEW, provider, address(token), _terms(SCOPE_A, 0, DEADLINE));
        vm.expectRevert(err); // zero scope commitment
        coord.createOrder(NEW, provider, address(token), _terms(bytes32(0), 70, DEADLINE));
        vm.expectRevert(err); // zero acceptance commitment
        coord.createOrder(NEW, provider, address(token), Terms(SCOPE_A, bytes32(0), 70, DEADLINE));
        vm.expectRevert(err); // deadline not in the future
        coord.createOrder(NEW, provider, address(token), _terms(SCOPE_A, 70, uint64(block.timestamp)));
        vm.expectRevert(abi.encodeWithSelector(AgentOrderAmendments.OrderIdTaken.selector, ORDER));
        coord.createOrder(ORDER, provider, address(token), ok);
        vm.stopPrank();
    }

    function test_agree_onlyProviderWithMatchingTermsBeforeDeadline() public {
        _createOffered(NEW, 70, DEADLINE);
        bytes32 th = _hashTerms(_terms(SCOPE_A, 70, DEADLINE));

        vm.prank(buyer);
        vm.expectRevert(AgentOrderAmendments.NotProvider.selector);
        coord.agreeOrder(NEW, th);
        vm.prank(provider);
        vm.expectRevert(AgentOrderAmendments.TermsHashMismatch.selector);
        coord.agreeOrder(NEW, keccak256("other"));

        uint256 snap = vm.snapshotState();
        vm.warp(DEADLINE);
        vm.prank(provider);
        vm.expectRevert(AgentOrderAmendments.DeadlinePassed.selector);
        coord.agreeOrder(NEW, th);
        vm.revertToState(snap);

        assertFalse(_state(NEW).eligible);
        vm.expectEmit(true, true, true, true, address(coord));
        emit AgentOrderAmendments.OrderAgreed(NEW, provider, th);
        vm.prank(provider);
        coord.agreeOrder(NEW, th);
        assertTrue(_state(NEW).eligible); // effective only now
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(AgentOrderAmendments.WrongOrderStatus.selector, NEW));
        coord.agreeOrder(NEW, th);
    }

    function test_cancelOffer_refundsBuyer() public {
        _createOffered(NEW, 70, DEADLINE);
        vm.prank(provider);
        vm.expectRevert(AgentOrderAmendments.NotBuyer.selector);
        coord.cancelOrder(NEW);
        uint256 before = token.balanceOf(buyer);
        vm.prank(buyer);
        coord.cancelOrder(NEW);
        assertEq(token.balanceOf(buyer), before + 70);
        assertEq(uint8(_st(NEW)), uint8(AgentOrderAmendments.OrderStatus.Cancelled));
        // an agreed order cannot be cancelled this way
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AgentOrderAmendments.WrongOrderStatus.selector, ORDER));
        coord.cancelOrder(ORDER);
    }

    // ------------------------------------------------------------------ submission (ERC-8448 MUSTs)

    function test_submit_onlyRecordedProvider() public {
        S memory s = _state(ORDER);
        vm.prank(buyer);
        vm.expectRevert(AgentOrderAmendments.NotProvider.selector);
        coord.submitWork(ORDER, s.revision, s.termsHash, RESULT);
        vm.prank(stranger);
        vm.expectRevert(AgentOrderAmendments.NotProvider.selector);
        coord.submitWork(ORDER, s.revision, s.termsHash, RESULT);
    }

    function test_submit_requiresExactRevisionTermsHashAndNonzeroResult() public {
        S memory s = _state(ORDER);
        vm.startPrank(provider);
        vm.expectRevert(AgentOrderAmendments.RevisionMismatch.selector);
        coord.submitWork(ORDER, s.revision + 1, s.termsHash, RESULT);
        vm.expectRevert(AgentOrderAmendments.TermsHashMismatch.selector);
        coord.submitWork(ORDER, s.revision, keccak256("other terms"), RESULT);
        vm.expectRevert(AgentOrderAmendments.ZeroResultHash.selector);
        coord.submitWork(ORDER, s.revision, s.termsHash, bytes32(0));

        vm.expectEmit(true, true, true, true, address(coord));
        emit AgentOrderAmendments.WorkSubmitted(ORDER, s.revision, s.termsHash, RESULT);
        coord.submitWork(ORDER, s.revision, s.termsHash, RESULT);
        vm.expectRevert(abi.encodeWithSelector(AgentOrderAmendments.WrongOrderStatus.selector, ORDER));
        coord.submitWork(ORDER, s.revision, s.termsHash, RESULT);
        vm.stopPrank();
    }

    function test_submit_mustBeBeforeCurrentDeadline() public {
        S memory s = _state(ORDER);
        vm.warp(DEADLINE);
        vm.prank(provider);
        vm.expectRevert(AgentOrderAmendments.DeadlinePassed.selector);
        coord.submitWork(ORDER, s.revision, s.termsHash, RESULT);
        vm.warp(DEADLINE - 1);
        vm.prank(provider);
        coord.submitWork(ORDER, s.revision, s.termsHash, RESULT);
    }

    function test_submit_afterAmendmentNeedsNewRevisionAndUsesNewDeadline() public {
        S memory old = _state(ORDER);
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE + 5_000));
        _execute(ih, p);
        vm.startPrank(provider);
        vm.expectRevert(AgentOrderAmendments.RevisionMismatch.selector);
        coord.submitWork(ORDER, old.revision, old.termsHash, RESULT);
        vm.expectRevert(AgentOrderAmendments.TermsHashMismatch.selector);
        coord.submitWork(ORDER, 1, old.termsHash, RESULT);
        vm.warp(DEADLINE + 100); // past the original deadline, inside the extended one
        coord.submitWork(ORDER, 1, _state(ORDER).termsHash, RESULT);
        vm.stopPrank();
    }

    function test_submit_makesOrderIneligibleForAllLaterAmendments() public {
        _submit(ORDER);
        assertFalse(_state(ORDER).eligible);
        // even a brand-new, fully accepted amendment built on the current state fails
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.OrderNotEligible.selector);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AgentOrderAmendments.OrderNotEligible.selector, ORDER));
        coord.invalidateAmendments(ORDER);
    }

    function test_submit_notPossibleOnOfferedOrder() public {
        _createOffered(NEW, 70, DEADLINE);
        S memory s = _state(NEW);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(AgentOrderAmendments.WrongOrderStatus.selector, NEW));
        coord.submitWork(NEW, s.revision, s.termsHash, RESULT);
    }

    // ------------------------------------------------------------------ settlement

    function test_settle_paysWholeEscrowIncludingSupplements() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        _execute(ih, p);
        _submit(ORDER);

        vm.prank(provider);
        vm.expectRevert(AgentOrderAmendments.NotBuyer.selector);
        coord.acceptAndPay(ORDER);

        vm.expectEmit(true, true, true, true, address(coord));
        emit AgentOrderAmendments.OrderSettled(ORDER, provider, 180);
        vm.prank(buyer);
        coord.acceptAndPay(ORDER);
        assertEq(token.balanceOf(provider), 180);
        assertEq(token.balanceOf(address(coord)), 0);
        assertEq(uint8(_st(ORDER)), uint8(AgentOrderAmendments.OrderStatus.Settled));

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AgentOrderAmendments.WrongOrderStatus.selector, ORDER));
        coord.acceptAndPay(ORDER);
    }

    function test_settle_requiresSubmission() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AgentOrderAmendments.WrongOrderStatus.selector, ORDER));
        coord.acceptAndPay(ORDER);
    }

    function test_refund_afterDeadlineWithoutSubmission() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        _execute(ih, p);

        vm.prank(buyer);
        vm.expectRevert(AgentOrderAmendments.DeadlineNotReached.selector);
        coord.refundAfterDeadline(ORDER);

        vm.warp(DEADLINE);
        vm.prank(provider);
        vm.expectRevert(AgentOrderAmendments.NotBuyer.selector);
        coord.refundAfterDeadline(ORDER);

        uint256 before = token.balanceOf(buyer);
        vm.expectEmit(true, true, true, true, address(coord));
        emit AgentOrderAmendments.OrderRefunded(ORDER, buyer, 180);
        vm.prank(buyer);
        coord.refundAfterDeadline(ORDER);
        assertEq(token.balanceOf(buyer), before + 180);
        assertEq(uint8(_st(ORDER)), uint8(AgentOrderAmendments.OrderStatus.Refunded));
    }

    function test_refund_notAfterSubmission() public {
        _submit(ORDER);
        vm.warp(DEADLINE + 1);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AgentOrderAmendments.WrongOrderStatus.selector, ORDER));
        coord.refundAfterDeadline(ORDER);
    }

    function test_getOrder_unknownReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IOrderAmendments.UnknownOrder.selector, NEW));
        coord.getOrder(NEW);
    }
}
