// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Disposable test token. Anyone can mint/change behavior. Never use for value.
contract TestToken is ERC20 {
    bool public failAfterTransfer;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackSucceeded;
    constructor() ERC20("Disposable test units", "TEST") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setFailAfterTransfer(bool fail) external { failAfterTransfer = fail; }
    function setCallback(address target, bytes calldata data) external { callbackTarget = target; callbackData = data; }
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        super.transferFrom(from, to, amount);
        if (callbackTarget != address(0)) (callbackSucceeded,) = callbackTarget.call(callbackData);
        return !failAfterTransfer;
    }
}

contract Test1271Wallet {
    address public immutable owner;
    bool public reject;
    constructor(address owner_) { owner = owner_; }
    function setReject(bool value) external { require(msg.sender == owner); reject = value; }
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        if (reject) return 0xffffffff;
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        return err == ECDSA.RecoverError.NoError && recovered == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
    function execute(address target, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == owner, "OWNER");
        (bool ok, bytes memory result) = target.call(data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        return result;
    }
}
