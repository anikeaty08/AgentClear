// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title JobEscrow
/// @notice Holds native 0G funds for one provider until an authorized outcome is recorded.
/// @dev Settlement and refunds credit pull-based withdrawals so recipients cannot block finalization.
contract JobEscrow is AccessControlDefaultAdminRules, ReentrancyGuard {
    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MAX_PROTOCOL_FEE_BPS = 2_000;

    bytes32 public constant SETTLEMENT_ROLE = keccak256("SETTLEMENT_ROLE");
    bytes32 public constant DISPUTE_ROLE = keccak256("DISPUTE_ROLE");

    enum EscrowState {
        NONE,
        FUNDED,
        DISPUTED,
        RELEASED,
        REFUNDED
    }

    struct Escrow {
        address buyer;
        address provider;
        uint128 amount;
        uint64 deadline;
        EscrowState state;
        bytes32 agreementHash;
    }

    error AmountTooLarge(uint256 amount);
    error DirectPaymentNotAllowed();
    error EscrowExpired(bytes32 jobId, uint64 deadline);
    error EscrowNotExpired(bytes32 jobId, uint64 deadline);
    error EtherTransferFailed(address recipient, uint256 amount);
    error InvalidAddress();
    error InvalidAmount();
    error InvalidDeadline(uint64 deadline);
    error InvalidHash();
    error InvalidJobId();
    error InvalidProtocolFee(uint16 feeBps);
    error InvalidState(bytes32 jobId, EscrowState expected, EscrowState actual);
    error JobAlreadyExists(bytes32 jobId);
    error NothingToWithdraw(address account);
    error OnlyBuyer(address caller, address buyer);
    error ProviderAlreadyAssigned(bytes32 jobId, address provider);
    error ProviderNotAssigned(bytes32 jobId);

    event DisputeOpened(bytes32 indexed jobId, bytes32 indexed evidenceHash);
    event DisputeResolved(
        bytes32 indexed jobId,
        bool releasedToProvider,
        bytes32 indexed resolutionHash,
        uint256 providerAmount,
        uint256 protocolFee
    );
    event JobFunded(
        bytes32 indexed jobId,
        address indexed buyer,
        address indexed provider,
        uint256 amount,
        uint64 deadline,
        bytes32 agreementHash
    );
    event JobCancelled(bytes32 indexed jobId, address indexed buyer, uint256 amount);
    event ProviderAssigned(bytes32 indexed jobId, address indexed provider);
    event JobRefunded(
        bytes32 indexed jobId,
        address indexed buyer,
        uint256 amount,
        bytes32 indexed verificationHash
    );
    event JobSettled(
        bytes32 indexed jobId,
        address indexed provider,
        uint256 providerAmount,
        uint256 protocolFee,
        bytes32 indexed verificationHash
    );
    event Withdrawal(address indexed account, address indexed recipient, uint256 amount);

    address public immutable feeRecipient;
    uint16 public immutable protocolFeeBps;

    mapping(bytes32 jobId => Escrow escrow) public escrows;
    mapping(address account => uint256 amount) public pendingWithdrawals;

    uint256 public totalEscrowed;
    uint256 public totalPendingWithdrawals;

    constructor(
        address initialAdmin,
        uint48 adminTransferDelay,
        address settlementAuthority,
        address disputeAuthority,
        address initialFeeRecipient,
        uint16 initialProtocolFeeBps
    ) AccessControlDefaultAdminRules(adminTransferDelay, initialAdmin) {
        if (
            settlementAuthority == address(0) || disputeAuthority == address(0)
                || initialFeeRecipient == address(0)
        ) {
            revert InvalidAddress();
        }
        if (initialProtocolFeeBps > MAX_PROTOCOL_FEE_BPS) {
            revert InvalidProtocolFee(initialProtocolFeeBps);
        }

        feeRecipient = initialFeeRecipient;
        protocolFeeBps = initialProtocolFeeBps;
        _grantRole(SETTLEMENT_ROLE, settlementAuthority);
        _grantRole(DISPUTE_ROLE, disputeAuthority);
    }

    /// @notice Creates and funds a native-asset escrow for a single provider.
    function fundJob(bytes32 jobId, address provider, uint64 deadline, bytes32 agreementHash)
        external
        payable
        nonReentrant
    {
        if (jobId == bytes32(0)) revert InvalidJobId();
        if (provider == msg.sender) revert InvalidAddress();
        // Job deadlines are coarse-grained liveness bounds; normal validator timestamp drift is acceptable.
        // forge-lint: disable-next-line(block-timestamp)
        if (deadline <= block.timestamp) revert InvalidDeadline(deadline);
        if (agreementHash == bytes32(0)) revert InvalidHash();
        if (msg.value == 0) revert InvalidAmount();
        if (msg.value > type(uint128).max) revert AmountTooLarge(msg.value);
        if (escrows[jobId].state != EscrowState.NONE) revert JobAlreadyExists(jobId);

        escrows[jobId] = Escrow({
            buyer: msg.sender,
            provider: provider,
            amount: uint128(msg.value),
            deadline: deadline,
            state: EscrowState.FUNDED,
            agreementHash: agreementHash
        });
        totalEscrowed += msg.value;

        emit JobFunded(jobId, msg.sender, provider, msg.value, deadline, agreementHash);
    }

    /// @notice Assigns the provider once when a job was funded without one.
    function assignProvider(bytes32 jobId, address provider) external {
        if (provider == address(0)) revert InvalidAddress();
        Escrow storage escrow = _requireState(jobId, EscrowState.FUNDED);
        if (msg.sender != escrow.buyer) revert OnlyBuyer(msg.sender, escrow.buyer);
        // See the deadline rationale in fundJob.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > escrow.deadline) revert EscrowExpired(jobId, escrow.deadline);
        if (escrow.provider != address(0)) {
            revert ProviderAlreadyAssigned(jobId, escrow.provider);
        }
        if (provider == escrow.buyer) revert InvalidAddress();

        escrow.provider = provider;
        emit ProviderAssigned(jobId, provider);
    }

    /// @notice Cancels and refunds a job that has not yet assigned a provider.
    function cancelUnassigned(bytes32 jobId) external {
        Escrow storage escrow = _requireState(jobId, EscrowState.FUNDED);
        if (msg.sender != escrow.buyer) revert OnlyBuyer(msg.sender, escrow.buyer);
        if (escrow.provider != address(0)) {
            revert ProviderAlreadyAssigned(jobId, escrow.provider);
        }

        uint256 amount = _refund(escrow);
        emit JobCancelled(jobId, escrow.buyer, amount);
    }

    /// @notice Finalizes a passing verification and credits the provider and protocol.
    function settle(bytes32 jobId, bytes32 verificationHash) external onlyRole(SETTLEMENT_ROLE) {
        if (verificationHash == bytes32(0)) revert InvalidHash();
        Escrow storage escrow = _requireState(jobId, EscrowState.FUNDED);
        if (escrow.provider == address(0)) revert ProviderNotAssigned(jobId);
        // See the deadline rationale in fundJob.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > escrow.deadline) revert EscrowExpired(jobId, escrow.deadline);

        (uint256 providerAmount, uint256 fee) = _release(escrow);
        emit JobSettled(jobId, escrow.provider, providerAmount, fee, verificationHash);
    }

    /// @notice Finalizes a failed verification and credits a full refund to the buyer.
    function refundFailed(bytes32 jobId, bytes32 verificationHash)
        external
        onlyRole(SETTLEMENT_ROLE)
    {
        if (verificationHash == bytes32(0)) revert InvalidHash();
        Escrow storage escrow = _requireState(jobId, EscrowState.FUNDED);
        uint256 amount = _refund(escrow);
        emit JobRefunded(jobId, escrow.buyer, amount, verificationHash);
    }

    /// @notice Credits a full refund after expiry. Any caller may trigger this liveness path.
    function refundExpired(bytes32 jobId) external {
        Escrow storage escrow = _requireState(jobId, EscrowState.FUNDED);
        // See the deadline rationale in fundJob.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= escrow.deadline) {
            revert EscrowNotExpired(jobId, escrow.deadline);
        }

        uint256 amount = _refund(escrow);
        emit JobRefunded(jobId, escrow.buyer, amount, bytes32(0));
    }

    /// @notice Freezes a funded, unexpired escrow while evidence is reviewed.
    function openDispute(bytes32 jobId, bytes32 evidenceHash) external onlyRole(DISPUTE_ROLE) {
        if (evidenceHash == bytes32(0)) revert InvalidHash();
        Escrow storage escrow = _requireState(jobId, EscrowState.FUNDED);
        if (escrow.provider == address(0)) revert ProviderNotAssigned(jobId);
        // See the deadline rationale in fundJob.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > escrow.deadline) revert EscrowExpired(jobId, escrow.deadline);

        escrow.state = EscrowState.DISPUTED;
        emit DisputeOpened(jobId, evidenceHash);
    }

    /// @notice Resolves a dispute by releasing funds or refunding the buyer.
    function resolveDispute(bytes32 jobId, bool releaseToProvider, bytes32 resolutionHash)
        external
        onlyRole(DISPUTE_ROLE)
    {
        if (resolutionHash == bytes32(0)) revert InvalidHash();
        Escrow storage escrow = _requireState(jobId, EscrowState.DISPUTED);

        if (releaseToProvider) {
            (uint256 providerAmount, uint256 fee) = _release(escrow);
            emit DisputeResolved(jobId, true, resolutionHash, providerAmount, fee);
        } else {
            _refund(escrow);
            emit DisputeResolved(jobId, false, resolutionHash, 0, 0);
        }
    }

    /// @notice Withdraws the caller's finalized credit to a chosen recipient.
    function withdraw(address payable recipient) external nonReentrant {
        if (recipient == address(0)) revert InvalidAddress();
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw(msg.sender);

        pendingWithdrawals[msg.sender] = 0;
        totalPendingWithdrawals -= amount;

        (bool sent,) = recipient.call{ value: amount }("");
        if (!sent) revert EtherTransferFailed(recipient, amount);

        emit Withdrawal(msg.sender, recipient, amount);
    }

    /// @notice Returns the native asset liability tracked by the contract.
    function totalLiability() external view returns (uint256) {
        return totalEscrowed + totalPendingWithdrawals;
    }

    function _requireState(bytes32 jobId, EscrowState expected)
        private
        view
        returns (Escrow storage escrow)
    {
        escrow = escrows[jobId];
        if (escrow.state != expected) revert InvalidState(jobId, expected, escrow.state);
    }

    function _release(Escrow storage escrow) private returns (uint256 providerAmount, uint256 fee) {
        uint256 amount = escrow.amount;
        fee = amount * protocolFeeBps / BPS_DENOMINATOR;
        providerAmount = amount - fee;

        escrow.state = EscrowState.RELEASED;
        totalEscrowed -= amount;
        pendingWithdrawals[escrow.provider] += providerAmount;
        pendingWithdrawals[feeRecipient] += fee;
        totalPendingWithdrawals += amount;
    }

    function _refund(Escrow storage escrow) private returns (uint256 amount) {
        amount = escrow.amount;
        escrow.state = EscrowState.REFUNDED;
        totalEscrowed -= amount;
        pendingWithdrawals[escrow.buyer] += amount;
        totalPendingWithdrawals += amount;
    }

    receive() external payable {
        revert DirectPaymentNotAllowed();
    }

    fallback() external payable {
        revert DirectPaymentNotAllowed();
    }
}
