// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface Vm {
    function addr(uint256 privateKey) external pure returns (address);
    function deal(address account, uint256 newBalance) external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
    function label(address account, string calldata newLabel) external;
    function prank(address msgSender) external;
    function startPrank(address msgSender) external;
    function stopPrank() external;
    function warp(uint256 newTimestamp) external;
}

abstract contract AgentClearTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function makeAddr(string memory name) internal returns (address account) {
        account = vm.addr(uint256(keccak256(bytes(name))));
        vm.label(account, name);
    }

    function bound(uint256 value, uint256 minimum, uint256 maximum)
        internal
        pure
        returns (uint256)
    {
        require(minimum <= maximum, "bound: invalid range");
        if (value >= minimum && value <= maximum) return value;
        return minimum + (value % (maximum - minimum + 1));
    }

    function assertTrue(bool value) internal pure {
        require(value, "assertTrue failed");
    }

    function assertFalse(bool value) internal pure {
        require(!value, "assertFalse failed");
    }

    function assertEq(uint256 left, uint256 right) internal pure {
        require(left == right, "assertEq(uint256) failed");
    }

    function assertEq(address left, address right) internal pure {
        require(left == right, "assertEq(address) failed");
    }

    function assertEq(bytes32 left, bytes32 right) internal pure {
        require(left == right, "assertEq(bytes32) failed");
    }

    function assertGt(uint256 left, uint256 right) internal pure {
        require(left > right, "assertGt failed");
    }

    function assertGe(uint256 left, uint256 right) internal pure {
        require(left >= right, "assertGe failed");
    }
}

abstract contract InvariantTarget {
    address[] private invariantTargets;

    function targetContract(address target) internal {
        invariantTargets.push(target);
    }

    function targetContracts() external view returns (address[] memory) {
        return invariantTargets;
    }
}
