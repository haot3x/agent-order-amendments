// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {AgentOrderAmendments} from "../src/AgentOrderAmendments.sol";
import {
    Status,
    AgentIntent,
    CoordinationPayload,
    AcceptanceAttestation,
    IAgentCoordination
} from "../src/interfaces/IERC8001.sol";
import {Terms, AmendmentData, IOrderAmendments} from "../src/interfaces/IOrderAmendments.sol";
import {Harness, TestToken} from "./mocks/Mocks.sol";

/// Shared fixtures. All hashing here is done independently of the contract's own helpers, directly
/// from the type strings in the two specifications.
abstract contract Base is Test {
    uint256 internal constant T0 = 2_000_000_000;
    uint64 internal constant DEADLINE = uint64(T0 + 10_000);
    uint256 internal constant SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    bytes32 internal constant COORD_TYPE = keccak256("ORDER_AMENDMENT_V1");
    bytes32 internal constant PAYLOAD_VERSION = keccak256("ORDER_AMENDMENT_PAYLOAD_V1");
    bytes32 internal constant TERMS_TYPEHASH =
        keccak256("Terms(bytes32 scopeHash,bytes32 acceptanceHash,uint256 totalPrice,uint64 deadline)");
    bytes32 internal constant INTENT_TYPEHASH = keccak256(
        "AgentIntent(bytes32 payloadHash,uint64 expiry,uint64 nonce,address agentId,bytes32 coordinationType,uint256 coordinationValue,address[] participants)"
    );
    bytes32 internal constant ACCEPTANCE_TYPEHASH = keccak256(
        "AcceptanceAttestation(bytes32 intentHash,address participant,uint64 nonce,uint64 expiry,bytes32 conditionsHash)"
    );

    bytes32 internal constant APPLIED_TOPIC =
        keccak256("OrderAmendmentApplied(bytes32,bytes32,uint64,bytes32,bytes32,uint256)");
    bytes32 internal constant EXECUTED_TOPIC = keccak256("CoordinationExecuted(bytes32,address,bool,uint256,bytes)");

    bytes32 internal constant ORDER = keccak256("order-1");
    bytes32 internal constant SCOPE_A = keccak256("three projects");
    bytes32 internal constant SCOPE_B = keccak256("ten projects");
    bytes32 internal constant SCOPE_C = keccak256("twelve projects");
    bytes32 internal constant ACCEPT_A = keccak256("acceptance criteria");
    bytes32 internal constant RESULT = keccak256("result document");

    uint256 internal buyerKey = 0xB0B;
    uint256 internal providerKey = 0xA11CE;
    uint256 internal strangerKey = 0xBAD;
    address internal buyer;
    address internal provider;
    address internal stranger;
    address internal relayer = address(0xE1A7);

    AgentOrderAmendments internal coord;
    TestToken internal token;

    uint64 internal intentTtl = 5_000;
    uint64 internal acceptTtl = 4_000;
    uint64 internal validTtl = 3_000;

    struct S {
        address buyer;
        address provider;
        address asset;
        uint64 revision;
        bytes32 termsHash;
        uint256 nonce;
        Terms terms;
        bool eligible;
    }

    function setUp() public virtual {
        vm.warp(T0);
        buyer = vm.addr(buyerKey);
        provider = vm.addr(providerKey);
        stranger = vm.addr(strangerKey);
        coord = new Harness();
        token = new TestToken();
        token.mint(buyer, 1_000);
        vm.prank(buyer);
        token.approve(address(coord), type(uint256).max);
        _createActive(ORDER, 100, DEADLINE);
    }

    function harness() internal view returns (Harness) {
        return Harness(address(coord));
    }

    // ------------------------------------------------------------------ orders

    function _terms(bytes32 scope, uint256 price, uint64 deadline) internal pure returns (Terms memory) {
        return Terms({scopeHash: scope, acceptanceHash: ACCEPT_A, totalPrice: price, deadline: deadline});
    }

    function _hashTerms(Terms memory t) internal pure returns (bytes32) {
        return keccak256(abi.encode(TERMS_TYPEHASH, t.scopeHash, t.acceptanceHash, t.totalPrice, t.deadline));
    }

    function _createOffered(bytes32 id, uint256 price, uint64 deadline) internal {
        vm.prank(buyer);
        coord.createOrder(id, provider, address(token), _terms(SCOPE_A, price, deadline));
    }

    function _createActive(bytes32 id, uint256 price, uint64 deadline) internal {
        _createOffered(id, price, deadline);
        vm.prank(provider);
        coord.agreeOrder(id, _hashTerms(_terms(SCOPE_A, price, deadline)));
    }

    function _state(bytes32 id) internal view returns (S memory s) {
        (s.buyer, s.provider, s.asset, s.revision, s.termsHash, s.nonce, s.terms, s.eligible) =
            coord.getAmendmentState(id);
    }

    function _submit(bytes32 id) internal {
        S memory s = _state(id);
        vm.prank(provider);
        coord.submitWork(id, s.revision, s.termsHash, RESULT);
    }

    // ------------------------------------------------------------------ typed data

    /// Builds amendment data from the common view only, as an independent client would.
    function _dataFor(bytes32 id, Terms memory nt) internal view returns (AmendmentData memory d) {
        S memory s = _state(id);
        d.orderContract = address(coord);
        d.orderId = id;
        d.baseRevision = s.revision;
        d.baseTermsHash = s.termsHash;
        d.amendmentNonce = s.nonce;
        d.newTermsHash = _hashTerms(nt);
        d.newTerms = nt;
        d.validUntil = uint64(block.timestamp) + validTtl;
    }

    function _payload(AmendmentData memory d) internal view returns (CoordinationPayload memory) {
        return _payloadRaw(abi.encode(d));
    }

    function _payloadRaw(bytes memory data) internal view returns (CoordinationPayload memory p) {
        p.version = PAYLOAD_VERSION;
        p.coordinationType = COORD_TYPE;
        p.coordinationData = data;
        p.conditionsHash = bytes32(0);
        p.timestamp = block.timestamp;
        p.metadata = "";
    }

    function _payloadHash(CoordinationPayload memory p) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(p.version, p.coordinationType, p.coordinationData, p.conditionsHash, p.timestamp, p.metadata)
        );
    }

    function _parties() internal view returns (address[] memory ps) {
        return _sorted(buyer, provider);
    }

    function _sorted(address a, address b) internal pure returns (address[] memory ps) {
        ps = new address[](2);
        (ps[0], ps[1]) = uint160(a) < uint160(b) ? (a, b) : (b, a);
    }

    function _intent(CoordinationPayload memory p, address agent) internal view returns (AgentIntent memory i) {
        i.payloadHash = _payloadHash(p);
        i.expiry = uint64(block.timestamp) + intentTtl;
        i.nonce = coord.getAgentNonce(agent) + 1;
        i.agentId = agent;
        i.coordinationType = COORD_TYPE;
        i.coordinationValue = 0;
        i.participants = _parties();
    }

    function _intentHash(AgentIntent memory i) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                i.payloadHash,
                i.expiry,
                i.nonce,
                i.agentId,
                i.coordinationType,
                i.coordinationValue,
                keccak256(abi.encodePacked(i.participants))
            )
        );
    }

    function _domainSeparator(address verifying) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ERC-8001"),
                keccak256("1"),
                block.chainid,
                verifying
            )
        );
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(address(coord)), structHash));
    }

    function _acceptanceHash(AcceptanceAttestation memory a) internal pure returns (bytes32) {
        return keccak256(abi.encode(ACCEPTANCE_TYPEHASH, a.intentHash, a.participant, a.nonce, a.expiry, a.conditionsHash));
    }

    // ------------------------------------------------------------------ signatures

    function _sig(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sigCompact(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, bytes32(uint256(s) | (uint256(v - 27) << 255)));
    }

    /// The mathematically equivalent high-s form of a signature (malleated twin).
    function _sigHighS(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, bytes32(SECP_N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
    }

    // ------------------------------------------------------------------ coordination flow

    function _propose(uint256 key, CoordinationPayload memory p) internal virtual returns (bytes32 ih) {
        AgentIntent memory i = _intent(p, vm.addr(key));
        ih = _intentHash(i);
        vm.prank(relayer);
        bytes32 returned = coord.proposeCoordination(i, _sig(key, _digest(ih)), p);
        assertEq(returned, ih, "proposeCoordination returns the struct hash");
    }

    function _attestation(bytes32 ih, uint256 key) internal view returns (AcceptanceAttestation memory a) {
        a.intentHash = ih;
        a.participant = vm.addr(key);
        a.nonce = 0;
        a.expiry = uint64(block.timestamp) + acceptTtl;
        a.conditionsHash = bytes32(0);
        a.signature = _sig(key, _digest(_acceptanceHash(a)));
    }

    function _accept(bytes32 ih, uint256 key) internal returns (bool) {
        AcceptanceAttestation memory a = _attestation(ih, key);
        vm.prank(a.participant);
        return coord.acceptCoordination(ih, a);
    }

    function _acceptBoth(bytes32 ih) internal {
        assertFalse(_accept(ih, buyerKey));
        assertTrue(_accept(ih, providerKey));
    }

    /// Buyer proposes an amendment to `nt` built from the current view; both parties accept.
    function _ready(bytes32 id, Terms memory nt) internal returns (bytes32 ih, CoordinationPayload memory p) {
        p = _payload(_dataFor(id, nt));
        ih = _propose(buyerKey, p);
        _acceptBoth(ih);
    }

    function _execute(bytes32 ih, CoordinationPayload memory p) internal returns (bool ok, bytes memory result) {
        vm.prank(relayer);
        (ok, result) = coord.executeCoordination(ih, p, "");
    }

    function _status(bytes32 ih) internal view returns (Status st) {
        (st,,,,) = coord.getCoordinationStatus(ih);
    }

    /// Puts a Ready coordination for an arbitrary payload into storage, bypassing proposal checks.
    function _forceReady(CoordinationPayload memory p) internal returns (bytes32 ih) {
        ih = keccak256(abi.encode("forced", _payloadHash(p)));
        harness().h_forceReady(ih, buyer, uint64(block.timestamp) + intentTtl, _payloadHash(p), _parties());
    }

    // ------------------------------------------------------------------ assertions

    function _countLogs(Vm.Log[] memory logs, bytes32 topic0) internal pure returns (uint256 n) {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic0) n++;
        }
    }

    function _findLog(Vm.Log[] memory logs, bytes32 topic0) internal pure returns (Vm.Log memory) {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic0) return logs[i];
        }
        revert("log not found");
    }

    /// Executes and asserts the "Executed, success=false, everything rolled back" outcome.
    function _assertFailedApplication(bytes32 id, bytes32 ih, CoordinationPayload memory p, bytes4 expectedError)
        internal
    {
        S memory before = _state(id);
        uint256 buyerBal = token.balanceOf(buyer);
        uint256 escrowBal = token.balanceOf(address(coord));
        (, uint256 escrowedBefore,) = coord.getOrder(id);

        vm.recordLogs();
        (bool ok, bytes memory result) = _execute(ih, p);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertFalse(ok, "application must fail");
        assertEq(bytes4(result), expectedError, "failure reason");
        assertEq(uint8(_status(ih)), uint8(Status.Executed), "Core status is Executed");
        assertEq(_countLogs(logs, APPLIED_TOPIC), 0, "no OrderAmendmentApplied in receipt");
        assertEq(_countLogs(logs, EXECUTED_TOPIC), 1, "one CoordinationExecuted");
        // Note: vm.recordLogs also captures logs emitted inside frames that later revert (for example the
        // token's Transfer), so the total log count is not asserted here. Removal of reverted-frame logs
        // from the receipt is an EVM guarantee; the state and balance assertions below show the rollback.
        (bool evOk,,) = abi.decode(_findLog(logs, EXECUTED_TOPIC).data, (bool, uint256, bytes));
        assertFalse(evOk, "CoordinationExecuted.success == false");

        S memory afterS = _state(id);
        assertEq(keccak256(abi.encode(afterS)), keccak256(abi.encode(before)), "order state unchanged");
        assertEq(token.balanceOf(buyer), buyerBal, "buyer balance unchanged");
        assertEq(token.balanceOf(address(coord)), escrowBal, "escrow balance unchanged");
        (, uint256 escrowedAfter,) = coord.getOrder(id);
        assertEq(escrowedAfter, escrowedBefore, "escrow accounting unchanged");
    }
}
