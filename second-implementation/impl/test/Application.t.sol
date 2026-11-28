// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.30;

import "./Base.sol";

/// ERC-8448 "Consent and application", "Failure and retry", "Application events and invalidation"
/// and the rows of the "Test Cases" table that concern application.
contract ApplicationTest is Base {
    // ------------------------------------------------------------------ success paths

    /// "Client uses only the common view and ERC-8001 coordination interface".
    function test_apply_clientUsingOnlyStandardInterfaces() public {
        IOrderAmendments view_ = IOrderAmendments(address(coord));
        IAgentCoordination core = IAgentCoordination(address(coord));

        (address b, address pr,, uint64 rev, bytes32 th, uint256 nonce, Terms memory cur, bool eligible) =
            view_.getAmendmentState(ORDER);
        assertTrue(eligible);

        AmendmentData memory d;
        d.orderContract = address(coord);
        d.orderId = ORDER;
        d.baseRevision = rev;
        d.baseTermsHash = th;
        d.amendmentNonce = nonce;
        d.newTerms = Terms(SCOPE_B, cur.acceptanceHash, 180, cur.deadline + 100);
        d.newTermsHash = _hashTerms(d.newTerms);
        d.validUntil = uint64(block.timestamp + 100);
        CoordinationPayload memory p = _payload(d);

        AgentIntent memory i;
        i.payloadHash = _payloadHash(p);
        i.expiry = uint64(block.timestamp + 200);
        i.nonce = core.getAgentNonce(pr) + 1;
        i.agentId = pr; // the provider initiates this time
        i.coordinationType = COORD_TYPE;
        i.participants = _sorted(b, pr);
        bytes32 ih = _intentHash(i);
        core.proposeCoordination(i, _sig(providerKey, _digest(ih)), p);
        assertEq(core.getRequiredAcceptances(ih), 2);

        vm.prank(pr);
        assertFalse(core.acceptCoordination(ih, _attestation(ih, providerKey)));
        vm.prank(b);
        assertTrue(core.acceptCoordination(ih, _attestation(ih, buyerKey)));

        (bool ok,) = core.executeCoordination(ih, p, "");
        assertTrue(ok);

        (,,, uint64 rev2, bytes32 th2,,,) = view_.getAmendmentState(ORDER);
        assertEq(rev2, rev + 1);
        assertEq(th2, d.newTermsHash);
    }

    function _assertExecutedLog(Vm.Log[] memory logs, bytes32 ih, bytes memory result) internal view {
        Vm.Log memory ex = _findLog(logs, EXECUTED_TOPIC);
        assertEq(ex.topics[1], ih);
        assertEq(address(uint160(uint256(ex.topics[2]))), relayer);
        (bool evOk,, bytes memory evResult) = abi.decode(ex.data, (bool, uint256, bytes));
        assertTrue(evOk);
        assertEq(evResult, result);
    }

    /// "Current total 100; complete agreed total 180".
    function test_apply_100to180_supplement80() public {
        Terms memory nt = _terms(SCOPE_B, 180, DEADLINE + 1_000);
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, nt);
        bytes32 oldHash = _state(ORDER).termsHash;

        // proposals and acceptances alone changed nothing and secured nothing
        assertEq(token.balanceOf(address(coord)), 100);
        assertEq(_state(ORDER).revision, 0);

        vm.expectEmit(true, true, true, true, address(coord));
        emit IOrderAmendments.OrderAmendmentApplied(ih, ORDER, 1, oldHash, _hashTerms(nt), 80);
        vm.recordLogs();
        (bool ok, bytes memory result) = _execute(ih, p);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertTrue(ok);
        assertEq(result.length, 128);
        assertEq(result, abi.encode(ORDER, uint64(1), _hashTerms(nt), uint256(80)));
        assertEq(_countLogs(logs, APPLIED_TOPIC), 1);
        _assertExecutedLog(logs, ih, result);

        S memory s = _state(ORDER);
        assertEq(s.revision, 1);
        assertEq(s.nonce, 1);
        assertEq(s.termsHash, _hashTerms(nt));
        assertEq(s.terms.totalPrice, 180);
        assertEq(s.terms.deadline, DEADLINE + 1_000);
        assertEq(token.balanceOf(address(coord)), 180);
        assertEq(token.balanceOf(buyer), 1_000 - 180);
        (, uint256 escrowed,) = coord.getOrder(ORDER);
        assertEq(escrowed, 180);
        assertEq(uint8(_status(ih)), uint8(Status.Executed));
    }

    /// "Current total 180 after an applied amendment; complete agreed total 220": 40, not 120.
    function test_apply_chained_180to220_supplement40() public {
        (bytes32 ih1, CoordinationPayload memory p1) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        _execute(ih1, p1);

        Terms memory nt = _terms(SCOPE_C, 220, DEADLINE);
        (bytes32 ih2, CoordinationPayload memory p2) = _ready(ORDER, nt);
        uint256 buyerBefore = token.balanceOf(buyer);
        vm.expectEmit(true, true, true, true, address(coord));
        emit IOrderAmendments.OrderAmendmentApplied(ih2, ORDER, 2, _hashTerms(_terms(SCOPE_B, 180, DEADLINE)), _hashTerms(nt), 40);
        (bool ok, bytes memory result) = _execute(ih2, p2);
        assertTrue(ok);
        assertEq(result, abi.encode(ORDER, uint64(2), _hashTerms(nt), uint256(40)));
        assertEq(buyerBefore - token.balanceOf(buyer), 40);
        assertEq(token.balanceOf(address(coord)), 220);
        S memory s = _state(ORDER);
        assertEq(s.revision, 2);
        assertEq(s.nonce, 2);
    }

    function test_apply_unchangedPriceExtendedDeadline_noTransferNeeded() public {
        vm.prank(buyer);
        token.approve(address(coord), 0); // no funding capacity at all
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_A, 100, DEADLINE + 1));
        (bool ok, bytes memory result) = _execute(ih, p);
        assertTrue(ok);
        assertEq(result, abi.encode(ORDER, uint64(1), _hashTerms(_terms(SCOPE_A, 100, DEADLINE + 1)), uint256(0)));
        assertEq(token.balanceOf(address(coord)), 100);
    }

    function test_apply_scopeAndAcceptanceMayChange() public {
        Terms memory nt = Terms(SCOPE_B, keccak256("new acceptance"), 100, DEADLINE);
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, nt);
        (bool ok,) = _execute(ih, p);
        assertTrue(ok);
        assertEq(_state(ORDER).terms.acceptanceHash, keccak256("new acceptance"));
    }

    function test_apply_anyCallerMayExecute() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        vm.prank(stranger);
        (bool ok,) = coord.executeCoordination(ih, p, "");
        assertTrue(ok);
    }

    function test_apply_validUntilOneSecondBeforeLimitSucceeds() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        vm.warp(T0 + validTtl - 1);
        (bool ok,) = _execute(ih, p);
        assertTrue(ok);
    }

    // ------------------------------------------------------------------ competing amendments, invalidation

    /// "Two amendments share one base revision".
    function test_apply_twoAmendmentsOneBase_onlyOneApplies() public {
        (bytes32 ihA, CoordinationPayload memory pA) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        // second one proposed by the provider against the same base
        CoordinationPayload memory pB = _payload(_dataFor(ORDER, _terms(SCOPE_C, 150, DEADLINE)));
        bytes32 ihB = _propose(providerKey, pB);
        _acceptBoth(ihB);

        (bool okA,) = _execute(ihA, pA);
        assertTrue(okA);
        _assertFailedApplication(ORDER, ihB, pB, AgentOrderAmendments.StaleBaseState.selector);
        assertEq(_state(ORDER).terms.totalPrice, 180);
        assertEq(_state(ORDER).revision, 1);
    }

    /// "State read, then either party invalidates" / "Either party invalidates before application".
    function test_apply_invalidationByProviderBlocksPendingAmendment() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        vm.expectEmit(true, true, true, true, address(coord));
        emit IOrderAmendments.AmendmentsInvalidated(ORDER, provider, 1);
        vm.prank(provider);
        coord.invalidateAmendments(ORDER);

        assertEq(_state(ORDER).nonce, 1); // a later read shows the advanced nonce
        assertEq(uint8(_status(ih)), uint8(Status.Ready)); // Core status is not rewritten to Cancelled

        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.StaleBaseState.selector);
        S memory s = _state(ORDER);
        assertEq(s.revision, 0);
        assertEq(s.terms.totalPrice, 100);
        assertTrue(s.eligible); // the underlying agreement stays intact
        assertEq(token.balanceOf(address(coord)), 100);
    }

    function test_apply_invalidationByBuyerBlocksPendingAmendment() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        vm.expectEmit(true, true, true, true, address(coord));
        emit IOrderAmendments.AmendmentsInvalidated(ORDER, buyer, 1);
        vm.prank(buyer);
        coord.invalidateAmendments(ORDER);
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.StaleBaseState.selector);
    }

    function test_invalidate_doesNotUndoAppliedAmendment_andNewBaseWorks() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        _execute(ih, p);
        vm.prank(buyer);
        coord.invalidateAmendments(ORDER);
        S memory s = _state(ORDER);
        assertEq(s.revision, 1);
        assertEq(s.nonce, 2);
        assertEq(s.terms.totalPrice, 180);
        assertEq(token.balanceOf(address(coord)), 180);

        // a fresh amendment signed over the post-invalidation nonce applies
        (bytes32 ih2, CoordinationPayload memory p2) = _ready(ORDER, _terms(SCOPE_C, 220, DEADLINE));
        (bool ok,) = _execute(ih2, p2);
        assertTrue(ok);
        assertEq(_state(ORDER).nonce, 3);
        assertEq(_state(ORDER).revision, 2);
    }

    function test_invalidate_restrictedToParties() public {
        vm.prank(stranger);
        vm.expectRevert(AgentOrderAmendments.NotOrderParty.selector);
        coord.invalidateAmendments(ORDER);
    }

    function test_invalidate_unknownOrderReverts() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(IOrderAmendments.UnknownOrder.selector, bytes32(uint256(7))));
        coord.invalidateAmendments(bytes32(uint256(7)));
    }

    function test_invalidate_revertsOnOfferedOrder() public {
        bytes32 id = keccak256("offered");
        _createOffered(id, 10, DEADLINE);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AgentOrderAmendments.OrderNotEligible.selector, id));
        coord.invalidateAmendments(id);
    }

    function test_invalidate_revertsAfterSubmission() public {
        _submit(ORDER);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(AgentOrderAmendments.OrderNotEligible.selector, ORDER));
        coord.invalidateAmendments(ORDER);
    }

    function test_invalidate_revertsAtDeadline() public {
        vm.warp(DEADLINE - 1);
        vm.prank(buyer);
        coord.invalidateAmendments(ORDER); // still allowed one second before
        vm.warp(DEADLINE);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AgentOrderAmendments.OrderNotEligible.selector, ORDER));
        coord.invalidateAmendments(ORDER);
    }

    function test_invalidate_leavesTermsAndFundsIntact() public {
        S memory before = _state(ORDER);
        uint256 bal = token.balanceOf(address(coord));
        vm.recordLogs();
        vm.prank(buyer);
        coord.invalidateAmendments(ORDER);
        assertEq(vm.getRecordedLogs().length, 1); // only AmendmentsInvalidated
        S memory afterS = _state(ORDER);
        assertEq(afterS.termsHash, before.termsHash);
        assertEq(afterS.revision, before.revision);
        assertEq(token.balanceOf(address(coord)), bal);
        (, uint256 escrowed,) = coord.getOrder(ORDER);
        assertEq(escrowed, 100);
    }

    function test_invalidate_nonceOverflowReverts() public {
        harness().h_setAmendmentNonce(ORDER, type(uint256).max);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSignature("Panic(uint256)", 0x11));
        coord.invalidateAmendments(ORDER);
        assertEq(_state(ORDER).nonce, type(uint256).max);
    }

    // ------------------------------------------------------------------ overflow in application

    function test_apply_revisionOverflowFailsInsteadOfWrapping() public {
        harness().h_setRevision(ORDER, type(uint64).max);
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        _assertFailedApplication(ORDER, ih, p, bytes4(keccak256("Panic(uint256)")));
        assertEq(_state(ORDER).revision, type(uint64).max);
    }

    function test_apply_amendmentNonceOverflowFailsInsteadOfWrapping() public {
        harness().h_setAmendmentNonce(ORDER, type(uint256).max);
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        _assertFailedApplication(ORDER, ih, p, bytes4(keccak256("Panic(uint256)")));
    }

    // ------------------------------------------------------------------ funding failure and retry

    /// "Eligible order without supplemental funding capacity" + "Funding fails after bilateral acceptance".
    function test_apply_fundingFailureIsAtomic() public {
        vm.prank(buyer);
        token.approve(address(coord), 0);
        assertTrue(_state(ORDER).eligible); // the view still returns true
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        assertTrue(_state(ORDER).eligible);
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.TokenCallFailed.selector);
    }

    function test_apply_insufficientBuyerBalanceIsAtomic() public {
        vm.startPrank(buyer);
        token.transfer(stranger, token.balanceOf(buyer) - 79); // one unit short of the supplement
        vm.stopPrank();
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.TokenCallFailed.selector);
    }

    /// "Capacity restored after that failed attempt".
    function test_retry_needsFreshIntentAndFreshAcceptances() public {
        vm.prank(buyer);
        token.approve(address(coord), 0);
        Terms memory nt = _terms(SCOPE_B, 180, DEADLINE);
        (bytes32 ih1, CoordinationPayload memory p) = _ready(ORDER, nt);
        AcceptanceAttestation memory oldBuyerAcc = _attestation(ih1, buyerKey);
        _assertFailedApplication(ORDER, ih1, p, AgentOrderAmendments.TokenCallFailed.selector);

        // capacity restored
        vm.prank(buyer);
        token.approve(address(coord), type(uint256).max);

        // the old coordination stays terminal
        vm.prank(relayer);
        vm.expectRevert(IAgentCoordination.ERC8001_NotReady.selector);
        coord.executeCoordination(ih1, p, "");
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AgentOrderAmendments.IntentNotOpen.selector, ih1));
        coord.cancelCoordination(ih1, "too late");
        assertEq(uint8(_status(ih1)), uint8(Status.Executed));

        // replaying the consumed intent itself is impossible (its nonce is spent)
        AgentIntent memory replay = _intent(p, buyer);
        replay.nonce = coord.getAgentNonce(buyer);
        vm.expectRevert(IAgentCoordination.ERC8001_NonceTooLow.selector);
        coord.proposeCoordination(replay, _sig(buyerKey, _digest(_intentHash(replay))), p);

        // a fresh intent over the same, still authoritative base state and the same payload
        bytes32 ih2 = _propose(buyerKey, p);
        assertTrue(ih2 != ih1);
        assertEq(uint8(_status(ih2)), uint8(Status.Proposed));

        // it has no acceptances: not executable
        vm.prank(relayer);
        vm.expectRevert(IAgentCoordination.ERC8001_NotReady.selector);
        coord.executeCoordination(ih2, p, "");

        // acceptances of the consumed intent are not reusable
        vm.prank(buyer);
        vm.expectRevert(AgentOrderAmendments.IntentHashMismatch.selector);
        coord.acceptCoordination(ih2, oldBuyerAcc);
        oldBuyerAcc.intentHash = ih2; // re-pointing it breaks the signature
        vm.prank(buyer);
        vm.expectRevert(IAgentCoordination.ERC8001_BadSignature.selector);
        coord.acceptCoordination(ih2, oldBuyerAcc);

        // fresh acceptances from both parties, then it applies
        _acceptBoth(ih2);
        (bool ok, bytes memory result) = _execute(ih2, p);
        assertTrue(ok);
        assertEq(result, abi.encode(ORDER, uint64(1), _hashTerms(nt), uint256(80)));
        assertEq(_state(ORDER).nonce, 1); // the failed attempt never advanced the order nonce
    }

    // ------------------------------------------------------------------ outer-call failures (no consumption)

    /// "Nonempty unsigned execution data".
    function test_execute_nonemptyExecutionDataRevertsWithoutConsuming() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        vm.prank(relayer);
        vm.expectRevert(AgentOrderAmendments.NonemptyExecutionData.selector);
        coord.executeCoordination(ih, p, hex"00");
        assertEq(uint8(_status(ih)), uint8(Status.Ready));
        assertEq(_state(ORDER).revision, 0);
        (bool ok,) = _execute(ih, p);
        assertTrue(ok);
    }

    function test_execute_payloadMismatchRevertsWithoutConsuming() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        CoordinationPayload memory other = _payload(_dataFor(ORDER, _terms(SCOPE_B, 101, DEADLINE)));
        vm.prank(relayer);
        vm.expectRevert(IAgentCoordination.ERC8001_PayloadHashMismatch.selector);
        coord.executeCoordination(ih, other, "");
        p.timestamp += 1; // even the informational timestamp is bound
        vm.prank(relayer);
        vm.expectRevert(IAgentCoordination.ERC8001_PayloadHashMismatch.selector);
        coord.executeCoordination(ih, p, "");
        assertEq(uint8(_status(ih)), uint8(Status.Ready));
    }

    function test_execute_notReadyReverts() public {
        CoordinationPayload memory p = _payload(_dataFor(ORDER, _terms(SCOPE_B, 180, DEADLINE)));
        bytes32 ih = _propose(buyerKey, p);
        vm.expectRevert(IAgentCoordination.ERC8001_NotReady.selector);
        coord.executeCoordination(ih, p, "");
        _accept(ih, providerKey); // only the counterparty accepted: proposing is not accepting
        vm.expectRevert(IAgentCoordination.ERC8001_NotReady.selector);
        coord.executeCoordination(ih, p, "");
        vm.expectRevert(IAgentCoordination.ERC8001_NotReady.selector);
        coord.executeCoordination(keccak256("unknown"), p, "");
    }

    function test_execute_expiredIntentRevertsWithoutConsuming() public {
        acceptTtl = 9_000;
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        vm.warp(T0 + intentTtl); // equality is expired
        vm.prank(relayer);
        vm.expectRevert(IAgentCoordination.ERC8001_ExpiredIntent.selector);
        coord.executeCoordination(ih, p, "");
        assertEq(uint8(_status(ih)), uint8(Status.Expired));
        assertEq(_state(ORDER).revision, 0);
    }

    function test_execute_expiredAcceptanceRevertsWithoutConsuming() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        vm.warp(T0 + acceptTtl); // acceptance expiry reached, intent still live
        address first = _parties()[0];
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IAgentCoordination.ERC8001_ExpiredAcceptance.selector, first));
        coord.executeCoordination(ih, p, "");
        assertTrue(uint8(_status(ih)) != uint8(Status.Executed));
        assertEq(_state(ORDER).revision, 0);
    }

    // ------------------------------------------------------------------ application failures (consumed)

    /// "Current time equals the current order deadline".
    function test_apply_atOrderDeadlineFails() public {
        intentTtl = 20_000;
        acceptTtl = 20_000;
        validTtl = 20_000;
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE + 5_000));
        vm.warp(DEADLINE);
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.OrderNotEligible.selector);
    }

    function test_apply_oneSecondBeforeOrderDeadlineSucceeds() public {
        intentTtl = 20_000;
        acceptTtl = 20_000;
        validTtl = 20_000;
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE + 5_000));
        vm.warp(DEADLINE - 1);
        (bool ok,) = _execute(ih, p);
        assertTrue(ok);
    }

    /// "...or amendment validity limit": equality is expired.
    function test_apply_atValidUntilFails() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        vm.warp(T0 + validTtl);
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.AmendmentExpired.selector);
    }

    /// "After a deadline extension, later amendments use the new current deadline."
    function test_apply_laterAmendmentUsesExtendedDeadline() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE + 5_000));
        _execute(ih, p);
        vm.warp(DEADLINE + 10); // past the original deadline, before the extended one
        (bytes32 ih2, CoordinationPayload memory p2) = _ready(ORDER, _terms(SCOPE_C, 220, DEADLINE + 5_000));
        (bool ok,) = _execute(ih2, p2);
        assertTrue(ok);
        // and shortening back below the new current deadline is out of profile
        (bytes32 ih3, CoordinationPayload memory p3) = _ready(ORDER, _terms(SCOPE_C, 220, DEADLINE + 4_999));
        _assertFailedApplication(ORDER, ih3, p3, AgentOrderAmendments.TermsOutOfProfile.selector);
    }

    /// "Work already submitted against the current revision".
    function test_apply_afterSubmissionFails() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        _submit(ORDER);
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.OrderNotEligible.selector);
        (AgentOrderAmendments.OrderStatus st,, bytes32 resultHash) = coord.getOrder(ORDER);
        assertEq(uint8(st), uint8(AgentOrderAmendments.OrderStatus.Submitted));
        assertEq(resultHash, RESULT);
        assertEq(_state(ORDER).terms.totalPrice, 100); // the submission's agreement is not rewritten
    }

    function test_apply_onOfferedOrderFails() public {
        bytes32 id = keccak256("offered");
        _createOffered(id, 100, DEADLINE);
        (bytes32 ih, CoordinationPayload memory p) = _ready(id, _terms(SCOPE_B, 180, DEADLINE));
        _assertFailedApplication(id, ih, p, AgentOrderAmendments.OrderNotEligible.selector);
    }

    function test_apply_onRefundedOrderFails() public {
        intentTtl = 20_000;
        acceptTtl = 20_000;
        validTtl = 20_000;
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE + 20_000));
        vm.warp(DEADLINE);
        vm.prank(buyer);
        coord.refundAfterDeadline(ORDER);
        vm.warp(T0 + 1);
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.OrderNotEligible.selector);
    }

    /// "Price decreases or deadline shortens".
    function test_apply_priceDecreaseFails() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 99, DEADLINE));
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.TermsOutOfProfile.selector);
    }

    function test_apply_zeroPriceFails() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 0, DEADLINE));
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.TermsOutOfProfile.selector);
    }

    function test_apply_deadlineShorteningFails() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE - 1));
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.TermsOutOfProfile.selector);
    }

    function test_apply_zeroScopeHashFails() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(bytes32(0), 180, DEADLINE));
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.TermsOutOfProfile.selector);
    }

    function test_apply_zeroAcceptanceHashFails() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, Terms(SCOPE_B, bytes32(0), 180, DEADLINE));
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.TermsOutOfProfile.selector);
    }

    /// "A successful amendment MUST change the full terms hash."
    function test_apply_identicalTermsFail() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_A, 100, DEADLINE));
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.TermsUnchanged.selector);
    }

    function test_apply_staleBaseTermsHashFails() public {
        AmendmentData memory d = _dataFor(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        d.baseTermsHash = keccak256("some other agreement");
        CoordinationPayload memory p = _payload(d);
        bytes32 ih = _propose(buyerKey, p);
        _acceptBoth(ih);
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.StaleBaseState.selector);
    }

    function test_apply_wrongBaseRevisionFails() public {
        AmendmentData memory d = _dataFor(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        d.baseRevision = 1;
        CoordinationPayload memory p = _payload(d);
        bytes32 ih = _propose(buyerKey, p);
        _acceptBoth(ih);
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.StaleBaseState.selector);
    }

    function test_apply_executionReadsAuthoritativeStateNotProposalTimeState() public {
        // Signed while eligible and correct; the order changes before execution.
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        (bytes32 ih0, CoordinationPayload memory p0) = _ready(ORDER, _terms(SCOPE_C, 120, DEADLINE));
        _execute(ih0, p0);
        _assertFailedApplication(ORDER, ih, p, AgentOrderAmendments.StaleBaseState.selector);
        assertEq(_state(ORDER).terms.totalPrice, 120);
    }

    // ------------------------------------------------------------------ the isolated helper

    function test_helper_onlyCallableByCoordinatorItself() public {
        CoordinationPayload memory p = _payload(_dataFor(ORDER, _terms(SCOPE_B, 180, DEADLINE)));
        vm.prank(buyer);
        vm.expectRevert(AgentOrderAmendments.OnlySelf.selector);
        coord.applyOrderAmendment(keccak256("x"), p.version, p.coordinationType, p.coordinationData);
        vm.prank(provider);
        vm.expectRevert(AgentOrderAmendments.OnlySelf.selector);
        coord.applyOrderAmendment(keccak256("x"), p.version, p.coordinationType, p.coordinationData);
        assertEq(_state(ORDER).revision, 0);
    }

    // The application call re-checks item 1 of the spec's list even though proposal already rejects
    // such payloads; these tests reach it by planting a Ready coordination directly in storage.

    function test_helper_rejectsNonCanonicalData() public {
        bytes memory good = abi.encode(_dataFor(ORDER, _terms(SCOPE_B, 180, DEADLINE)));
        CoordinationPayload memory p = _payloadRaw(abi.encodePacked(good, bytes32(0)));
        _assertFailedApplication(ORDER, _forceReady(p), p, AgentOrderAmendments.NonCanonicalAmendmentData.selector);
    }

    function test_helper_rejectsDirtyAddressPadding() public {
        bytes memory data = abi.encode(_dataFor(ORDER, _terms(SCOPE_B, 180, DEADLINE)));
        data[0] = 0x01;
        CoordinationPayload memory p = _payloadRaw(data);
        _assertFailedApplication(ORDER, _forceReady(p), p, AgentOrderAmendments.NonCanonicalAmendmentData.selector);
    }

    function test_helper_rejectsTermsHashMismatch() public {
        AmendmentData memory d = _dataFor(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        d.newTermsHash = keccak256("not the terms");
        CoordinationPayload memory p = _payload(d);
        _assertFailedApplication(ORDER, _forceReady(p), p, AgentOrderAmendments.NewTermsHashMismatch.selector);
    }

    function test_helper_rejectsForeignOrderContract() public {
        AmendmentData memory d = _dataFor(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        d.orderContract = address(0xDEAD);
        CoordinationPayload memory p = _payload(d);
        _assertFailedApplication(ORDER, _forceReady(p), p, AgentOrderAmendments.WrongOrderContract.selector);
    }

    function test_helper_rejectsWrongPayloadVersion() public {
        CoordinationPayload memory p = _payload(_dataFor(ORDER, _terms(SCOPE_B, 180, DEADLINE)));
        p.version = keccak256("ORDER_AMENDMENT_PAYLOAD_V2");
        _assertFailedApplication(ORDER, _forceReady(p), p, AgentOrderAmendments.WrongPayloadVersion.selector);
    }

    function test_helper_rejectsWrongProfile() public {
        CoordinationPayload memory p = _payload(_dataFor(ORDER, _terms(SCOPE_B, 180, DEADLINE)));
        p.coordinationType = keccak256("SOMETHING_ELSE_V1");
        _assertFailedApplication(ORDER, _forceReady(p), p, AgentOrderAmendments.WrongCoordinationType.selector);
    }

    function test_helper_rejectsUnknownOrder() public {
        AmendmentData memory d = _dataFor(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        d.orderId = keccak256("nope");
        CoordinationPayload memory p = _payload(d);
        _assertFailedApplication(ORDER, _forceReady(p), p, IOrderAmendments.UnknownOrder.selector);
    }
}
