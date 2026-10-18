# ERC submission preparation

This directory is a review package for a possible new ERC defining an order-amendment profile over ERC-8001. It has not been submitted to `ethereum/ERCs`, has no assigned number and is not evidence of standards approval.

- [Proposed specification](ERCS/erc-draft_order_amendments.md)
- [Deterministic vector](assets/erc-draft_order_amendments/order-amendment-v1.json)

The layout mirrors the destination repository: a template document under `ERCS/`, local assets, and the official CC0 license. The draft deliberately omits a numeric `eip` header. The current official template requests an abbreviated draft filename; confirm ERC-specific naming with the editors before filing. This package's `status: Draft` is the requested initial status, not a status already granted by an editor.

## Review before filing

1. Confirm that the profile's application-defined order view, canonical amendment payload and required events are enough for independent clients to interoperate. The amendment format does not itself standardize order creation, delivery or settlement APIs.
2. Review consumed-on-failure execution and permissionless execution as an explicit liveness tradeoff. No fresh-consent retry guarantee should depend on an ERC-8427 grant update alone.
3. Verify every normative rule against the existing implementation and vectors. A breaking change needs a new profile identifier rather than a silent change to `ORDER_AMENDMENT_V1`.
4. Run the destination repository's current EIP/Markdown/link/spelling checks, resolve editor feedback on filename and scope, and open a focused new-proposal PR using the existing Magicians topic as `discussions-to`.

The assets use the same vector as `vectors/order-amendment-v1.json`. No executable code changes with this package. The reference code outside this directory remains MIT licensed; this submission text and its data are offered under [CC0](LICENSE.md), as required for an ERC submission.

An independent reproducer would strengthen the proposal, but no fixed forum vote count or blanket two-implementation prerequisite is imposed by EIP-1 for submitting an ERC Draft. A new number and a merged Draft are separate from later Review, Last Call and Final status.

## Official sources

| Source | Raw URL |
| --- | --- |
| Process and required sections | https://eips.ethereum.org/EIPS/eip-1 |
| ERC template | https://github.com/ethereum/ERCs/blob/master/erc-template.md |
| Contribution guidance | https://github.com/ethereum/ERCs/blob/master/.github/CONTRIBUTING.md |
