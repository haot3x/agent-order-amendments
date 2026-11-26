# ERC-8448 submission snapshot

This directory preserves the order-amendment profile over ERC-8001 submitted in [ethereum/ERCs PR #2082](https://github.com/ethereum/ERCs/pull/2082). The PR merged on 25 November 2026 after editor review by @jochem-brouwer. [ERC-8448 in the official repository](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-8448.md) is the authoritative specification, currently Draft, not Final.

- [Proposed specification](ERCS/erc-8448.md)
- [Deterministic vector](assets/erc-8448/order-amendment-v1.json)

The layout mirrors the destination repository: a template document under `ERCS/`, local assets, and the official CC0 license. The document includes `eip: 8448`; its filename and asset directory use the assigned number. The document's `../assets/eip-8448/` link follows the destination website build, which renames `erc-` asset directories to `eip-`. The canonical document now has `status: Draft`. Future specification changes should target the official repository.

## Review focus

1. Review the required `getAmendmentState(orderId)` ABI, unknown-order error and eligibility semantics together with the canonical amendment payload and required events. The amendment format does not itself standardize order creation, delivery or settlement APIs.
2. Review consumed-on-failure execution and permissionless execution as an explicit liveness tradeoff. No fresh-consent retry guarantee should depend on an ERC-8427 grant update alone.
3. Verify every normative rule against the existing implementation and vectors. A breaking change needs a new profile identifier rather than a silent change to `ORDER_AMENDMENT_V1`.
4. Continue technical review and interoperability discussion in the existing Magicians topic, which remains the canonical `discussions-to`.

## Validation

On 21 October 2026, all 81 implementation tests passed, including nine new common-view EVM cases, and the local demo passed. The viem client declares the public ABI and signed encoding separately from the implementation, then reads, signs, applies and verifies an amendment. A second read-only fixture checks storage-layout independence; it is not a second complete implementation or external adoption evidence. Regenerating the signed vector produced no changes.

Full EIPW 0.11.0 reports zero diagnostics with the destination lint/modifier configuration, merged proposal references and numbering checks enabled. Markdownlint, Codespell and whitespace checks passed. The merged [official PR](https://github.com/ethereum/ERCs/pull/2082) passed its checks and received editor approval. Implementation PR #7 was also merged with 95 passing tests ([CI](https://github.com/haot3x/agent-order-amendments/actions/runs/45036489260)). The public author is `Ted (@haot3x)`.

The assets use the same vector as `vectors/order-amendment-v1.json`. No executable code changes with this package. The reference code outside this directory remains MIT licensed; this submission text and its data are offered under [CC0](LICENSE.md), as required for an ERC submission.

An independent reproducer would strengthen the proposal, but no fixed forum vote count or blanket two-implementation prerequisite is imposed by EIP-1 for submitting an ERC Draft. A new number and a merged Draft are separate from later Review, Last Call and Final status.

## Official sources

| Source | Raw URL |
| --- | --- |
| Process and required sections | https://eips.ethereum.org/EIPS/eip-1 |
| ERC template | https://github.com/ethereum/ERCs/blob/master/erc-template.md |
| Contribution guidance | https://github.com/ethereum/ERCs/blob/master/.github/CONTRIBUTING.md |
