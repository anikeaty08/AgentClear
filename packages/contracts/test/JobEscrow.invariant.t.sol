// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { JobEscrow } from "../src/JobEscrow.sol";
import { AgentClearTest, InvariantTarget } from "./TestBase.sol";

contract JobEscrowHandler is AgentClearTest {
    uint256 private constant MAX_JOB_AMOUNT = 100 ether;
    uint64 private constant DEADLINE_OFFSET = 7 days;

    JobEscrow public immutable escrow;
    address public immutable buyer;
    address public immutable provider;
    address public immutable feeRecipient;

    bytes32[] private jobIds;

    constructor() {
        buyer = makeAddr("invariant-buyer");
        provider = makeAddr("invariant-provider");
        feeRecipient = makeAddr("invariant-fee-recipient");
        escrow =
            new JobEscrow(address(this), 1 days, address(this), address(this), feeRecipient, 250);
        vm.deal(buyer, 1_000_000 ether);
    }

    function fund(uint256 rawAmount, uint256 salt) external {
        bytes32 jobId = keccak256(abi.encode("job", salt));
        (,,,, JobEscrow.EscrowState state,) = escrow.escrows(jobId);
        if (state != JobEscrow.EscrowState.NONE) return;

        uint256 amount = bound(rawAmount, 1, MAX_JOB_AMOUNT);
        address initialProvider = salt % 2 == 0 ? provider : address(0);
        vm.prank(buyer);
        escrow.fundJob{ value: amount }(
            jobId,
            initialProvider,
            uint64(block.timestamp + DEADLINE_OFFSET),
            keccak256(abi.encode("agreement", salt))
        );
        jobIds.push(jobId);
    }

    function settle(uint256 index) external {
        if (jobIds.length == 0) return;
        bytes32 jobId = jobIds[index % jobIds.length];
        (, address jobProvider,, uint64 deadline, JobEscrow.EscrowState state,) =
            escrow.escrows(jobId);
        // forge-lint: disable-next-line(block-timestamp)
        bool expired = block.timestamp > deadline;
        if (state != JobEscrow.EscrowState.FUNDED || jobProvider == address(0) || expired) return;
        escrow.settle(jobId, keccak256(abi.encode("pass", jobId)));
    }

    function assignProvider(uint256 index) external {
        if (jobIds.length == 0) return;
        bytes32 jobId = jobIds[index % jobIds.length];
        (address jobBuyer, address jobProvider,, uint64 deadline, JobEscrow.EscrowState state,) =
            escrow.escrows(jobId);
        // forge-lint: disable-next-line(block-timestamp)
        bool expired = block.timestamp > deadline;
        if (state != JobEscrow.EscrowState.FUNDED || jobProvider != address(0) || expired) return;
        vm.prank(jobBuyer);
        escrow.assignProvider(jobId, provider);
    }

    function cancelUnassigned(uint256 index) external {
        if (jobIds.length == 0) return;
        bytes32 jobId = jobIds[index % jobIds.length];
        (address jobBuyer, address jobProvider,,, JobEscrow.EscrowState state,) =
            escrow.escrows(jobId);
        if (state != JobEscrow.EscrowState.FUNDED || jobProvider != address(0)) return;
        vm.prank(jobBuyer);
        escrow.cancelUnassigned(jobId);
    }

    function refundFailed(uint256 index) external {
        if (jobIds.length == 0) return;
        bytes32 jobId = jobIds[index % jobIds.length];
        (,,,, JobEscrow.EscrowState state,) = escrow.escrows(jobId);
        if (state != JobEscrow.EscrowState.FUNDED) return;
        escrow.refundFailed(jobId, keccak256(abi.encode("fail", jobId)));
    }

    function openDispute(uint256 index) external {
        if (jobIds.length == 0) return;
        bytes32 jobId = jobIds[index % jobIds.length];
        (, address jobProvider,, uint64 deadline, JobEscrow.EscrowState state,) =
            escrow.escrows(jobId);
        // forge-lint: disable-next-line(block-timestamp)
        bool expired = block.timestamp > deadline;
        if (state != JobEscrow.EscrowState.FUNDED || jobProvider == address(0) || expired) return;
        escrow.openDispute(jobId, keccak256(abi.encode("evidence", jobId)));
    }

    function resolveDispute(uint256 index, bool releaseToProvider) external {
        if (jobIds.length == 0) return;
        bytes32 jobId = jobIds[index % jobIds.length];
        (,,,, JobEscrow.EscrowState state,) = escrow.escrows(jobId);
        if (state != JobEscrow.EscrowState.DISPUTED) return;
        escrow.resolveDispute(
            jobId, releaseToProvider, keccak256(abi.encode("resolution", jobId, releaseToProvider))
        );
    }

    function expireAndRefund(uint256 index) external {
        if (jobIds.length == 0) return;
        bytes32 jobId = jobIds[index % jobIds.length];
        (,,, uint64 deadline, JobEscrow.EscrowState state,) = escrow.escrows(jobId);
        if (state != JobEscrow.EscrowState.FUNDED) return;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= deadline) vm.warp(uint256(deadline) + 1);
        escrow.refundExpired(jobId);
    }

    function withdrawBuyer() external {
        _withdrawIfAvailable(buyer);
    }

    function withdrawProvider() external {
        _withdrawIfAvailable(provider);
    }

    function withdrawFee() external {
        _withdrawIfAvailable(feeRecipient);
    }

    function jobCount() external view returns (uint256) {
        return jobIds.length;
    }

    function jobIdAt(uint256 index) external view returns (bytes32) {
        return jobIds[index];
    }

    function _withdrawIfAvailable(address account) private {
        if (escrow.pendingWithdrawals(account) == 0) return;
        vm.prank(account);
        escrow.withdraw(payable(account));
    }
}

contract JobEscrowInvariantTest is InvariantTarget, AgentClearTest {
    JobEscrowHandler private handler;
    JobEscrow private escrow;

    function setUp() public {
        handler = new JobEscrowHandler();
        escrow = handler.escrow();
        targetContract(address(handler));
    }

    function invariantNativeBalanceAlwaysCoversAllLiabilities() public view {
        assertGe(address(escrow).balance, escrow.totalLiability());
    }

    function invariantTrackedLiabilityMatchesJobsAndCredits() public view {
        uint256 expectedLiability = escrow.pendingWithdrawals(handler.buyer())
            + escrow.pendingWithdrawals(handler.provider())
            + escrow.pendingWithdrawals(handler.feeRecipient());

        uint256 count = handler.jobCount();
        for (uint256 index; index < count; ++index) {
            (,, uint128 amount,, JobEscrow.EscrowState state,) =
                escrow.escrows(handler.jobIdAt(index));
            if (state == JobEscrow.EscrowState.FUNDED || state == JobEscrow.EscrowState.DISPUTED) {
                expectedLiability += amount;
            }
        }

        assertEq(escrow.totalLiability(), expectedLiability);
        assertEq(address(escrow).balance, expectedLiability);
    }
}
