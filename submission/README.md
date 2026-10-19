# ERC submission preparation

This directory contains the proposed order-amendment profile over ERC-8001, submitted for editor review in [ethereum/ERCs PR 2082](https://github.com/ethereum/ERCs/pull/2082). Editor/associate @abcoathup assigned ERC-8448 on 19 October 2026. The official PR is still awaiting editor approval and merge; numbering is not standards approval.

- [Proposed specification](ERCS/erc-8448.md)
- [Deterministic vector](assets/erc-8448/order-amendment-v1.json)

The layout mirrors the destination repository: a template document under `ERCS/`, local assets, and the official CC0 license. The document includes `eip: 8448`; its filename and asset directory use the assigned number. The document's `../assets/eip-8448/` link follows the destination website build, which renames `erc-` asset directories to `eip-`. This package's `status: Draft` is the requested initial status, not a status already granted by an editor.

## Review focus

1. Confirm that the profile's application-defined order view, canonical amendment payload and required events are enough for independent clients to interoperate. The amendment format does not itself standardize order creation, delivery or settlement APIs.
2. Review consumed-on-failure execution and permissionless execution as an explicit liveness tradeoff. No fresh-consent retry guarantee should depend on an ERC-8427 grant update alone.
3. Verify every normative rule against the existing implementation and vectors. A breaking change needs a new profile identifier rather than a silent change to `ORDER_AMENDMENT_V1`.
4. Address editor feedback on filename, numbering, scope and conformance. The official PR uses the existing Magicians topic as `discussions-to`.

## Validation

The 72 existing implementation tests passed again on 19 October 2026; no runtime code changed. The submitted vector is identical to the existing vector. Markdownlint and Codespell passed using the destination repository's configuration and whitelist. After applying the assigned number, full EIPW 0.11.0 reports zero diagnostics using the destination lint/modifier configuration and merged proposal references, with all numbering checks enabled. The rendered asset link was also corrected for the destination website layout. Official CI is running again on the updated submission. The official repository's complete CI and editor review are separate from these local results.

The assets use the same vector as `vectors/order-amendment-v1.json`. No executable code changes with this package. The reference code outside this directory remains MIT licensed; this submission text and its data are offered under [CC0](LICENSE.md), as required for an ERC submission.

An independent reproducer would strengthen the proposal, but no fixed forum vote count or blanket two-implementation prerequisite is imposed by EIP-1 for submitting an ERC Draft. A new number and a merged Draft are separate from later Review, Last Call and Final status.

## Official sources

| Source | Raw URL |
| --- | --- |
| Process and required sections | https://eips.ethereum.org/EIPS/eip-1 |
| ERC template | https://github.com/ethereum/ERCs/blob/master/erc-template.md |
| Contribution guidance | https://github.com/ethereum/ERCs/blob/master/.github/CONTRIBUTING.md |
