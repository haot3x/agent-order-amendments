// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Local-EVM experiment with a minimal buyer-reviewed settlement fixture.
/// @dev Use only disposable test tokens. Not an audited escrow or a full conformance claim.
contract ExperimentalOrderAmendments is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status { None, Proposed, Ready, Executed, Cancelled, Expired }
    // Append only: existing profile status values remain unchanged.
    enum OrderStatus { None, Offered, Active, Submitted, Accepted, Cancelled, Refunded }
    struct Terms { bytes32 scopeHash; bytes32 acceptanceHash; uint256 totalPrice; uint64 deadline; }
    struct Order {
        address buyer; address provider; OrderStatus status;
        uint64 revision; uint256 amendmentNonce; bytes32 termsHash;
        Terms terms; uint256 escrow; bytes32 resultHash;
    }
    struct AmendmentData {
        address orderContract; bytes32 orderId; uint64 baseRevision;
        bytes32 baseTermsHash; uint256 amendmentNonce; bytes32 newTermsHash;
        Terms newTerms; uint64 validUntil;
    }
    struct AgentIntent {
        bytes32 payloadHash; uint64 expiry; uint64 nonce; address agentId;
        bytes32 coordinationType; uint256 coordinationValue; address[] participants;
    }
    struct CoordinationPayload {
        bytes32 version; bytes32 coordinationType; bytes coordinationData;
        bytes32 conditionsHash; uint256 timestamp; bytes metadata;
    }
    struct AcceptanceAttestation {
        bytes32 intentHash; address participant; uint64 nonce; uint64 expiry;
        bytes32 conditionsHash; bytes signature;
    }
    struct Coordination {
        Status status; address proposer; bytes32 payloadHash; uint64 expiry;
        uint64 minAcceptanceExpiry; address[] participants; address[] acceptedBy;
        mapping(address => bool) accepted;
    }

    bytes32 public constant COORDINATION_TYPE = keccak256("ORDER_AMENDMENT_V1");
    bytes32 public constant PAYLOAD_VERSION = keccak256("ORDER_AMENDMENT_PAYLOAD_V1");
    bytes32 public constant TERMS_TYPEHASH = keccak256("Terms(bytes32 scopeHash,bytes32 acceptanceHash,uint256 totalPrice,uint64 deadline)");
    bytes32 public constant INTENT_TYPEHASH = keccak256("AgentIntent(bytes32 payloadHash,uint64 expiry,uint64 nonce,address agentId,bytes32 coordinationType,uint256 coordinationValue,address[] participants)");
    bytes32 public constant ACCEPTANCE_TYPEHASH = keccak256("AcceptanceAttestation(bytes32 intentHash,address participant,uint64 nonce,uint64 expiry,bytes32 conditionsHash)");
    IERC20 public immutable asset;
    mapping(bytes32 => Order) private orders;
    mapping(bytes32 => Coordination) private coordinations;
    mapping(address => uint64) private agentNonces;

    event CoordinationProposed(bytes32 indexed intentHash, address indexed proposer, bytes32 coordinationType, uint256 participantCount, uint256 coordinationValue);
    event CoordinationAccepted(bytes32 indexed intentHash, address indexed participant, bytes32 acceptanceHash, uint256 acceptedCount, uint256 requiredCount);
    event CoordinationExecuted(bytes32 indexed intentHash, address indexed executor, bool success, uint256 gasUsed, bytes result);
    event CoordinationCancelled(bytes32 indexed intentHash, address indexed canceller, string reason, uint8 finalStatus);
    event OrderOffered(bytes32 indexed orderId, address buyer, address provider, bytes32 termsHash);
    event OrderActivated(bytes32 indexed orderId);
    event OrderAmendmentApplied(bytes32 indexed intentHash, bytes32 indexed orderId, uint64 revision, bytes32 previousTermsHash, bytes32 newTermsHash, uint256 supplement);
    event AmendmentsInvalidated(bytes32 indexed orderId, address indexed participant, uint256 amendmentNonce);
    event OrderSubmitted(bytes32 indexed orderId, uint64 revision, bytes32 termsHash, bytes32 resultHash);
    event OrderAccepted(bytes32 indexed orderId, address indexed buyer, uint64 revision, bytes32 termsHash, bytes32 resultHash);
    event OrderPaid(bytes32 indexed orderId, address indexed provider, uint256 amount);
    event OrderRefunded(bytes32 indexed orderId, address indexed buyer, uint256 amount, OrderStatus finalStatus);

    constructor(IERC20 testAsset) EIP712("ERC-8001", "1") {
        require(address(testAsset).code.length > 0, "ASSET");
        asset = testAsset;
    }

    function hashTerms(Terms memory t) public pure returns (bytes32) {
        return keccak256(abi.encode(TERMS_TYPEHASH, t.scopeHash, t.acceptanceHash, t.totalPrice, t.deadline));
    }
    function getPayloadHash(CoordinationPayload calldata p) public pure returns (bytes32) {
        return keccak256(abi.encode(p.version, p.coordinationType, p.coordinationData, p.conditionsHash, p.timestamp, p.metadata));
    }
    function getIntentHash(AgentIntent calldata i) public pure returns (bytes32) {
        return keccak256(abi.encode(INTENT_TYPEHASH, i.payloadHash, i.expiry, i.nonce, i.agentId, i.coordinationType, i.coordinationValue, keccak256(abi.encodePacked(i.participants))));
    }
    function getAcceptanceHash(AcceptanceAttestation calldata a) public pure returns (bytes32) {
        return keccak256(abi.encode(ACCEPTANCE_TYPEHASH, a.intentHash, a.participant, a.nonce, a.expiry, a.conditionsHash));
    }
    function getTypedDataDigest(bytes32 structHash) external view returns (bytes32) { return _hashTypedDataV4(structHash); }

    function _validSignature(address signer, bytes32 digest, bytes memory signature) private view returns (bool) {
        if (signer.code.length > 0) {
            (bool ok, bytes memory result) = signer.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, signature)));
            return ok && result.length >= 32 && abi.decode(result, (bytes4)) == IERC1271.isValidSignature.selector;
        }
        address recovered; ECDSA.RecoverError recoveryError;
        if (signature.length == 64) {
            bytes32 r; bytes32 vs;
            assembly ("memory-safe") { r := mload(add(signature, 32)) vs := mload(add(signature, 64)) }
            (recovered, recoveryError,) = ECDSA.tryRecover(digest, r, vs);
        } else { (recovered, recoveryError,) = ECDSA.tryRecover(digest, signature); }
        return recoveryError == ECDSA.RecoverError.NoError && recovered != address(0) && recovered == signer;
    }
    function _termsValid(Terms memory t) private pure {
        require(t.scopeHash != 0 && t.acceptanceHash != 0 && t.totalPrice > 0, "TERMS");
    }
    function _fund(address buyer, uint256 amount) private {
        if (amount == 0) return;
        uint256 fromBefore = asset.balanceOf(buyer);
        uint256 toBefore = asset.balanceOf(address(this));
        asset.safeTransferFrom(buyer, address(this), amount);
        require(asset.balanceOf(address(this)) == toBefore + amount, "RECEIVED_AMOUNT");
        require(asset.balanceOf(buyer) == fromBefore - amount, "DEBIT_AMOUNT");
    }
    function _release(Order storage o, address recipient) private returns (uint256 amount) {
        amount = o.escrow;
        require(amount > 0, "EMPTY_ESCROW");
        // Public callers set the terminal status before this interaction. A token
        // failure reverts both that status and these effects, allowing a retry.
        o.escrow = 0;
        uint256 fromBefore = asset.balanceOf(address(this));
        uint256 toBefore = asset.balanceOf(recipient);
        asset.safeTransfer(recipient, amount);
        require(asset.balanceOf(address(this)) == fromBefore - amount, "DEBIT_AMOUNT");
        require(asset.balanceOf(recipient) == toBefore + amount, "RECEIVED_AMOUNT");
    }

    /// @dev Minimal initial order fixture: buyer funds, provider explicitly activates.
    function offerOrder(bytes32 id, address provider, Terms calldata terms) external nonReentrant {
        require(id != 0 && orders[id].status == OrderStatus.None, "ORDER_EXISTS");
        require(provider != address(0) && provider != msg.sender, "PARTIES");
        _termsValid(terms); require(block.timestamp < terms.deadline, "ORDER_DEADLINE");
        _fund(msg.sender, terms.totalPrice);
        Order storage o = orders[id];
        o.buyer = msg.sender; o.provider = provider; o.status = OrderStatus.Offered;
        o.terms = terms; o.termsHash = hashTerms(terms); o.escrow = terms.totalPrice;
        emit OrderOffered(id, msg.sender, provider, o.termsHash);
    }
    function activateOrder(bytes32 id) external nonReentrant {
        Order storage o = orders[id];
        require(o.status == OrderStatus.Offered && msg.sender == o.provider, "ACTIVATION");
        require(block.timestamp < o.terms.deadline, "ORDER_DEADLINE");
        o.status = OrderStatus.Active; emit OrderActivated(id);
    }
    function getOrder(bytes32 id) external view returns (Order memory) { return orders[id]; }
    function invalidateAmendments(bytes32 id) external nonReentrant {
        Order storage o = orders[id];
        require(msg.sender == o.buyer || msg.sender == o.provider, "PARTY");
        require(o.status == OrderStatus.Active && block.timestamp < o.terms.deadline, "ORDER_INACTIVE");
        emit AmendmentsInvalidated(id, msg.sender, ++o.amendmentNonce);
    }
    function submit(bytes32 id, uint64 revision, bytes32 termsHash, bytes32 resultHash) external nonReentrant {
        Order storage o = orders[id];
        require(msg.sender == o.provider && o.status == OrderStatus.Active, "SUBMISSION");
        require(block.timestamp < o.terms.deadline, "ORDER_DEADLINE");
        require(revision == o.revision && termsHash == o.termsHash && resultHash != 0, "SUBMISSION_BINDING");
        o.status = OrderStatus.Submitted; o.resultHash = resultHash;
        emit OrderSubmitted(id, revision, termsHash, resultHash);
    }
    /// @dev Application fixture, not part of the amendment wire format. The buyer
    /// reviews the actual deliverable off-chain; a hash does not prove quality.
    function acceptDelivery(bytes32 id, uint64 revision, bytes32 termsHash, bytes32 resultHash) external nonReentrant {
        Order storage o = orders[id];
        require(msg.sender == o.buyer, "BUYER");
        require(o.status == OrderStatus.Submitted, "NOT_SUBMITTED");
        require(revision == o.revision && termsHash == o.termsHash && resultHash == o.resultHash, "ACCEPTANCE_BINDING");
        o.status = OrderStatus.Accepted;
        emit OrderAccepted(id, msg.sender, revision, termsHash, resultHash);
        uint256 amount = _release(o, o.provider);
        emit OrderPaid(id, o.provider, amount);
    }
    /// @dev A provider has not committed to an Offered order yet. Once activated,
    /// there is no unilateral early cancellation in this minimal fixture.
    function cancelOfferedOrder(bytes32 id) external nonReentrant {
        Order storage o = orders[id];
        require(msg.sender == o.buyer, "BUYER");
        require(o.status == OrderStatus.Offered, "NOT_OFFERED");
        o.status = OrderStatus.Cancelled;
        uint256 amount = _release(o, o.buyer);
        emit OrderRefunded(id, o.buyer, amount, OrderStatus.Cancelled);
    }
    /// @dev Anyone can trigger a refund, but only to the recorded buyer. Work
    /// submitted on time must be reviewed; expiry cannot override that delivery.
    function refundExpiredOrder(bytes32 id) external nonReentrant {
        Order storage o = orders[id];
        require(o.status == OrderStatus.Offered || o.status == OrderStatus.Active, "NOT_REFUNDABLE");
        require(block.timestamp >= o.terms.deadline, "NOT_EXPIRED");
        o.status = OrderStatus.Refunded;
        uint256 amount = _release(o, o.buyer);
        emit OrderRefunded(id, o.buyer, amount, OrderStatus.Refunded);
    }
    function _data(CoordinationPayload calldata p) private view returns (AmendmentData memory d) {
        require(p.version == PAYLOAD_VERSION && p.coordinationType == COORDINATION_TYPE, "PROFILE");
        require(p.conditionsHash == 0 && p.metadata.length == 0, "UNSUPPORTED_CONDITIONS");
        d = abi.decode(p.coordinationData, (AmendmentData));
        require(keccak256(abi.encode(d)) == keccak256(p.coordinationData), "NON_CANONICAL_DATA");
        require(d.orderContract == address(this), "ORDER_CONTRACT");
        require(hashTerms(d.newTerms) == d.newTermsHash, "TERMS_HASH");
    }
    function proposeCoordination(AgentIntent calldata i, bytes calldata signature, CoordinationPayload calldata p) external nonReentrant returns (bytes32 h) {
        require(i.expiry > block.timestamp, "INTENT_EXPIRED");
        require(i.nonce > agentNonces[i.agentId], "INTENT_NONCE");
        require(i.participants.length == 2 && i.participants[0] < i.participants[1], "PARTICIPANTS");
        require(i.agentId == i.participants[0] || i.agentId == i.participants[1], "INITIATOR");
        require(i.coordinationType == COORDINATION_TYPE && i.coordinationValue == 0, "PROFILE");
        require(getPayloadHash(p) == i.payloadHash, "PAYLOAD_HASH");
        AmendmentData memory d = _data(p);
        Order storage o = orders[d.orderId];
        require(o.status != OrderStatus.None, "UNKNOWN_ORDER");
        require((i.participants[0] == o.buyer && i.participants[1] == o.provider) || (i.participants[1] == o.buyer && i.participants[0] == o.provider), "ORDER_PARTIES");
        h = getIntentHash(i);
        require(_validSignature(i.agentId, _hashTypedDataV4(h), signature), "INTENT_SIGNATURE");
        Coordination storage c = coordinations[h];
        require(c.status == Status.None, "INTENT_EXISTS");
        c.status = Status.Proposed; c.proposer = i.agentId; c.payloadHash = i.payloadHash;
        c.expiry = i.expiry; c.minAcceptanceExpiry = type(uint64).max; c.participants = i.participants;
        agentNonces[i.agentId] = i.nonce;
        emit CoordinationProposed(h, i.agentId, i.coordinationType, 2, 0);
    }
    function acceptCoordination(bytes32 h, AcceptanceAttestation calldata a) external nonReentrant returns (bool allAccepted) {
        Coordination storage c = coordinations[h];
        require(c.status == Status.Proposed && block.timestamp < c.expiry, "NOT_PROPOSED");
        require(msg.sender == c.participants[0] || msg.sender == c.participants[1], "CALLER_NOT_PARTICIPANT");
        require(a.participant == c.participants[0] || a.participant == c.participants[1], "NOT_PARTICIPANT");
        require(a.intentHash == h && a.expiry > block.timestamp, "ACCEPTANCE_BINDING");
        require(a.nonce == 0 && a.conditionsHash == 0, "UNSUPPORTED_CONDITIONS");
        require(!c.accepted[a.participant], "DUPLICATE_ACCEPTANCE");
        bytes32 aHash = getAcceptanceHash(a);
        require(_validSignature(a.participant, _hashTypedDataV4(aHash), a.signature), "ACCEPTANCE_SIGNATURE");
        c.accepted[a.participant] = true; c.acceptedBy.push(a.participant);
        if (a.expiry < c.minAcceptanceExpiry) c.minAcceptanceExpiry = a.expiry;
        allAccepted = c.acceptedBy.length == 2;
        if (allAccepted) c.status = Status.Ready;
        emit CoordinationAccepted(h, a.participant, aHash, c.acceptedBy.length, 2);
    }
    function executeCoordination(bytes32 h, CoordinationPayload calldata p, bytes calldata executionData) external nonReentrant returns (bool success, bytes memory result) {
        Coordination storage c = coordinations[h];
        require(c.status == Status.Ready, "NOT_READY");
        require(block.timestamp < c.expiry && block.timestamp < c.minAcceptanceExpiry, "EXPIRED");
        require(getPayloadHash(p) == c.payloadHash, "PAYLOAD_HASH");
        require(executionData.length == 0, "UNSIGNED_EXECUTION_DATA");
        c.status = Status.Executed;
        uint256 start = gasleft();
        // Isolated EVM call: a failed funding/application attempt rolls back all
        // order/token writes, while Core records this intent's failed attempt.
        try this.applyPayload(h, p, executionData) returns (bytes memory applied) {
            success = true; result = applied;
        } catch (bytes memory reason) { result = reason; }
        emit CoordinationExecuted(h, msg.sender, success, start - gasleft(), result);
    }
    function applyPayload(bytes32 h, CoordinationPayload calldata p, bytes calldata executionData) external returns (bytes memory) {
        require(msg.sender == address(this), "ONLY_SELF");
        require(executionData.length == 0, "UNSIGNED_EXECUTION_DATA");
        AmendmentData memory d = _data(p);
        Order storage o = orders[d.orderId];
        require(o.status == OrderStatus.Active && block.timestamp < o.terms.deadline, "ORDER_INACTIVE");
        require(block.timestamp < d.validUntil, "AMENDMENT_EXPIRED");
        require(o.revision == d.baseRevision && o.termsHash == d.baseTermsHash, "STALE_REVISION");
        require(o.amendmentNonce == d.amendmentNonce, "STALE_AMENDMENT_NONCE");
        _termsValid(d.newTerms);
        require(d.newTermsHash != o.termsHash, "NO_CHANGE");
        require(d.newTerms.totalPrice >= o.terms.totalPrice && d.newTerms.deadline >= o.terms.deadline, "OUT_OF_PROFILE");
        uint256 delta = d.newTerms.totalPrice - o.terms.totalPrice;
        _fund(o.buyer, delta);
        o.terms = d.newTerms; o.termsHash = d.newTermsHash; o.escrow += delta;
        ++o.revision; ++o.amendmentNonce;
        emit OrderAmendmentApplied(h, d.orderId, o.revision, d.baseTermsHash, d.newTermsHash, delta);
        return abi.encode(d.orderId, o.revision, d.newTermsHash, delta);
    }
    function cancelCoordination(bytes32 h, string calldata reason) external nonReentrant {
        Coordination storage c = coordinations[h];
        require(c.status == Status.Proposed || c.status == Status.Ready, "NOT_CANCELLABLE");
        require(block.timestamp >= c.expiry || msg.sender == c.proposer, "NOT_PROPOSER");
        c.status = Status.Cancelled;
        emit CoordinationCancelled(h, msg.sender, reason, uint8(Status.Cancelled));
    }
    function getCoordinationStatus(bytes32 h) external view returns (Status status, address proposer, address[] memory participants, address[] memory acceptedBy, uint256 expiry) {
        Coordination storage c = coordinations[h]; status = c.status;
        if ((status == Status.Proposed || status == Status.Ready) && (block.timestamp >= c.expiry || (status == Status.Ready && block.timestamp >= c.minAcceptanceExpiry))) status = Status.Expired;
        return (status, c.proposer, c.participants, c.acceptedBy, c.expiry);
    }
    function getRequiredAcceptances(bytes32 h) external view returns (uint256) { return coordinations[h].participants.length; }
    function getAgentNonce(address agent) external view returns (uint64) { return agentNonces[agent]; }
}
