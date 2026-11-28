// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.30;

/// ERC-8001 canonical status codes.
enum Status {
    None,
    Proposed,
    Ready,
    Executed,
    Cancelled,
    Expired
}

struct AgentIntent {
    bytes32 payloadHash;
    uint64 expiry;
    uint64 nonce;
    address agentId;
    bytes32 coordinationType;
    uint256 coordinationValue;
    address[] participants;
}

struct CoordinationPayload {
    bytes32 version;
    bytes32 coordinationType;
    bytes coordinationData;
    bytes32 conditionsHash;
    uint256 timestamp;
    bytes metadata;
}

struct AcceptanceAttestation {
    bytes32 intentHash;
    address participant;
    uint64 nonce;
    uint64 expiry;
    bytes32 conditionsHash;
    bytes signature;
}

/// ERC-8001 required interface, transcribed from the specification text.
interface IAgentCoordination {
    event CoordinationProposed(
        bytes32 indexed intentHash,
        address indexed proposer,
        bytes32 coordinationType,
        uint256 participantCount,
        uint256 coordinationValue
    );
    event CoordinationAccepted(
        bytes32 indexed intentHash,
        address indexed participant,
        bytes32 acceptanceHash,
        uint256 acceptedCount,
        uint256 requiredCount
    );
    event CoordinationExecuted(
        bytes32 indexed intentHash, address indexed executor, bool success, uint256 gasUsed, bytes result
    );
    event CoordinationCancelled(bytes32 indexed intentHash, address indexed canceller, string reason, uint8 finalStatus);

    error ERC8001_NotProposer();
    error ERC8001_ExpiredIntent();
    error ERC8001_ExpiredAcceptance(address participant);
    error ERC8001_BadSignature();
    error ERC8001_NotParticipant();
    error ERC8001_DuplicateAcceptance();
    error ERC8001_ParticipantsNotCanonical();
    error ERC8001_NonceTooLow();
    error ERC8001_PayloadHashMismatch();
    error ERC8001_NotReady();

    function proposeCoordination(
        AgentIntent calldata intent,
        bytes calldata signature,
        CoordinationPayload calldata payload
    ) external returns (bytes32 intentHash);

    function acceptCoordination(bytes32 intentHash, AcceptanceAttestation calldata attestation)
        external
        returns (bool allAccepted);

    function executeCoordination(bytes32 intentHash, CoordinationPayload calldata payload, bytes calldata executionData)
        external
        returns (bool success, bytes memory result);

    function cancelCoordination(bytes32 intentHash, string calldata reason) external;

    function getCoordinationStatus(bytes32 intentHash)
        external
        view
        returns (
            Status status,
            address proposer,
            address[] memory participants,
            address[] memory acceptedBy,
            uint256 expiry
        );

    function getRequiredAcceptances(bytes32 intentHash) external view returns (uint256);

    function getAgentNonce(address agent) external view returns (uint64);
}
