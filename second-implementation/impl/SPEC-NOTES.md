# Spec notes from an independent implementation of ERC-8448

Written while implementing `ORDER_AMENDMENT_V1` from `spec/erc-8448.md`, `spec/erc-8001.md` and
`spec/order-amendment-v1.json` only. No other implementation was read.

Each item is tagged:

- **(a)** genuine ambiguity: two conforming implementations could diverge on the wire or in
  observable behaviour.
- **(b)** editorial or unclear, but not divergence-causing (or only in revert reasons, which the
  spec does not standardize anyway).

Items are ordered most significant first. "Chosen reading" is what `src/AgentOrderAmendments.sol` does.

---

## A. Ambiguities that can cause divergence

### A1. (a) Where are static profile violations rejected: at proposal, or as `Executed, success=false`?

Three passages point in different directions.

- "Consent and application", self-call list item 1: "The signed order contract, payload version,
  profile and full new-terms commitment." This puts these checks in the isolated call, whose failure
  yields `Executed, success=false`.
- "Test Cases": "Complete replacement data is not canonical ABI, or its terms hash differs |
  Reject the payload; do not apply an amendment." "Reject the payload" reads like a revert when the
  payload is presented, and the "Failure and retry" table has no row for a malformed payload at all:
  its second row lists "Stale order revision/nonce, ineligible order, expired amendment, failed
  funding or out-of-profile terms", none of which is "non-canonical data" or "wrong payload version".
- "Signed representation": "The payload MUST have `conditionsHash == bytes32(0)` and empty
  `metadata`", "`newTermsHash` MUST equal the struct hash of the complete `newTerms`", and the
  "Profile rule" table (`intent.coordinationType`, `intent.coordinationValue` zero, participants),
  none of which names an enforcement point. `conditionsHash`, `metadata`, `coordinationValue` and the
  participant rule appear in neither the outer checks ("Ready status, intent and acceptance
  freshness, payload hash and empty executionData") nor the six self-call checks.

**Chosen reading:** both. `proposeCoordination` reverts on every violation that can be decided
without mutable order state (payload hash vs `intent.payloadHash`, payload version, both
`coordinationType` fields, zero `coordinationValue`, zero `conditionsHash`, empty `metadata`,
canonical 352-byte data, `orderContract == address(this)`, `newTermsHash`, known order, participants
equal to the order parties). The isolated call additionally re-checks item 1 exactly as listed, so a
coordination that somehow reached Ready with such a payload ends `Executed, success=false`.

**Why:** a coordinator "subject to the additional profile restrictions" should not record consent
for something that can never be this profile; and re-checking in the isolated call keeps the literal
list satisfied.

**Divergence:** an implementation that treats the payload as opaque until execution will accept the
same `proposeCoordination` call that this one reverts, and later emit
`CoordinationExecuted(success=false)`. A cross-test must not assume either behaviour. Suggest the
spec add a row to the failure table for "payload not in profile" and state the enforcement point.

### A2. (a) Where is "participants are exactly the authoritative buyer and provider" enforced, and what does proposal need to know?

"Signed representation" table: "intent.participants | Exactly the authoritative buyer and provider,
sorted ascending by address and distinct". To enforce it the coordinator must decode
`coordinationData` to find the order, yet ERC-8001 calls that field "opaque to Core" and its
`proposeCoordination` revert list does not even require the supplied `payload` to hash to
`intent.payloadHash`. The six self-call checks do not mention participants.

**Chosen reading:** enforced in `proposeCoordination`, which therefore (i) requires
`keccak256(abi.encode(payload...)) == intent.payloadHash`, (ii) decodes the data, (iii) reverts with
`UnknownOrder(orderId)` if the order does not exist, (iv) requires `participants.length == 2` and
equality with the sorted pair. Buyer and provider are immutable, so a proposal-time check stays true.

**Divergence:** an implementation checking participants only at execution would let a stranger
propose against someone else's order (harmless but observable), and would let a proposal precede
order creation. Neither is possible here.

### A3. (a) `result` (returned and in `CoordinationExecuted`) when the application fails; and `gasUsed`

The spec fixes `result` only on success: "A successful application MUST return
`abi.encode(orderId, revision, newTermsHash, supplement)`". For `success=false` nothing is said.
ERC-8001 does not define how `gasUsed` is measured.

**Chosen reading:** on failure `result` is the raw revert data of the isolated call (a 4-byte custom
error selector plus arguments, or `Panic(uint256)` data for overflow). `gasUsed` is the gas consumed
by the isolated call only, measured around it.

**Divergence:** another implementation may return empty bytes or an error string, and a different
`gasUsed`. Both are in log data. Consumers must not parse `result` when `success` is false.

### A4. (a) Does "revision" in the return value and in `OrderAmendmentApplied` mean the new revision or the base revision?

"Application events and invalidation": "emit `OrderAmendmentApplied` with the applied revision,
previous and new terms hashes and actual supplement." "Consent and application": "MUST return
`abi.encode(orderId, revision, newTermsHash, supplement)`". The hashes are disambiguated
("previous and new"); the revision is not. The published vector contains no expected event or
return bytes.

**Chosen reading:** the new, post-increment revision (the revision that the applied terms now
have). For the vector that is `1`.

**Divergence:** an implementation reading "applied revision" as "the revision the amendment was
applied to" would emit `0`. Suggest adding the expected `result` bytes and event to the vector.

### A5. (a) `CoordinationAccepted.acceptanceHash`: struct hash or EIP-712 digest?

ERC-8001 declares `bytes32 acceptanceHash` in the event and never defines it. ERC-8448's vector
gives only a `digest` for each acceptance.

**Chosen reading:** the acceptance **struct hash** (no domain prefix), by analogy with
`intentHash`, which both specs insist is the struct hash.

**Divergence:** log data differs from an implementation that emits the digest. The vector cannot
detect this because it does not list acceptance struct hashes or expected events.

### A6. (a) Which signers get ECDSA and which get ERC-1271?

"Submission and signatures": "low-s 65-byte ECDSA and compact 64-byte ERC-2098 signatures for EOAs
and ERC-1271 signatures for contract signers". It does not say how an implementation tells them
apart.

**Chosen reading:** by code size at validation time. No code: ECDSA only. Any code: ERC-1271 via
STATICCALL only; an ECDSA signature is never tried for an address with code.

**Divergence:** an "ECDSA first, fall back to ERC-1271" implementation accepts a plain ECDSA
signature from an EIP-7702-delegated EOA (which has code); this one does not unless the delegate
implements `isValidSignature`. Also unspecified and potentially divergent: whether `v` of 0/1 is
accepted in 65-byte signatures (here: no, only 27/28), and what counts as a valid ERC-1271 return
(here: at least 32 bytes of return data whose first word is `0x1626ba7e` left-aligned and otherwise
zero).

### A7. (a) Is the token called when the supplement is zero?

"Consent and application" item 6: "The supplemental transfer is exactly
`newTerms.totalPrice - currentTerms.totalPrice`", and "The transfer ... MUST all occur in this
isolated call." An unchanged price is explicitly allowed ("positive, unchanged or increased total
price").

**Chosen reading:** when the supplement is zero no token call is made at all.

**Divergence:** an implementation that always calls `transferFrom(buyer, escrow, 0)` produces an
extra `Transfer` log and fails on tokens that reject zero-value transfers, turning a deadline-only
amendment into `success=false`.

### A8. (a) How the supplement is collected is implied, not stated

The spec says "The application MUST verify the exact buyer and escrow token-balance deltas" and
speaks of "allowance", "budget grant" and "external funding policy" elsewhere, but never states the
mechanism. A client needs to know what to approve.

**Chosen reading:** `transferFrom(buyer, address(this), supplement)` on the order's payment asset,
relying on the buyer's ERC-20 allowance to the combined contract; escrow is the contract's own
balance. The call must not revert and must return either no data or exactly `true`; then
`balanceOf(buyer)` must have decreased by exactly the supplement and `balanceOf(this)` increased by
exactly the supplement.

**Divergence:** an implementation with a separate escrow vault, or one pulling through a budget
contract, needs a different approval target. The common view exposes no "spender" address. Tokens
without a return value are accepted here; another implementation could require a `true` return.

### A9. (a) Status of a Ready coordination whose acceptance has expired but whose intent has not

ERC-8001 `getCoordinationStatus`: "`Ready` if all participants have accepted and expiries have not
elapsed"; "`Expired` if the intent has expired and was not executed or cancelled". When an
acceptance (not the intent) has lapsed, neither definition applies and `Proposed` ("not all
participants have accepted") does not either.

**Chosen reading:** the view returns `Expired`. `executeCoordination` reverts with
`ERC8001_ExpiredAcceptance(participant)` and does not consume the intent. The lapsed acceptance
cannot be replaced (duplicate acceptance), so the coordination is dead; cancellation rights still
follow the intent expiry.

**Divergence:** another implementation may keep reporting `Ready`. ERC-8448 relies on "Ready status"
without saying whether it means the stored or the derived value.

### A10. (a, minor) `CoordinationCancelled.finalStatus`

ERC-8001 declares `uint8 finalStatus` and says "status MUST be `Cancelled`" on success. It is not
said whether cancelling an already expired intent reports 4 (`Cancelled`) or 5 (`Expired`).

**Chosen reading:** always `4`, and the stored status becomes `Cancelled`.

### A11. (a, minor) `getIntentHash` is referenced normatively but is not in the required interface

Both specs say "`getIntentHash(intent)` MUST return `intentStructHash`", but ERC-8001's
`IAgentCoordination` block does not declare such a function.

**Chosen reading:** exposed as `getIntentHash(AgentIntent calldata) public pure returns (bytes32)`.
A client that depends on it may find it missing, or under a different signature, elsewhere.

### A12. (a, minor) Gas-limited execution can consume an intent

"Failure and retry" notes "gas constraints can also affect attempts" and "Security Considerations"
says "Gas exhaustion can also revert an entire transaction". With an isolated self-call the caller
can also choose a gas limit at which only the inner call runs out of gas while the outer call
completes, producing `Executed, success=false`. The spec neither forbids nor requires a minimum-gas
guard.

**Chosen reading:** no guard (the spec "accepts that liveness tradeoff"). An implementation that adds
a gas floor would revert the outer call instead. Reasoned about, not tested.

---

## B. Unclear or underspecified, not divergence-causing

### B1. (b) Enforcement point of "A successful amendment MUST change the full terms hash"

"Scope and authoritative order" states it; the six self-call checks do not list it. Chosen: checked
in the isolated call after item 5 (`TermsUnchanged`), so identical terms give `Executed,
success=false`. It depends on current state, so it cannot be a proposal-time rule.

### B2. (b) Order of the six checks

The list is numbered but not stated to be an evaluation order. It only affects which failure reason
appears in `result` (see A3). Chosen: the listed order, with "order exists" between 1 and 2.

### B3. (b) `acceptCoordination` inputs that neither spec lists

Not stated but required for soundness, and implemented as reverts: `attestation.intentHash` must
equal the `intentHash` argument; the coordination must not be `Executed` or `Cancelled`. ERC-8001's
"the caller is not listed as a participant" is kept even though ERC-8448 lets one participant relay
the other's attestation, so a third-party relayer cannot submit acceptances while it can submit
proposals and executions. That asymmetry is in the specs; it is noted, not changed.

### B4. (b) Who may call `proposeCoordination`

Neither spec restricts the caller. Chosen: anyone holding a valid signed intent (the vector test
submits the published intent from an unrelated address). An implementation requiring
`msg.sender == agentId` would be stricter than ERC-8001's revert list.

### B5. (b) ERC-8001 wording that the profile overrides

- ERC-8001: "`Executed` = intent successfully executed". ERC-8448: `Executed, success=false` is a
  normal outcome. ERC-8448 says so explicitly; the enum comment in ERC-8001 is simply misleading.
- ERC-8001: "the implementation MUST attempt execution of the behaviour represented by
  `executionData`". ERC-8448: `executionData` MUST be empty and the behaviour comes from the signed
  payload. Implemented per ERC-8448.
- ERC-8001 marks `CoordinationPayload.conditionsHash` "domain-specific" and `metadata` "optional";
  the profile requires zero and empty.

### B6. (b) "unused zero ID"

"An unknown order, including an unused zero ID, MUST revert". The wording allows an implementation
in which the zero ID is a real order. Chosen: `createOrder` rejects `orderId == 0`, so zero is always
unknown.

### B7. (b) Error selectors

Only `UnknownOrder(bytes32)` is standardized, and only for the view. ERC-8001's error list is a
SHOULD. Chosen: ERC-8001's suggested names where they fit, own names otherwise;
`invalidateAmendments` and proposal also use `UnknownOrder` for unknown orders. Clients cannot rely
on revert reasons across implementations.

### B8. (b) Intent nonce edge

"uint64, strictly greater than the coordinator's stored nonce". Gaps are allowed, so an initiator can
sign nonce `2^64 - 1` and permanently lose the ability to propose. Implemented as specified.

### B9. (b) No relation required between the four time limits

Intent expiry, acceptance expiry, `validUntil` and the order deadline are independent; e.g. a
`validUntil` later than the intent expiry is legal and simply never matters. Implemented as
independent checks. No inconsistency found.

### B10. (b) Vector field naming

`expected.termsHash` is the **new** terms hash; the original terms hash appears only as
`data.baseTermsHash`. Both reproduce, but the name invites a wrong comparison.

---

## C. What the profile relies on in ERC-8001 without restating it

- The two type strings (`AgentIntent(...)`, `AcceptanceAttestation(...)`) are only in ERC-8001;
  ERC-8448 says "use ERC-8001's type strings".
- `participantsHash = keccak256(abi.encodePacked(address[]))`. For a memory/calldata array
  `abi.encodePacked` pads each element to 32 bytes, which coincides with EIP-712 array encoding. The
  vector's intent struct hash confirms this.
- `AcceptanceAttestation.signature` is a struct member but not part of the typed data.
- The `EIP712Domain` type string is written out in neither spec. Inferred from the domain object:
  `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)`, no salt. The
  vector's digests confirm it.
- ERC-8001 defines the payload hash only as the comment "keccak256(CoordinationPayload)". ERC-8448
  supplies the formula (plain `abi.encode` of the six fields with the two `bytes` fields dynamic;
  not an EIP-712 struct hash). An ERC-8001 coordinator built before ERC-8448 could have used another
  formula; the profile is what pins it.
- Expiry comparisons: ERC-8001 gives "`intent.expiry <= block.timestamp`" and
  "`attestation.expiry <= block.timestamp`" as revert conditions, so equality is expired. ERC-8448
  says the same for the deadline and `validUntil` but relies on ERC-8001 for the Core ones.
- Canonical participants: "strictly ascending by `uint160(address)`".
- The exact return tuple of `getCoordinationStatus`, and the `Status` enum order.
- Low-s is stated as "required" only in ERC-8001's Security Considerations; ERC-8448 restates it.
- ERC-5267 exposure of the domain is a SHOULD in ERC-8001 (implemented as `eip712Domain()`).

---

## D. Vector versus text

No disagreement found. Every value in `order-amendment-v1.json` was reproduced from the text alone:
both identifiers, original and new terms hashes, the 352 ABI bytes, payload hash, intent struct hash,
intent digest, both acceptance digests, and all three signatures (65-byte, low-s, recovering to keys
1 and 2). The signatures were accepted by this contract's real entry points at the vector's
`verifyingContract` on chain id 31337.

What the vector does not cover, so it cannot detect divergence there:

- no expected `executeCoordination` result bytes or events (A3, A4, A5);
- no ERC-2098 compact signature and no ERC-1271 case (A6);
- no payment asset and no order-creation data (application-defined, so the order with the vector's
  `orderId` has to be created through each implementation's own API);
- no negative cases (non-canonical data, wrong terms hash), so A1 is invisible to it;
- acceptance struct hashes are not listed, only digests.

## E. Areas where nothing ambiguous was found

- "Amendment state view": signature, field order, `UnknownOrder`, the `eligible` definition and its
  boundary at the deadline are precise.
- `invalidateAmendments` and the two application event signatures.
- The `AmendmentData` layout and the canonical-encoding rule.
- The retry rule (new intent, new acceptances, same base allowed).
- The submission rule ("recorded provider before the current order deadline ... exact current
  revision, terms hash and a nonzero result hash").
