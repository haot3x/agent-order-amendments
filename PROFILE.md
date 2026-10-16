# ORDER_AMENDMENT_V1 — experimental profile 0.1

Status: implementation experiment over ERC-8001, not an assigned ERC or an adopted extension. Breaking revisions must use a new profile identifier. This document describes this repository's behavior, not additions already accepted into ERC-8001.

## Scope

One buyer, one provider, one immutable payment asset, one chain, one combined coordinator/order contract. Original orders are funded by the buyer and explicitly activated by the provider. Setup and settlement operations are an application test fixture, not a general commerce standard or additions to ERC-8001 Core.

Allowed amendments: unchanged or increased total price, unchanged or extended deadline, replacement scope/acceptance commitments, and no submitted work. A successful amendment must change the terms hash. Scope and acceptance hashes commit to exact document bytes; they do not guarantee document availability or work quality.

The Solidity example adds a minimal buyer-reviewed payout, pre-activation cancellation and undelivered-order expiry refund. These operations do not alter the signed amendment encoding. They supply no dispute resolution, review timeout, cooperative active-order cancellation or milestones. Only local disposable test assets are suitable.

## Signed representation

The EIP-712 domain is `{ name: "ERC-8001", version: "1", chainId, verifyingContract }`. `verifyingContract` is also the order contract in this experiment. The asset and order counterparties are immutable within that contract's order state.

Identifiers are Keccak-256 of the exact UTF-8 strings:

```text
coordinationType = keccak256("ORDER_AMENDMENT_V1")
payload.version = keccak256("ORDER_AMENDMENT_PAYLOAD_V1")
```

Terms use the struct hash for this exact EIP-712 type (no domain prefix in a terms hash):

```solidity
Terms(bytes32 scopeHash,bytes32 acceptanceHash,uint256 totalPrice,uint64 deadline)
```

`CoordinationPayload.coordinationData` is `abi.encode(AmendmentData)` using this field order:

```solidity
struct Terms {
    bytes32 scopeHash;
    bytes32 acceptanceHash;
    uint256 totalPrice;
    uint64 deadline;
}
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
```

All fields in this tuple are static ABI values, including the nested terms tuple. Encoding is 11 consecutive 32-byte slots (352 bytes); no dynamic tuple offset. Decode/re-encode equality rejects trailing bytes and noncanonical representations. `newTermsHash` must equal the struct hash of the complete `newTerms`.

The payload hash is:

```solidity
keccak256(abi.encode(
    payload.version,
    payload.coordinationType,
    payload.coordinationData,
    payload.conditionsHash,
    payload.timestamp,
    payload.metadata
))
```

This profile requires payload `conditionsHash == bytes32(0)` and empty `metadata`. `timestamp` is informational and signed through the payload hash; it does not establish execution time. Acceptance criteria belong in `Terms.acceptanceHash`, not in an ignored opaque condition field.

`AgentIntent` and `AcceptanceAttestation` use ERC-8001's type strings. `getIntentHash` returns the **struct hash**, not the full domain-prefixed digest. Each acceptance contains that struct hash and is signed under its own EIP-712 digest.

| Field | Profile rule |
| --- | --- |
| intent.participants | Exactly the authoritative buyer and provider, sorted ascending by address and distinct |
| intent.agentId | One of those two participants |
| intent.nonce | uint64, strictly greater than the coordinator's stored nonce for this initiator |
| intent.coordinationType | ORDER_AMENDMENT_V1 identifier |
| intent.coordinationValue | Zero; funding is computed from current order terms, not this informational field |
| acceptance.nonce | Zero; optional Core acceptance nonces are not enabled |
| acceptance.conditionsHash | Zero; nonzero constraints are rejected rather than silently ignored |
| acceptance.participant | One of the two authoritative participants; its signature must validate |
| acceptCoordination caller | Must be a listed participant; one participant may submit the other's valid attestation |
| executionData | Must be empty; no unsigned target, price, recipient or terms override |

JSON vectors serialize integers as base-10 strings. Hashes and addresses are hexadecimal strings. JSON text itself is not the hashed message.

## Consent and application

Both participants, including the initiator, must explicitly accept. Proposing does not count as an acceptance. Proposals and acceptances do not alter the order, secure extra funds or establish that execution will succeed.

The coordinator implements the Core status values `None, Proposed, Ready, Executed, Cancelled, Expired`. Core signature nonces, order revisions and order amendment nonces have distinct meanings:

- A new Core intent advances its initiator's nonce. It does not revoke all older pending intents.
- An applied amendment increments the order revision and amendment nonce.
- Either buyer or provider can call `invalidateAmendments(orderId)` on an active, unexpired order. It increments only the order amendment nonce and leaves existing terms/funds intact. It does not rewrite Core status to Cancelled.
- Before intent expiry, only its proposer may invoke Core cancellation. At or after intent expiry, anyone can cancel it. Executed and cancelled intents are terminal.

At execution, Core first verifies Ready status, intent and acceptance freshness, payload hash and empty executionData. Invalid outer inputs revert without consuming the intent. Valid outer inputs begin one execution attempt and consume it.

An isolated EVM self-call then checks:

1. The signed order contract, payload version, profile and full new-terms commitment.
2. The order is Active, and `block.timestamp < currentTerms.deadline`.
3. `block.timestamp < validUntil`.
4. The current revision, terms hash and amendment nonce match the signed base state.
5. Price/deadline restrictions and nonempty scope/acceptance commitments.
6. The supplemental transfer is exactly `newTerms.totalPrice - currentTerms.totalPrice`.

The transfer, escrow accounting, terms replacement, revision/nonce increments and `OrderAmendmentApplied` event all occur in this call. The reference checks buyer and escrow token-balance deltas and rejects mismatches. This does not establish safe support for arbitrary malicious, rebasing or fee-charging tokens; only the supplied test token has been exercised.

Execution and invalidation are ordered by transactions. Invalidation does not undo an already applied change. At most one amendment can apply against a given base revision. After a deadline extension, later amendments use the new current deadline.

## Failure and retry

| Failure stage | Core outcome | Order and funds |
| --- | --- | --- |
| Invalid Core state, expired intent/acceptance, payload mismatch or nonempty executionData | Outer call reverts | Unchanged |
| Stale order revision/nonce, ineligible order, expired amendment, failed funding or out-of-profile terms | Executed, success=false | All application-call writes and logs rolled back |
| Successful application | Executed, success=true, plus OrderAmendmentApplied | New authoritative revision and additional escrow |

Consumers must inspect success and the authoritative order/application event. `Ready` is consent readiness; `Executed` alone is not proof of successful amendment.

A failed application consumes the Core intent but does not increment the order nonce/revision. A retry requires a new Core intent nonce/hash and new acceptances from both parties. It can reference the same order base state if that state is still authoritative. The implementation does not automatically reuse old acceptances.

Any caller may execute a Ready coordination, including a relayer. Consequently, an execution attempt during temporary funding failure can consume the intent before the parties want to retry; gas constraints can also affect attempts. This experiment accepts that liveness tradeoff. A production execution policy requires further design and review; the current implementation does not claim griefing-resistant scheduling.

The same rollback boundary covers a token that moves funds and then returns false. Reentrancy protection covers public mutation entry points; the application helper is callable only by the coordinator itself.

## Submission and signatures

Only the provider may submit, before the current order deadline, with the exact current revision, terms hash and nonzero result hash. Submission changes order status to Submitted and disables all later amendments.

EOA signatures accept low-s 65-byte ECDSA and compact 64-byte EIP-2098 encodings. Contract signers use ERC-1271 via STATICCALL. Signatures are validated at propose/accept time; the contract does not revalidate a mutable ERC-1271 signing policy at execute time. To withdraw an already accepted amendment, use the explicit order invalidation operation while eligible.

The test ERC-1271 wallet is an owner-signature mock, not a Safe or production account integration.

## Demo application settlement

This is a local application policy layered around the amendment experiment. It is not a proposed universal acceptance/verification standard. Existing order-status values are preserved; new terminal values are appended: `None=0, Offered=1, Active=2, Submitted=3, Accepted=4, Cancelled=5, Refunded=6`.

| Operation | Caller and precondition | Outcome |
| --- | --- | --- |
| `acceptDelivery(id, revision, termsHash, resultHash)` | Recorded buyer; Submitted; exact stored revision, terms hash and result hash | Accepted; full escrow paid to recorded provider; `OrderAccepted` and `OrderPaid` |
| `cancelOfferedOrder(id)` | Recorded buyer; Offered | Cancelled; full escrow returned to buyer; `OrderRefunded` |
| `refundExpiredOrder(id)` | Anyone; Offered or Active; `block.timestamp >= currentTerms.deadline` | Refunded; full escrow returned to buyer; `OrderRefunded` |

The buyer reviews the actual result off-chain. The contract verifies caller and record bindings, not the quality, truth, availability or semantic satisfaction of the work. Buyer acceptance and payout are atomic in this fixture: a failed transfer rolls back both, including their logs, and can be retried with the same delivery. Application events distinguish the acceptance fact from the payment fact even though they share one transaction. These operations do not consume a new Core coordination.

Cancellation means cancellation before provider activation. An Active order cannot be unilaterally cancelled early. If activation and cancellation compete, only the first successful transaction can transition the Offered order. Expiry refunds use the **current amended deadline**, and return the entire remaining escrow, including applied supplements. They never pay the caller instead of the buyer. Terminal orders cannot be paid/refunded twice or amended back into an active state.

Submission requires `timestamp < deadline`; undelivered-order expiry refunds require `timestamp >= deadline`. Once validly Submitted, the order is no longer eligible for an expiry refund, and the buyer may accept after the delivery deadline. There is **no default payment, automatic refund or dispute resolver for submitted work**. A silent or dissatisfied buyer can leave the escrow locked indefinitely. That unresolved review policy is one reason this fixture is restricted to local test tokens.

Payout/refund updates terminal status and zeros the order escrow before the external token call. Reentrancy protection and exact sender/recipient balance-delta checks apply. A transfer failure rolls back the entire transaction. One order's settlement does not release another order's escrow. These checks are not a guarantee of compatibility with arbitrary or malicious tokens.

## Discovery and tender composition

[ERC-8444's author clarified](https://ethereum-magicians.org/t/erc-8444-agentic-resource-discovery-ard-onchain/29963/6) that its task payload is a hash-committed tender snapshot for discovery. Bilateral amendments belong in the order and settlement layer, with the discovery anchor providing the composition pointer. This profile therefore keeps the order ID, revision and terms hash in the order layer; it does not require adding them to the discovery payload.

A discovery descriptor update, its hash, or its discovery level does not constitute either party's acceptance of an order amendment. Execution must still check both parties' explicit consent and the authoritative base revision, terms hash and amendment nonce, and apply supplemental funding and the new revision atomically. A descriptor hash and this profile's EIP-712 terms hash commit to different objects and are not interchangeable.

ERC-8414 separately records the task version cited by each submission and fixes tender reward and deadlines at mint. This profile cannot directly increase an existing tender's reward or extend its deadlines. A future composition must define the mapping between tender versions and order revisions, preserve the version associated with delivered work, and specify whether an award survives a specification update before submission or the task is frozen at award time. No ERC-8414 or ERC-8444 adapter is implemented here; these are composition boundaries, not conformance or adoption claims.

## Validation and open questions

The optional [ERC-8427 fixture](ERC8427.md) routes funding through a pinned registered-grant executor while preserving this profile's signed encoding and application rollback boundary. The base order contract still uses direct ERC-20 funding. The fixture is an application integration, not a change to ERC-8001 Core or an adopted standard. Its grant usage counts gross funding transfers; refunds do not restore that usage.

The published vector is checked by ethers, independently declared viem ABI/types, and Solidity hash functions. The deployed EIP-712 domain is checked separately because the deterministic vector uses a fixed illustrative verifying-contract address.

Tests exercise transaction-ordered competing candidates on a disposable local EVM. They do not establish multi-chain atomicity, real-world transaction inclusion guarantees, a database recovery protocol, or independent ecosystem adoption.

Open questions for review:

1. Is order-level invalidation sufficient, or should a future profile expose additional participant-specific invalidation?
2. Is consumed-on-failure appropriate, or should execution admission be constrained to reduce liveness griefing?
3. Which event/history view should independent clients require to reconstruct prior agreements?
4. Can a reservation-aware ERC-8312 adapter atomically apply the same signed revision without releasing old headroom prematurely?

## Sources

| Source | raw URL |
| --- | --- |
| ERC-8001 Final specification | https://eips.ethereum.org/EIPS/eip-8001 |
| Specification revision consulted | https://github.com/ethereum/ERCs/blob/110d5c24b0ce6ee0043f2aeb1d4f575c7673d298/ERCS/erc-8001.md |
| Scope feedback motivating this experiment | https://ethereum-magicians.org/t/pre-erc-discussion-agent-service-order-amendments/29936/4 |
| Shared-budget integration question | https://ethereum-magicians.org/t/erc-8312-bounded-agent-actions/28851/75 |
| ERC-8444 discovery/order boundary clarification | https://ethereum-magicians.org/t/erc-8444-agentic-resource-discovery-ard-onchain/29963/6 |
| ERC-8414 task version and immutable tender terms, inspected revision | https://github.com/garyyang-finchip/task-token-standard/blob/e1d0bc6504a7b7a128fabcab4640ab1e266c6a5d/ERCS/erc-9999.md |
| ERC-8414 award/admission discussion | https://ethereum-magicians.org/t/erc-8414-token-bound-task-tenders/29597/27 |
