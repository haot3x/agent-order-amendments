# Agent Service Order Amendments

Experimental `ORDER_AMENDMENT_V1` profile over [ERC-8001](https://eips.ethereum.org/EIPS/eip-8001): two parties agree to new order terms, and supplemental funding and the new revision take effect together.

**Local test software. ERC-8448 has been assigned; the [official Draft submission](https://github.com/ethereum/ERCs/pull/2082) is awaiting editor approval and merge. Use only disposable test tokens on a local chain.** The Solidity example includes a minimal buyer-acceptance payout and undelivered-order refund fixture. It has no dispute resolution or review timeout, and has not been audited or deployed to a public network.

Author: Ted (@haot3x)

Discussion: https://ethereum-magicians.org/t/erc-8448-agent-service-order-amendments/29936

## Run

New reviewer? Start with the [five-minute reproduction guide](QUICKSTART.md): a pinned implementation, two commands, expected state and balance changes, and a short feedback template.

Node.js 22 or newer; Node.js 24 is used in CI. Anvil is installed as a pinned platform-specific npm dependency. No global Foundry installation, RPC URL or private key is required.

```sh
npm ci --ignore-scripts
npm test
npm run demo
```

The EVM tests compile Solidity 0.8.37 for Cancun, start a disposable Anvil node on a random **127.0.0.1** port, and stop it afterward. They do not fork or send transactions to a public chain. Anvil's default development accounts and the vector's integer keys 1 and 2 are public test fixtures, never production credentials.

```sh
npm run test:evm       # Local Solidity/EVM integration cases
npm run test:state     # Common read ABI and viem amendment workflow
npm run test:spend-grants # ERC-8427 cap changes and atomic order funding
npm run test:vectors   # ethers / viem encoding comparison
npm run compile       # Optional ABI/bytecode output in ignored artifacts/
npm run vectors       # Regenerate the committed deterministic vector
npm run demo          # Full local EVM workflow, payout and two refund branches
npm run demo:model    # Original JavaScript-only order experiment
```

The demo funds an order for 100 TEST, obtains both parties' amendment signatures, collects an additional 80, activates revision 1, submits a synthetic ten-project report, and pays 180 after the buyer checks and accepts that exact delivery. Separate examples cancel an unactivated offer and refund an active order with no delivery at expiry. All transactions are mined on the disposable local chain.

Documents, signed payloads, balances and transaction/event receipts are written to ignored `artifacts/local-order-demo/`. These are local evidence, not public explorer records. TEST has 18 decimals; event amounts use base units. The demo uses synthetic fixture records and does not call an LLM or the Finch backend. See [DEMO.md](DEMO.md) for the walkthrough and settlement boundaries.

## What is implemented

- A common `getAmendmentState(orderId)` view for parties, asset, revision, complete terms, terms hash, amendment nonce and order eligibility.
- Canonical signed payload containing the exact order, base revision, base terms hash, amendment nonce, complete replacement terms and validity deadline.
- ERC-8001 intent and explicit acceptance from both order parties, including the initiator; EOA 65-byte / EIP-2098 signatures and an ERC-1271 path.
- An order-level nonce that either party can advance to invalidate pending amendments without cancelling the underlying order.
- A same-transaction execution step: check the authoritative order, collect only the price increase, update the revision and emit `OrderAmendmentApplied`.
- Separate coordination-attempt and order-application outcomes. A failed application leaves order/token state unchanged but consumes that coordination attempt; a retry needs a fresh intent and acceptances.
- Submission bound to a revision, terms hash and result hash; submission freezes further amendments.
- Buyer acceptance of that exact submitted delivery and a full payout to the recorded provider in one transaction. Failed transfers roll back acceptance and escrow accounting.
- Buyer cancellation before provider activation; permissionless expiry refunds of Offered/Active orders with no submitted work, always to the recorded buyer. Refunds include all applied supplements.

For `100 → 180 → 220`, supplements are 80 and 40. Price decreases, deadline shortening and post-submission changes are outside this profile.

## Evidence

Local run on 2026-10-21: **81 tests passed**: 59 local EVM tests (including 10 ERC-8427 integration cases), 1 cross-library fixed-vector test and 21 original JavaScript model tests. The full local EVM demo also passed, and regenerating the signed vector produced no changes.

EVM cases include competing amendments, buyer/provider invalidation, insufficient balance and allowance, a token that moves funds then reports failure, a reentrant token callback, substituted payloads, expiry equality, compact signatures, and a mock ERC-1271 wallet. Solidity, ethers and independently declared viem encodings agree on the published vector.

Settlement cases cover single payment, exact delivery binding, unauthorized acceptance, late buyer acceptance, refunds using the current amended deadline, preservation of another order's escrow, failed-transfer rollback/retry, refund reentrancy and terminal-order replay protection.

The [ERC-8427 integration experiment](ERC8427.md) adds 10 local EVM cases against the pinned, unmodified upstream registered-grant registry and direct executor. They cover cap reduction after consent, revocation, atomic debit/transfer/revision rollback, fresh-consent retry and competing orders sharing one grant. The upstream contracts use solc 0.8.28; our fixture uses 0.8.37.

The [common-view workflow](STATE-VIEW.md) adds nine EVM cases. A viem client declares its ABI and encodings separately, reads the base state, signs, applies an amendment and verifies the new revision. Cases cover unknown IDs, ineligible states, deadline equality, nonce invalidation, funding failure and a second read-only storage-layout fixture. That fixture is not a second complete ERC-8448 implementation.

External reproduction reported on 2026-10-27: [Revinand ran the quickstart](https://ethereum-magicians.org/t/erc-8448-agent-service-order-amendments/29936/10) at commit `6d58faba27a32e802f11c4919cfd9682489976ba` on Ubuntu 24.04.5 LTS x86_64, Node.js 24.8.0 and npm 11.6.0. Installation succeeded, all 9 state-view cases and all 81 full-suite tests passed, and the lifecycle demo passed. The report confirms revision/nonce advancement, the supplemental transfer, failed-funding state preservation, final balances and both refunds.

The implementation and supplied client are authored within one project. The linked report is an external run of that code; it does not establish a second independently written implementation, adoption, an external audit, or exhaustive ERC-8001 conformance certification.

The [discovery and tender composition notes](PROFILE.md#discovery-and-tender-composition) record the ERC-8444 author's clarification that bilateral amendments stay in the order/settlement layer, and the version and fixed-term boundaries for a future ERC-8414 integration. Neither adapter is implemented here.

## Files

| File | Purpose |
| --- | --- |
| [QUICKSTART.md](QUICKSTART.md) | Five-minute external reproduction with expected results and a feedback template |
| [PROFILE.md](PROFILE.md) | Experimental wire format, state transitions and failure semantics |
| [STATE-VIEW.md](STATE-VIEW.md) | Common read ABI, viem client and executable state-view workflow |
| [examples/independent-client.mjs](examples/independent-client.mjs) | Separately declared ABI, amendment encoding and typed data |
| [test/amendment-state-evm.test.mjs](test/amendment-state-evm.test.mjs) | State view semantics and client-to-contract workflow |
| [DEMO.md](DEMO.md) | Local demo walkthrough and application settlement policy |
| [ERC8427.md](ERC8427.md) | Registered-grant funding integration and reproducible results |
| [contracts/ExperimentalOrderAmendments.sol](contracts/ExperimentalOrderAmendments.sol) | Combined coordination/order execution experiment |
| [contracts/test/Fixtures.sol](contracts/test/Fixtures.sol) | Disposable token and contract-wallet fixtures |
| [src/profile.mjs](src/profile.mjs) | ethers encoding helpers |
| [vectors/order-amendment-v1.json](vectors/order-amendment-v1.json) | Fixed bytes, hashes and signatures |
| [test/profile-evm.test.mjs](test/profile-evm.test.mjs) | Local EVM integration tests |
| [test/settlement-evm.test.mjs](test/settlement-evm.test.mjs) | Payout, cancellation and refund integration tests |
| [test/spend-grants-evm.test.mjs](test/spend-grants-evm.test.mjs) | Upstream ERC-8427 integration cases |
| [scripts/demo-evm.mjs](scripts/demo-evm.mjs) | Runnable local workflow with saved evidence |
| [scripts/local-evm.mjs](scripts/local-evm.mjs) | Shared disposable-chain launcher for tests and demo |
| [test/profile-vectors.test.mjs](test/profile-vectors.test.mjs) | Independent viem ABI/type declarations |
| [src/protocol.mjs](src/protocol.mjs) | Earlier JavaScript state-machine model, with a different signature domain |

The original `protocol.mjs` signatures are **not** ERC-8001 signatures. The model remains as a regression baseline; the new profile has its own encoder and executor.

## Open work

1. Review the profile's order-level invalidation and consumed-on-failure execution policy.
2. Have another developer independently encode and apply the published workflow.
3. Define persistent revision-history access, review deadlines, disputed-delivery resolution and cooperative active-order cancellation. The demo's minimal settlement fixture does not resolve these production requirements: submitted work can remain locked if the buyer does not accept.
4. Explore an ERC-8312 reservation-aware shared-budget adapter; it is not implemented here.
5. Validate a Finch staging adapter against actual backend and runtime behavior. This repository is not a production Finch integration or endorsement.

The first implementation follows the canonical ERC-8001 domain `ERC-8001` / `1` and strict expiry checks. It is a separate implementation, not a claim that the linked upstream reference contract already supplies this order behavior. Profile-specific constraints are in [PROFILE.md](PROFILE.md).

## Contributing

Use English for public-facing documentation, examples and discussion updates.

Issues and small PRs with a concrete workflow, counterexample or independently computed vector are welcome. Include the base order, signed payload, expected outcome and reproducible steps. The discussion's scope poll is advisory; it does not assign an ERC number or approve a standard.

MIT licensed. Dependencies retain their own licenses. The `tmp` override pins a patched compiler-tooling dependency; versions and integrity hashes are in `package-lock.json`.
