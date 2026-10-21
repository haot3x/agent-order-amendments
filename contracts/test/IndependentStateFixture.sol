// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @dev Independent read-only layout fixture. Not an ERC-8001 coordinator or a
/// second complete ERC-8448 implementation. No getOrder or hash helper exists.
contract IndependentStateFixture {
    struct CurrentTerms { bytes32 scopeHash; bytes32 acceptanceHash; uint256 totalPrice; uint64 deadline; }
    bytes32 private immutable key;
    address private immutable payer;
    address private immutable worker;
    address private immutable token;
    CurrentTerms private current;
    bytes32 private commitment;
    error UnknownOrder(bytes32 orderId);

    constructor(bytes32 orderId, address buyer, address provider, address paymentAsset, CurrentTerms memory terms) {
        key = orderId; payer = buyer; worker = provider; token = paymentAsset; current = terms;
        commitment = keccak256(abi.encode(
            keccak256('Terms(bytes32 scopeHash,bytes32 acceptanceHash,uint256 totalPrice,uint64 deadline)'),
            terms.scopeHash, terms.acceptanceHash, terms.totalPrice, terms.deadline
        ));
    }
    function getAmendmentState(bytes32 orderId) external view returns (
        address buyer, address provider, address paymentAsset, uint64 revision,
        bytes32 termsHash, uint256 amendmentNonce, CurrentTerms memory terms, bool eligible
    ) {
        if (orderId != key) revert UnknownOrder(orderId);
        return (payer, worker, token, 7, commitment, 11, current, block.timestamp < current.deadline);
    }
}
