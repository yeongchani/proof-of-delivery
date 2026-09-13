// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Proof of Delivery — milestone escrow interface
interface IMilestoneEscrow {
    enum MilestoneState {
        Unfunded,
        Funded,
        Submitted,
        Challenged,
        Released,
        Refunded
    }

    struct Milestone {
        uint256 amount; // payout (token units)
        bytes32 acceptanceHash; // keccak256(canonical acceptance.json)
        MilestoneState state;
        bytes32 resultHash; // keccak256(canonical result.json)
        bytes32 commitHash; // verified git commit, 20 bytes left-padded to bytes32
        uint64 submittedAt;
        address challenger;
    }

    struct Agreement {
        address client;
        address developer;
        address runner; // EIP-712 signer of verification results
        bytes32 runnerImageDigest; // pinned runner image / workflow digest
        IERC20 token;
        uint64 challengeWindow; // seconds, inclusive range 1 day to 30 days
        uint256 challengeBond; // token units
        uint256 milestoneCount;
        bool terminated;
    }

    /// @dev EIP-712 signed payload produced by the runner.
    struct VerificationResult {
        uint256 agreementId;
        uint256 milestoneIndex;
        bytes32 acceptanceHash;
        bytes32 commitHash;
        bytes32 runnerImageDigest;
        bytes32 resultHash;
        bool passed;
        uint64 timestamp;
    }

    event AgreementCreated(
        uint256 indexed agreementId,
        address indexed client,
        address indexed developer,
        address runner,
        uint256 milestoneCount
    );
    event MilestoneFunded(uint256 indexed agreementId, uint256 indexed index, uint256 amount);
    event VerificationSubmitted(
        uint256 indexed agreementId,
        uint256 indexed index,
        bytes32 commitHash,
        bytes32 resultHash,
        uint64 releasableAt
    );
    event VerificationFailed(uint256 indexed agreementId, uint256 indexed index, bytes32 commitHash, bytes32 resultHash);
    event Challenged(uint256 indexed agreementId, uint256 indexed index, address challenger, uint256 bond);
    event Released(uint256 indexed agreementId, uint256 indexed index, uint256 amount);
    event ChallengeResolved(uint256 indexed agreementId, uint256 indexed index, bool developerWins);

    error NotClient();
    error NotArbiter();
    error InvalidState();
    error BadSigner();
    error HashMismatch();
    error DigestMismatch();
    error WindowOpen();
    error WindowClosed();
    error LengthMismatch();
    error ResultMismatch();
    error InvalidAgreement();
    error InvalidMilestoneIndex();
    error InvalidDeveloper();
    error InvalidRunner();
    error InvalidToken();
    error InvalidChallengeWindow();
    error InvalidAmount();
    error OwnershipRenunciationDisabled();

    function createAgreement(
        address developer,
        address runner,
        bytes32 runnerImageDigest,
        IERC20 token,
        uint64 challengeWindow,
        uint256 challengeBond,
        uint256[] calldata amounts,
        bytes32[] calldata acceptanceHashes
    ) external returns (uint256 agreementId);

    function fundMilestone(uint256 agreementId, uint256 index) external;

    function submitResult(
        uint256 agreementId,
        uint256 index,
        VerificationResult calldata r,
        bytes calldata runnerSignature
    ) external;

    function challenge(uint256 agreementId, uint256 index) external;

    function release(uint256 agreementId, uint256 index) external;

    function resolveChallenge(uint256 agreementId, uint256 index, bool developerWins) external;

    function getAgreement(uint256 agreementId) external view returns (Agreement memory);

    function getMilestone(uint256 agreementId, uint256 index) external view returns (Milestone memory);

    function releasableAt(uint256 agreementId, uint256 index) external view returns (uint64);
}
