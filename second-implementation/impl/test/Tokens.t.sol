// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.30;

import "./Base.sol";
import {NoReturnToken} from "./mocks/Mocks.sol";

/// Exact balance-delta checks, the rollback boundary for misbehaving tokens, and reentrancy.
contract TokensTest is Base {
    // ------------------------------------------------------------------ misbehaving tokens

    /// "The same rollback boundary covers a token that moves funds and then returns false."
    function test_token_movesFundsThenReturnsFalse_rolledBack() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        token.setMode(TestToken.Mode.MoveThenFalse);
        // sanity: outside the coordinator this token really does move the funds before returning false
        uint256 snap = vm.snapshotState();
        vm.prank(address(coord));
        assertFalse(token.transferFrom(buyer, address(coord), 80));
        assertEq(token.balanceOf(address(coord)), 180);
        vm.revertToState(snap);

        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.TokenCallFailed.selector);
        assertEq(token.balanceOf(address(coord)), 100);
        assertEq(token.balanceOf(buyer), 900);
    }

    function test_token_afterFalseReturnFailure_freshAttemptCollectsExactly80() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        token.setMode(TestToken.Mode.MoveThenFalse);
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.TokenCallFailed.selector);
        token.setMode(TestToken.Mode.Normal);
        bytes32 ih2 = _propose(providerKey, p);
        _acceptBoth(ih2);
        (bool ok,) = _execute(ih2, p);
        assertTrue(ok);
        assertEq(token.balanceOf(address(coord)), 180);
        assertEq(token.balanceOf(buyer), 820);
    }

    function test_token_returnsTrueWithoutMoving_rejected() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        token.setMode(TestToken.Mode.TrueNoMove);
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.BalanceDeltaMismatch.selector);
    }

    function test_token_feeOnTransfer_rejected() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        token.setMode(TestToken.Mode.Fee);
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.BalanceDeltaMismatch.selector);
    }

    function test_token_reverting_rejected() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        token.setMode(TestToken.Mode.Revert);
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.TokenCallFailed.selector);
    }

    function test_token_createOrderAlsoUsesExactDeltas() public {
        bytes32 id = keccak256("fee order");
        token.setMode(TestToken.Mode.Fee);
        vm.prank(buyer);
        vm.expectRevert(AgentOrderAmendments.BalanceDeltaMismatch.selector);
        coord.createOrder(id, provider, address(token), _terms(SCOPE_A, 50, DEADLINE));
        token.setMode(TestToken.Mode.MoveThenFalse);
        vm.prank(buyer);
        vm.expectRevert(AgentOrderAmendments.TokenCallFailed.selector);
        coord.createOrder(id, provider, address(token), _terms(SCOPE_A, 50, DEADLINE));
        vm.expectRevert(abi.encodeWithSelector(IOrderAmendments.UnknownOrder.selector, id));
        coord.getAmendmentState(id);
    }

    function test_token_withoutReturnValue_supported() public {
        NoReturnToken nrt = new NoReturnToken();
        nrt.mint(buyer, 500);
        bytes32 id = keccak256("no-return order");
        vm.startPrank(buyer);
        nrt.approve(address(coord), 500);
        coord.createOrder(id, provider, address(nrt), _terms(SCOPE_A, 100, DEADLINE));
        vm.stopPrank();
        vm.prank(provider);
        coord.agreeOrder(id, _hashTerms(_terms(SCOPE_A, 100, DEADLINE)));

        (bytes32 ih, CoordinationPayload memory p) = _ready(id, _terms(SCOPE_B, 180, DEADLINE));
        (bool ok,) = _execute(ih, p);
        assertTrue(ok);
        assertEq(nrt.balanceOf(address(coord)), 180);
        assertEq(nrt.balanceOf(buyer), 320);
    }

    /// Escrow of two orders in the same asset is accounted per order.
    function test_token_escrowAccountingPerOrder() public {
        bytes32 other = keccak256("order-2");
        _createActive(other, 300, DEADLINE);
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        _execute(ih, p);
        (, uint256 e1,) = coord.getOrder(ORDER);
        (, uint256 e2,) = coord.getOrder(other);
        assertEq(e1, 180);
        assertEq(e2, 300);
        assertEq(token.balanceOf(address(coord)), 480);
    }

    // ------------------------------------------------------------------ reentrancy

    function _reentrantCalls(bytes32 pendingIntent, CoordinationPayload memory pendingPayload)
        internal
        view
        returns (bytes[] memory calls)
    {
        AgentIntent memory i = _intent(pendingPayload, buyer);
        AcceptanceAttestation memory a = _attestation(pendingIntent, buyerKey);
        calls = new bytes[](11);
        calls[0] = abi.encodeCall(coord.executeCoordination, (pendingIntent, pendingPayload, ""));
        calls[1] = abi.encodeCall(coord.invalidateAmendments, (ORDER));
        calls[2] = abi.encodeCall(coord.proposeCoordination, (i, _sig(buyerKey, _digest(_intentHash(i))), pendingPayload));
        calls[3] = abi.encodeCall(coord.acceptCoordination, (pendingIntent, a));
        calls[4] = abi.encodeCall(coord.cancelCoordination, (pendingIntent, "reenter"));
        calls[5] = abi.encodeCall(
            coord.createOrder, (keccak256("reentrant order"), provider, address(token), _terms(SCOPE_A, 1, DEADLINE))
        );
        calls[6] = abi.encodeCall(coord.agreeOrder, (ORDER, bytes32(0)));
        calls[7] = abi.encodeCall(coord.cancelOrder, (ORDER));
        calls[8] = abi.encodeCall(coord.submitWork, (ORDER, 0, bytes32(0), RESULT));
        calls[9] = abi.encodeCall(coord.acceptAndPay, (ORDER));
        calls[10] = abi.encodeCall(coord.refundAfterDeadline, (ORDER));
    }

    /// Every public mutating entry point is closed while the supplemental transfer is in flight.
    function test_reentrancy_allPublicMutationsBlockedDuringSupplement() public {
        // a second, independently Ready coordination the token will try to execute from the callback
        CoordinationPayload memory pending = _payload(_dataFor(ORDER, _terms(SCOPE_C, 999, DEADLINE)));
        bytes32 pendingIntent = _propose(providerKey, pending);
        _acceptBoth(pendingIntent);

        bytes[] memory calls = _reentrantCalls(pendingIntent, pending);
        uint256 price = 100;
        for (uint256 k = 0; k < calls.length; ++k) {
            price += 10;
            (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, price, DEADLINE));
            token.setReenter(address(coord), calls[k]);
            (bool ok,) = _execute(ih, p);
            token.setMode(TestToken.Mode.Normal);

            assertTrue(ok, "the legitimate amendment still applies");
            assertEq(token.reenterCount(), k + 1, "callback ran");
            assertFalse(token.reenterOk(), "reentrant call must fail");
            assertEq(bytes4(token.reenterRet()), AgentOrderAmendments.ReentrantCall.selector);
            S memory s = _state(ORDER);
            assertEq(s.revision, k + 1, "applied exactly once");
            assertEq(s.nonce, k + 1);
            assertEq(s.terms.totalPrice, price);
            assertEq(token.balanceOf(address(coord)), price);
        }
        assertEq(uint8(_status(pendingIntent)), uint8(Status.Ready), "the other coordination was not consumed");
    }

    function test_reentrancy_sameIntentCannotApplyTwice() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        token.setReenter(address(coord), abi.encodeCall(coord.executeCoordination, (ih, p, "")));
        (bool ok,) = _execute(ih, p);
        assertTrue(ok);
        assertFalse(token.reenterOk());
        assertEq(_state(ORDER).revision, 1);
        assertEq(token.balanceOf(address(coord)), 180);
    }

    /// The isolated helper cannot be entered from a callback either: it only accepts the coordinator.
    function test_reentrancy_helperNotCallableFromTokenCallback() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        token.setReenter(
            address(coord),
            abi.encodeCall(coord.applyOrderAmendment, (ih, p.version, p.coordinationType, p.coordinationData))
        );
        (bool ok,) = _execute(ih, p);
        assertTrue(ok);
        assertFalse(token.reenterOk());
        assertEq(bytes4(token.reenterRet()), AgentOrderAmendments.OnlySelf.selector);
        assertEq(_state(ORDER).revision, 1);
        assertEq(token.balanceOf(address(coord)), 180);
    }

    function test_reentrancy_blockedDuringPayout() public {
        _submit(ORDER);
        token.setReenter(address(coord), abi.encodeCall(coord.acceptAndPay, (ORDER)));
        vm.prank(buyer);
        coord.acceptAndPay(ORDER);
        assertFalse(token.reenterOk());
        assertEq(bytes4(token.reenterRet()), AgentOrderAmendments.ReentrantCall.selector);
        assertEq(token.balanceOf(provider), 100);
        assertEq(token.balanceOf(address(coord)), 0);
    }

    function test_reentrancy_blockedDuringOrderFunding() public {
        token.setReenter(address(coord), abi.encodeCall(coord.invalidateAmendments, (ORDER)));
        vm.prank(buyer);
        coord.createOrder(keccak256("o2"), provider, address(token), _terms(SCOPE_A, 5, DEADLINE));
        assertFalse(token.reenterOk());
        assertEq(bytes4(token.reenterRet()), AgentOrderAmendments.ReentrantCall.selector);
        assertEq(_state(ORDER).nonce, 0);
    }

    function test_reentrancy_guardReleasedAfterEachCall() public {
        // two sequential guarded calls in one transaction both work
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        _execute(ih, p);
        vm.prank(buyer);
        coord.invalidateAmendments(ORDER);
        assertEq(_state(ORDER).nonce, 2);
    }
}
