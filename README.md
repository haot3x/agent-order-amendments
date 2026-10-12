# Agent Service Order Amendments

Experimental `ORDER_AMENDMENT_V1` profile over [ERC-8001](https://eips.ethereum.org/EIPS/eip-8001): two parties agree to new order terms, and supplemental funding and the new revision take effect together.

**Local test software. No ERC number has been assigned. The Solidity experiment has no withdrawal, refund, dispute or final-payment lifecycle. Use only disposable test tokens on a local chain.** It has not been audited or deployed to a public network.

Discussion: https://ethereum-magicians.org/t/pre-erc-discussion-agent-service-order-amendments/29936

## Run

Node.js 22 or newer; Node.js 24 is used in CI. Anvil is installed as a pinned platform-specific npm dependency. No global Foundry installation, RPC URL or private key is required.

```sh
npm ci --ignore-scripts
npm test
```

The EVM tests compile Solidity 0.8.37 for Cancun, start a disposable Anvil node on a random **127.0.0.1** port, and stop it afterward. They do not fork or send transactions to a public chain. Anvil's default development accounts and the vector's integer keys 1 and 2 are public test fixtures, never production credentials.

```sh
npm run test:evm       # Local Solidity/EVM integration cases
npm run test:vectors   # ethers / viem encoding comparison
npm run compile       # Optional ABI/bytecode output in ignored artifacts/
npm run vectors       # Regenerate the committed deterministic vector
npm run demo          # Original JavaScript-only order experiment
```

## What is implemented

- Canonical signed payload containing the exact order, base revision, base terms hash, amendment nonce, complete replacement terms and validity deadline.
- ERC-8001 intent and explicit acceptance from both order parties, including the initiator; EOA 65-byte / EIP-2098 signatures and an ERC-1271 path.
- An order-level nonce that either party can advance to invalidate pending amendments without cancelling the underlying order.
- A same-transaction execution step: check the authoritative order, collect only the price increase, update the revision and emit `OrderAmendmentApplied`.
- Separate coordination-attempt and order-application outcomes. A failed application leaves order/token state unchanged but consumes that coordination attempt; a retry needs a fresh intent and acceptances.
- Submission bound to a revision, terms hash and result hash; submission freezes further amendments.

For `100 → 180 → 220`, supplements are 80 and 40. Price decreases, deadline shortening and post-submission changes are outside this profile.

## Evidence

Local run on 2026-10-12: **46 tests passed**: 24 local EVM tests, 1 cross-library fixed-vector test and 21 original JavaScript model tests.

EVM cases include competing amendments, buyer/provider invalidation, insufficient balance and allowance, a token that moves funds then reports failure, a reentrant token callback, substituted payloads, expiry equality, compact signatures, and a mock ERC-1271 wallet. Solidity, ethers and independently declared viem encodings agree on the published vector.

This is authored and tested within one project. Cross-library agreement is not an independent adopter, external audit, or exhaustive ERC-8001 conformance certification.

## Files

| File | Purpose |
| --- | --- |
| [PROFILE.md](PROFILE.md) | Experimental wire format, state transitions and failure semantics |
| [contracts/ExperimentalOrderAmendments.sol](contracts/ExperimentalOrderAmendments.sol) | Combined coordination/order execution experiment |
| [contracts/test/Fixtures.sol](contracts/test/Fixtures.sol) | Disposable token and contract-wallet fixtures |
| [src/profile.mjs](src/profile.mjs) | ethers encoding helpers |
| [vectors/order-amendment-v1.json](vectors/order-amendment-v1.json) | Fixed bytes, hashes and signatures |
| [test/profile-evm.test.mjs](test/profile-evm.test.mjs) | Local EVM integration tests |
| [test/profile-vectors.test.mjs](test/profile-vectors.test.mjs) | Independent viem ABI/type declarations |
| [src/protocol.mjs](src/protocol.mjs) | Earlier JavaScript state-machine model, with a different signature domain |

The original `protocol.mjs` signatures are **not** ERC-8001 signatures. The model remains as a regression baseline; the new profile has its own encoder and executor.

## Open work

1. Review the profile's order-level invalidation and consumed-on-failure execution policy.
2. Have another developer independently encode and apply the published workflow.
3. Define persistent revision-history access and a complete settlement/cancellation/refund lifecycle before considering real assets.
4. Explore an ERC-8312 reservation-aware shared-budget adapter; it is not implemented here.
5. Validate a Finch staging adapter against actual backend and runtime behavior. This repository is not a production Finch integration or endorsement.

The first implementation follows the canonical ERC-8001 domain `ERC-8001` / `1` and strict expiry checks. It is a separate implementation, not a claim that the linked upstream reference contract already supplies this order behavior. Profile-specific constraints are in [PROFILE.md](PROFILE.md).

## Contributing

Issues and small PRs with a concrete workflow, counterexample or independently computed vector are welcome. Include the base order, signed payload, expected outcome and reproducible steps. The discussion's scope poll is advisory; it does not assign an ERC number or approve a standard.

MIT licensed. Dependencies retain their own licenses. The `tmp` override pins a patched compiler-tooling dependency; versions and integrity hashes are in `package-lock.json`.
