# ERC-8448 second implementation and cross-implementation tests

Author: Ted (@haot3x)

[ERC-8448](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-8448.md) (Agent Service Order Amendments) is a Draft.
This directory holds a second implementation written only from the published text, and tests that drive it and the
[reference implementation](../contracts/ExperimentalOrderAmendments.sol) at the repository root with one client that
knows nothing but the specification.

## What is here

| Path | Content |
| --- | --- |
| `spec/` | The three pinned inputs: ERC-8448, ERC-8001 and the published vector |
| `impl/` | The second implementation: Solidity 0.8.30, Foundry, no third-party contract libraries, 176 tests |
| `impl/SPEC-NOTES.md` | Every place the text had to be interpreted while implementing it |
| `interop/` | A spec-level client, 22 scenarios run against both implementations, 21 tests |
| `INTEROP.md` | Results, and what they say about each open point in the spec notes |

## Result

Across 22 scenarios the two implementations agree on every observation except one: the bytes of `result` when an
application fails, which the specification leaves undefined. The published vector's real signatures apply through
the real entry points of both, on a live local chain. Details are in [INTEROP.md](INTEROP.md).

## How the second implementation was kept independent

It was written by an AI coding agent in a fresh context whose only inputs were the three files in `spec/`. It was
instructed not to read the reference repository or any other ERC-8448 code, and not to use OpenZeppelin, so signature
recovery, EIP-712 hashing, ERC-1271 validation and the reentrancy guard are written from scratch. The reference uses
OpenZeppelin, solc-js and ethers; this one uses Foundry. It was developed outside this repository and moved here
afterwards, so that the cross-implementation tests build both from one commit.

That is weaker than a second team. Both implementations were commissioned by the specification's author, the same
person wrote the cross-implementation tests, and an agent's isolation is an instruction it reported following, not
something an outsider can audit. Treat this as a reproducible starting point for an outside implementation, not as a
substitute for one.

## Reproduce

Requires Foundry 1.7.1 and Node.js 22 or later. From the repository root:

```sh
npm ci --ignore-scripts
git clone --depth 1 --branch v1.17.0 https://github.com/foundry-rs/forge-std second-implementation/impl/lib/forge-std
(cd second-implementation/impl && forge build && forge test)   # 176 tests
npm run test:interop                                           # 21 tests, needs the build above
```

The reference implementation is compiled from this repository's own sources at the same commit. `npm run observe:interop`
writes the raw observations of both implementations to `second-implementation/interop/observations.json`.

## Limits

- Local Anvil chain and a disposable token only. Nothing here was deployed or audited.
- The scenarios cover the specification's test table and the points in the spec notes that can be observed from
  outside. They do not cover EIP-7702 accounts, gas-limited execution or tokens beyond the one misbehaving case.
- Order creation, submission and settlement are application-defined by the specification, so each implementation has
  its own; the tests reach them through a small per-implementation adapter and use only the standardized surface after
  that.

Code is under the repository's MIT license. The files in `spec/` are CC0-1.0 copies from ethereum/ERCs.
