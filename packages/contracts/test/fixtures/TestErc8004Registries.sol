// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract TestErc8004IdentityRegistry {
    mapping(uint256 agentId => address owner) private _owners;

    function setOwner(uint256 agentId, address owner) external {
        require(owner != address(0), "zero owner");
        _owners[agentId] = owner;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        address owner = _owners[agentId];
        require(owner != address(0), "missing agent");
        return owner;
    }
}

contract TestErc8004ReputationRegistry {
    struct Feedback {
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        bool isRevoked;
    }

    TestErc8004IdentityRegistry private immutable _identityRegistry;
    mapping(uint256 agentId => mapping(address client => uint64 count)) private _counts;
    mapping(
        uint256 agentId => mapping(address client => mapping(uint64 index => Feedback feedback))
    ) private _feedback;

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );

    constructor(address identityRegistry_) {
        _identityRegistry = TestErc8004IdentityRegistry(identityRegistry_);
    }

    function getIdentityRegistry() external view returns (address) {
        return address(_identityRegistry);
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        require(valueDecimals <= 18, "decimals");
        require(_identityRegistry.ownerOf(agentId) != msg.sender, "self feedback");
        uint64 feedbackIndex = ++_counts[agentId][msg.sender];
        _feedback[agentId][msg.sender][feedbackIndex] = Feedback({
            value: value, valueDecimals: valueDecimals, tag1: tag1, tag2: tag2, isRevoked: false
        });
        _emitNewFeedback(agentId, feedbackIndex, endpoint, feedbackURI, feedbackHash);
    }

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (
            int128 value,
            uint8 valueDecimals,
            string memory tag1,
            string memory tag2,
            bool isRevoked
        )
    {
        Feedback storage feedback = _feedback[agentId][clientAddress][feedbackIndex];
        return (
            feedback.value, feedback.valueDecimals, feedback.tag1, feedback.tag2, feedback.isRevoked
        );
    }

    function _emitNewFeedback(
        uint256 agentId,
        uint64 feedbackIndex,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) private {
        Feedback storage feedback = _feedback[agentId][msg.sender][feedbackIndex];
        emit NewFeedback(
            agentId,
            msg.sender,
            feedbackIndex,
            feedback.value,
            feedback.valueDecimals,
            feedback.tag1,
            feedback.tag1,
            feedback.tag2,
            endpoint,
            feedbackURI,
            feedbackHash
        );
    }
}
