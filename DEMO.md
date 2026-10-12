# Local order lifecycle demo

[中文说明](DEMO.zh-CN.md)

This demo runs the complete happy path: fund an order for 100, agree to amend the total to 180, collect the additional 80 and activate the new revision, submit a deliverable, then obtain buyer acceptance and pay the provider 180. Two additional examples demonstrate cancellation before activation and an expiry refund when no work has been submitted.

It is a local Solidity/EVM experiment using synthetic data and disposable TEST tokens. It does not call an LLM, connect to the Finch backend, use real funds or deploy to a public network. The settlement operations are an application fixture around the amendment profile, not additions to ERC-8001 Core or a proposed general verification standard.

## Run

From the repository directory, using Node.js 22 or newer:

```sh
npm ci --ignore-scripts
npm run demo
```

The script starts a disposable Anvil chain on a random port bound to `127.0.0.1`, deploys the contracts, mines test transactions, checks the results and shuts the chain down. No wallet setup, private key or RPC configuration is required. Each run uses a fresh local chain and overwrites the previous demo artifacts.

## Order walkthrough

| Step | Action | Order escrow |
| --- | --- | --- |
| Offer | Buyer funds a 100-unit order for three synthetic project records | 100 TEST |
| Activate | Provider accepts the original terms; order becomes Active | 100 TEST |
| Agree amendment | Expand to ten records for a total of 180; both parties explicitly accept; coordination becomes Ready | Still 100 TEST |
| Apply amendment | Collect 80 and activate revision 1 with the new terms in the same transaction | 180 TEST |
| Submit | Provider submits the current revision, terms hash and exact result-file hash | 180 TEST |
| Accept and pay | Buyer checks the file and calls `acceptDelivery`; provider receives 180 | 0 TEST |

The buyer starts with 1,000 TEST. After the successful order, the buyer holds 820 and the provider holds 180. The two additional examples escrow and fully refund 40 and 60 respectively, leaving final balances of buyer 820, provider 180 and contract 0. TEST has 18 decimals; transaction events use integer base units.

## Verification, acceptance and payment

- **Off-chain file checks:** the demo buyer checks the ten agreed project IDs, required fields, correspondence with the local fixture and the complete result-file hash. These are deterministic fixture checks, not proof that real research conclusions are correct.
- **On-chain buyer acceptance:** only the recorded buyer may accept. The supplied revision, terms hash and result hash must exactly match the submitted delivery.
- **On-chain settlement:** acceptance pays that order's full escrow to its recorded provider. A failed transfer rolls back acceptance and escrow changes together, allowing a retry. No successful acceptance state is left behind after a failed payment.

There is no independent reviewer or collective verification committee in this demo. `acceptanceHash` commits to the criteria document; the contract does not interpret or enforce natural-language requirements in that document. A future Finch application could connect its review workflow to these interfaces. This script only demonstrates the connection points.

## Cancellation and refund policy

| Situation | Implemented behavior |
| --- | --- |
| Provider has not activated the offer | Buyer may cancel and receive the full escrow |
| Active order with no delivery, before its deadline | No unilateral early cancellation |
| No delivery at or after the current effective deadline | Anyone may trigger a full refund, including applied supplements, only to the recorded buyer |
| Delivery submitted before the deadline | Expiry cannot bypass that delivery; buyer may still accept after the delivery deadline |
| Buyer is silent or disputes the submitted work | No automatic payment, refund or arbitration path; funds remain escrowed pending an acceptance |

An amended deadline replaces the deadline used for expiry refunds. Terminal orders cannot pay or refund twice, and a pending amendment cannot reactivate them. Review timeouts, dispute resolution and cooperative cancellation of active work remain future application-policy work. This is a material limitation for using anything beyond disposable local test tokens.

## Inspect the evidence

The script writes to the Git-ignored `artifacts/local-order-demo/` directory:

| File | Contents |
| --- | --- |
| `scope-v0.json` / `scope-v1.json` | Original and amended scope documents |
| `criteria-v0.json` / `criteria-v1.json` | Original and amended acceptance criteria |
| `delivery.json` | Deliverable containing ten synthetic project records |
| `signed-amendment.json` | EIP-712 domain, amendment payload and both parties' signatures |
| `receipt.json` | State and balance checkpoints, transaction hashes and decoded events |

Document hashes commit to the exact saved UTF-8 bytes, including indentation and the trailing newline. Transaction hashes belong only to that disposable local chain, which is stopped at completion; they are not public explorer records.

```sh
npm test             # All regression tests
npm run test:evm     # Solidity/EVM tests
npm run demo:model   # Earlier JavaScript-only model
```

A future UI can display three separate facts from this workflow: whether both parties consented to the amendment, whether the buyer accepted the current delivery, and whether funds were actually paid or refunded. Real task integration and a policy for unresolved reviews are still open work.
