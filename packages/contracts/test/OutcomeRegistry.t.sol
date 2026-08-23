// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { OutcomeRegistry } from "../src/OutcomeRegistry.sol";
import { AgentClearTest } from "./TestBase.sol";

contract OutcomeRegistryTest is AgentClearTest {
    bytes32 private constant JOB_ID = keccak256("job_01");
    bytes32 private constant AGREEMENT_HASH = keccak256("agreement");
    bytes32 private constant SUBMISSION_HASH = keccak256("submission");
    bytes32 private constant REPORT_HASH = keccak256("report");
    bytes32 private constant BUYER_HASH = keccak256("erc8004:16602:123");
    bytes32 private constant PROVIDER_HASH = keccak256("erc8004:16602:456");

    address private admin = makeAddr("admin");
    address private writer = makeAddr("writer");
    OutcomeRegistry private registry;

    function setUp() public {
        registry = new OutcomeRegistry(admin, 2 days, writer);
    }

    function testConstructorSeparatesAdminAndWriter() public view {
        assertEq(registry.defaultAdmin(), admin);
        assertTrue(registry.hasRole(registry.OUTCOME_WRITER_ROLE(), writer));
        assertFalse(registry.hasRole(registry.OUTCOME_WRITER_ROLE(), admin));
    }

    function testRecordsPassingOutcomeExactlyOnce() public {
        vm.warp(1_800_000_000);
        vm.prank(writer);
        registry.recordOutcome(
            JOB_ID,
            AGREEMENT_HASH,
            SUBMISSION_HASH,
            REPORT_HASH,
            BUYER_HASH,
            PROVIDER_HASH,
            OutcomeRegistry.Outcome.PASS
        );

        (
            bytes32 agreementHash,
            bytes32 submissionHash,
            bytes32 reportHash,
            bytes32 buyerHash,
            bytes32 providerHash,
            OutcomeRegistry.Outcome outcome,
            uint64 finalizedAt
        ) = registry.outcomes(JOB_ID);
        assertEq(agreementHash, AGREEMENT_HASH);
        assertEq(submissionHash, SUBMISSION_HASH);
        assertEq(reportHash, REPORT_HASH);
        assertEq(buyerHash, BUYER_HASH);
        assertEq(providerHash, PROVIDER_HASH);
        assertEq(uint8(outcome), uint8(OutcomeRegistry.Outcome.PASS));
        assertEq(finalizedAt, 1_800_000_000);

        vm.prank(writer);
        vm.expectRevert(
            abi.encodeWithSelector(OutcomeRegistry.OutcomeAlreadyRecorded.selector, JOB_ID)
        );
        registry.recordOutcome(
            JOB_ID,
            AGREEMENT_HASH,
            SUBMISSION_HASH,
            REPORT_HASH,
            BUYER_HASH,
            PROVIDER_HASH,
            OutcomeRegistry.Outcome.FAIL
        );
    }

    function testRejectsUnauthorizedWriter() public {
        bytes32 role = registry.OUTCOME_WRITER_ROLE();
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, admin, role
            )
        );
        registry.recordOutcome(
            JOB_ID,
            AGREEMENT_HASH,
            SUBMISSION_HASH,
            REPORT_HASH,
            BUYER_HASH,
            PROVIDER_HASH,
            OutcomeRegistry.Outcome.PASS
        );
    }

    function testRejectsInvalidInputs() public {
        vm.startPrank(writer);
        vm.expectRevert(OutcomeRegistry.InvalidJobId.selector);
        registry.recordOutcome(
            bytes32(0),
            AGREEMENT_HASH,
            SUBMISSION_HASH,
            REPORT_HASH,
            BUYER_HASH,
            PROVIDER_HASH,
            OutcomeRegistry.Outcome.PASS
        );

        vm.expectRevert(OutcomeRegistry.InvalidHash.selector);
        registry.recordOutcome(
            JOB_ID,
            AGREEMENT_HASH,
            bytes32(0),
            REPORT_HASH,
            BUYER_HASH,
            PROVIDER_HASH,
            OutcomeRegistry.Outcome.PASS
        );

        vm.expectRevert(OutcomeRegistry.InvalidOutcome.selector);
        registry.recordOutcome(
            JOB_ID,
            AGREEMENT_HASH,
            SUBMISSION_HASH,
            REPORT_HASH,
            BUYER_HASH,
            PROVIDER_HASH,
            OutcomeRegistry.Outcome.NONE
        );
        vm.stopPrank();
    }

    function testFuzzStoresDistinctCommitments(
        bytes32 jobId,
        bytes32 agreementHash,
        bytes32 submissionHash,
        bytes32 reportHash,
        bytes32 buyerHash,
        bytes32 providerHash,
        bool passes
    ) public {
        jobId = bytes32(uint256(jobId) | 1);
        agreementHash = bytes32(uint256(agreementHash) | 1);
        submissionHash = bytes32(uint256(submissionHash) | 1);
        reportHash = bytes32(uint256(reportHash) | 1);
        buyerHash = bytes32(uint256(buyerHash) | 1);
        providerHash = bytes32(uint256(providerHash) | 1);
        OutcomeRegistry.Outcome expected =
            passes ? OutcomeRegistry.Outcome.PASS : OutcomeRegistry.Outcome.FAIL;
        vm.prank(writer);
        registry.recordOutcome(
            jobId, agreementHash, submissionHash, reportHash, buyerHash, providerHash, expected
        );
        (,,,,, OutcomeRegistry.Outcome stored,) = registry.outcomes(jobId);
        assertEq(uint8(stored), uint8(expected));
    }
}
