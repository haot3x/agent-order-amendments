// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.30;

/// ERC-8448 terms. Hashed as the EIP-712 struct
/// `Terms(bytes32 scopeHash,bytes32 acceptanceHash,uint256 totalPrice,uint64 deadline)`.
struct Terms {
    bytes32 scopeHash;
    bytes32 acceptanceHash;
    uint256 totalPrice;
    uint64 deadline;
}

/// ERC-8448 `CoordinationPayload.coordinationData`, 11 static ABI slots.
struct AmendmentData {
    address orderContract;
    bytes32 orderId;
    uint64 baseRevision;
    bytes32 baseTermsHash;
    uint256 amendmentNonce;
    bytes32 newTermsHash;
    Terms newTerms;
    uint64 validUntil;
}

/// The part of ERC-8448 that is standardized on top of ERC-8001.
interface IOrderAmendments {
    error UnknownOrder(bytes32 orderId);

    event AmendmentsInvalidated(bytes32 indexed orderId, address indexed participant, uint256 amendmentNonce);
    event OrderAmendmentApplied(
        bytes32 indexed intentHash,
        bytes32 indexed orderId,
        uint64 revision,
        bytes32 previousTermsHash,
        bytes32 newTermsHash,
        uint256 supplement
    );

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
        );

    function invalidateAmendments(bytes32 orderId) external;
}
