# Cross-implementation results

Run on 28 November 2026 with the reference implementation at the repository root and the second implementation in
[`impl/`](impl/), both built from the same commit.

## Method

[`interop/client.mjs`](interop/client.mjs) is a client whose ABI is transcribed from ERC-8448 and ERC-8001. It reads
`getAmendmentState`, builds and signs an amendment, and uses `proposeCoordination`, `acceptCoordination`,
`executeCoordination`, `cancelCoordination`, `invalidateAmendments` and the status getters. It never sees either
implementation's own ABI.

[`interop/scenarios.mjs`](interop/scenarios.mjs) runs the same 21 scenarios against each implementation on a fresh
local chain and records what an outside observer sees: whether each transaction was accepted, the decoded events in
real receipts, the common view, token balances and coordination status. A 22nd scenario places each implementation's
code at the published vector's verifying contract address and submits the vector's published signatures.

[`interop/interop.test.mjs`](interop/interop.test.mjs) checks each scenario against the specification on both
implementations, then compares the two sets of observations field by field.

## Shared surface

Every function, event and error the two specifications name has the same selector or topic in both builds:
`getAmendmentState`, `invalidateAmendments`, the four coordination functions, `getCoordinationStatus`,
`getRequiredAcceptances`, `getAgentNonce`, `getIntentHash`, `getAcceptanceHash`, `UnknownOrder`,
`AmendmentsInvalidated`, `OrderAmendmentApplied` and the four coordination events. Order creation, submission and
settlement differ, as the specification allows.

## Scenarios

| Scenario | Specification test-table row | Both implementations |
| --- | --- | --- |
| Unknown order and zero id | Unknown order or unused zero ID queried | Revert with identical `UnknownOrder(orderId)` data |
| Offered order | Known offered order queried | Readable, `eligible=false` |
| 100 to 180, then 180 to 220, from the common view only | Client uses only the common view; total 100 to 180; total 180 to 220 | Supplements 80 and 40; revision and nonce 1 then 2; identical event fields and return encoding |
| Two amendments on one base | Two amendments share one base revision | First applies, second is `Executed, success=false`, state unchanged |
| Provider invalidates | Either party invalidates before application | Nonce advances, terms and funds intact, pending amendment fails, a stranger cannot invalidate |
| Funding fails, then retry | Funding fails; capacity restored | Rolled back with no application or token log in the receipt; old intent terminal; fresh intent and acceptances apply |
| Token returns false after moving funds | Failure and retry section | Rolled back |
| Nonempty execution data | Nonempty unsigned execution data | Outer revert, intent still Ready, then applies |
| Work submitted | Work already submitted | View `eligible=false`, amendment and invalidation fail |
| Lower price, shorter deadline, unchanged terms | Price decreases or deadline shortens | Accepted by both parties, then fail at application |
| Same price, new criteria | (not in the table) | Applies with supplement 0 and no token call |
| Time equals `validUntil`; time equals the deadline | Current time equals the deadline or validity limit | Fail; view `eligible=false` at the deadline |
| Deadline extension | Query exactly at the current deadline, second half | View and later amendments use the new deadline |
| ERC-2098 compact signature, cross-submission | Submission and signatures section | Accepted; forged and outsider-submitted attestations rejected |
| ERC-1271 buyer | Submission and signatures section | Accepted at acceptance; not revalidated at execution after the wallet starts rejecting |
| Intent, payload and acceptance rules | Signed representation table | Seven violations rejected |
| Cancellation | Consent and application section | Proposer only before expiry, anyone after; cancelled and expired intents do not execute |
| Non-canonical payload | Complete replacement data is not canonical ABI, or its terms hash differs | Never applied |
| Acceptance expires before the intent | (not in the table) | Reported Expired; execution reverts without consuming |
| Published vector on a live chain | Test Cases, deterministic vector | Published signatures accepted; revision 1, supplement 80, expected terms hash |

## The one difference

When an application fails, `CoordinationExecuted.result` and the returned `result` hold different bytes: the reference
returns a string revert reason, the second implementation a custom error. The specification says only that `result`
is returned. A client that decodes it to explain a failure would work against one implementation and not the other.

## Agreement the text does not guarantee

[`impl/SPEC-NOTES.md`](impl/SPEC-NOTES.md) lists twelve places where two conforming implementations could diverge.
The two implementations here happened to choose the same reading for most of them. That is evidence the reading is the
natural one, not that the text requires it.

| Note | Open point | Observed |
| --- | --- | --- |
| A1 | Where a non-canonical payload is rejected | Both reject trailing bytes, a wrong terms hash, a wrong order contract and a wrong payload version at proposal. Both reject a zero scope hash at application |
| A2 | Where "participants are the buyer and provider" is enforced | Both at proposal |
| A3 | `result` on a failed application | **Differs**, as above. `gasUsed` was not compared |
| A4 | "revision" in the event and return value | Both use the new revision |
| A5 | `CoordinationAccepted.acceptanceHash` | Same value from both |
| A6 | EOA or contract signer dispatch | Not observed; needs an EIP-7702 account |
| A7 | Token call on a zero supplement | Neither calls the token |
| A8 | How the supplement is collected | Both pull from the buyer's allowance to the coordinator |
| A9 | Status when an acceptance expired before the intent | Both report Expired and revert execution without consuming |
| A10 | `finalStatus` when cancelling an expired intent | Both emit Cancelled |
| A11 | `getIntentHash` missing from the required interface | Both expose the same selector |
| A12 | Gas-limited execution consuming an intent | Not observed |

Each row except A6 and A12 is a candidate for one clarifying sentence in the specification, so that a third
implementation does not have to guess.
