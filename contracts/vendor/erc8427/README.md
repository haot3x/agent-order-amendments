# Pinned ERC-8427 reference sources

Unmodified CC0-1.0 Solidity sources from:

https://github.com/tankcdr/erc-spend-grants/tree/d70b04cd3f72ea57882a1afd6c6514a02f96e1b1/src

These files implement the registered-grant revision discussed at:

https://ethereum-magicians.org/t/erc-8427-portable-spend-grants/29776/21

`manifest.json` records each original path and SHA-256. The integration compiler verifies these hashes and uses pinned solc 0.8.28, optimizer 200, via-IR, Cancun. Our order fixture is separately compiled with solc 0.8.37 and calls this reference through its ABI. No upstream source or pragma is rewritten.

Only the direct executor path is exercised here. Vendoring these sources does not imply upstream endorsement, a security audit, or a complete conformance test. Their CC0-1.0 licenses remain in force independently of this project's MIT license.
