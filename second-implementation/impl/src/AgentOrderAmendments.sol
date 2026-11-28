// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.30;

import {
    Status,
    AgentIntent,
    CoordinationPayload,
    AcceptanceAttestation,
    IAgentCoordination
} from "./interfaces/IERC8001.sol";
import {Terms, AmendmentData, IOrderAmendments} from "./interfaces/IOrderAmendments.sol";
import {SignatureValidation} from "./lib/SignatureValidation.sol";

/// @title AgentOrderAmendments
/// @notice Independent implementation of ERC-8448 (`ORDER_AMENDMENT_V1`), written only from the
///         published ERC-8448 and ERC-8001 texts. One contract is both the ERC-8001 coordinator
///         and the order application, as the profile requires.
/// @dev No constructor arguments and no immutables: the EIP-712 domain is derived from
///      `block.chainid` and `address(this)` on every use.
contract AgentOrderAmendments is IAgentCoordination, IOrderAmendments {
    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    bytes32 public constant ORDER_AMENDMENT_V1 = keccak256("ORDER_AMENDMENT_V1");
    bytes32 public constant ORDER_AMENDMENT_PAYLOAD_V1 = keccak256("ORDER_AMENDMENT_PAYLOAD_V1");

    bytes32 public constant TERMS_TYPEHASH =
        keccak256("Terms(bytes32 scopeHash,bytes32 acceptanceHash,uint256 totalPrice,uint64 deadline)");
    bytes32 public constant AGENT_INTENT_TYPEHASH = keccak256(
        "AgentIntent(bytes32 payloadHash,uint64 expiry,uint64 nonce,address agentId,bytes32 coordinationType,uint256 coordinationValue,address[] participants)"
    );
    bytes32 public constant ACCEPTANCE_TYPEHASH = keccak256(
        "AcceptanceAttestation(bytes32 intentHash,address participant,uint64 nonce,uint64 expiry,bytes32 conditionsHash)"
    );

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("ERC-8001");
    bytes32 private constant VERSION_HASH = keccak256("1");

    /// abi.encode(AmendmentData) is exactly 11 static words.
    uint256 private constant AMENDMENT_DATA_LENGTH = 352;

    // ---------------------------------------------------------------------
    // Application-defined order model (not standardized by ERC-8448)
    // ---------------------------------------------------------------------

    enum OrderStatus {
        None, // unknown order
        Offered, // created and funded by the buyer, awaiting the provider's agreement
        Active, // initial agreement effective; the only amendable status
        Submitted, // provider submitted a result; frozen for amendments
        Cancelled, // buyer withdrew the offer before agreement; escrow returned
        Settled, // buyer accepted the result; escrow paid to the provider
        Refunded // deadline passed without a submission; escrow returned
    }

    struct Order {
        address buyer;
        address provider;
        address paymentAsset;
        OrderStatus status;
        uint64 revision;
        uint256 amendmentNonce;
        Terms terms;
        bytes32 termsHash;
        uint256 escrowed;
        bytes32 resultHash;
    }

    struct Coordination {
        Status status; // stored value is never Expired; expiry is derived on read
        address proposer;
        uint64 expiry;
        bytes32 payloadHash;
        address[] participants;
        address[] acceptedBy;
        mapping(address => uint64) acceptanceExpiry; // nonzero once accepted
    }

    event OrderCreated(
        bytes32 indexed orderId,
        address indexed buyer,
        address indexed provider,
        address paymentAsset,
        bytes32 termsHash,
        Terms terms
    );
    event OrderAgreed(bytes32 indexed orderId, address indexed provider, bytes32 termsHash);
    event OrderCancelled(bytes32 indexed orderId, uint256 refunded);
    event WorkSubmitted(bytes32 indexed orderId, uint64 revision, bytes32 termsHash, bytes32 resultHash);
    event OrderSettled(bytes32 indexed orderId, address indexed provider, uint256 paid);
    event OrderRefunded(bytes32 indexed orderId, address indexed buyer, uint256 refunded);

    // ---------------------------------------------------------------------
    // Errors (additional to ERC-8001's and UnknownOrder)
    // ---------------------------------------------------------------------

    error ReentrantCall();
    error OnlySelf();

    // Coordinator, profile restrictions
    error UnknownIntent(bytes32 intentHash);
    error IntentNotOpen(bytes32 intentHash);
    error IntentHashMismatch();
    error WrongCoordinationType();
    error WrongPayloadVersion();
    error NonzeroCoordinationValue();
    error NonzeroPayloadConditions();
    error NonemptyPayloadMetadata();
    error NonCanonicalAmendmentData();
    error WrongOrderContract();
    error NewTermsHashMismatch();
    error ParticipantsNotOrderParties();
    error NonzeroAcceptanceNonce();
    error NonzeroAcceptanceConditions();
    error NonemptyExecutionData();

    // Application
    error OrderNotEligible(bytes32 orderId);
    error AmendmentExpired();
    error StaleBaseState();
    error TermsOutOfProfile();
    error TermsUnchanged();
    error TokenCallFailed();
    error BalanceDeltaMismatch();
    error NotOrderParty();
    error NotBuyer();
    error NotProvider();
    error InvalidOrderParameters();
    error OrderIdTaken(bytes32 orderId);
    error WrongOrderStatus(bytes32 orderId);
    error TermsHashMismatch();
    error RevisionMismatch();
    error ZeroResultHash();
    error DeadlinePassed();
    error DeadlineNotReached();

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    mapping(bytes32 => Order) internal _orders;
    mapping(bytes32 => Coordination) internal _coordinations;
    mapping(address => uint64) internal _agentNonces;

    bool private transient _entered;

    modifier nonReentrant() {
        if (_entered) revert ReentrantCall();
        _entered = true;
        _;
        _entered = false;
    }

    // =====================================================================
    // Hashing (public so that clients and tests can reproduce every value)
    // =====================================================================

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    /// ERC-5267 domain description (SHOULD in ERC-8001).
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        )
    {
        return (hex"0f", "ERC-8001", "1", block.chainid, address(this), bytes32(0), new uint256[](0));
    }

    /// EIP-712 struct hash of `Terms`, without any domain prefix.
    function hashTerms(Terms memory terms) public pure returns (bytes32) {
        return
            keccak256(
                abi.encode(TERMS_TYPEHASH, terms.scopeHash, terms.acceptanceHash, terms.totalPrice, terms.deadline)
            );
    }

    function hashPayload(CoordinationPayload calldata payload) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                payload.version,
                payload.coordinationType,
                payload.coordinationData,
                payload.conditionsHash,
                payload.timestamp,
                payload.metadata
            )
        );
    }

    /// Returns the AgentIntent **struct hash** (not the domain-prefixed digest).
    function getIntentHash(AgentIntent calldata intent) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                AGENT_INTENT_TYPEHASH,
                intent.payloadHash,
                intent.expiry,
                intent.nonce,
                intent.agentId,
                intent.coordinationType,
                intent.coordinationValue,
                keccak256(abi.encodePacked(intent.participants))
            )
        );
    }

    /// Struct hash of an acceptance (the `signature` member is not part of the typed data).
    function getAcceptanceHash(AcceptanceAttestation calldata attestation) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ACCEPTANCE_TYPEHASH,
                attestation.intentHash,
                attestation.participant,
                attestation.nonce,
                attestation.expiry,
                attestation.conditionsHash
            )
        );
    }

    /// Full EIP-712 digest for a struct hash under this contract's domain.
    function toTypedDataDigest(bytes32 structHash) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    // =====================================================================
    // ERC-8001 coordinator, restricted to the ORDER_AMENDMENT_V1 profile
    // =====================================================================

    function proposeCoordination(
        AgentIntent calldata intent,
        bytes calldata signature,
        CoordinationPayload calldata payload
    ) external nonReentrant returns (bytes32 intentHash) {
        // --- ERC-8001 Core ---
        if (intent.expiry <= block.timestamp) revert ERC8001_ExpiredIntent();
        if (intent.nonce <= _agentNonces[intent.agentId]) revert ERC8001_NonceTooLow();
        _checkCanonicalParticipants(intent.participants, intent.agentId);

        // --- ORDER_AMENDMENT_V1 static restrictions ---
        if (intent.coordinationType != ORDER_AMENDMENT_V1) revert WrongCoordinationType();
        if (intent.coordinationValue != 0) revert NonzeroCoordinationValue();
        if (hashPayload(payload) != intent.payloadHash) revert ERC8001_PayloadHashMismatch();
        _checkPayloadAndParties(payload, intent.participants);

        // --- signature, validated now and never again ---
        intentHash = getIntentHash(intent);
        if (!SignatureValidation.isValid(intent.agentId, toTypedDataDigest(intentHash), signature)) {
            revert ERC8001_BadSignature();
        }

        Coordination storage c = _coordinations[intentHash];
        // Unreachable while nonces are strictly increasing, kept as a cheap invariant.
        if (c.status != Status.None) revert IntentNotOpen(intentHash);

        _agentNonces[intent.agentId] = intent.nonce;
        c.status = Status.Proposed;
        c.proposer = intent.agentId;
        c.expiry = intent.expiry;
        c.payloadHash = intent.payloadHash;
        c.participants = intent.participants;

        emit CoordinationProposed(
            intentHash, intent.agentId, intent.coordinationType, intent.participants.length, intent.coordinationValue
        );
    }

    function acceptCoordination(bytes32 intentHash, AcceptanceAttestation calldata attestation)
        external
        nonReentrant
        returns (bool allAccepted)
    {
        Coordination storage c = _coordinations[intentHash];
        Status stored = c.status;
        if (stored == Status.None) revert UnknownIntent(intentHash);
        if (stored == Status.Executed || stored == Status.Cancelled) revert IntentNotOpen(intentHash);
        if (c.expiry <= block.timestamp) revert ERC8001_ExpiredIntent();

        if (!_isListed(c.participants, msg.sender)) revert ERC8001_NotParticipant();
        if (!_isListed(c.participants, attestation.participant)) revert ERC8001_NotParticipant();
        if (c.acceptanceExpiry[attestation.participant] != 0) revert ERC8001_DuplicateAcceptance();

        if (attestation.intentHash != intentHash) revert IntentHashMismatch();
        if (attestation.nonce != 0) revert NonzeroAcceptanceNonce();
        if (attestation.conditionsHash != bytes32(0)) revert NonzeroAcceptanceConditions();
        if (attestation.expiry <= block.timestamp) revert ERC8001_ExpiredAcceptance(attestation.participant);

        bytes32 acceptanceHash = getAcceptanceHash(attestation);
        if (
            !SignatureValidation.isValid(
                attestation.participant, toTypedDataDigest(acceptanceHash), attestation.signature
            )
        ) {
            revert ERC8001_BadSignature();
        }

        c.acceptanceExpiry[attestation.participant] = attestation.expiry;
        c.acceptedBy.push(attestation.participant);

        uint256 accepted = c.acceptedBy.length;
        uint256 required = c.participants.length;
        allAccepted = accepted == required;
        if (allAccepted) c.status = Status.Ready;

        emit CoordinationAccepted(intentHash, attestation.participant, acceptanceHash, accepted, required);
    }

    function executeCoordination(bytes32 intentHash, CoordinationPayload calldata payload, bytes calldata executionData)
        external
        nonReentrant
        returns (bool success, bytes memory result)
    {
        Coordination storage c = _coordinations[intentHash];

        // --- outer checks: any failure reverts and does not consume the intent ---
        if (c.status != Status.Ready) revert ERC8001_NotReady();
        if (c.expiry <= block.timestamp) revert ERC8001_ExpiredIntent();
        uint256 n = c.participants.length;
        for (uint256 i = 0; i < n; ++i) {
            address p = c.participants[i];
            if (c.acceptanceExpiry[p] <= block.timestamp) revert ERC8001_ExpiredAcceptance(p);
        }
        if (hashPayload(payload) != c.payloadHash) revert ERC8001_PayloadHashMismatch();
        if (executionData.length != 0) revert NonemptyExecutionData();

        // --- one execution attempt begins here and is consumed whatever the application does ---
        c.status = Status.Executed;

        uint256 gasBefore = gasleft();
        (success, result) = address(this).call(
            abi.encodeCall(
                this.applyOrderAmendment,
                (intentHash, payload.version, payload.coordinationType, payload.coordinationData)
            )
        );
        uint256 gasUsed = gasBefore - gasleft();

        emit CoordinationExecuted(intentHash, msg.sender, success, gasUsed, result);
    }

    function cancelCoordination(bytes32 intentHash, string calldata reason) external nonReentrant {
        Coordination storage c = _coordinations[intentHash];
        Status stored = c.status;
        if (stored == Status.None) revert UnknownIntent(intentHash);
        if (stored == Status.Executed || stored == Status.Cancelled) revert IntentNotOpen(intentHash);
        if (block.timestamp < c.expiry && msg.sender != c.proposer) revert ERC8001_NotProposer();

        c.status = Status.Cancelled;
        emit CoordinationCancelled(intentHash, msg.sender, reason, uint8(Status.Cancelled));
    }

    function getCoordinationStatus(bytes32 intentHash)
        external
        view
        returns (
            Status status,
            address proposer,
            address[] memory participants,
            address[] memory acceptedBy,
            uint256 expiry
        )
    {
        Coordination storage c = _coordinations[intentHash];
        return (_effectiveStatus(c), c.proposer, c.participants, c.acceptedBy, c.expiry);
    }

    function getRequiredAcceptances(bytes32 intentHash) external view returns (uint256) {
        return _coordinations[intentHash].participants.length;
    }

    function getAgentNonce(address agent) external view returns (uint64) {
        return _agentNonces[agent];
    }

    // =====================================================================
    // ERC-8448 application: isolated amendment call
    // =====================================================================

    /// @notice The isolated application entry point. Only callable by this contract, from
    ///         `executeCoordination`. Everything it does (token transfer, escrow accounting, terms
    ///         replacement, counters, event) is reverted together if any check fails.
    /// @return orderId, the applied revision, the new terms hash and the collected supplement; the raw
    ///         return data is therefore `abi.encode(bytes32, uint64, bytes32, uint256)`.
    function applyOrderAmendment(
        bytes32 intentHash,
        bytes32 payloadVersion,
        bytes32 coordinationType,
        bytes calldata coordinationData
    ) external returns (bytes32, uint64, bytes32, uint256) {
        if (msg.sender != address(this)) revert OnlySelf();

        // 1. signed order contract, payload version, profile, full new-terms commitment
        if (payloadVersion != ORDER_AMENDMENT_PAYLOAD_V1) revert WrongPayloadVersion();
        if (coordinationType != ORDER_AMENDMENT_V1) revert WrongCoordinationType();
        AmendmentData memory d = _decodeAmendment(coordinationData);
        if (d.orderContract != address(this)) revert WrongOrderContract();
        if (d.newTermsHash != hashTerms(d.newTerms)) revert NewTermsHashMismatch();

        Order storage o = _orders[d.orderId];
        if (o.status == OrderStatus.None) revert UnknownOrder(d.orderId);

        // 2. order is Active and before its current deadline
        if (o.status != OrderStatus.Active || block.timestamp >= o.terms.deadline) {
            revert OrderNotEligible(d.orderId);
        }
        // 3. amendment validity limit; equality is expired
        if (block.timestamp >= d.validUntil) revert AmendmentExpired();
        // 4. signed base state is still the authoritative state
        bytes32 previousTermsHash = o.termsHash;
        if (
            d.baseRevision != o.revision || d.baseTermsHash != previousTermsHash
                || d.amendmentNonce != o.amendmentNonce
        ) revert StaleBaseState();
        // 5. profile restrictions on the replacement terms
        uint256 currentPrice = o.terms.totalPrice;
        if (
            d.newTerms.totalPrice == 0 || d.newTerms.totalPrice < currentPrice
                || d.newTerms.deadline < o.terms.deadline || d.newTerms.scopeHash == bytes32(0)
                || d.newTerms.acceptanceHash == bytes32(0)
        ) revert TermsOutOfProfile();
        if (d.newTermsHash == previousTermsHash) revert TermsUnchanged();

        // 6. supplement computed from the current terms, collected with exact balance deltas
        uint256 supplement = d.newTerms.totalPrice - currentPrice;
        if (supplement != 0) {
            _pullExact(o.paymentAsset, o.buyer, supplement);
            o.escrowed += supplement;
        }

        // Checked arithmetic: overflow reverts rather than wraps.
        uint64 newRevision = o.revision + 1;
        o.revision = newRevision;
        o.amendmentNonce = o.amendmentNonce + 1;
        o.terms = d.newTerms;
        o.termsHash = d.newTermsHash;

        emit OrderAmendmentApplied(intentHash, d.orderId, newRevision, previousTermsHash, d.newTermsHash, supplement);
        return (d.orderId, newRevision, d.newTermsHash, supplement);
    }

    // =====================================================================
    // ERC-8448 common view and invalidation
    // =====================================================================

    function getAmendmentState(bytes32 orderId)
        external
        view
        returns (
            address buyer,
            address provider,
            address paymentAsset,
            uint64 revision,
            bytes32 termsHash,
            uint256 amendmentNonce,
            Terms memory terms,
            bool eligible
        )
    {
        Order storage o = _orders[orderId];
        if (o.status == OrderStatus.None) revert UnknownOrder(orderId);
        buyer = o.buyer;
        provider = o.provider;
        paymentAsset = o.paymentAsset;
        revision = o.revision;
        termsHash = o.termsHash;
        amendmentNonce = o.amendmentNonce;
        terms = o.terms;
        eligible = o.status == OrderStatus.Active && block.timestamp < o.terms.deadline;
    }

    function invalidateAmendments(bytes32 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.status == OrderStatus.None) revert UnknownOrder(orderId);
        if (msg.sender != o.buyer && msg.sender != o.provider) revert NotOrderParty();
        if (o.status != OrderStatus.Active || block.timestamp >= o.terms.deadline) revert OrderNotEligible(orderId);

        uint256 newNonce = o.amendmentNonce + 1; // checked
        o.amendmentNonce = newNonce;
        emit AmendmentsInvalidated(orderId, msg.sender, newNonce);
    }

    // =====================================================================
    // Application-defined order lifecycle
    // =====================================================================

    /// @notice Buyer creates and fully funds an offer. The order is not amendable until the
    ///         provider calls `agreeOrder`.
    /// @param orderId Caller-chosen, nonzero, previously unused identifier.
    function createOrder(bytes32 orderId, address provider, address paymentAsset, Terms calldata terms)
        external
        nonReentrant
    {
        if (orderId == bytes32(0)) revert InvalidOrderParameters();
        Order storage o = _orders[orderId];
        if (o.status != OrderStatus.None) revert OrderIdTaken(orderId);
        if (
            provider == address(0) || provider == msg.sender || provider == address(this)
                || paymentAsset == address(0) || paymentAsset.code.length == 0 || terms.totalPrice == 0
                || terms.scopeHash == bytes32(0) || terms.acceptanceHash == bytes32(0)
                || terms.deadline <= block.timestamp
        ) revert InvalidOrderParameters();

        bytes32 termsHash = hashTerms(terms);
        o.buyer = msg.sender;
        o.provider = provider;
        o.paymentAsset = paymentAsset;
        o.status = OrderStatus.Offered;
        o.terms = terms;
        o.termsHash = termsHash;
        o.escrowed = terms.totalPrice;

        _pullExact(paymentAsset, msg.sender, terms.totalPrice);
        emit OrderCreated(orderId, msg.sender, provider, paymentAsset, termsHash, terms);
    }

    /// @notice Provider agrees to the offered terms; the initial agreement becomes effective.
    function agreeOrder(bytes32 orderId, bytes32 termsHash) external nonReentrant {
        Order storage o = _known(orderId);
        if (msg.sender != o.provider) revert NotProvider();
        if (o.status != OrderStatus.Offered) revert WrongOrderStatus(orderId);
        if (termsHash != o.termsHash) revert TermsHashMismatch();
        if (block.timestamp >= o.terms.deadline) revert DeadlinePassed();

        o.status = OrderStatus.Active;
        emit OrderAgreed(orderId, msg.sender, termsHash);
    }

    /// @notice Buyer withdraws an offer the provider has not agreed to; escrow is returned.
    function cancelOrder(bytes32 orderId) external nonReentrant {
        Order storage o = _known(orderId);
        if (msg.sender != o.buyer) revert NotBuyer();
        if (o.status != OrderStatus.Offered) revert WrongOrderStatus(orderId);

        uint256 amount = o.escrowed;
        o.escrowed = 0;
        o.status = OrderStatus.Cancelled;
        _push(o.paymentAsset, o.buyer, amount);
        emit OrderCancelled(orderId, amount);
    }

    /// @notice Provider submits a result against the exact current revision and terms hash.
    function submitWork(bytes32 orderId, uint64 revision, bytes32 termsHash, bytes32 resultHash)
        external
        nonReentrant
    {
        Order storage o = _known(orderId);
        if (msg.sender != o.provider) revert NotProvider();
        if (o.status != OrderStatus.Active) revert WrongOrderStatus(orderId);
        if (block.timestamp >= o.terms.deadline) revert DeadlinePassed();
        if (revision != o.revision) revert RevisionMismatch();
        if (termsHash != o.termsHash) revert TermsHashMismatch();
        if (resultHash == bytes32(0)) revert ZeroResultHash();

        o.status = OrderStatus.Submitted;
        o.resultHash = resultHash;
        emit WorkSubmitted(orderId, revision, termsHash, resultHash);
    }

    /// @notice Buyer accepts the submitted result; the whole escrow is paid to the provider.
    function acceptAndPay(bytes32 orderId) external nonReentrant {
        Order storage o = _known(orderId);
        if (msg.sender != o.buyer) revert NotBuyer();
        if (o.status != OrderStatus.Submitted) revert WrongOrderStatus(orderId);

        uint256 amount = o.escrowed;
        o.escrowed = 0;
        o.status = OrderStatus.Settled;
        _push(o.paymentAsset, o.provider, amount);
        emit OrderSettled(orderId, o.provider, amount);
    }

    /// @notice Buyer reclaims the escrow of an agreed order whose deadline passed with no submission.
    function refundAfterDeadline(bytes32 orderId) external nonReentrant {
        Order storage o = _known(orderId);
        if (msg.sender != o.buyer) revert NotBuyer();
        if (o.status != OrderStatus.Active) revert WrongOrderStatus(orderId);
        if (block.timestamp < o.terms.deadline) revert DeadlineNotReached();

        uint256 amount = o.escrowed;
        o.escrowed = 0;
        o.status = OrderStatus.Refunded;
        _push(o.paymentAsset, o.buyer, amount);
        emit OrderRefunded(orderId, o.buyer, amount);
    }

    /// @notice Application-specific details that the common view deliberately does not standardize.
    function getOrder(bytes32 orderId)
        external
        view
        returns (OrderStatus status, uint256 escrowed, bytes32 resultHash)
    {
        Order storage o = _known(orderId);
        return (o.status, o.escrowed, o.resultHash);
    }

    // =====================================================================
    // Internals
    // =====================================================================

    function _known(bytes32 orderId) private view returns (Order storage o) {
        o = _orders[orderId];
        if (o.status == OrderStatus.None) revert UnknownOrder(orderId);
    }

    function _effectiveStatus(Coordination storage c) private view returns (Status) {
        Status stored = c.status;
        if (stored == Status.Proposed || stored == Status.Ready) {
            if (c.expiry <= block.timestamp) return Status.Expired;
            if (stored == Status.Ready) {
                // "Ready if all participants have accepted and expiries have not elapsed"
                uint256 n = c.participants.length;
                for (uint256 i = 0; i < n; ++i) {
                    if (c.acceptanceExpiry[c.participants[i]] <= block.timestamp) return Status.Expired;
                }
            }
        }
        return stored;
    }

    function _checkCanonicalParticipants(address[] calldata participants, address agentId) private pure {
        uint256 n = participants.length;
        bool found;
        for (uint256 i = 0; i < n; ++i) {
            if (i != 0 && uint160(participants[i - 1]) >= uint160(participants[i])) {
                revert ERC8001_ParticipantsNotCanonical();
            }
            if (participants[i] == agentId) found = true;
        }
        if (!found) revert ERC8001_NotParticipant();
    }

    /// Static profile checks that need no mutable order state: payload shape, canonical data, and
    /// that the participant list is exactly the order's immutable buyer and provider.
    function _checkPayloadAndParties(CoordinationPayload calldata payload, address[] calldata participants)
        private
        view
    {
        if (payload.coordinationType != ORDER_AMENDMENT_V1) revert WrongCoordinationType();
        if (payload.version != ORDER_AMENDMENT_PAYLOAD_V1) revert WrongPayloadVersion();
        if (payload.conditionsHash != bytes32(0)) revert NonzeroPayloadConditions();
        if (payload.metadata.length != 0) revert NonemptyPayloadMetadata();

        AmendmentData memory d = _decodeAmendment(payload.coordinationData);
        if (d.orderContract != address(this)) revert WrongOrderContract();
        if (d.newTermsHash != hashTerms(d.newTerms)) revert NewTermsHashMismatch();

        Order storage o = _orders[d.orderId];
        if (o.status == OrderStatus.None) revert UnknownOrder(d.orderId);
        (address lo, address hi) =
            uint160(o.buyer) < uint160(o.provider) ? (o.buyer, o.provider) : (o.provider, o.buyer);
        if (participants.length != 2 || participants[0] != lo || participants[1] != hi) {
            revert ParticipantsNotOrderParties();
        }
    }

    /// Accepts only the canonical 352-byte encoding: exact length, clean padding on the address and
    /// uint64 words, and byte equality after decode/re-encode.
    function _decodeAmendment(bytes calldata data) private pure returns (AmendmentData memory d) {
        if (data.length != AMENDMENT_DATA_LENGTH) revert NonCanonicalAmendmentData();
        if (
            (_word(data, 0) >> 160) != 0 // orderContract
                || (_word(data, 2) >> 64) != 0 // baseRevision
                || (_word(data, 9) >> 64) != 0 // newTerms.deadline
                || (_word(data, 10) >> 64) != 0 // validUntil
        ) revert NonCanonicalAmendmentData();
        d = abi.decode(data, (AmendmentData));
        if (keccak256(abi.encode(d)) != keccak256(data)) revert NonCanonicalAmendmentData();
    }

    function _word(bytes calldata data, uint256 index) private pure returns (uint256) {
        return uint256(bytes32(data[index * 32:index * 32 + 32]));
    }

    function _isListed(address[] storage list, address who) private view returns (bool) {
        uint256 n = list.length;
        for (uint256 i = 0; i < n; ++i) {
            if (list[i] == who) return true;
        }
        return false;
    }

    // --- ERC-20 handling without any library ---

    function _balanceOf(address token, address account) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, account));
        if (!ok || ret.length < 32) revert TokenCallFailed();
        return abi.decode(ret, (uint256));
    }

    /// A token call succeeds only if it did not revert and returned either nothing or exactly `true`.
    function _callToken(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) revert TokenCallFailed();
        if (ret.length != 0) {
            if (ret.length < 32 || abi.decode(ret, (uint256)) != 1) revert TokenCallFailed();
        }
    }

    /// transferFrom(from, this, amount) and require that `from` lost exactly `amount` and this
    /// contract gained exactly `amount`.
    function _pullExact(address token, address from, uint256 amount) private {
        uint256 fromBefore = _balanceOf(token, from);
        uint256 selfBefore = _balanceOf(token, address(this));
        _callToken(token, abi.encodeWithSelector(0x23b872dd, from, address(this), amount));
        uint256 fromAfter = _balanceOf(token, from);
        uint256 selfAfter = _balanceOf(token, address(this));
        if (fromBefore < amount || fromAfter != fromBefore - amount) revert BalanceDeltaMismatch();
        if (selfAfter < selfBefore || selfAfter - selfBefore != amount) revert BalanceDeltaMismatch();
    }

    function _push(address token, address to, uint256 amount) private {
        _callToken(token, abi.encodeWithSelector(0xa9059cbb, to, amount));
    }
}
