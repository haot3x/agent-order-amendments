# Common amendment state view

Author: Ted (@haot3x).

ERC-8448 requires `getAmendmentState(bytes32 orderId)` on the combined coordinator/order contract. The [proposed specification](submission/ERCS/erc-8448.md#amendment-state-view) defines its exact ABI. It returns the buyer, provider, immutable payment asset, revision, terms hash, amendment nonce, complete current terms and `eligible` flag in that order.

This addresses [Revinand's interoperability feedback](https://ethereum-magicians.org/t/erc-8448-agent-service-order-amendments/29936/7): clients should not need an application-specific `getOrder` adapter to obtain the amendment base. Creation, submission, settlement and storage remain application-defined. The signed format and fixed vector are unchanged.

## Read semantics

- An unknown order, including an unused zero ID, reverts with `UnknownOrder(orderId)`.
- A known offer or submitted, cancelled or settled order remains readable with `eligible=false`.
- Eligibility requires an effective, unsubmitted, nonterminal agreement and a timestamp strictly before its current deadline. An applied extension changes that deadline.
- Invalidation advances the amendment nonce without changing terms or revision. Successful application advances both nonce and revision.
- Eligibility does not check signatures, proposed terms, allowances, balances or grant capacity. It reserves neither funding nor a nonce. Execution rechecks all applicable conditions.

## Client workflow

The [viem example](examples/independent-client.mjs) declares its ABI and encodings from the specification without importing the Solidity compiler ABI or `src/profile.mjs`. The caller provides an RPC client and the deployed coordinator address and order ID:

```js
import { readAmendmentState, constructAmendment } from './examples/independent-client.mjs';

const blockNumber = await publicClient.getBlockNumber({ cacheTime: 0 });
const state = await readAmendmentState(publicClient, coordinator, orderId, blockNumber);
// Also obtain the chain ID and a fresh ERC-8001 initiator nonce.
const amendment = constructAmendment({
  address: coordinator, chainId, orderId, state, newTerms,
  agentId: buyer, intentNonce, expiry, validUntil, timestamp,
});
```

The helper verifies the returned terms commitment and encodes the signed base revision, terms hash and amendment nonce. `intentNonce` is a fresh ERC-8001 nonce, distinct from the returned order amendment nonce. Signers must review the actual scope and acceptance documents and compare the complete replacement terms before signing.

Sign `amendment.intent` under `amendment.domain` with the exported `INTENT_TYPES`. Propose through ERC-8001, then obtain and submit both parties' explicit `AcceptanceAttestation` signatures using `amendment.acceptance(participant)` and `ACCEPTANCE_TYPES`. After execution, inspect `CoordinationExecuted.success`, `OrderAmendmentApplied` and a new state read; Core `Executed` by itself is not proof of application. A block-pinned read is a consistent snapshot, not an execution guarantee.

The [executable test](test/amendment-state-evm.test.mjs) supplies all inputs, signs with disposable development accounts and runs this full workflow on local Anvil:

```sh
npm ci --ignore-scripts
npm run test:state
```

Nine cases cover the declared ABI, unknown-order error, deadline equality, known ineligible states, block-pinned reads, a successful amendment, stale-nonce failure, funding failure and an alternate read-only storage fixture. The successful case verifies the new terms, revision, nonce, event and supplemental escrow, then checks eligibility against the extended deadline.

All code and tests are maintained in this project. The alternate fixture implements only the read surface; it cannot apply amendments. This is cross-library and storage-layout evidence, not a second complete implementation, independent adopter or external audit.
