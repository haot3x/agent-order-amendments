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
import {TestToken} from "./mocks/Mocks.sol";

/// Reproduces the published deterministic vector (`order-amendment-v1.json`, read from disk, a
/// byte-identical copy of the spec asset) and drives its real signatures through the real
/// propose/accept/execute entry points of a contract placed at the vector's verifyingContract.
contract VectorTest is Test {
    string internal json;
    AgentOrderAmendments internal coord;
    TestToken internal token;

    address internal constant VERIFYING = 0x1000000000000000000000000000000000000001;

    function setUp() public {
        json = vm.readFile("test/vectors/order-amendment-v1.json");
        // The contract has no constructor arguments or immutables, so its code can be placed directly.
        deployCodeTo("AgentOrderAmendments.sol:AgentOrderAmendments", VERIFYING);
        coord = AgentOrderAmendments(VERIFYING);
        token = new TestToken();
        vm.warp(_u(".payload.timestamp"));
    }

    // ------------------------------------------------------------------ json helpers

    function _u(string memory key) internal view returns (uint256) {
        return vm.parseUint(vm.parseJsonString(json, key));
    }

    function _b32(string memory key) internal view returns (bytes32) {
        return vm.parseJsonBytes32(json, key);
    }

    function _addr(string memory key) internal view returns (address) {
        return vm.parseJsonAddress(json, key);
    }

    function _terms(string memory prefix) internal view returns (Terms memory t) {
        t.scopeHash = _b32(string.concat(prefix, ".scopeHash"));
        t.acceptanceHash = _b32(string.concat(prefix, ".acceptanceHash"));
        t.totalPrice = _u(string.concat(prefix, ".totalPrice"));
        t.deadline = uint64(_u(string.concat(prefix, ".deadline")));
    }

    function _data() internal view returns (AmendmentData memory d) {
        d.orderContract = _addr(".data.orderContract");
        d.orderId = _b32(".data.orderId");
        d.baseRevision = uint64(_u(".data.baseRevision"));
        d.baseTermsHash = _b32(".data.baseTermsHash");
        d.amendmentNonce = _u(".data.amendmentNonce");
        d.newTermsHash = _b32(".data.newTermsHash");
        d.newTerms = _terms(".data.newTerms");
        d.validUntil = uint64(_u(".data.validUntil"));
    }

    function _payload() internal view returns (CoordinationPayload memory p) {
        p.version = _b32(".payload.version");
        p.coordinationType = _b32(".payload.coordinationType");
        p.coordinationData = vm.parseJsonBytes(json, ".payload.coordinationData");
        p.conditionsHash = _b32(".payload.conditionsHash");
        p.timestamp = _u(".payload.timestamp");
        p.metadata = vm.parseJsonBytes(json, ".payload.metadata");
    }

    function _intent() internal view returns (AgentIntent memory i) {
        i.payloadHash = _b32(".intent.payloadHash");
        i.expiry = uint64(_u(".intent.expiry"));
        i.nonce = uint64(_u(".intent.nonce"));
        i.agentId = _addr(".intent.agentId");
        i.coordinationType = _b32(".intent.coordinationType");
        i.coordinationValue = _u(".intent.coordinationValue");
        i.participants = vm.parseJsonAddressArray(json, ".intent.participants");
    }

    function _acceptance(uint256 n) internal view returns (AcceptanceAttestation memory a) {
        string memory base = string.concat(".acceptances[", vm.toString(n), "]");
        a.intentHash = _b32(string.concat(base, ".message.intentHash"));
        a.participant = _addr(string.concat(base, ".message.participant"));
        a.nonce = uint64(_u(string.concat(base, ".message.nonce")));
        a.expiry = uint64(_u(string.concat(base, ".message.expiry")));
        a.conditionsHash = _b32(string.concat(base, ".message.conditionsHash"));
        a.signature = vm.parseJsonBytes(json, string.concat(base, ".signature"));
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(vm.parseJsonString(json, ".domain.name"))),
                keccak256(bytes(vm.parseJsonString(json, ".domain.version"))),
                _u(".domain.chainId"),
                _addr(".domain.verifyingContract")
            )
        );
    }

    function _recover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        require(sig.length == 65, "vector signatures are 65 bytes");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        return ecrecover(digest, v, r, s);
    }

    // ------------------------------------------------------------------ hashes, recomputed independently

    function test_vector_domainAndParties() public view {
        assertEq(_u(".domain.chainId"), block.chainid, "test chain id matches the vector domain");
        assertEq(_addr(".domain.verifyingContract"), address(coord));
        assertEq(_addr(".data.orderContract"), address(coord));
        assertEq(_addr(".buyer"), vm.addr(1), "buyer is public key 1");
        assertEq(_addr(".provider"), vm.addr(2), "provider is public key 2");
        assertEq(coord.DOMAIN_SEPARATOR(), _domainSeparator());
    }

    function test_vector_identifiers() public view {
        assertEq(_b32(".payload.coordinationType"), keccak256("ORDER_AMENDMENT_V1"));
        assertEq(_b32(".intent.coordinationType"), keccak256("ORDER_AMENDMENT_V1"));
        assertEq(_b32(".payload.version"), keccak256("ORDER_AMENDMENT_PAYLOAD_V1"));
        assertEq(coord.ORDER_AMENDMENT_V1(), _b32(".payload.coordinationType"));
        assertEq(coord.ORDER_AMENDMENT_PAYLOAD_V1(), _b32(".payload.version"));
    }

    function test_vector_termsHashes() public view {
        bytes32 th = keccak256("Terms(bytes32 scopeHash,bytes32 acceptanceHash,uint256 totalPrice,uint64 deadline)");
        Terms memory o = _terms(".originalTerms");
        Terms memory n = _terms(".data.newTerms");
        bytes32 oh = keccak256(abi.encode(th, o.scopeHash, o.acceptanceHash, o.totalPrice, o.deadline));
        bytes32 nh = keccak256(abi.encode(th, n.scopeHash, n.acceptanceHash, n.totalPrice, n.deadline));
        assertEq(oh, _b32(".data.baseTermsHash"), "original terms hash");
        assertEq(nh, _b32(".data.newTermsHash"), "new terms hash");
        assertEq(nh, _b32(".expected.termsHash"), "expected.termsHash");
        assertEq(coord.hashTerms(o), oh);
        assertEq(coord.hashTerms(n), nh);
    }

    function test_vector_abiBytes() public view {
        bytes memory expected = vm.parseJsonBytes(json, ".payload.coordinationData");
        assertEq(expected.length, 352, "11 static words");
        assertEq(abi.encode(_data()), expected, "abi.encode(AmendmentData)");
        AmendmentData memory round = abi.decode(expected, (AmendmentData));
        assertEq(keccak256(abi.encode(round)), keccak256(expected), "decode/re-encode equality");
    }

    function test_vector_payloadHash() public view {
        CoordinationPayload memory p = _payload();
        bytes32 h = keccak256(
            abi.encode(p.version, p.coordinationType, p.coordinationData, p.conditionsHash, p.timestamp, p.metadata)
        );
        assertEq(h, _b32(".expected.payloadHash"));
        assertEq(h, _b32(".intent.payloadHash"));
        assertEq(coord.hashPayload(p), h);
        assertEq(p.metadata.length, 0);
        assertEq(p.conditionsHash, bytes32(0));
    }

    function test_vector_intentStructHashAndDigest() public view {
        AgentIntent memory i = _intent();
        bytes32 sh = keccak256(
            abi.encode(
                keccak256(
                    "AgentIntent(bytes32 payloadHash,uint64 expiry,uint64 nonce,address agentId,bytes32 coordinationType,uint256 coordinationValue,address[] participants)"
                ),
                i.payloadHash,
                i.expiry,
                i.nonce,
                i.agentId,
                i.coordinationType,
                i.coordinationValue,
                keccak256(abi.encodePacked(i.participants))
            )
        );
        assertEq(sh, _b32(".expected.intentStructHash"), "intent struct hash");
        assertEq(coord.getIntentHash(i), sh, "getIntentHash returns the struct hash");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), sh));
        assertEq(digest, _b32(".expected.intentDigest"), "intent digest");
        assertEq(coord.toTypedDataDigest(sh), digest);
    }

    function test_vector_intentSignatureRecoversBuyer() public view {
        bytes memory sig = vm.parseJsonBytes(json, ".intentSignature");
        assertEq(_recover(_b32(".expected.intentDigest"), sig), _addr(".buyer"));
        assertEq(_addr(".intent.agentId"), _addr(".buyer"));
    }

    function test_vector_acceptanceDigestsAndSignatures() public view {
        bytes32 th = keccak256(
            "AcceptanceAttestation(bytes32 intentHash,address participant,uint64 nonce,uint64 expiry,bytes32 conditionsHash)"
        );
        for (uint256 n = 0; n < 2; ++n) {
            AcceptanceAttestation memory a = _acceptance(n);
            assertEq(a.intentHash, _b32(".expected.intentStructHash"), "acceptance carries the struct hash");
            bytes32 sh = keccak256(abi.encode(th, a.intentHash, a.participant, a.nonce, a.expiry, a.conditionsHash));
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), sh));
            bytes32 expected = _b32(string.concat(".acceptances[", vm.toString(n), "].digest"));
            assertEq(digest, expected, "acceptance digest");
            assertEq(coord.getAcceptanceHash(a), sh);
            assertEq(coord.toTypedDataDigest(sh), expected);
            assertEq(_recover(digest, a.signature), a.participant, "acceptance signer");
        }
        assertEq(_acceptance(0).participant, _addr(".buyer"));
        assertEq(_acceptance(1).participant, _addr(".provider"));
    }

    // ------------------------------------------------------------------ real signatures, real entry points

    function _createVectorOrder() internal {
        address buyer = _addr(".buyer");
        address provider = _addr(".provider");
        Terms memory original = _terms(".originalTerms");
        token.mint(buyer, 180);
        vm.startPrank(buyer);
        token.approve(address(coord), type(uint256).max);
        coord.createOrder(_b32(".data.orderId"), provider, address(token), original);
        vm.stopPrank();
        vm.prank(provider);
        coord.agreeOrder(_b32(".data.orderId"), _b32(".data.baseTermsHash"));
    }

    function test_vector_realSignaturesThroughProposeAcceptExecute() public {
        _createVectorOrder();
        bytes32 orderId = _b32(".data.orderId");
        bytes32 intentHash = _b32(".expected.intentStructHash");
        address buyer = _addr(".buyer");
        address provider = _addr(".provider");
        CoordinationPayload memory p = _payload();

        // The base state the vector signs is exactly what the common view reports.
        {
            (address b, address pr, address asset, uint64 rev, bytes32 th, uint256 nonce, Terms memory t, bool eligible)
            = coord.getAmendmentState(orderId);
            assertEq(b, buyer);
            assertEq(pr, provider);
            assertEq(asset, address(token));
            assertEq(rev, uint64(_u(".data.baseRevision")));
            assertEq(th, _b32(".data.baseTermsHash"));
            assertEq(nonce, _u(".data.amendmentNonce"));
            assertEq(t.totalPrice, 100);
            assertTrue(eligible);
        }

        // propose with the published intent signature, submitted by an unrelated relayer
        vm.expectEmit(true, true, true, true, address(coord));
        emit IAgentCoordination.CoordinationProposed(intentHash, buyer, keccak256("ORDER_AMENDMENT_V1"), 2, 0);
        vm.prank(address(0xE1A7));
        bytes32 returned = coord.proposeCoordination(_intent(), vm.parseJsonBytes(json, ".intentSignature"), p);
        assertEq(returned, intentHash);
        assertEq(coord.getAgentNonce(buyer), 1);

        // both published acceptances; the provider submits the buyer's, the buyer submits the provider's
        vm.prank(provider);
        assertFalse(coord.acceptCoordination(intentHash, _acceptance(0)));
        vm.prank(buyer);
        assertTrue(coord.acceptCoordination(intentHash, _acceptance(1)));
        (Status st,,, address[] memory acceptedBy,) = coord.getCoordinationStatus(intentHash);
        assertEq(uint8(st), uint8(Status.Ready));
        assertEq(acceptedBy.length, 2);

        // execute
        vm.expectEmit(true, true, true, true, address(coord));
        emit IOrderAmendments.OrderAmendmentApplied(
            intentHash, orderId, 1, _b32(".data.baseTermsHash"), _b32(".data.newTermsHash"), 80
        );
        vm.prank(address(0xE1A7));
        (bool ok, bytes memory result) = coord.executeCoordination(intentHash, p, "");
        assertTrue(ok);
        assertEq(result, abi.encode(orderId, uint64(1), _b32(".expected.termsHash"), uint256(80)));

        (,,, uint64 revision, bytes32 termsHash, uint256 amendmentNonce, Terms memory terms,) =
            coord.getAmendmentState(orderId);
        assertEq(revision, 1);
        assertEq(amendmentNonce, 1);
        assertEq(termsHash, _b32(".expected.termsHash"));
        assertEq(terms.totalPrice, 180);
        assertEq(terms.deadline, 2000020000);
        assertEq(token.balanceOf(address(coord)), 180);
        assertEq(token.balanceOf(buyer), 0);
    }

    /// The same bytes are not accepted by an identical contract at any other address (domain binding).
    function test_vector_signaturesRejectedUnderAnotherVerifyingContract() public {
        AgentOrderAmendments other = new AgentOrderAmendments();
        address buyer = _addr(".buyer");
        token.mint(buyer, 100);
        vm.startPrank(buyer);
        token.approve(address(other), 100);
        other.createOrder(_b32(".data.orderId"), _addr(".provider"), address(token), _terms(".originalTerms"));
        vm.stopPrank();
        // data.orderContract no longer equals the verifying contract
        vm.expectRevert(AgentOrderAmendments.WrongOrderContract.selector);
        other.proposeCoordination(_intent(), vm.parseJsonBytes(json, ".intentSignature"), _payload());
    }

    /// The vector's intent signature does not validate once the chain id differs.
    function test_vector_signatureRejectedOnAnotherChain() public {
        _createVectorOrder();
        vm.chainId(1);
        vm.expectRevert(IAgentCoordination.ERC8001_BadSignature.selector);
        coord.proposeCoordination(_intent(), vm.parseJsonBytes(json, ".intentSignature"), _payload());
    }
}
