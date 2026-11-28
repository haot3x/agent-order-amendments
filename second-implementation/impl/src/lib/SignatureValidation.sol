// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.30;

/// Signature validation written from the EIP-712 / ERC-1271 / ERC-2098 texts.
///
/// - Accounts without code: ECDSA, either 65-byte `r || s || v` (v in {27, 28}) or
///   64-byte ERC-2098 `r || yParityAndS`. `s` must be in the lower half of the curve order.
/// - Accounts with code: ERC-1271 `isValidSignature(bytes32,bytes)` through STATICCALL only.
library SignatureValidation {
    /// secp256k1n / 2
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    /// bytes4(keccak256("isValidSignature(bytes32,bytes)"))
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;

    function isValid(address signer, bytes32 digest, bytes calldata signature) internal view returns (bool) {
        if (signer == address(0)) return false;
        if (signer.code.length == 0) {
            return recover(digest, signature) == signer;
        }
        return _isValidERC1271(signer, digest, signature);
    }

    /// Returns address(0) for any malformed, high-s or unrecoverable signature.
    function recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        if (signature.length == 65) {
            r = bytes32(signature[0:32]);
            s = bytes32(signature[32:64]);
            v = uint8(signature[64]);
        } else if (signature.length == 64) {
            r = bytes32(signature[0:32]);
            uint256 vs = uint256(bytes32(signature[32:64]));
            s = bytes32(vs & ((uint256(1) << 255) - 1));
            v = uint8(vs >> 255) + 27;
        } else {
            return address(0);
        }
        if (uint256(s) > HALF_N) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }

    function _isValidERC1271(address signer, bytes32 digest, bytes calldata signature) private view returns (bool) {
        bytes memory callData = abi.encodeWithSelector(ERC1271_MAGIC, digest, signature);
        bool ok;
        uint256 returnSize;
        bytes32 word;
        assembly ("memory-safe") {
            // Only the first return word is copied, so oversized return data cannot be used to burn gas here.
            ok := staticcall(gas(), signer, add(callData, 0x20), mload(callData), 0x00, 0x20)
            returnSize := returndatasize()
            word := mload(0x00)
        }
        return ok && returnSize >= 32 && word == bytes32(ERC1271_MAGIC);
    }
}
