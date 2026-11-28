// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.30;

import "./Base.sol";

/// ERC-8001 lifecycle as constrained by the ERC-8448 "Signed representation" table.
contract CoordinationTest is Base {
    CoordinationPayload internal p0;

    function setUp() public override {
        super.setUp();
        p0 = _payload(_dataFor(ORDER, _terms(SCOPE_B, 180, DEADLINE)));
    }

    function _proposeRaw(AgentIntent memory i, uint256 key, CoordinationPayload memory p) internal returns (bytes32) {
        return coord.proposeCoordination(i, _sig(key, _digest(_intentHash(i))), p);
    }

    // ------------------------------------------------------------------ interface surface

    function test_core_selectors() public pure {
        assertEq(
            IAgentCoordination.proposeCoordination.selector,
            bytes4(
                keccak256(
                    "proposeCoordination((bytes32,uint64,uint64,address,bytes32,uint256,address[]),bytes,(bytes32,bytes32,bytes,bytes32,uint256,bytes))"
                )
            )
        );
        assertEq(
            IAgentCoordination.acceptCoordination.selector,
            bytes4(keccak256("acceptCoordination(bytes32,(bytes32,address,uint64,uint64,bytes32,bytes))"))
        );
        assertEq(
            IAgentCoordination.executeCoordination.selector,
            bytes4(keccak256("executeCoordination(bytes32,(bytes32,bytes32,bytes,bytes32,uint256,bytes),bytes)"))
        );
        assertEq(
            IAgentCoordination.cancelCoordination.selector, bytes4(keccak256("cancelCoordination(bytes32,string)"))
        );
        assertEq(
            IAgentCoordination.getCoordinationStatus.selector, bytes4(keccak256("getCoordinationStatus(bytes32)"))
        );
        assertEq(
            IAgentCoordination.getRequiredAcceptances.selector, bytes4(keccak256("getRequiredAcceptances(bytes32)"))
        );
        assertEq(IAgentCoordination.getAgentNonce.selector, bytes4(keccak256("getAgentNonce(address)")));
        assertEq(IOrderAmendments.invalidateAmendments.selector, bytes4(keccak256("invalidateAmendments(bytes32)")));
    }

    function test_core_statusEnumValues() public pure {
        assertEq(uint8(Status.None), 0);
        assertEq(uint8(Status.Proposed), 1);
        assertEq(uint8(Status.Ready), 2);
        assertEq(uint8(Status.Executed), 3);
        assertEq(uint8(Status.Cancelled), 4);
        assertEq(uint8(Status.Expired), 5);
    }

    function test_core_domain() public view {
        assertEq(coord.DOMAIN_SEPARATOR(), _domainSeparator(address(coord)));
        (bytes1 fields, string memory name, string memory version, uint256 chainId, address verifying,,) =
            coord.eip712Domain();
        assertEq(fields, hex"0f");
        assertEq(name, "ERC-8001");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifying, address(coord));
    }

    function test_core_getIntentHashIsStructHash() public view {
        AgentIntent memory i = _intent(p0, buyer);
        assertEq(coord.getIntentHash(i), _intentHash(i));
        assertTrue(coord.getIntentHash(i) != _digest(_intentHash(i)));
    }

    // ------------------------------------------------------------------ propose

    function test_propose_success() public {
        AgentIntent memory i = _intent(p0, buyer);
        bytes32 ih = _intentHash(i);
        vm.expectEmit(true, true, true, true, address(coord));
        emit IAgentCoordination.CoordinationProposed(ih, buyer, COORD_TYPE, 2, 0);
        assertEq(_proposeRaw(i, buyerKey, p0), ih);

        (Status st, address proposer, address[] memory ps, address[] memory acceptedBy, uint256 expiry) =
            coord.getCoordinationStatus(ih);
        assertEq(uint8(st), uint8(Status.Proposed));
        assertEq(proposer, buyer);
        assertEq(ps.length, 2);
        assertEq(ps[0], _parties()[0]);
        assertEq(ps[1], _parties()[1]);
        assertEq(acceptedBy.length, 0); // proposing is not accepting
        assertEq(expiry, i.expiry);
        assertEq(coord.getAgentNonce(buyer), i.nonce);
        assertEq(coord.getRequiredAcceptances(ih), 2);
        // nothing about the order moved
        assertEq(_state(ORDER).revision, 0);
        assertEq(token.balanceOf(address(coord)), 100);
    }

    function test_propose_providerMayInitiate() public {
        bytes32 ih = _propose(providerKey, p0);
        (, address proposer,,,) = coord.getCoordinationStatus(ih);
        assertEq(proposer, provider);
        assertEq(coord.getAgentNonce(provider), 1);
        assertEq(coord.getAgentNonce(buyer), 0);
    }

    function test_propose_nonceMustStrictlyIncrease_gapsAllowed() public {
        AgentIntent memory i = _intent(p0, buyer);
        i.nonce = 5;
        _proposeRaw(i, buyerKey, p0);
        assertEq(coord.getAgentNonce(buyer), 5);

        i.nonce = 5;
        _expectProposeRevert(i, buyerKey, p0, IAgentCoordination.ERC8001_NonceTooLow.selector);
        i.nonce = 4;
        _expectProposeRevert(i, buyerKey, p0, IAgentCoordination.ERC8001_NonceTooLow.selector);
        i.nonce = 0;
        _expectProposeRevert(i, buyerKey, p0, IAgentCoordination.ERC8001_NonceTooLow.selector);

        i.nonce = type(uint64).max;
        _proposeRaw(i, buyerKey, p0);
        assertEq(coord.getAgentNonce(buyer), type(uint64).max);
    }

    /// Signing happens before expectRevert so that the cheatcode targets the coordinator call.
    function _expectProposeRevert(AgentIntent memory i, uint256 key, CoordinationPayload memory p, bytes4 err)
        internal
    {
        bytes memory sig = _sig(key, _digest(_intentHash(i)));
        vm.expectRevert(err);
        coord.proposeCoordination(i, sig, p);
    }

    function test_propose_revertsOnBadSignature() public {
        AgentIntent memory i = _intent(p0, buyer);
        _expectProposeRevert(i, providerKey, p0, IAgentCoordination.ERC8001_BadSignature.selector); // wrong signer
        _expectProposeRevert(i, strangerKey, p0, IAgentCoordination.ERC8001_BadSignature.selector);
        // right signer, wrong domain (another verifying contract)
        bytes32 foreign =
            keccak256(abi.encodePacked("\x19\x01", _domainSeparator(address(0xBEEF)), _intentHash(i)));
        bytes memory sig = _sig(buyerKey, foreign);
        vm.expectRevert(IAgentCoordination.ERC8001_BadSignature.selector);
        coord.proposeCoordination(i, sig, p0);
        assertEq(coord.getAgentNonce(buyer), 0);
    }

    function test_propose_revertsWhenExpired() public {
        AgentIntent memory i = _intent(p0, buyer);
        i.expiry = uint64(block.timestamp); // equality is expired
        _expectProposeRevert(i, buyerKey, p0, IAgentCoordination.ERC8001_ExpiredIntent.selector);
        i.expiry = uint64(block.timestamp) - 1;
        _expectProposeRevert(i, buyerKey, p0, IAgentCoordination.ERC8001_ExpiredIntent.selector);
        i.expiry = uint64(block.timestamp) + 1;
        _proposeRaw(i, buyerKey, p0);
    }

    function test_propose_revertsOnDescendingParticipants() public {
        AgentIntent memory i = _intent(p0, buyer);
        (i.participants[0], i.participants[1]) = (i.participants[1], i.participants[0]);
        _expectProposeRevert(i, buyerKey, p0, IAgentCoordination.ERC8001_ParticipantsNotCanonical.selector);
    }

    function test_propose_revertsOnDuplicateParticipants() public {
        AgentIntent memory i = _intent(p0, buyer);
        i.participants[0] = buyer;
        i.participants[1] = buyer;
        _expectProposeRevert(i, buyerKey, p0, IAgentCoordination.ERC8001_ParticipantsNotCanonical.selector);
    }

    function test_propose_revertsWhenAgentNotAParticipant() public {
        AgentIntent memory i = _intent(p0, stranger);
        _expectProposeRevert(i, strangerKey, p0, IAgentCoordination.ERC8001_NotParticipant.selector);
    }

    function test_propose_revertsWhenParticipantsAreNotTheOrderParties() public {
        // a canonical two-party list that includes the initiator but not the order's counterparty
        AgentIntent memory i = _intent(p0, buyer);
        i.participants = _sorted(buyer, stranger);
        _expectProposeRevert(i, buyerKey, p0, AgentOrderAmendments.ParticipantsNotOrderParties.selector);
        // a stranger initiating with another stranger
        i = _intent(p0, stranger);
        i.participants = _sorted(stranger, address(0x1234));
        _expectProposeRevert(i, strangerKey, p0, AgentOrderAmendments.ParticipantsNotOrderParties.selector);
    }

    function test_propose_revertsOnExtraParticipant() public {
        AgentIntent memory i = _intent(p0, buyer);
        address[] memory three = new address[](3);
        address[] memory two = _parties();
        three[0] = two[0];
        three[1] = two[1];
        three[2] = address(type(uint160).max);
        i.participants = three;
        _expectProposeRevert(i, buyerKey, p0, AgentOrderAmendments.ParticipantsNotOrderParties.selector);
    }

    function test_propose_revertsOnSingleParticipant() public {
        AgentIntent memory i = _intent(p0, buyer);
        address[] memory one = new address[](1);
        one[0] = buyer;
        i.participants = one;
        _expectProposeRevert(i, buyerKey, p0, AgentOrderAmendments.ParticipantsNotOrderParties.selector);
    }

    function test_propose_revertsOnWrongIntentCoordinationType() public {
        AgentIntent memory i = _intent(p0, buyer);
        i.coordinationType = keccak256("MEV_SANDWICH_COORD_V1");
        _expectProposeRevert(i, buyerKey, p0, AgentOrderAmendments.WrongCoordinationType.selector);
    }

    function test_propose_revertsOnPayloadTypeDifferentFromIntentType() public {
        CoordinationPayload memory p = p0;
        p.coordinationType = keccak256("OTHER");
        AgentIntent memory i = _intent(p, buyer);
        _expectProposeRevert(i, buyerKey, p, AgentOrderAmendments.WrongCoordinationType.selector);
    }

    function test_propose_revertsOnNonzeroCoordinationValue() public {
        AgentIntent memory i = _intent(p0, buyer);
        i.coordinationValue = 80;
        _expectProposeRevert(i, buyerKey, p0, AgentOrderAmendments.NonzeroCoordinationValue.selector);
    }

    function test_propose_revertsOnPayloadHashMismatch() public {
        AgentIntent memory i = _intent(p0, buyer);
        i.payloadHash = keccak256("something else");
        _expectProposeRevert(i, buyerKey, p0, IAgentCoordination.ERC8001_PayloadHashMismatch.selector);
    }

    function test_propose_revertsOnWrongPayloadVersion() public {
        CoordinationPayload memory p = p0;
        p.version = keccak256("ORDER_AMENDMENT_PAYLOAD_V2");
        _expectProposeRevert(_intent(p, buyer), buyerKey, p, AgentOrderAmendments.WrongPayloadVersion.selector);
    }

    function test_propose_revertsOnNonzeroPayloadConditions() public {
        CoordinationPayload memory p = p0;
        p.conditionsHash = keccak256("conditions");
        _expectProposeRevert(_intent(p, buyer), buyerKey, p, AgentOrderAmendments.NonzeroPayloadConditions.selector);
    }

    function test_propose_revertsOnNonemptyMetadata() public {
        CoordinationPayload memory p = p0;
        p.metadata = hex"01";
        _expectProposeRevert(_intent(p, buyer), buyerKey, p, AgentOrderAmendments.NonemptyPayloadMetadata.selector);
    }

    /// "Complete replacement data is not canonical ABI ...: reject the payload".
    function test_propose_revertsOnTrailingBytes() public {
        CoordinationPayload memory p = _payloadRaw(abi.encodePacked(p0.coordinationData, bytes32(0)));
        _expectProposeRevert(_intent(p, buyer), buyerKey, p, AgentOrderAmendments.NonCanonicalAmendmentData.selector);
        p = _payloadRaw(abi.encodePacked(p0.coordinationData, bytes1(0)));
        _expectProposeRevert(_intent(p, buyer), buyerKey, p, AgentOrderAmendments.NonCanonicalAmendmentData.selector);
    }

    function test_propose_revertsOnTruncatedData() public {
        bytes memory full = p0.coordinationData;
        bytes memory short = new bytes(320);
        for (uint256 k = 0; k < 320; ++k) {
            short[k] = full[k];
        }
        CoordinationPayload memory p = _payloadRaw(short);
        _expectProposeRevert(_intent(p, buyer), buyerKey, p, AgentOrderAmendments.NonCanonicalAmendmentData.selector);
        p = _payloadRaw("");
        _expectProposeRevert(_intent(p, buyer), buyerKey, p, AgentOrderAmendments.NonCanonicalAmendmentData.selector);
    }

    function test_propose_revertsOnDirtyPadding() public {
        // word 0 (address), 2 (uint64 baseRevision), 9 (uint64 deadline), 10 (uint64 validUntil)
        uint256[4] memory words = [uint256(0), 2, 9, 10];
        for (uint256 k = 0; k < 4; ++k) {
            bytes memory data = bytes.concat(p0.coordinationData);
            data[words[k] * 32] = 0x80;
            CoordinationPayload memory p = _payloadRaw(data);
            _expectProposeRevert(
                _intent(p, buyer), buyerKey, p, AgentOrderAmendments.NonCanonicalAmendmentData.selector
            );
        }
    }

    /// "... or its terms hash differs: reject the payload".
    function test_propose_revertsOnNewTermsHashMismatch() public {
        AmendmentData memory d = _dataFor(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        d.newTermsHash = keccak256("not these terms");
        CoordinationPayload memory p = _payload(d);
        _expectProposeRevert(_intent(p, buyer), buyerKey, p, AgentOrderAmendments.NewTermsHashMismatch.selector);
        // a domain-prefixed digest of the terms is not the terms hash either
        d.newTermsHash = _digest(_hashTerms(d.newTerms));
        p = _payload(d);
        _expectProposeRevert(_intent(p, buyer), buyerKey, p, AgentOrderAmendments.NewTermsHashMismatch.selector);
    }

    function test_propose_revertsOnForeignOrderContract() public {
        AmendmentData memory d = _dataFor(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        d.orderContract = address(0xDEAD);
        CoordinationPayload memory p = _payload(d);
        _expectProposeRevert(_intent(p, buyer), buyerKey, p, AgentOrderAmendments.WrongOrderContract.selector);
    }

    function test_propose_revertsOnUnknownOrder() public {
        AmendmentData memory d = _dataFor(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        d.orderId = keccak256("unknown");
        CoordinationPayload memory p = _payload(d);
        AgentIntent memory i = _intent(p, buyer);
        bytes memory sig = _sig(buyerKey, _digest(_intentHash(i)));
        vm.expectRevert(abi.encodeWithSelector(IOrderAmendments.UnknownOrder.selector, d.orderId));
        coord.proposeCoordination(i, sig, p);
    }

    /// "A new Core intent advances its initiator's nonce. It does not revoke all older pending intents."
    function test_propose_newerIntentDoesNotRevokeOlderOne() public {
        bytes32 older = _propose(buyerKey, p0);
        CoordinationPayload memory p1 = _payload(_dataFor(ORDER, _terms(SCOPE_C, 150, DEADLINE)));
        bytes32 newer = _propose(buyerKey, p1);
        assertEq(coord.getAgentNonce(buyer), 2);
        assertEq(uint8(_status(older)), uint8(Status.Proposed));
        _acceptBoth(older);
        _acceptBoth(newer);
        (bool ok,) = _execute(older, p0);
        assertTrue(ok);
        assertEq(_state(ORDER).terms.totalPrice, 180);
    }

    // ------------------------------------------------------------------ accept

    function test_accept_bothRequired_initiatorIncluded() public {
        bytes32 ih = _propose(buyerKey, p0);
        AcceptanceAttestation memory a = _attestation(ih, providerKey);
        vm.expectEmit(true, true, true, true, address(coord));
        emit IAgentCoordination.CoordinationAccepted(ih, provider, _acceptanceHash(a), 1, 2);
        vm.prank(provider);
        assertFalse(coord.acceptCoordination(ih, a));
        // the counterparty accepted, the proposer has not: still only Proposed
        (Status st,,, address[] memory acceptedBy,) = coord.getCoordinationStatus(ih);
        assertEq(uint8(st), uint8(Status.Proposed));
        assertEq(acceptedBy.length, 1);
        assertEq(acceptedBy[0], provider);

        AcceptanceAttestation memory b = _attestation(ih, buyerKey);
        vm.expectEmit(true, true, true, true, address(coord));
        emit IAgentCoordination.CoordinationAccepted(ih, buyer, _acceptanceHash(b), 2, 2);
        vm.prank(buyer);
        assertTrue(coord.acceptCoordination(ih, b));
        (st,,, acceptedBy,) = coord.getCoordinationStatus(ih);
        assertEq(uint8(st), uint8(Status.Ready));
        assertEq(acceptedBy.length, 2);
        // consent alone alters nothing
        assertEq(_state(ORDER).revision, 0);
        assertEq(token.balanceOf(address(coord)), 100);
    }

    function test_accept_participantMaySubmitTheOthersAttestation() public {
        bytes32 ih = _propose(buyerKey, p0);
        AcceptanceAttestation memory a = _attestation(ih, providerKey);
        vm.prank(buyer);
        assertFalse(coord.acceptCoordination(ih, a));
        (,,, address[] memory acceptedBy,) = coord.getCoordinationStatus(ih);
        assertEq(acceptedBy[0], provider); // credited to the signer, not the caller
    }

    function test_accept_revertsForNonParticipantCaller() public {
        bytes32 ih = _propose(buyerKey, p0);
        AcceptanceAttestation memory a = _attestation(ih, providerKey);
        vm.prank(relayer);
        vm.expectRevert(IAgentCoordination.ERC8001_NotParticipant.selector);
        coord.acceptCoordination(ih, a);
    }

    function test_accept_revertsForNonParticipantSigner() public {
        bytes32 ih = _propose(buyerKey, p0);
        AcceptanceAttestation memory a = _attestation(ih, strangerKey);
        vm.prank(buyer);
        vm.expectRevert(IAgentCoordination.ERC8001_NotParticipant.selector);
        coord.acceptCoordination(ih, a);
    }

    function test_accept_revertsOnDuplicate() public {
        bytes32 ih = _propose(buyerKey, p0);
        _accept(ih, buyerKey);
        AcceptanceAttestation memory a = _attestation(ih, buyerKey);
        vm.prank(buyer);
        vm.expectRevert(IAgentCoordination.ERC8001_DuplicateAcceptance.selector);
        coord.acceptCoordination(ih, a);
        _accept(ih, providerKey);
        a = _attestation(ih, providerKey);
        vm.prank(provider);
        vm.expectRevert(IAgentCoordination.ERC8001_DuplicateAcceptance.selector);
        coord.acceptCoordination(ih, a);
    }

    function test_accept_revertsOnBadSignature() public {
        bytes32 ih = _propose(buyerKey, p0);
        AcceptanceAttestation memory a = _attestation(ih, providerKey);
        a.signature = _sig(buyerKey, _digest(_acceptanceHash(a))); // signed by the other party
        vm.prank(provider);
        vm.expectRevert(IAgentCoordination.ERC8001_BadSignature.selector);
        coord.acceptCoordination(ih, a);

        a = _attestation(ih, providerKey);
        a.expiry += 1; // any signed field altered after signing
        vm.prank(provider);
        vm.expectRevert(IAgentCoordination.ERC8001_BadSignature.selector);
        coord.acceptCoordination(ih, a);

        // signed over the intent digest instead of the struct hash
        a = _attestation(ih, providerKey);
        a.signature = _sig(providerKey, _acceptanceHash(a)); // struct hash without domain
        vm.prank(provider);
        vm.expectRevert(IAgentCoordination.ERC8001_BadSignature.selector);
        coord.acceptCoordination(ih, a);
    }

    function test_accept_revertsWhenAcceptanceExpired() public {
        bytes32 ih = _propose(buyerKey, p0);
        AcceptanceAttestation memory a = _attestation(ih, providerKey);
        a.expiry = uint64(block.timestamp); // equality is expired
        a.signature = _sig(providerKey, _digest(_acceptanceHash(a)));
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(IAgentCoordination.ERC8001_ExpiredAcceptance.selector, provider));
        coord.acceptCoordination(ih, a);
    }

    function test_accept_revertsOnNonzeroNonce() public {
        bytes32 ih = _propose(buyerKey, p0);
        AcceptanceAttestation memory a = _attestation(ih, providerKey);
        a.nonce = 1;
        a.signature = _sig(providerKey, _digest(_acceptanceHash(a)));
        vm.prank(provider);
        vm.expectRevert(AgentOrderAmendments.NonzeroAcceptanceNonce.selector);
        coord.acceptCoordination(ih, a);
    }

    function test_accept_revertsOnNonzeroConditions() public {
        bytes32 ih = _propose(buyerKey, p0);
        AcceptanceAttestation memory a = _attestation(ih, providerKey);
        a.conditionsHash = keccak256("only if the moon is full");
        a.signature = _sig(providerKey, _digest(_acceptanceHash(a)));
        vm.prank(provider);
        vm.expectRevert(AgentOrderAmendments.NonzeroAcceptanceConditions.selector);
        coord.acceptCoordination(ih, a);
    }

    function test_accept_revertsOnUnknownIntent() public {
        bytes32 ih = keccak256("unknown");
        AcceptanceAttestation memory a = _attestation(ih, providerKey);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(AgentOrderAmendments.UnknownIntent.selector, ih));
        coord.acceptCoordination(ih, a);
    }

    function test_accept_revertsWhenIntentExpired() public {
        bytes32 ih = _propose(buyerKey, p0);
        vm.warp(T0 + intentTtl);
        AcceptanceAttestation memory a = _attestation(ih, providerKey);
        vm.prank(provider);
        vm.expectRevert(IAgentCoordination.ERC8001_ExpiredIntent.selector);
        coord.acceptCoordination(ih, a);
    }

    function test_accept_revertsOnAttestationForAnotherIntent() public {
        bytes32 ih1 = _propose(buyerKey, p0);
        bytes32 ih2 = _propose(buyerKey, p0);
        AcceptanceAttestation memory a = _attestation(ih1, providerKey);
        vm.prank(provider);
        vm.expectRevert(AgentOrderAmendments.IntentHashMismatch.selector);
        coord.acceptCoordination(ih2, a);
    }

    // ------------------------------------------------------------------ cancel

    function test_cancel_onlyProposerBeforeExpiry() public {
        bytes32 ih = _propose(buyerKey, p0);
        vm.prank(provider);
        vm.expectRevert(IAgentCoordination.ERC8001_NotProposer.selector);
        coord.cancelCoordination(ih, "no");
        vm.prank(stranger);
        vm.expectRevert(IAgentCoordination.ERC8001_NotProposer.selector);
        coord.cancelCoordination(ih, "no");

        vm.expectEmit(true, true, true, true, address(coord));
        emit IAgentCoordination.CoordinationCancelled(ih, buyer, "changed my mind", uint8(Status.Cancelled));
        vm.prank(buyer);
        coord.cancelCoordination(ih, "changed my mind");
        assertEq(uint8(_status(ih)), uint8(Status.Cancelled));
    }

    function test_cancel_anyoneAtOrAfterExpiry() public {
        bytes32 ih = _propose(buyerKey, p0);
        vm.warp(T0 + intentTtl - 1);
        vm.prank(stranger);
        vm.expectRevert(IAgentCoordination.ERC8001_NotProposer.selector);
        coord.cancelCoordination(ih, "");
        vm.warp(T0 + intentTtl); // "at or after intent expiry, anyone can cancel it"
        assertEq(uint8(_status(ih)), uint8(Status.Expired));
        vm.prank(stranger);
        coord.cancelCoordination(ih, "expired");
        assertEq(uint8(_status(ih)), uint8(Status.Cancelled));
    }

    function test_cancel_readyIntentThenTerminal() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        vm.prank(buyer);
        coord.cancelCoordination(ih, "withdrawn");

        vm.expectRevert(IAgentCoordination.ERC8001_NotReady.selector);
        coord.executeCoordination(ih, p, "");
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AgentOrderAmendments.IntentNotOpen.selector, ih));
        coord.cancelCoordination(ih, "again");
        assertEq(_state(ORDER).revision, 0);
        assertEq(_state(ORDER).nonce, 0); // Core cancellation does not touch the order nonce
    }

    function test_cancel_cancelledIntentCannotBeAccepted() public {
        bytes32 ih = _propose(buyerKey, p0);
        vm.prank(buyer);
        coord.cancelCoordination(ih, "");
        AcceptanceAttestation memory a = _attestation(ih, providerKey);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(AgentOrderAmendments.IntentNotOpen.selector, ih));
        coord.acceptCoordination(ih, a);
    }

    function test_cancel_executedIntentIsTerminal() public {
        (bytes32 ih, CoordinationPayload memory p) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        _execute(ih, p);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AgentOrderAmendments.IntentNotOpen.selector, ih));
        coord.cancelCoordination(ih, "");
        vm.expectRevert(IAgentCoordination.ERC8001_NotReady.selector);
        coord.executeCoordination(ih, p, ""); // cannot apply twice
        assertEq(_state(ORDER).revision, 1);
    }

    function test_cancel_unknownIntentReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AgentOrderAmendments.UnknownIntent.selector, bytes32(uint256(1))));
        coord.cancelCoordination(bytes32(uint256(1)), "");
    }

    // ------------------------------------------------------------------ status

    function test_status_noneForUnknownIntent() public view {
        (Status st, address proposer, address[] memory ps, address[] memory acc, uint256 expiry) =
            coord.getCoordinationStatus(keccak256("unknown"));
        assertEq(uint8(st), uint8(Status.None));
        assertEq(proposer, address(0));
        assertEq(ps.length, 0);
        assertEq(acc.length, 0);
        assertEq(expiry, 0);
        assertEq(coord.getRequiredAcceptances(keccak256("unknown")), 0);
    }

    function test_status_expiredAfterIntentExpiry() public {
        bytes32 ih = _propose(buyerKey, p0);
        vm.warp(T0 + intentTtl - 1);
        assertEq(uint8(_status(ih)), uint8(Status.Proposed));
        vm.warp(T0 + intentTtl);
        assertEq(uint8(_status(ih)), uint8(Status.Expired));
    }

    function test_status_readyBecomesExpiredWhenAnAcceptanceLapses() public {
        (bytes32 ih,) = _ready(ORDER, _terms(SCOPE_B, 180, DEADLINE));
        vm.warp(T0 + acceptTtl - 1);
        assertEq(uint8(_status(ih)), uint8(Status.Ready));
        vm.warp(T0 + acceptTtl); // intent itself still unexpired
        assertEq(uint8(_status(ih)), uint8(Status.Expired));
    }
}
