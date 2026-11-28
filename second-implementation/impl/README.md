# ERC-8448 second implementation (clean room)

An independent implementation of ERC-8448, "Agent Service Order Amendments" (`ORDER_AMENDMENT_V1`),
a profile over ERC-8001. It was written only from the published specification texts and the
published deterministic vector in `../spec/`; no other implementation was consulted. Its purpose is
interoperability evidence: it can be cross-tested against the reference implementation.

Places where the specification had to be interpreted are recorded in [`SPEC-NOTES.md`](./SPEC-NOTES.md).

No third-party contract libraries are used. EIP-712 hashing, ECDSA recovery (65-byte low-s and
64-byte ERC-2098), ERC-1271 validation by STATICCALL, ERC-20 call handling and the reentrancy guard
are in this repository. forge-std is used by the tests only.

## Layout

| Path | Content |
| --- | --- |
| `src/AgentOrderAmendments.sol` | The combined coordinator/order contract |
| `src/interfaces/IERC8001.sol` | ERC-8001 structs, `Status`, `IAgentCoordination`, error names |
| `src/interfaces/IOrderAmendments.sol` | `Terms`, `AmendmentData`, the ERC-8448 view, invalidation, events |
| `src/lib/SignatureValidation.sol` | ECDSA / ERC-2098 / ERC-1271 |
| `test/` | 176 Foundry tests; `test/vectors/order-amendment-v1.json` is a byte-identical copy of the spec asset |
| `out/AgentOrderAmendments.sol/AgentOrderAmendments.json` | Compiled artifact (ABI + bytecode) |

## Build and test

Solidity 0.8.30, EVM version `cancun` (the reentrancy guard uses transient storage), optimizer on.

```sh
forge build
forge test
```

Expected: `176 tests passed, 0 failed, 0 skipped`.

## Deployment

`AgentOrderAmendments` has **no constructor arguments** and no immutables. The EIP-712 domain
`{ name: "ERC-8001", version: "1", chainId, verifyingContract }` is derived from `block.chainid` and
`address(this)` on each use, so the same bytecode works at any address.

## Standardized surface

- ERC-8001: `proposeCoordination`, `acceptCoordination`, `executeCoordination`, `cancelCoordination`,
  `getCoordinationStatus`, `getRequiredAcceptances`, `getAgentNonce`, the four `Coordination*` events.
- ERC-8448: `getAmendmentState(bytes32)`, `error UnknownOrder(bytes32)`,
  `invalidateAmendments(bytes32)`, `AmendmentsInvalidated`, `OrderAmendmentApplied`.
- Helpers (not standardized): `getIntentHash(AgentIntent)`, `getAcceptanceHash(AcceptanceAttestation)`,
  `hashPayload(CoordinationPayload)`, `hashTerms(Terms)`, `toTypedDataDigest(bytes32)`,
  `DOMAIN_SEPARATOR()`, `eip712Domain()` (ERC-5267), and the public constants `ORDER_AMENDMENT_V1`,
  `ORDER_AMENDMENT_PAYLOAD_V1`, `TERMS_TYPEHASH`, `AGENT_INTENT_TYPEHASH`, `ACCEPTANCE_TYPEHASH`.
- `applyOrderAmendment(bytes32 intentHash, bytes32 payloadVersion, bytes32 coordinationType, bytes coordinationData)
  returns (bytes32, uint64, bytes32, uint256)` is the isolated application helper. It is `external`
  only so that it can be reached by a self-call; any other caller gets `OnlySelf()`.

Funding: the supplement is collected with `transferFrom(buyer, coordinator, supplement)`, so the
buyer must have approved **the coordinator contract** on the order's payment asset. No token call is
made when the supplement is zero.

## Application-defined order API

ERC-8448 leaves creation, submission and settlement to the application. This implementation uses:

```solidity
enum OrderStatus { None, Offered, Active, Submitted, Cancelled, Settled, Refunded }

function createOrder(bytes32 orderId, address provider, address paymentAsset, Terms calldata terms) external;
function agreeOrder(bytes32 orderId, bytes32 termsHash) external;
function cancelOrder(bytes32 orderId) external;
function submitWork(bytes32 orderId, uint64 revision, bytes32 termsHash, bytes32 resultHash) external;
function acceptAndPay(bytes32 orderId) external;
function refundAfterDeadline(bytes32 orderId) external;
function getOrder(bytes32 orderId) external view returns (OrderStatus status, uint256 escrowed, bytes32 resultHash);
```

| Function | Caller | Precondition | Effect |
| --- | --- | --- | --- |
| `createOrder` | buyer (`msg.sender`) | `orderId` nonzero and unused; provider nonzero, not the buyer, not the contract; asset has code; price > 0; both hashes nonzero; deadline in the future; allowance for `terms.totalPrice` | Pulls `totalPrice` into escrow (exact balance deltas), status `Offered`, revision 0, nonce 0 |
| `agreeOrder` | provider | `Offered`, `termsHash` equals the stored hash, before the deadline | Status `Active`: the initial agreement is effective and the order becomes amendable |
| `cancelOrder` | buyer | `Offered` | Escrow returned, status `Cancelled` |
| `submitWork` | provider | `Active`, before the current deadline, exact current `revision` and `termsHash`, nonzero `resultHash` | Status `Submitted`; no further amendments or invalidations |
| `acceptAndPay` | buyer | `Submitted` | Whole escrow (initial price plus all supplements) paid to the provider, status `Settled` |
| `refundAfterDeadline` | buyer | `Active` and `block.timestamp >= deadline` | Whole escrow returned, status `Refunded` |

Events: `OrderCreated`, `OrderAgreed`, `OrderCancelled`, `WorkSubmitted`, `OrderSettled`, `OrderRefunded`.

Deliberate limits of this minimal application (outside the profile): order IDs are caller-chosen, so
a pending `createOrder` can be front-run by someone taking the same ID (the buyer picks another);
there is no review timeout or dispute path, so a submitted order stays in escrow until the buyer
calls `acceptAndPay`. The specification says such policies "must be specified independently".

## Conformance table

Tests are named `file :: test`. `V` = `Vector.t.sol`, `S` = `AmendmentState.t.sol`,
`C` = `Coordination.t.sol`, `A` = `Application.t.sol`, `G` = `Signatures.t.sol`,
`T` = `Tokens.t.sol`, `O` = `OrderLifecycle.t.sol`.

### Scope and authoritative order

| MUST | Tests |
| --- | --- |
| One chain, one buyer, one provider, one immutable ERC-20 asset, combined contract | S `test_view_activeOrderIsEligibleWithAuthoritativeState`, V `test_vector_signatureRejectedOnAnotherChain`, V `test_vector_signaturesRejectedUnderAnotherVerifyingContract` |
| Identity, counterparties and asset do not change through an amendment | S `test_view_termsHashMatchesTermsAfterAmendment` |
| Implements ERC-8001 interface, hashes, domain, lifecycle | C `test_core_selectors`, `test_core_statusEnumValues`, `test_core_domain`, `test_core_getIntentHashIsStructHash`, all C `test_propose_*`, `test_accept_*`, `test_cancel_*`, `test_status_*`; V all |
| Authoritative state exposed through the common view | S `test_view_selectorAndReturnLayout`, `test_view_activeOrderIsEligibleWithAuthoritativeState` |
| Execution reads authoritative state, not a cached view | A `test_apply_executionReadsAuthoritativeStateNotProposalTimeState`, `test_apply_twoAmendmentsOneBase_onlyOneApplies` |
| Buyer and provider distinct and nonzero | O `test_create_rejectsInvalidParameters` |
| Price positive and unchanged or increased | A `test_apply_priceDecreaseFails`, `test_apply_zeroPriceFails`, `test_apply_unchangedPriceExtendedDeadline_noTransferNeeded` |
| Deadline unchanged or extended | A `test_apply_deadlineShorteningFails`, `test_apply_laterAmendmentUsesExtendedDeadline` |
| No previously submitted deliverable | A `test_apply_afterSubmissionFails` |
| Scope and acceptance commitments may change | A `test_apply_scopeAndAcceptanceMayChange` |
| A successful amendment changes the full terms hash | A `test_apply_identicalTermsFail` |
| Scope and acceptance hashes nonzero | A `test_apply_zeroScopeHashFails`, `test_apply_zeroAcceptanceHashFails`, O `test_create_rejectsInvalidParameters` |
| Raw integer units, no decimal conversion | A `test_apply_100to180_supplement80`, `test_apply_chained_180to220_supplement40` |
| Unix-second timestamps for deadline, `validUntil`, expiries | A `test_apply_atOrderDeadlineFails`, `test_apply_atValidUntilFails`, `test_execute_expiredIntentRevertsWithoutConsuming`, `test_execute_expiredAcceptanceRevertsWithoutConsuming` |
| Not reported eligible merely because it holds tokens | S `test_view_offeredOrderIsKnownButIneligible` |

### Signed representation

| MUST | Tests |
| --- | --- |
| Domain `{ERC-8001, 1, chainId, verifyingContract}` | V `test_vector_domainAndParties`, `test_vector_intentStructHashAndDigest`, C `test_core_domain`, `test_propose_revertsOnBadSignature` |
| `verifyingContract == AmendmentData.orderContract` | C `test_propose_revertsOnForeignOrderContract`, A `test_helper_rejectsForeignOrderContract`, V `test_vector_signaturesRejectedUnderAnotherVerifyingContract` |
| Identifiers are keccak of the exact strings | V `test_vector_identifiers` |
| Terms struct hash, no domain prefix | V `test_vector_termsHashes`, C `test_propose_revertsOnNewTermsHashMismatch` |
| `coordinationData` is 11 static words; trailing bytes and noncanonical forms rejected | V `test_vector_abiBytes`, C `test_propose_revertsOnTrailingBytes`, `test_propose_revertsOnTruncatedData`, `test_propose_revertsOnDirtyPadding`, A `test_helper_rejectsNonCanonicalData`, `test_helper_rejectsDirtyAddressPadding` |
| `newTermsHash` equals the struct hash of `newTerms` | C `test_propose_revertsOnNewTermsHashMismatch`, A `test_helper_rejectsTermsHashMismatch` |
| Payload hash formula | V `test_vector_payloadHash`, C `test_propose_revertsOnPayloadHashMismatch`, A `test_execute_payloadMismatchRevertsWithoutConsuming` |
| `conditionsHash == 0`, empty `metadata` | C `test_propose_revertsOnNonzeroPayloadConditions`, `test_propose_revertsOnNonemptyMetadata` |
| `getIntentHash` returns the struct hash; acceptances carry it and are signed under their own digest | V `test_vector_intentStructHashAndDigest`, `test_vector_acceptanceDigestsAndSignatures`, C `test_core_getIntentHashIsStructHash`, `test_accept_revertsOnBadSignature` |
| participants exactly buyer and provider, sorted, distinct | C `test_propose_revertsWhenParticipantsAreNotTheOrderParties`, `test_propose_revertsOnExtraParticipant`, `test_propose_revertsOnSingleParticipant`, `test_propose_revertsOnDescendingParticipants`, `test_propose_revertsOnDuplicateParticipants` |
| `agentId` one of the two | C `test_propose_revertsWhenAgentNotAParticipant`, `test_propose_providerMayInitiate` |
| `intent.nonce` strictly greater than stored | C `test_propose_nonceMustStrictlyIncrease_gapsAllowed`, A `test_retry_needsFreshIntentAndFreshAcceptances` |
| `intent.coordinationType` is the profile identifier | C `test_propose_revertsOnWrongIntentCoordinationType`, `test_propose_revertsOnPayloadTypeDifferentFromIntentType`, A `test_helper_rejectsWrongProfile` |
| `intent.coordinationValue` zero | C `test_propose_revertsOnNonzeroCoordinationValue` |
| `acceptance.nonce` zero | C `test_accept_revertsOnNonzeroNonce` |
| `acceptance.conditionsHash` zero, nonzero rejected | C `test_accept_revertsOnNonzeroConditions` |
| `acceptance.participant` is a party and its signature validates | C `test_accept_revertsForNonParticipantSigner`, `test_accept_revertsOnBadSignature` |
| `acceptCoordination` caller is a listed participant; may relay the other's attestation | C `test_accept_revertsForNonParticipantCaller`, `test_accept_participantMaySubmitTheOthersAttestation`, V `test_vector_realSignaturesThroughProposeAcceptExecute` |
| `executionData` empty | A `test_execute_nonemptyExecutionDataRevertsWithoutConsuming` |

### Amendment state view

| MUST | Tests |
| --- | --- |
| Exact input, return types and field order | S `test_view_selectorAndReturnLayout`, `test_view_unknownOrderErrorSelector` |
| Callable by any address | S `test_view_callableByAnyAddress` |
| Unknown order, including unused zero ID, reverts `UnknownOrder(orderId)` | S `test_view_unknownOrderReverts`, `test_view_unusedZeroIdReverts` |
| Known order stays readable when ineligible | S `test_view_offeredOrderIsKnownButIneligible`, `test_view_submittedOrderIneligible`, `test_view_cancelledOrderIneligible`, `test_view_settledOrderIneligible`, `test_view_refundedOrderIneligible`, `test_view_deadlineEqualityIsIneligible` |
| `termsHash` is the struct hash of the returned `terms` | S `test_view_selectorAndReturnLayout`, `test_view_termsHashMatchesTermsAfterAmendment` |
| Same authoritative values execution checks | A `test_apply_clientUsingOnlyStandardInterfaces`, `test_apply_staleBaseTermsHashFails`, `test_apply_wrongBaseRevisionFails` |
| `eligible` iff effective, not cancelled/settled, nothing submitted, `now < deadline`; equality false | S `test_view_activeOrderIsEligibleWithAuthoritativeState`, `test_view_deadlineEqualityIsIneligible`, the five `...Ineligible` tests above |
| After an applied extension the view uses the new deadline | S `test_view_usesAmendedDeadlineAfterExtension` |
| Invalidation advances the nonce without changing revision or terms | S `test_view_invalidationAdvancesOnlyNonce` |
| `eligible` independent of proposals, signatures, balances, allowances | S `test_view_eligibilityIgnoresBalancesAndAllowances`, `test_view_eligibilityIgnoresPendingProposals`, A `test_apply_fundingFailureIsAtomic` |
| Execution rechecks state, expiry and funding even after a true read | A `test_apply_fundingFailureIsAtomic`, `test_apply_invalidationByProviderBlocksPendingAmendment`, `test_apply_atOrderDeadlineFails` |

### Consent and application

| MUST | Tests |
| --- | --- |
| Both participants, including the initiator, explicitly accept; proposing is not accepting | C `test_propose_success`, `test_accept_bothRequired_initiatorIncluded`, A `test_execute_notReadyReverts` |
| Proposals and acceptances do not alter the order or secure funds | C `test_propose_success`, `test_accept_bothRequired_initiatorIncluded`, A `test_apply_100to180_supplement80` |
| A new intent advances the nonce and does not revoke older intents | C `test_propose_newerIntentDoesNotRevokeOlderOne` |
| Applied amendment increments revision and amendment nonce | A `test_apply_100to180_supplement80`, `test_apply_chained_180to220_supplement40` |
| `invalidateAmendments` by either party; nonce only; Core status not rewritten | A `test_apply_invalidationByProviderBlocksPendingAmendment`, `test_apply_invalidationByBuyerBlocksPendingAmendment`, `test_invalidate_leavesTermsAndFundsIntact` |
| Cancellation: proposer only before expiry, anyone at or after; executed and cancelled terminal | C `test_cancel_onlyProposerBeforeExpiry`, `test_cancel_anyoneAtOrAfterExpiry`, `test_cancel_readyIntentThenTerminal`, `test_cancel_cancelledIntentCannotBeAccepted`, `test_cancel_executedIntentIsTerminal` |
| Invalid outer inputs revert without consuming the intent | A `test_execute_notReadyReverts`, `test_execute_expiredIntentRevertsWithoutConsuming`, `test_execute_expiredAcceptanceRevertsWithoutConsuming`, `test_execute_payloadMismatchRevertsWithoutConsuming`, `test_execute_nonemptyExecutionDataRevertsWithoutConsuming` |
| Check 1: order contract, version, profile, terms commitment | A `test_helper_rejectsForeignOrderContract`, `test_helper_rejectsWrongPayloadVersion`, `test_helper_rejectsWrongProfile`, `test_helper_rejectsTermsHashMismatch`, `test_helper_rejectsNonCanonicalData`, `test_helper_rejectsUnknownOrder` |
| Check 2: Active and `now < currentTerms.deadline` | A `test_apply_atOrderDeadlineFails`, `test_apply_oneSecondBeforeOrderDeadlineSucceeds`, `test_apply_onOfferedOrderFails`, `test_apply_onRefundedOrderFails`, `test_apply_afterSubmissionFails` |
| Check 3: `now < validUntil` | A `test_apply_atValidUntilFails`, `test_apply_validUntilOneSecondBeforeLimitSucceeds` |
| Check 4: revision, terms hash, amendment nonce match | A `test_apply_wrongBaseRevisionFails`, `test_apply_staleBaseTermsHashFails`, `test_apply_invalidationByBuyerBlocksPendingAmendment` |
| Check 5: price/deadline restrictions, nonempty commitments | A `test_apply_priceDecreaseFails`, `test_apply_zeroPriceFails`, `test_apply_deadlineShorteningFails`, `test_apply_zeroScopeHashFails`, `test_apply_zeroAcceptanceHashFails` |
| Check 6: supplement is exactly new minus current price | A `test_apply_100to180_supplement80`, `test_apply_chained_180to220_supplement40`, `test_apply_unchangedPriceExtendedDeadline_noTransferNeeded` |
| Transfer, accounting, terms, counters and event all inside the isolated call | A `test_apply_fundingFailureIsAtomic`, `test_apply_revisionOverflowFailsInsteadOfWrapping`, T `test_token_movesFundsThenReturnsFalse_rolledBack` |
| Return `abi.encode(orderId, revision, newTermsHash, supplement)` | A `test_apply_100to180_supplement80`, `test_apply_chained_180to220_supplement40`, V `test_vector_realSignaturesThroughProposeAcceptExecute` |
| Exact buyer and escrow balance deltas verified, mismatches rejected | T `test_token_returnsTrueWithoutMoving_rejected`, `test_token_feeOnTransfer_rejected`, `test_token_createOrderAlsoUsesExactDeltas` |
| At most one amendment per base revision; invalidation does not undo an applied change | A `test_apply_twoAmendmentsOneBase_onlyOneApplies`, `test_invalidate_doesNotUndoAppliedAmendment_andNewBaseWorks` |
| Later amendments use the extended deadline | A `test_apply_laterAmendmentUsesExtendedDeadline` |

### Failure and retry

| MUST | Tests |
| --- | --- |
| Row 1: outer call reverts, nothing changes | the five A `test_execute_*` tests |
| Row 2: `Executed, success=false`, writes rolled back | every A/T/O test that uses `_assertFailedApplication` (36 call sites), e.g. A `test_apply_fundingFailureIsAtomic` |
| Row 3: `Executed, success=true` plus `OrderAmendmentApplied` | A `test_apply_100to180_supplement80`, V `test_vector_realSignaturesThroughProposeAcceptExecute` |
| Failed application consumes the intent, does not increment nonce/revision | A `test_retry_needsFreshIntentAndFreshAcceptances` |
| Retry needs a new intent and new acceptances; old acceptances are not reused | A `test_retry_needsFreshIntentAndFreshAcceptances`, T `test_token_afterFalseReturnFailure_freshAttemptCollectsExactly80` |
| Any caller may execute a Ready coordination | A `test_apply_anyCallerMayExecute`, V `test_vector_realSignaturesThroughProposeAcceptExecute` |
| Token that moves funds then returns false is covered by the rollback | T `test_token_movesFundsThenReturnsFalse_rolledBack` |
| Reentrant public mutations prevented | T `test_reentrancy_allPublicMutationsBlockedDuringSupplement`, `test_reentrancy_sameIntentCannotApplyTwice`, `test_reentrancy_blockedDuringPayout`, `test_reentrancy_blockedDuringOrderFunding`, `test_reentrancy_guardReleasedAfterEachCall` |
| Application helper restricted to the coordinator itself | A `test_helper_onlyCallableByCoordinatorItself`, T `test_reentrancy_helperNotCallableFromTokenCallback` |

### Submission and signatures

| MUST | Tests |
| --- | --- |
| Submission restricted to the recorded provider | O `test_submit_onlyRecordedProvider` |
| Before the current order deadline | O `test_submit_mustBeBeforeCurrentDeadline`, `test_submit_afterAmendmentNeedsNewRevisionAndUsesNewDeadline` |
| Exact current revision, terms hash, nonzero result hash | O `test_submit_requiresExactRevisionTermsHashAndNonzeroResult`, `test_submit_afterAmendmentNeedsNewRevisionAndUsesNewDeadline` |
| A valid submission makes the order ineligible for all later amendments | O `test_submit_makesOrderIneligibleForAllLaterAmendments`, A `test_apply_afterSubmissionFails`, S `test_view_submittedOrderIneligible` |
| Low-s 65-byte ECDSA | G `test_sig_65ByteLowS_acceptedAtProposeAndAccept`, `test_sig_highS_rejectedAtPropose`, `test_sig_highS_rejectedAtAccept`, `test_sig_sExactlyHalfNBoundary`; V (published signatures) |
| Compact 64-byte ERC-2098 | G `test_sig_compact64_acceptedAtPropose`, `test_sig_compact64_acceptedAtAccept_thenExecutes`, `test_sig_compact64_bothParities`, `test_sig_compact64_wrongSignerRejected` |
| ERC-1271 for contract signers, by STATICCALL | G `test_1271_acceptedAtProposeAndAccept_andApplies`, `test_1271_rejectedWhenWalletSaysNo_propose` (includes a wallet that tries to write state), `test_1271_rejectedWhenWalletSaysNo_accept`, `test_1271_ownerSignatureDoesNotActForUnrelatedParticipant` |
| Invalid signatures rejected | G `test_sig_invalidV_rejected`, `test_sig_wrongLength_rejected`, `test_sig_zeroSignerNeverValid`, C `test_propose_revertsOnBadSignature`, `test_accept_revertsOnBadSignature` |
| Validated at proposal/acceptance; not revalidated at execution | G `test_1271_notRevalidatedAtExecution` |
| Withdrawal by explicit invalidation | G `test_1271_walletWithdrawsByInvalidation`, A `test_apply_invalidationByBuyerBlocksPendingAmendment` |

### Application events and invalidation

| MUST | Tests |
| --- | --- |
| `invalidateAmendments(bytes32)` exposed with that signature | C `test_core_selectors` |
| Restricted to buyer or provider | A `test_invalidate_restrictedToParties` |
| Only while active, no submitted work, before the deadline | A `test_invalidate_revertsOnOfferedOrder`, `test_invalidate_revertsAfterSubmission`, `test_invalidate_revertsAtDeadline`, `test_invalidate_unknownOrderReverts` |
| Advances only the amendment nonce; terms and funds unchanged | A `test_invalidate_leavesTermsAndFundsIntact`, S `test_view_invalidationAdvancesOnlyNonce` |
| Emits `AmendmentsInvalidated(orderId, participant, amendmentNonce)` | A `test_apply_invalidationByProviderBlocksPendingAmendment`, `test_apply_invalidationByBuyerBlocksPendingAmendment` |
| Successful amendment increments revision and nonce once and emits `OrderAmendmentApplied` with revision, previous/new hashes, actual supplement | A `test_apply_100to180_supplement80`, `test_apply_chained_180to220_supplement40`, V `test_vector_realSignaturesThroughProposeAcceptExecute` |
| Overflow reverts rather than wraps | A `test_invalidate_nonceOverflowReverts`, `test_apply_revisionOverflowFailsInsteadOfWrapping`, `test_apply_amendmentNonceOverflowFailsInsteadOfWrapping` |
| An unsuccessful application leaves no `OrderAmendmentApplied` in the receipt | `_assertFailedApplication` in `test/Base.sol` (see limitation below) |

### "Test Cases" table of the specification

| Case | Tests |
| --- | --- |
| Unknown order or unused zero ID queried | S `test_view_unknownOrderReverts`, `test_view_unusedZeroIdReverts` |
| Known offered, submitted, cancelled or settled order queried | S `test_view_offeredOrderIsKnownButIneligible`, `test_view_submittedOrderIneligible`, `test_view_cancelledOrderIneligible`, `test_view_settledOrderIneligible` |
| Query exactly at the current deadline | S `test_view_deadlineEqualityIsIneligible`, `test_view_usesAmendedDeadlineAfterExtension` |
| State read, then either party invalidates | A `test_apply_invalidationByProviderBlocksPendingAmendment`, `test_apply_invalidationByBuyerBlocksPendingAmendment` |
| Eligible order without supplemental funding capacity | A `test_apply_fundingFailureIsAtomic`, S `test_view_eligibilityIgnoresBalancesAndAllowances` |
| Client uses only the common view and ERC-8001 interface | A `test_apply_clientUsingOnlyStandardInterfaces` |
| Current total 100; agreed total 180 | A `test_apply_100to180_supplement80` |
| Current total 180; agreed total 220 | A `test_apply_chained_180to220_supplement40` |
| Two amendments share one base revision | A `test_apply_twoAmendmentsOneBase_onlyOneApplies` |
| Either party invalidates before application | A `test_apply_invalidationByProviderBlocksPendingAmendment`, `test_apply_invalidationByBuyerBlocksPendingAmendment` |
| Funding fails after bilateral acceptance | A `test_apply_fundingFailureIsAtomic`, `test_apply_insufficientBuyerBalanceIsAtomic` |
| Capacity restored after that failed attempt | A `test_retry_needsFreshIntentAndFreshAcceptances` |
| Nonempty unsigned execution data | A `test_execute_nonemptyExecutionDataRevertsWithoutConsuming` |
| Replacement data not canonical ABI, or terms hash differs | C `test_propose_revertsOnTrailingBytes`, `test_propose_revertsOnTruncatedData`, `test_propose_revertsOnDirtyPadding`, `test_propose_revertsOnNewTermsHashMismatch`; A `test_helper_rejectsNonCanonicalData`, `test_helper_rejectsDirtyAddressPadding`, `test_helper_rejectsTermsHashMismatch` |
| Current time equals the order deadline or validity limit | A `test_apply_atOrderDeadlineFails`, `test_apply_atValidUntilFails` |
| Work already submitted against the current revision | A `test_apply_afterSubmissionFails` |
| Price decreases or deadline shortens | A `test_apply_priceDecreaseFails`, `test_apply_deadlineShorteningFails` |

## The published vector

`test/Vector.t.sol` reads the JSON from disk and

1. recomputes, without calling the contract, both identifiers, both terms hashes, the 352 ABI bytes,
   the payload hash, the intent struct hash and digest, and both acceptance digests, and recovers
   the three signers with `ecrecover`;
2. places the contract's code at the vector's `verifyingContract`
   `0x1000000000000000000000000000000000000001` (chain id 31337, time warped to the payload
   timestamp), creates the order with the vector's `orderId` and original terms through
   `createOrder` / `agreeOrder`, and then submits the published intent signature to
   `proposeCoordination` and both published acceptances to `acceptCoordination`. All three are
   accepted, `executeCoordination` succeeds with supplement 80, revision 1 and the expected new
   terms hash.

## Known limitations of the test evidence

- `vm.recordLogs` also records logs emitted in call frames that later revert (it captures the
  token's `Transfer` from a rolled-back supplement). The tests therefore show rollback through state
  and balances and through the absence of `OrderAmendmentApplied`, which this implementation emits
  as the last statement of the isolated call. That reverted-frame logs are absent from a real
  transaction receipt is an EVM guarantee and was not observed against a node here.
- Item 1 of the isolated call's checks is unreachable through the public entry points, because
  proposal already rejects those payloads. The `test_helper_rejects*` tests reach it with
  `test/mocks/Mocks.sol:Harness`, a subclass that writes a Ready coordination directly to storage.
  The same harness sets the counters to their maximum for the overflow tests. All other tests use
  only public entry points (the harness adds functions, it changes none).
- Nothing was run against a live chain or against any other implementation.
