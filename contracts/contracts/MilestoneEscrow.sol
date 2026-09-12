// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IMilestoneEscrow} from "./interfaces/IMilestoneEscrow.sol";

/// @title Proof of Delivery — MilestoneEscrow
/// @notice Client funds a milestone; a neutral runner signs the verification result (EIP-712);
///         after the challenge window the developer is paid automatically. Owner acts as arbiter.
contract MilestoneEscrow is IMilestoneEscrow, Ownable, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant VERIFICATION_RESULT_TYPEHASH =
        keccak256(
            "VerificationResult(uint256 agreementId,uint256 milestoneIndex,bytes32 acceptanceHash,bytes32 commitHash,bytes32 runnerImageDigest,bytes32 resultHash,bool passed,uint64 timestamp)"
        );

    uint256 public nextAgreementId = 1;

    mapping(uint256 => Agreement) private _agreements;
    mapping(uint256 => mapping(uint256 => Milestone)) private _milestones;

    constructor(address initialArbiter) Ownable(initialArbiter) EIP712("ProofOfDelivery", "1") {}

    // ---------------------------------------------------------------- views

    /// @notice Owner doubles as the (single, demo) arbiter.
    function arbiter() external view returns (address) {
        return owner();
    }

    function getAgreement(uint256 agreementId) external view returns (Agreement memory) {
        return _agreements[agreementId];
    }

    function getMilestone(uint256 agreementId, uint256 index) external view returns (Milestone memory) {
        return _milestones[agreementId][index];
    }

    function releasableAt(uint256 agreementId, uint256 index) external view returns (uint64) {
        Milestone storage m = _milestones[agreementId][index];
        if (m.submittedAt == 0) return 0;
        return m.submittedAt + _agreements[agreementId].challengeWindow;
    }

    // ------------------------------------------------------------- mutators

    function createAgreement(
        address developer,
        address runner,
        bytes32 runnerImageDigest,
        IERC20 token,
        uint64 challengeWindow,
        uint256 challengeBond,
        uint256[] calldata amounts,
        bytes32[] calldata acceptanceHashes
    ) external returns (uint256 agreementId) {
        if (amounts.length == 0 || amounts.length != acceptanceHashes.length) revert LengthMismatch();

        agreementId = nextAgreementId++;
        _agreements[agreementId] = Agreement({
            client: msg.sender,
            developer: developer,
            runner: runner,
            runnerImageDigest: runnerImageDigest,
            token: token,
            challengeWindow: challengeWindow,
            challengeBond: challengeBond,
            milestoneCount: amounts.length,
            terminated: false
        });

        for (uint256 i = 0; i < amounts.length; i++) {
            Milestone storage m = _milestones[agreementId][i];
            m.amount = amounts[i];
            m.acceptanceHash = acceptanceHashes[i];
            m.state = MilestoneState.Unfunded;
        }

        emit AgreementCreated(agreementId, msg.sender, developer, runner, amounts.length);
    }

    function fundMilestone(uint256 agreementId, uint256 index) external nonReentrant {
        Agreement storage a = _agreements[agreementId];
        Milestone storage m = _milestones[agreementId][index];
        if (msg.sender != a.client) revert NotClient();
        if (m.state != MilestoneState.Unfunded) revert InvalidState();

        m.state = MilestoneState.Funded;
        a.token.safeTransferFrom(msg.sender, address(this), m.amount);

        emit MilestoneFunded(agreementId, index, m.amount);
    }

    function submitResult(
        uint256 agreementId,
        uint256 index,
        VerificationResult calldata r,
        bytes calldata runnerSignature
    ) external {
        Agreement storage a = _agreements[agreementId];
        Milestone storage m = _milestones[agreementId][index];
        if (m.state != MilestoneState.Funded) revert InvalidState();
        if (r.agreementId != agreementId || r.milestoneIndex != index) revert ResultMismatch();
        if (r.acceptanceHash != m.acceptanceHash) revert HashMismatch();
        if (r.runnerImageDigest != a.runnerImageDigest) revert DigestMismatch();

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    VERIFICATION_RESULT_TYPEHASH,
                    r.agreementId,
                    r.milestoneIndex,
                    r.acceptanceHash,
                    r.commitHash,
                    r.runnerImageDigest,
                    r.resultHash,
                    r.passed,
                    r.timestamp
                )
            )
        );
        if (ECDSA.recover(digest, runnerSignature) != a.runner) revert BadSigner();

        if (r.passed) {
            m.state = MilestoneState.Submitted;
            m.resultHash = r.resultHash;
            m.commitHash = r.commitHash;
            m.submittedAt = uint64(block.timestamp);
            emit VerificationSubmitted(agreementId, index, r.commitHash, r.resultHash, m.submittedAt + a.challengeWindow);
        } else {
            emit VerificationFailed(agreementId, index, r.commitHash, r.resultHash);
        }
    }

    function challenge(uint256 agreementId, uint256 index) external nonReentrant {
        Agreement storage a = _agreements[agreementId];
        Milestone storage m = _milestones[agreementId][index];
        if (msg.sender != a.client) revert NotClient();
        if (m.state != MilestoneState.Submitted) revert InvalidState();
        if (block.timestamp >= m.submittedAt + a.challengeWindow) revert WindowClosed();

        m.state = MilestoneState.Challenged;
        m.challenger = msg.sender;
        a.token.safeTransferFrom(msg.sender, address(this), a.challengeBond);

        emit Challenged(agreementId, index, msg.sender, a.challengeBond);
    }

    function release(uint256 agreementId, uint256 index) external nonReentrant {
        Agreement storage a = _agreements[agreementId];
        Milestone storage m = _milestones[agreementId][index];
        if (m.state != MilestoneState.Submitted) revert InvalidState();
        if (block.timestamp < m.submittedAt + a.challengeWindow) revert WindowOpen();

        m.state = MilestoneState.Released;
        a.token.safeTransfer(a.developer, m.amount);

        emit Released(agreementId, index, m.amount);
    }

    function resolveChallenge(uint256 agreementId, uint256 index, bool developerWins) external nonReentrant {
        if (msg.sender != owner()) revert NotArbiter();
        Agreement storage a = _agreements[agreementId];
        Milestone storage m = _milestones[agreementId][index];
        if (m.state != MilestoneState.Challenged) revert InvalidState();

        uint256 payout = m.amount + a.challengeBond; // loser's bond goes to the winner (no protocol fee)
        if (developerWins) {
            m.state = MilestoneState.Released;
            a.token.safeTransfer(a.developer, payout);
        } else {
            m.state = MilestoneState.Refunded;
            a.token.safeTransfer(a.client, payout);
        }

        emit ChallengeResolved(agreementId, index, developerWins);
    }
}
