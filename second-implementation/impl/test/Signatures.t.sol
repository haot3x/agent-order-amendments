// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.30;

import "./Base.sol";
import {SigHarness, Wallet1271} from "./mocks/Mocks.sol";

/// ERC-8448 "Submission and signatures": signature formats and validation time.
contract SignaturesTest is Base {
    CoordinationPayload internal p0;
    SigHarness internal sigs;

    uint256 internal walletKey = 0x77A11E7;
    Wallet1271 internal wallet;
    bytes32 internal constant WORDER = keccak256("wallet-order");

    function setUp() public override {
        super.setUp();
        p0 = _payload(_dataFor(ORDER, _terms(SCOPE_B, 180, DEADLINE)));
        sigs = new SigHarness();

        // an order whose buyer is an ERC-1271 contract wallet
        wallet = new Wallet1271(vm.addr(walletKey));
        token.mint(address(wallet), 1_000);
        wallet.execute(address(token), abi.encodeCall(token.approve, (address(coord), type(uint256).max)));
        wallet.execute(
            address(coord),
            abi.encodeCall(coord.createOrder, (WORDER, provider, address(token), _terms(SCOPE_A, 100, DEADLINE)))
        );
        vm.prank(provider);
        coord.agreeOrder(WORDER, _hashTerms(_terms(SCOPE_A, 100, DEADLINE)));
    }

    // ------------------------------------------------------------------ EOA: 65-byte

    function test_sig_65ByteLowS_acceptedAtProposeAndAccept() public {
        bytes32 ih = _propose(buyerKey, p0);
        AcceptanceAttestation memory a = _attestation(ih, providerKey);
        assertEq(a.signature.length, 65);
        vm.prank(provider);
        coord.acceptCoordination(ih, a);
    }

    // ------------------------------------------------------------------ EOA: ERC-2098 compact

    function test_sig_compact64_acceptedAtPropose() public {
        AgentIntent memory i = _intent(p0, buyer);
        bytes32 ih = _intentHash(i);
        bytes memory sig = _sigCompact(buyerKey, _digest(ih));
        assertEq(sig.length, 64);
        assertEq(coord.proposeCoordination(i, sig, p0), ih);
        assertEq(uint8(_status(ih)), uint8(Status.Proposed));
    }

    function test_sig_compact64_acceptedAtAccept_thenExecutes() public {
        bytes32 ih = _propose(buyerKey, p0);
        AcceptanceAttestation memory a = _attestation(ih, providerKey);
        a.signature = _sigCompact(providerKey, _digest(_acceptanceHash(a)));
        vm.prank(provider);
        assertFalse(coord.acceptCoordination(ih, a));
        AcceptanceAttestation memory b = _attestation(ih, buyerKey);
        b.signature = _sigCompact(buyerKey, _digest(_acceptanceHash(b)));
        vm.prank(buyer);
        assertTrue(coord.acceptCoordination(ih, b));
        (bool ok,) = _execute(ih, p0);
        assertTrue(ok);
    }

    function test_sig_compact64_bothParities() public view {
        bool saw27;
        bool saw28;
        for (uint256 k = 0; k < 64 && !(saw27 && saw28); ++k) {
            bytes32 digest = keccak256(abi.encode("parity", k));
            (uint8 v,,) = vm.sign(buyerKey, digest);
            if (v == 27) saw27 = true;
            else saw28 = true;
            assertEq(sigs.recover(digest, _sigCompact(buyerKey, digest)), buyer);
            assertEq(sigs.recover(digest, _sig(buyerKey, digest)), buyer);
        }
        assertTrue(saw27 && saw28, "both y-parities exercised");
    }

    function test_sig_compact64_wrongSignerRejected() public {
        AgentIntent memory i = _intent(p0, buyer);
        bytes memory sig = _sigCompact(providerKey, _digest(_intentHash(i)));
        vm.expectRevert(IAgentCoordination.ERC8001_BadSignature.selector);
        coord.proposeCoordination(i, sig, p0);
    }

    // ------------------------------------------------------------------ EOA: malleability and malformed input

    function test_sig_highS_rejectedAtPropose() public {
        AgentIntent memory i = _intent(p0, buyer);
        bytes32 digest = _digest(_intentHash(i));
        bytes memory high = _sigHighS(buyerKey, digest);
        // the twin is a mathematically valid signature by the buyer: only the low-s rule rejects it
        (bytes32 r, bytes32 s, uint8 v) = _split(high);
        assertEq(ecrecover(digest, v, r, s), buyer);
        assertGt(uint256(s), SECP_N / 2);
        vm.expectRevert(IAgentCoordination.ERC8001_BadSignature.selector);
        coord.proposeCoordination(i, high, p0);
        // the low-s original is accepted
        coord.proposeCoordination(i, _sig(buyerKey, digest), p0);
    }

    function test_sig_highS_rejectedAtAccept() public {
        bytes32 ih = _propose(buyerKey, p0);
        AcceptanceAttestation memory a = _attestation(ih, providerKey);
        a.signature = _sigHighS(providerKey, _digest(_acceptanceHash(a)));
        vm.prank(provider);
        vm.expectRevert(IAgentCoordination.ERC8001_BadSignature.selector);
        coord.acceptCoordination(ih, a);
    }

    function test_sig_sExactlyHalfNBoundary() public view {
        // s == n/2 is the largest low-s value and passes the range check (it recovers *some* address);
        // s == n/2 + 1 is rejected outright.
        bytes32 digest = keccak256("boundary");
        (, bytes32 r,) = vm.sign(buyerKey, digest); // a valid curve x-coordinate
        uint256 half = SECP_N / 2;
        assertTrue(sigs.recover(digest, abi.encodePacked(r, bytes32(half), uint8(27))) != address(0));
        assertEq(sigs.recover(digest, abi.encodePacked(r, bytes32(half + 1), uint8(27))), address(0));
    }

    function test_sig_invalidV_rejected() public {
        AgentIntent memory i = _intent(p0, buyer);
        bytes32 digest = _digest(_intentHash(i));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerKey, digest);
        uint8[3] memory bad = [v - 27, 29, 0xff];
        for (uint256 k = 0; k < 3; ++k) {
            bytes memory sig = abi.encodePacked(r, s, bad[k]);
            vm.expectRevert(IAgentCoordination.ERC8001_BadSignature.selector);
            coord.proposeCoordination(i, sig, p0);
        }
    }

    function test_sig_wrongLength_rejected() public {
        AgentIntent memory i = _intent(p0, buyer);
        bytes memory good = _sig(buyerKey, _digest(_intentHash(i)));
        bytes[4] memory bad = [bytes(""), abi.encodePacked(good, uint8(0)), _slice(good, 63), _slice(good, 32)];
        for (uint256 k = 0; k < 4; ++k) {
            vm.expectRevert(IAgentCoordination.ERC8001_BadSignature.selector);
            coord.proposeCoordination(i, bad[k], p0);
        }
    }

    function test_sig_zeroSignerNeverValid() public view {
        // ecrecover returns address(0) for garbage; that must not validate a zero "signer"
        bytes memory garbage = abi.encodePacked(bytes32(0), bytes32(0), uint8(27));
        assertEq(sigs.recover(keccak256("x"), garbage), address(0));
        assertFalse(sigs.isValid(address(0), keccak256("x"), garbage));
    }

    // ------------------------------------------------------------------ ERC-1271 contract signers

    function _walletIntent(CoordinationPayload memory p) internal view returns (AgentIntent memory i) {
        i = _intent(p, address(wallet));
        i.participants = _sorted(address(wallet), provider);
    }

    function _walletAttestation(bytes32 ih) internal view returns (AcceptanceAttestation memory a) {
        a.intentHash = ih;
        a.participant = address(wallet);
        a.expiry = uint64(block.timestamp) + acceptTtl;
        a.signature = _sig(walletKey, _digest(_acceptanceHash(a)));
    }

    function _walletPayload() internal view returns (CoordinationPayload memory) {
        return _payload(_dataFor(WORDER, _terms(SCOPE_B, 180, DEADLINE)));
    }

    function test_1271_acceptedAtProposeAndAccept_andApplies() public {
        CoordinationPayload memory p = _walletPayload();
        AgentIntent memory i = _walletIntent(p);
        bytes32 ih = _intentHash(i);
        coord.proposeCoordination(i, _sig(walletKey, _digest(ih)), p);
        (, address proposer,,,) = coord.getCoordinationStatus(ih);
        assertEq(proposer, address(wallet));

        AcceptanceAttestation memory a = _walletAttestation(ih);
        vm.prank(provider); // the EOA counterparty relays the wallet's attestation
        assertFalse(coord.acceptCoordination(ih, a));
        assertTrue(_accept(ih, providerKey));

        (bool ok, bytes memory result) = _execute(ih, p);
        assertTrue(ok);
        assertEq(result, abi.encode(WORDER, uint64(1), _hashTerms(_terms(SCOPE_B, 180, DEADLINE)), uint256(80)));
        assertEq(token.balanceOf(address(wallet)), 1_000 - 180);
    }

    function test_1271_rejectedWhenWalletSaysNo_propose() public {
        CoordinationPayload memory p = _walletPayload();
        AgentIntent memory i = _walletIntent(p);
        bytes32 digest = _digest(_intentHash(i));

        // signed by a key the wallet does not recognise
        bytes memory sig = _sig(strangerKey, digest);
        vm.expectRevert(IAgentCoordination.ERC8001_BadSignature.selector);
        coord.proposeCoordination(i, sig, p);

        sig = _sig(walletKey, digest);
        Wallet1271.Mode[4] memory modes =
            [Wallet1271.Mode.WrongMagic, Wallet1271.Mode.Revert, Wallet1271.Mode.Write, Wallet1271.Mode.Empty];
        for (uint256 k = 0; k < 4; ++k) {
            wallet.setMode(modes[k]);
            vm.expectRevert(IAgentCoordination.ERC8001_BadSignature.selector);
            coord.proposeCoordination(i, sig, p);
        }
        assertEq(wallet.counter(), 0, "STATICCALL: the wallet could not write state");

        wallet.setMode(Wallet1271.Mode.Valid);
        coord.proposeCoordination(i, sig, p);
    }

    function test_1271_rejectedWhenWalletSaysNo_accept() public {
        CoordinationPayload memory p = _walletPayload();
        bytes32 ih = _propose(providerKey, p);
        AcceptanceAttestation memory a = _walletAttestation(ih);

        wallet.setMode(Wallet1271.Mode.WrongMagic);
        vm.prank(provider);
        vm.expectRevert(IAgentCoordination.ERC8001_BadSignature.selector);
        coord.acceptCoordination(ih, a);

        wallet.setMode(Wallet1271.Mode.Write);
        vm.prank(provider);
        vm.expectRevert(IAgentCoordination.ERC8001_BadSignature.selector);
        coord.acceptCoordination(ih, a);

        wallet.setMode(Wallet1271.Mode.Valid);
        a.signature = _sig(strangerKey, _digest(_acceptanceHash(a)));
        vm.prank(provider);
        vm.expectRevert(IAgentCoordination.ERC8001_BadSignature.selector);
        coord.acceptCoordination(ih, a);
    }

    /// A contract signer is validated through ERC-1271 only: an ECDSA signature that would recover to
    /// some EOA is irrelevant, and the wallet owner's signature is not accepted for the owner's EOA.
    function test_1271_ownerSignatureDoesNotActForUnrelatedParticipant() public {
        bytes32 ih = _propose(buyerKey, p0);
        AcceptanceAttestation memory a = _attestation(ih, providerKey);
        a.signature = _sig(walletKey, _digest(_acceptanceHash(a)));
        vm.prank(provider);
        vm.expectRevert(IAgentCoordination.ERC8001_BadSignature.selector);
        coord.acceptCoordination(ih, a);
    }

    /// "this profile MUST NOT revalidate a mutable ERC-1271 signing policy at execution time".
    function test_1271_notRevalidatedAtExecution() public {
        CoordinationPayload memory p = _walletPayload();
        AgentIntent memory i = _walletIntent(p);
        bytes32 ih = _intentHash(i);
        coord.proposeCoordination(i, _sig(walletKey, _digest(ih)), p);
        vm.prank(provider);
        coord.acceptCoordination(ih, _walletAttestation(ih));
        _accept(ih, providerKey);

        // the wallet's policy changes after acceptance: new owner, and it now rejects everything
        wallet.setOwner(stranger);
        wallet.setMode(Wallet1271.Mode.Revert);

        (bool ok,) = _execute(ih, p);
        assertTrue(ok);
        assertEq(_state(WORDER).revision, 1);
    }

    /// Withdrawal after acceptance is by explicit order invalidation, also for a contract wallet.
    function test_1271_walletWithdrawsByInvalidation() public {
        CoordinationPayload memory p = _walletPayload();
        AgentIntent memory i = _walletIntent(p);
        bytes32 ih = _intentHash(i);
        coord.proposeCoordination(i, _sig(walletKey, _digest(ih)), p);
        vm.prank(provider);
        coord.acceptCoordination(ih, _walletAttestation(ih));
        _accept(ih, providerKey);

        wallet.execute(address(coord), abi.encodeCall(coord.invalidateAmendments, (WORDER)));
        (bool ok,) = _execute(ih, p);
        assertFalse(ok);
        assertEq(_state(WORDER).revision, 0);
        assertEq(_state(WORDER).nonce, 1);
    }

    // ------------------------------------------------------------------ helpers

    /// `_propose` builds participants from (buyer, provider); the wallet order needs (wallet, provider).
    function _propose(uint256 key, CoordinationPayload memory p) internal override returns (bytes32 ih) {
        AmendmentData memory d = abi.decode(p.coordinationData, (AmendmentData));
        if (d.orderId != WORDER) return super._propose(key, p);
        AgentIntent memory i = _intent(p, vm.addr(key));
        i.participants = _sorted(address(wallet), provider);
        ih = _intentHash(i);
        coord.proposeCoordination(i, _sig(key, _digest(ih)), p);
    }

    function _split(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
    }

    function _slice(bytes memory data, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 k = 0; k < len; ++k) {
            out[k] = data[k];
        }
    }
}
