// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

/// @title OutcomeRegistry
/// @notice Anchors the immutable commitments behind one finalized AgentClear job outcome.
/// @dev Identity strings and evidence stay off-chain; only their commitments are recorded here.
contract OutcomeRegistry is AccessControlDefaultAdminRules {
    bytes32 public constant OUTCOME_WRITER_ROLE = keccak256("OUTCOME_WRITER_ROLE");

    enum Outcome {
        NONE,
        PASS,
        FAIL
    }

    struct OutcomeRecord {
        bytes32 agreementHash;
        bytes32 submissionHash;
        bytes32 verificationReportHash;
        bytes32 buyerIdentityHash;
        bytes32 providerIdentityHash;
        Outcome outcome;
        uint64 finalizedAt;
    }

    error InvalidAddress();
    error InvalidHash();
    error InvalidJobId();
    error InvalidOutcome();
    error OutcomeAlreadyRecorded(bytes32 jobId);

    event OutcomeRecorded(
        bytes32 indexed jobId,
        bytes32 indexed agreementHash,
        bytes32 indexed submissionHash,
        bytes32 verificationReportHash,
        bytes32 buyerIdentityHash,
        bytes32 providerIdentityHash,
        Outcome outcome,
        uint64 finalizedAt
    );

    mapping(bytes32 jobId => OutcomeRecord record) public outcomes;

    constructor(address initialAdmin, uint48 adminTransferDelay, address outcomeWriter)
        AccessControlDefaultAdminRules(adminTransferDelay, initialAdmin)
    {
        if (outcomeWriter == address(0)) revert InvalidAddress();
        _grantRole(OUTCOME_WRITER_ROLE, outcomeWriter);
    }

    /// @notice Records all commitments for one final PASS or FAIL exactly once.
    function recordOutcome(
        bytes32 jobId,
        bytes32 agreementHash,
        bytes32 submissionHash,
        bytes32 verificationReportHash,
        bytes32 buyerIdentityHash,
        bytes32 providerIdentityHash,
        Outcome outcome
    ) external onlyRole(OUTCOME_WRITER_ROLE) {
        if (jobId == bytes32(0)) revert InvalidJobId();
        if (
            agreementHash == bytes32(0) || submissionHash == bytes32(0)
                || verificationReportHash == bytes32(0) || buyerIdentityHash == bytes32(0)
                || providerIdentityHash == bytes32(0)
        ) {
            revert InvalidHash();
        }
        if (outcome != Outcome.PASS && outcome != Outcome.FAIL) revert InvalidOutcome();
        if (outcomes[jobId].outcome != Outcome.NONE) revert OutcomeAlreadyRecorded(jobId);

        uint64 finalizedAt = uint64(block.timestamp);
        outcomes[jobId] = OutcomeRecord({
            agreementHash: agreementHash,
            submissionHash: submissionHash,
            verificationReportHash: verificationReportHash,
            buyerIdentityHash: buyerIdentityHash,
            providerIdentityHash: providerIdentityHash,
            outcome: outcome,
            finalizedAt: finalizedAt
        });
        emit OutcomeRecorded(
            jobId,
            agreementHash,
            submissionHash,
            verificationReportHash,
            buyerIdentityHash,
            providerIdentityHash,
            outcome,
            finalizedAt
        );
    }
}
