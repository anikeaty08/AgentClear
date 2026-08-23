// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { JobEscrow } from "../src/JobEscrow.sol";
import { AgentClearTest } from "./TestBase.sol";

contract ReentrantRecipient {
    JobEscrow private immutable escrow;

    bool public reentryBlocked;

    constructor(JobEscrow escrow_) {
        escrow = escrow_;
    }

    function withdraw() external {
        escrow.withdraw(payable(address(this)));
    }

    receive() external payable {
        try escrow.withdraw(payable(address(this))) { }
        catch (bytes memory reason) {
            reentryBlocked = keccak256(reason)
                == keccak256(
                    abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
                );
        }
    }
}

contract JobEscrowTest is AgentClearTest {
    uint16 private constant FEE_BPS = 250;
    uint256 private constant AMOUNT = 2 ether;
    uint64 private constant DEADLINE_OFFSET = 2 days;

    bytes32 private constant JOB_ID = keccak256("job_01");
    bytes32 private constant AGREEMENT_HASH = keccak256("agreement");
    bytes32 private constant VERIFICATION_HASH = keccak256("verification");
    bytes32 private constant EVIDENCE_HASH = keccak256("evidence");

    address private admin = makeAddr("admin");
    address private settlementAuthority = makeAddr("settlement-authority");
    address private disputeAuthority = makeAddr("dispute-authority");
    address private buyer = makeAddr("buyer");
    address private provider = makeAddr("provider");
    address private feeRecipient = makeAddr("fee-recipient");

    JobEscrow private escrow;

    function setUp() public {
        escrow = new JobEscrow(
            admin, 2 days, settlementAuthority, disputeAuthority, feeRecipient, FEE_BPS
        );
        vm.deal(buyer, 100 ether);
    }

    function testConstructorConfiguresSeparatedRoles() public view {
        assertEq(escrow.defaultAdmin(), admin);
        assertTrue(escrow.hasRole(escrow.SETTLEMENT_ROLE(), settlementAuthority));
        assertTrue(escrow.hasRole(escrow.DISPUTE_ROLE(), disputeAuthority));
        assertFalse(escrow.hasRole(escrow.SETTLEMENT_ROLE(), provider));
        assertEq(escrow.feeRecipient(), feeRecipient);
        assertEq(escrow.protocolFeeBps(), FEE_BPS);
    }

    function testConstructorRejectsInvalidConfig() public {
        uint16 invalidFeeBps = escrow.MAX_PROTOCOL_FEE_BPS() + 1;

        vm.expectRevert(JobEscrow.InvalidAddress.selector);
        new JobEscrow(admin, 2 days, address(0), disputeAuthority, feeRecipient, FEE_BPS);

        vm.expectRevert(
            abi.encodeWithSelector(JobEscrow.InvalidProtocolFee.selector, invalidFeeBps)
        );
        new JobEscrow(
            admin, 2 days, settlementAuthority, disputeAuthority, feeRecipient, invalidFeeBps
        );
    }

    function testFundsJobAndTracksLiability() public {
        uint64 deadline = _fund(JOB_ID, provider, AMOUNT);

        (
            address storedBuyer,
            address storedProvider,
            uint128 amount,
            uint64 storedDeadline,
            JobEscrow.EscrowState state,
            bytes32 storedAgreementHash
        ) = escrow.escrows(JOB_ID);

        assertEq(storedBuyer, buyer);
        assertEq(storedProvider, provider);
        assertEq(amount, AMOUNT);
        assertEq(storedDeadline, deadline);
        assertEq(uint8(state), uint8(JobEscrow.EscrowState.FUNDED));
        assertEq(storedAgreementHash, AGREEMENT_HASH);
        assertEq(escrow.totalEscrowed(), AMOUNT);
        assertEq(escrow.totalLiability(), AMOUNT);
        assertEq(address(escrow).balance, AMOUNT);
    }

    function testFundsOpenJobThenBuyerAssignsProviderOnce() public {
        uint64 deadline = _fund(JOB_ID, address(0), AMOUNT);

        vm.prank(buyer);
        escrow.assignProvider(JOB_ID, provider);

        (, address storedProvider,,, JobEscrow.EscrowState state,) = escrow.escrows(JOB_ID);
        assertEq(storedProvider, provider);
        assertEq(uint8(state), uint8(JobEscrow.EscrowState.FUNDED));

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(JobEscrow.ProviderAlreadyAssigned.selector, JOB_ID, provider)
        );
        escrow.assignProvider(JOB_ID, makeAddr("different-provider"));

        vm.warp(uint256(deadline) + 1);
        escrow.refundExpired(JOB_ID);
    }

    function testOnlyBuyerCanAssignProvider() public {
        _fund(JOB_ID, address(0), AMOUNT);

        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.OnlyBuyer.selector, provider, buyer));
        escrow.assignProvider(JOB_ID, provider);
    }

    function testUnassignedJobCannotSettleOrEnterDispute() public {
        _fund(JOB_ID, address(0), AMOUNT);

        vm.prank(settlementAuthority);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.ProviderNotAssigned.selector, JOB_ID));
        escrow.settle(JOB_ID, VERIFICATION_HASH);

        vm.prank(disputeAuthority);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.ProviderNotAssigned.selector, JOB_ID));
        escrow.openDispute(JOB_ID, EVIDENCE_HASH);
    }

    function testBuyerCanCancelOnlyBeforeProviderAssignment() public {
        _fund(JOB_ID, address(0), AMOUNT);

        vm.prank(buyer);
        escrow.cancelUnassigned(JOB_ID);
        assertEq(escrow.pendingWithdrawals(buyer), AMOUNT);
        assertEq(uint8(_state(JOB_ID)), uint8(JobEscrow.EscrowState.REFUNDED));

        bytes32 assignedJobId = keccak256("assigned-job");
        _fund(assignedJobId, provider, AMOUNT);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                JobEscrow.ProviderAlreadyAssigned.selector, assignedJobId, provider
            )
        );
        escrow.cancelUnassigned(assignedJobId);
    }

    function testRejectsInvalidAndDuplicateFunding() public {
        uint64 deadline = uint64(block.timestamp + DEADLINE_OFFSET);

        vm.startPrank(buyer);
        vm.expectRevert(JobEscrow.InvalidJobId.selector);
        escrow.fundJob{ value: AMOUNT }(bytes32(0), provider, deadline, AGREEMENT_HASH);

        vm.expectRevert(JobEscrow.InvalidAddress.selector);
        escrow.fundJob{ value: AMOUNT }(JOB_ID, buyer, deadline, AGREEMENT_HASH);

        vm.expectRevert(
            abi.encodeWithSelector(JobEscrow.InvalidDeadline.selector, uint64(block.timestamp))
        );
        escrow.fundJob{ value: AMOUNT }(JOB_ID, provider, uint64(block.timestamp), AGREEMENT_HASH);

        vm.expectRevert(JobEscrow.InvalidHash.selector);
        escrow.fundJob{ value: AMOUNT }(JOB_ID, provider, deadline, bytes32(0));

        vm.expectRevert(JobEscrow.InvalidAmount.selector);
        escrow.fundJob(JOB_ID, provider, deadline, AGREEMENT_HASH);
        vm.stopPrank();

        _fund(JOB_ID, provider, AMOUNT);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.JobAlreadyExists.selector, JOB_ID));
        escrow.fundJob{ value: AMOUNT }(JOB_ID, provider, deadline, AGREEMENT_HASH);
    }

    function testSettlesOnceAndCreditsPullPayments() public {
        _fund(JOB_ID, provider, AMOUNT);

        vm.prank(settlementAuthority);
        escrow.settle(JOB_ID, VERIFICATION_HASH);

        uint256 fee = AMOUNT * FEE_BPS / escrow.BPS_DENOMINATOR();
        assertEq(escrow.pendingWithdrawals(provider), AMOUNT - fee);
        assertEq(escrow.pendingWithdrawals(feeRecipient), fee);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(escrow.totalPendingWithdrawals(), AMOUNT);
        assertEq(escrow.totalLiability(), AMOUNT);
        assertEq(uint8(_state(JOB_ID)), uint8(JobEscrow.EscrowState.RELEASED));

        vm.prank(settlementAuthority);
        vm.expectRevert(
            abi.encodeWithSelector(
                JobEscrow.InvalidState.selector,
                JOB_ID,
                JobEscrow.EscrowState.FUNDED,
                JobEscrow.EscrowState.RELEASED
            )
        );
        escrow.settle(JOB_ID, VERIFICATION_HASH);
    }

    function testProviderCannotSettleItsOwnJob() public {
        _fund(JOB_ID, provider, AMOUNT);
        bytes32 settlementRole = escrow.SETTLEMENT_ROLE();

        vm.prank(provider);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, provider, settlementRole
            )
        );
        escrow.settle(JOB_ID, VERIFICATION_HASH);
    }

    function testSettlementCannotRacePastExpiry() public {
        uint64 deadline = _fund(JOB_ID, provider, AMOUNT);
        vm.warp(uint256(deadline) + 1);

        vm.prank(settlementAuthority);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.EscrowExpired.selector, JOB_ID, deadline));
        escrow.settle(JOB_ID, VERIFICATION_HASH);

        escrow.refundExpired(JOB_ID);
        assertEq(escrow.pendingWithdrawals(buyer), AMOUNT);
        assertEq(uint8(_state(JOB_ID)), uint8(JobEscrow.EscrowState.REFUNDED));
    }

    function testExpiredRefundRequiresExpiry() public {
        uint64 deadline = _fund(JOB_ID, provider, AMOUNT);

        vm.expectRevert(
            abi.encodeWithSelector(JobEscrow.EscrowNotExpired.selector, JOB_ID, deadline)
        );
        escrow.refundExpired(JOB_ID);
    }

    function testAuthorizedFailureRefundsBuyer() public {
        _fund(JOB_ID, provider, AMOUNT);

        vm.prank(settlementAuthority);
        escrow.refundFailed(JOB_ID, VERIFICATION_HASH);

        assertEq(escrow.pendingWithdrawals(buyer), AMOUNT);
        assertEq(escrow.pendingWithdrawals(provider), 0);
        assertEq(uint8(_state(JOB_ID)), uint8(JobEscrow.EscrowState.REFUNDED));
    }

    function testDisputeFreezesOrdinarySettlementAndCanRelease() public {
        _fund(JOB_ID, provider, AMOUNT);

        vm.prank(disputeAuthority);
        escrow.openDispute(JOB_ID, EVIDENCE_HASH);

        assertEq(uint8(_state(JOB_ID)), uint8(JobEscrow.EscrowState.DISPUTED));
        vm.prank(settlementAuthority);
        vm.expectRevert(
            abi.encodeWithSelector(
                JobEscrow.InvalidState.selector,
                JOB_ID,
                JobEscrow.EscrowState.FUNDED,
                JobEscrow.EscrowState.DISPUTED
            )
        );
        escrow.settle(JOB_ID, VERIFICATION_HASH);

        vm.prank(disputeAuthority);
        escrow.resolveDispute(JOB_ID, true, VERIFICATION_HASH);
        assertEq(uint8(_state(JOB_ID)), uint8(JobEscrow.EscrowState.RELEASED));
        assertGt(escrow.pendingWithdrawals(provider), 0);
    }

    function testDisputeCanRefundAndCannotResolveTwice() public {
        _fund(JOB_ID, provider, AMOUNT);
        vm.prank(disputeAuthority);
        escrow.openDispute(JOB_ID, EVIDENCE_HASH);

        vm.prank(disputeAuthority);
        escrow.resolveDispute(JOB_ID, false, VERIFICATION_HASH);
        assertEq(escrow.pendingWithdrawals(buyer), AMOUNT);

        vm.prank(disputeAuthority);
        vm.expectRevert(
            abi.encodeWithSelector(
                JobEscrow.InvalidState.selector,
                JOB_ID,
                JobEscrow.EscrowState.DISPUTED,
                JobEscrow.EscrowState.REFUNDED
            )
        );
        escrow.resolveDispute(JOB_ID, false, VERIFICATION_HASH);
    }

    function testWithdrawUsesChecksEffectsInteractions() public {
        _fund(JOB_ID, provider, AMOUNT);
        vm.prank(settlementAuthority);
        escrow.settle(JOB_ID, VERIFICATION_HASH);

        uint256 credit = escrow.pendingWithdrawals(provider);
        address payable recipient = payable(makeAddr("recipient"));
        vm.prank(provider);
        escrow.withdraw(recipient);

        assertEq(recipient.balance, credit);
        assertEq(escrow.pendingWithdrawals(provider), 0);
        assertEq(escrow.totalPendingWithdrawals(), AMOUNT - credit);
        assertEq(escrow.totalLiability(), AMOUNT - credit);
        assertEq(address(escrow).balance, AMOUNT - credit);
    }

    function testReentrantWithdrawalIsBlockedWithoutLosingCredit() public {
        ReentrantRecipient attacker = new ReentrantRecipient(escrow);
        _fund(JOB_ID, address(attacker), AMOUNT);
        vm.prank(settlementAuthority);
        escrow.settle(JOB_ID, VERIFICATION_HASH);

        uint256 credit = escrow.pendingWithdrawals(address(attacker));
        attacker.withdraw();

        assertTrue(attacker.reentryBlocked());
        assertEq(address(attacker).balance, credit);
        assertEq(escrow.pendingWithdrawals(address(attacker)), 0);
    }

    function testRejectsDirectNativeTransfers() public {
        vm.deal(address(this), 1 ether);
        (bool sent, bytes memory reason) = address(escrow).call{ value: 1 ether }("");
        assertFalse(sent);
        assertEq(
            keccak256(reason),
            keccak256(abi.encodeWithSelector(JobEscrow.DirectPaymentNotAllowed.selector))
        );
    }

    function testFuzzSettlementPreservesLiability(uint128 rawAmount, uint16 rawFeeBps) public {
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint16 feeBps = uint16(bound(rawFeeBps, 0, escrow.MAX_PROTOCOL_FEE_BPS()));
        JobEscrow fuzzEscrow = new JobEscrow(
            admin, 2 days, settlementAuthority, disputeAuthority, feeRecipient, feeBps
        );
        vm.deal(buyer, amount);
        vm.prank(buyer);
        fuzzEscrow.fundJob{ value: amount }(
            JOB_ID, provider, uint64(block.timestamp + DEADLINE_OFFSET), AGREEMENT_HASH
        );

        vm.prank(settlementAuthority);
        fuzzEscrow.settle(JOB_ID, VERIFICATION_HASH);

        uint256 fee = amount * feeBps / fuzzEscrow.BPS_DENOMINATOR();
        assertEq(fuzzEscrow.pendingWithdrawals(provider), amount - fee);
        assertEq(fuzzEscrow.pendingWithdrawals(feeRecipient), fee);
        assertEq(fuzzEscrow.totalLiability(), amount);
        assertEq(address(fuzzEscrow).balance, amount);
    }

    function testFuzzExpiredRefundPreservesPrincipal(uint128 rawAmount) public {
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        vm.deal(buyer, amount);
        uint64 deadline = _fund(JOB_ID, provider, amount);

        vm.warp(uint256(deadline) + 1);
        escrow.refundExpired(JOB_ID);

        assertEq(escrow.pendingWithdrawals(buyer), amount);
        assertEq(escrow.totalLiability(), amount);
        assertEq(address(escrow).balance, amount);
    }

    function _fund(bytes32 jobId, address jobProvider, uint256 amount)
        private
        returns (uint64 deadline)
    {
        deadline = uint64(block.timestamp + DEADLINE_OFFSET);
        vm.prank(buyer);
        escrow.fundJob{ value: amount }(jobId, jobProvider, deadline, AGREEMENT_HASH);
    }

    function _state(bytes32 jobId) private view returns (JobEscrow.EscrowState state) {
        (,,,, state,) = escrow.escrows(jobId);
    }
}
