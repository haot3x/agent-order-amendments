# Repeated amendments and fee delays

Author: Ted (@haot3x)

This experiment addresses [tagemeyo's question](https://ethereum-magicians.org/t/erc-8448-agent-service-order-amendments/29936/13)
about frequent updates, supplemental funding and higher network fees. It adds
six local EVM cases without changing contracts, the signed payload, fixed
vectors or the proposed specification. ERC-8448's
[Draft submission](https://github.com/ethereum/ERCs/pull/2082) still needs editor
re-review; successful implementation tests are not standards approval.

## What is locked, and when

The buyer deposits the original price when offering the order. Preparing an
amendment and recording both acceptances does **not** reserve or debit its
supplement. At execution, current revision, terms, nonce and deadlines are
checked again. The supplemental transfer and revision update share the same
isolated application call. If it fails, neither change persists.

A submitted but unmined transaction cannot collect the supplement. The buyer
can still spend it elsewhere, so consent does not guarantee later funding.
The original escrow remains subject to the existing order's settlement/refund
rules; it does not unlock merely because an amendment is delayed or expires.

Network fees are paid in ETH by each transaction sender, separately from TEST
escrow. A higher fee cap does not increase the token price or authorize different
terms. A mined transaction can spend gas even when the amendment does not apply.

## Cases

| Case | Checked outcome |
| --- | --- |
| 32 consecutive complete-term updates, +5 token base units each | Revision and nonce reach 32; escrow grows from 100 to 260; each execution transfers exactly 5. State, balances and common getter are checked after every update. |
| Eight Ready candidates for the same base, executed in one block | Exactly one applies and transfers its supplement. Seven report stale-state application failure; no additional token transfers or applied events. A single executor's transaction nonces control this test's ordering. |
| Four transfer-then-fail attempts, interleaved with fresh consent and successful retries | Failed attempts preserve the entire order, balances and allowance; their transfer logs disappear. Each failed coordination attempt is consumed. Fresh intent and both acceptances are required to retry. |
| Identical amendment at 1 and 100 gwei base fee | Same gas units and 80-unit supplement; different ETH fees. Both executions start from the same snapshot. |
| Fee cap becomes insufficient after submission | The transaction is not mined and the supplement stays with the buyer. A fee-bumped resubmission using the same signed intent and account nonce applies once before expiry. |
| Fee-delayed execution mined exactly at the intent/acceptance expiry | Transaction reverts with no logs or order/token changes. The coordination view reports Expired, but the executor still pays the transaction fee. |

The delayed cases use manual mining and `anvil_setNextBlockBaseFeePerGas`.
Anvil 1.7.1 drops the underpriced transaction when attempting to mine it;
production clients can retain underpriced transactions. The tests establish
non-inclusion and unchanged contract state, not universal mempool retention or
replacement behavior. The base-fee jump is an injected scenario, not a simulation
of EIP-1559's block-by-block adjustment limit.

## Gas measurements

Gas below is **transaction receipt gas**, including intrinsic/calldata costs,
not the narrower `CoordinationExecuted.gasUsed` event field. The consecutive
sequence records proposal, buyer acceptance, provider acceptance and execution
separately. Order creation, activation, token approval, signing, RPC traffic and
failed competing attempts are excluded from that four-transaction total.

| Local measurement | Gas units |
| --- | ---: |
| First update: proposal / buyer acceptance / provider acceptance / execution | 211,417 / 118,209 / 98,165 / 134,562 |
| Successful execution, range over 32 updates | 117,474–134,562 |
| Complete four-transaction amendment, range over 32 updates | 528,213–562,353 |
| Stale competing execution | 56,156–56,168 |
| Transfer-then-fail execution | 86,818–86,854 |

The fee comparison uses one 134,574-gas execution with a 1 gwei priority fee:

| Base fee | Effective gas price | Executor fee | Token supplement |
| --- | --- | --- | --- |
| 1 gwei | 2 gwei | 0.000269148 ETH | 80 base units |
| 100 gwei | 101 gwei | 0.013591974 ETH | 80 base units |

These measurements use a disposable token, EOA signatures and this repository's
combined coordination/order fixture on Cancun. They are observations, not gas
ceilings. Different calldata, signature forms, tokens, storage, hooks, hardforks
or rollup data fees can change costs. Historical coordination records also keep
consuming storage even when later executions remain similarly priced.

## Reproduce

```sh
npm ci --ignore-scripts
npm run test:bursts
npm test
npm run vectors
git diff --exit-code -- vectors/
npm run demo
```

The targeted command expects **6 passing tests** and prints gas diagnostics.
The complete suite expects **95 passing tests**. Node.js 24.15.0, npm 11.12.1,
Anvil 1.7.1, solc 0.8.37, optimizer 200 and via-IR were used for the local run.
No RPC endpoint, real funds or deployment is needed.

Evidence is in [evidence/2026-11-18-bursts-fees](evidence/2026-11-18-bursts-fees).
Two negative controls temporarily remove (1) the stale revision/nonce guards
and (2) the intent/acceptance expiry guard. The corresponding test fails in
each case. Original contract bytes are restored before the full suite runs.

These are bounded correctness cases, not a sustained throughput benchmark,
independent implementation, public-mempool study or reorg/finality test.
For frequent updates, clients should re-read the authoritative state before
signing, monitor application events as well as transaction receipts, and obtain
fresh consent when the old base or validity window no longer applies. Whether
an application should batch/coalesce proposed changes or use an L2 remains a
deployment decision, not a new requirement of this profile.
