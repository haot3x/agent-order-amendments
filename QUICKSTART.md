# Reproduce ERC-8448 in five minutes

Author: Ted (@haot3x)

Run a local order amendment from a common state read through both signatures, supplemental funding and revision activation. Then run the delivery and payment demo. Allow roughly five minutes with Git and Node.js 24 already installed; the first dependency download can take longer.

This is a reproduction of the project's experimental implementation. ERC-8448's [Draft submission](https://github.com/ethereum/ERCs/pull/2082) is awaiting editor approval and merge. A successful run is useful external reproduction evidence, but does not establish a second implementation, an audit or standards approval.

## 1. Get the tested implementation

Use macOS or Linux, Git and Node.js 24. No wallet, RPC URL, global Foundry installation or private key is needed. Run in a directory without an existing `agent-order-amendments` folder:

```sh
git clone https://github.com/haot3x/agent-order-amendments.git
cd agent-order-amendments
git checkout --detach 6d58faba27a32e802f11c4919cfd9682489976ba
npm ci --ignore-scripts
```

The commit pins the executable code used below; later documentation changes may live on a newer commit. Dependencies, including Anvil and the Solidity compilers, are pinned in the lockfile. Each command below creates and stops its own disposable chain on a random `127.0.0.1` port. All accounts and tokens are local test fixtures.

## 2. Check the shared read and amendment flow

```sh
npm run test:state
```

Expected: **9 tests pass, 0 fail**, and the command exits successfully. In the successful workflow, a viem client reads `getAmendmentState(orderId)`, constructs the amendment from that state, signs an intent and both parties' explicit acceptances, and submits execution through a third account.

| Check | Before application | After application |
| --- | --- | --- |
| Revision | `0` | `1` |
| Amendment nonce | `0` | `1` |
| Total price / contract token balance | `100` | `180` |
| Supplemental transfer | — | `80` |
| Terms commitment | Original terms | Matches the complete replacement terms |
| Execution evidence | — | `CoordinationExecuted.success == true` and `OrderAmendmentApplied` |

These test amounts are **integer token base units**. The lifecycle demo below uses 18-decimal TEST instead. The test also advances beyond the original deadline and confirms that the extended deadline governs eligibility.

The same command checks unknown orders, ineligible orders, deadline equality, nonce invalidation, failed funding, block-pinned reads and a different storage layout. The failed-funding case expects `success == false`, unchanged amendment state and a balance of `100`; that expected rejection is a passing test. An eligible read does not reserve money or guarantee execution.

To inspect the actual client boundary, start with [the viem client](examples/independent-client.mjs) and [its executable workflow](test/amendment-state-evm.test.mjs). The client declares its read ABI, encoding and typed data separately from the compiler ABI and ethers helpers. Deployment and transaction submission still use this project's test harness. The alternate storage fixture only implements the read surface.

## 3. Run the visible order lifecycle

```sh
npm run demo
```

Read the numbered terminal checkpoints:

| Checkpoint | Expected result |
| --- | --- |
| `1. Buyer funds the order` | Offered, revision `0`, escrow `100.0 TEST` |
| `3. Both agreed; amendment is Ready` | Revision still `0`, escrow still `100.0 TEST` |
| `4. Supplement funded; new version is effective` | Revision `1`, escrow `180.0 TEST` |
| `5. Work submitted; payment awaits buyer review` | Submitted, escrow still `180.0 TEST` |
| `6. Buyer accepted and provider was paid` | Accepted, escrow `0.0 TEST`, provider balance `180.0 TEST` |
| `7` and `8`: cancellation and expiry examples | Each refund returns to its recorded buyer |

The final summary should say:

```text
PASS: provider received 180 TEST once; both refunds returned to buyer; escrow balance is zero.
```

Final balances are buyer `820.0 TEST`, provider `180.0 TEST`, contract `0.0 TEST`. Inspect `artifacts/local-order-demo/receipt.json` for checkpoints and decoded transaction events, and `signed-amendment.json` for the signed payload and acceptances. Scope, criteria and delivery documents are saved alongside them. Each run overwrites this ignored artifact directory; copy it elsewhere first if retaining a previous run.

This lifecycle demo uses the project's ethers helper path. Step 2 exercises the separately declared viem client and the common getter. The demo's acceptance and refund operations are application fixtures around the amendment profile; its synthetic report checks do not verify real research quality. Submitted work has no automatic resolution if the buyer remains silent. See [DEMO.md](DEMO.md) for those settlement boundaries.

## Share one useful result

Open a [reproduction issue](https://github.com/haot3x/agent-order-amendments/issues/new) or add a concise result to the [ERC-8448 discussion](https://ethereum-magicians.org/t/erc-8448-agent-service-order-amendments/29936). One report is enough. Copy this template:

```text
Commit: 6d58faba27a32e802f11c4919cfd9682489976ba
OS / architecture:
Node / npm versions:
test:state: __ passed, __ failed
demo: PASS / FAIL
Observed revision / supplemental amount / final balances:
Failure or unexpected result, if any (command and relevant output):
Reproduction only, or independently written client/implementation:
```

Use `git rev-parse HEAD`, `node --version` and `npm --version` to capture the versions. If a command fails, retain its output and report that step before drawing conclusions about the protocol. Installation or Anvil startup failures may occur before any contract assertion runs.

For a deeper contribution, write your own client from the [common-view specification](submission/ERCS/erc-8448.md#amendment-state-view), compare against the [fixed vector](vectors/order-amendment-v1.json), and share the client or a concrete failing case. Running these commands alone does not count as an independently written client.

Optional full regression run:

```sh
npm test
```

At the pinned implementation, the expected total is **81 passing tests**.

Maintainer verification, 27 October 2026: a fresh checkout on macOS arm64 with Node.js 24.15.0 and npm 11.12.1 passed installation, all nine state-view cases and the lifecycle demo. This record is not an external reproduction report.
