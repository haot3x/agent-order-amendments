// SPDX-License-Identifier: CC0-1.0
pragma solidity 0.8.30;

import {AgentOrderAmendments} from "../../src/AgentOrderAmendments.sol";
import {SignatureValidation} from "../../src/lib/SignatureValidation.sol";
import {Status} from "../../src/interfaces/IERC8001.sol";

/// The real contract plus test-only storage setters. Used to reach states that the public entry
/// points make unreachable (counter overflow, a Ready coordination whose payload skipped the
/// proposal-time profile checks).
contract Harness is AgentOrderAmendments {
    function h_setRevision(bytes32 orderId, uint64 revision) external {
        _orders[orderId].revision = revision;
    }

    function h_setAmendmentNonce(bytes32 orderId, uint256 nonce) external {
        _orders[orderId].amendmentNonce = nonce;
    }

    function h_forceReady(bytes32 intentHash, address proposer, uint64 expiry, bytes32 payloadHash, address[] calldata ps)
        external
    {
        Coordination storage c = _coordinations[intentHash];
        c.status = Status.Ready;
        c.proposer = proposer;
        c.expiry = expiry;
        c.payloadHash = payloadHash;
        c.participants = ps;
        for (uint256 i = 0; i < ps.length; ++i) {
            c.acceptanceExpiry[ps[i]] = expiry;
            c.acceptedBy.push(ps[i]);
        }
    }
}

/// Exposes the signature library for direct unit tests.
contract SigHarness {
    function recover(bytes32 digest, bytes calldata signature) external pure returns (address) {
        return SignatureValidation.recover(digest, signature);
    }

    function isValid(address signer, bytes32 digest, bytes calldata signature) external view returns (bool) {
        return SignatureValidation.isValid(signer, digest, signature);
    }
}

/// ERC-20 with switchable misbehaviour.
contract TestToken {
    enum Mode {
        Normal,
        MoveThenFalse, // moves the funds, then returns false
        TrueNoMove, // returns true without moving anything
        Fee, // recipient receives amount - 1
        Revert, // always reverts
        Reenter // calls back into `reenterTarget` before moving funds, then behaves normally
    }

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    Mode public mode;

    address public reenterTarget;
    bytes public reenterData;
    uint256 public reenterCount;
    bool public reenterOk;
    bytes public reenterRet;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function setReenter(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
        mode = Mode.Reenter;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (mode != Mode.TrueNoMove) {
            uint256 a = allowance[from][msg.sender];
            require(a >= amount, "allowance");
            if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        }
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) private returns (bool) {
        Mode m = mode;
        if (m == Mode.Revert) revert("token reverts");
        if (m == Mode.TrueNoMove) return true;
        if (m == Mode.Reenter) {
            reenterCount++;
            (bool ok, bytes memory ret) = reenterTarget.call(reenterData);
            reenterOk = ok;
            reenterRet = ret;
        }
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += (m == Mode.Fee ? amount - 1 : amount);
        emit Transfer(from, to, amount);
        return m != Mode.MoveThenFalse;
    }
}

/// ERC-20 whose transfer functions return no data at all (pre-standard style).
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// Minimal ERC-1271 wallet: valid when the supplied 65-byte ECDSA signature is by `owner`.
contract Wallet1271 {
    enum Mode {
        Valid,
        WrongMagic,
        Revert,
        Write, // tries to write storage, which must fail under STATICCALL
        Empty // returns no data
    }

    address public owner;
    Mode public mode;
    uint256 public counter;

    constructor(address owner_) {
        owner = owner_;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function setOwner(address o) external {
        owner = o;
    }

    function execute(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, "wallet call failed");
        return ret;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external returns (bytes4) {
        Mode m = mode;
        if (m == Mode.Revert) revert("no");
        if (m == Mode.Write) counter++;
        if (m == Mode.Empty) {
            assembly {
                return(0, 0)
            }
        }
        if (m == Mode.WrongMagic) return 0xffffffff;
        if (signature.length != 65) return 0xffffffff;
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        return ecrecover(digest, v, r, s) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
