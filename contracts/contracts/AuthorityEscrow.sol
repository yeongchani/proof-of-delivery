// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice One immutable milestone per agreement. Only standard exact-transfer tokens are supported.
/// @dev Signatures attest authorized evidence, not AI correctness or valid encrypted delivery.
contract AuthorityEscrow is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum State { Created, Accepted, Funded, Submitted, Challenged, Released, Refunded }
    struct Terms {
        address developer;
        address runner;
        address token;
        bytes32 acceptanceHash;
        bytes32 runnerDigest;
        bytes32 policyHash;
        uint256 amount;
        uint256 devBond;
        uint256 challengeBond;
        uint256 challengeWindow;
        uint256 deliveryDuration;
        uint256 disputeDuration;
        uint256 retentionBps;
        uint256 retentionPeriod;
        bytes32 sourceKeyHash;
    }
    struct Agreement {
        Terms terms;
        address client;
        address runner;
        State state;
        uint256 authorityVersion;
        bool revoked;
        bool priceDeposited;
        bool bondDeposited;
        bool sourceRevealed;
        uint256 deliveryDeadline;
        uint256 challengeDeadline;
        uint256 disputeDeadline;
        uint256 retentionDeadline;
        uint256 retained;
        bytes32 clientProposal;
        bytes32 developerProposal;
        bytes32 resultHash;
        bytes32 sourceHash;
    }
    struct Result {
        uint256 agreementId;
        uint256 authorityVersion;
        bytes32 acceptanceHash;
        bytes32 runnerDigest;
        bytes32 policyHash;
        bytes32 resultHash;
        bytes32 sourceHash;
        bool passed;
        uint256 expiry;
    }
    bytes32 public constant RESULT_TYPEHASH = keccak256("Result(uint256 agreementId,uint256 authorityVersion,bytes32 acceptanceHash,bytes32 runnerDigest,bytes32 policyHash,bytes32 resultHash,bytes32 sourceHash,bool passed,uint256 expiry)");
    address public immutable arbiter;
    uint256 public nextAgreementId = 1;
    mapping(uint256 => Agreement) private agreements;
    event AgreementCreated(uint256 indexed id, address indexed client, address indexed developer);
    event Accepted(uint256 indexed id, uint256 deliveryDeadline);
    event Deposited(uint256 indexed id, address indexed party, uint256 amount);
    event AuthorityApproved(uint256 indexed id, address indexed party, bytes32 proposal);
    event AuthorityChanged(uint256 indexed id, address runner, uint256 version, bool revoked);
    event ResultSubmitted(uint256 indexed id, bytes32 resultHash, bytes32 sourceHash, uint256 challengeDeadline);
    /// @dev This key is PUBLIC. Its hash match is not proof that ciphertext decrypts correctly.
    event SourceKeyRevealed(uint256 indexed id, bytes key);
    event Challenged(uint256 indexed id, uint256 disputeDeadline);
    event Paid(uint256 indexed id, address indexed recipient, uint256 amount);

    constructor(address arbiter_) EIP712("AuthorityEscrow", "1") {
        require(arbiter_ != address(0), "arbiter");
        arbiter = arbiter_;
    }
    function createAgreement(Terms calldata t) external returns (uint256 id) {
        require(t.developer != address(0) && t.developer != msg.sender && t.developer != address(this), "developer");
        _neutralRunner(t.runner, msg.sender, t.developer);
        require(t.token.code.length != 0 && t.amount != 0, "terms");
        require(t.acceptanceHash != bytes32(0) && t.runnerDigest != bytes32(0) && t.policyHash != bytes32(0), "empty commitment");
        require(t.challengeWindow >= 1 days && t.challengeWindow <= 30 days, "challenge window");
        require(t.retentionBps <= 2000 && t.retentionPeriod >= 1 days && t.retentionPeriod <= 90 days, "retention");
        require(t.deliveryDuration > 0 && t.deliveryDuration <= 365 days, "delivery duration");
        require(t.disputeDuration > 0 && t.disputeDuration <= 365 days, "dispute duration");
        // Bound aggregate arithmetic even for nonstandard token denominations.
        require(t.amount <= type(uint256).max / 10000 && t.devBond <= type(uint256).max / 4 && t.challengeBond <= type(uint256).max / 4, "amount bounds");
        id = nextAgreementId++;
        Agreement storage a = agreements[id];
        a.terms = t;
        a.client = msg.sender;
        a.runner = t.runner;
        a.authorityVersion = 1;
        a.sourceRevealed = t.sourceKeyHash == bytes32(0);
        emit AgreementCreated(id, msg.sender, t.developer);
    }
    function getAgreement(uint256 id) external view returns (Agreement memory) { return _get(id); }
    function acceptAgreement(uint256 id) external {
        Agreement storage a = _get(id);
        require(msg.sender == a.terms.developer && a.state == State.Created, "accept");
        a.state = State.Accepted;
        a.deliveryDeadline = block.timestamp + a.terms.deliveryDuration;
        emit Accepted(id, a.deliveryDeadline);
    }
    function fund(uint256 id) external nonReentrant {
        Agreement storage a = _get(id);
        _depositOpen(a);
        require(msg.sender == a.client && !a.priceDeposited, "fund");
        a.priceDeposited = true;
        _pull(a, msg.sender, a.terms.amount);
        _funded(a);
        emit Deposited(id, msg.sender, a.terms.amount);
    }
    function depositDevBond(uint256 id) external nonReentrant {
        Agreement storage a = _get(id);
        _depositOpen(a);
        require(msg.sender == a.terms.developer && !a.bondDeposited, "bond");
        a.bondDeposited = true;
        _pull(a, msg.sender, a.terms.devBond);
        _funded(a);
        emit Deposited(id, msg.sender, a.terms.devBond);
    }
    function authorityProposalHash(uint256 id, address runner, uint256 version) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, id, runner, version));
    }
    function approveAuthority(uint256 id, address runner, uint256 version) external {
        Agreement storage a = _get(id);
        _authorityOpen(a);
        _neutralRunner(runner, a.client, a.terms.developer);
        require(version == a.authorityVersion + 1, "proposal");
        bytes32 proposal = authorityProposalHash(id, runner, version);
        if (msg.sender == a.client) a.clientProposal = proposal;
        else a.developerProposal = proposal;
        emit AuthorityApproved(id, msg.sender, proposal);
        if (a.clientProposal == proposal && a.developerProposal == proposal) {
            a.runner = runner;
            a.authorityVersion = version;
            a.revoked = false;
            _clearProposals(a);
            emit AuthorityChanged(id, runner, version, false);
        }
    }
    function revokeAuthority(uint256 id) external {
        Agreement storage a = _get(id);
        _authorityOpen(a);
        a.revoked = true;
        a.authorityVersion++;
        _clearProposals(a);
        emit AuthorityChanged(id, a.runner, a.authorityVersion, true);
    }
    function submitResult(Result calldata r, bytes calldata signature) external {
        Agreement storage a = _get(r.agreementId);
        require(a.state == State.Funded && !a.revoked && block.timestamp < a.deliveryDeadline, "submission");
        require(a.sourceRevealed && r.passed && block.timestamp <= r.expiry, "result");
        require(r.resultHash != bytes32(0) && r.sourceHash != bytes32(0), "empty evidence");
        require(r.authorityVersion == a.authorityVersion && r.acceptanceHash == a.terms.acceptanceHash && r.runnerDigest == a.terms.runnerDigest && r.policyHash == a.terms.policyHash, "binding");
        require(ECDSA.recover(_hashTypedDataV4(keccak256(abi.encode(RESULT_TYPEHASH, r))), signature) == a.runner, "signer");
        a.state = State.Submitted;
        a.resultHash = r.resultHash;
        a.sourceHash = r.sourceHash;
        a.challengeDeadline = block.timestamp + a.terms.challengeWindow;
        emit ResultSubmitted(r.agreementId, r.resultHash, r.sourceHash, a.challengeDeadline);
    }
    /// @notice Deliberately reveal BEFORE submission, unlike the deck's later key step:
    /// clients get the full challenge window to inspect delivery, and withheld keys use delivery timeout.
    /// Bind the expected sealed-package hash in acceptanceHash's document and sign it as sourceHash.
    /// The chain checks the key commitment and signed hashes, not package validity or document contents.
    function revealSourceKey(uint256 id, bytes calldata key) external {
        Agreement storage a = _get(id);
        require(a.state == State.Accepted || a.state == State.Funded, "source state");
        require(!a.sourceRevealed && keccak256(key) == a.terms.sourceKeyHash, "source key");
        a.sourceRevealed = true;
        emit SourceKeyRevealed(id, key);
    }
    function release(uint256 id) external nonReentrant {
        Agreement storage a = _get(id);
        require(a.state == State.Submitted && block.timestamp >= a.challengeDeadline, "release");
        _developerWins(id, a, 0);
    }
    function releaseRetention(uint256 id) external nonReentrant {
        Agreement storage a = _get(id);
        require(a.state == State.Released && a.retained != 0 && block.timestamp >= a.retentionDeadline, "retention");
        uint256 amount = a.retained;
        a.retained = 0;
        _pay(id, a, a.terms.developer, amount);
    }
    function challenge(uint256 id) external nonReentrant {
        Agreement storage a = _get(id);
        require(msg.sender == a.client && a.state == State.Submitted && block.timestamp < a.challengeDeadline, "challenge");
        a.state = State.Challenged;
        a.disputeDeadline = block.timestamp + a.terms.disputeDuration;
        _pull(a, msg.sender, a.terms.challengeBond);
        emit Challenged(id, a.disputeDeadline);
    }
    /// @notice Explicit culpability decision: winner receives price and both bonds; developer price retains its holdback.
    function resolve(uint256 id, bool developerWins) external nonReentrant {
        Agreement storage a = _get(id);
        require(msg.sender == arbiter && a.state == State.Challenged && block.timestamp < a.disputeDeadline, "resolve");
        if (developerWins) _developerWins(id, a, a.terms.challengeBond);
        else {
            a.state = State.Refunded;
            _pay(id, a, a.client, a.terms.amount + a.terms.devBond + a.terms.challengeBond);
        }
    }
    /// @notice Neutral timeout returns each party's own deposits, including partially funded agreements.
    function refundTimeout(uint256 id) external nonReentrant {
        Agreement storage a = _get(id);
        bool disputed = a.state == State.Challenged;
        require(disputed ? block.timestamp >= a.disputeDeadline :
            ((a.state == State.Accepted || a.state == State.Funded) && block.timestamp >= a.deliveryDeadline), "timeout");
        a.state = State.Refunded;
        _pay(id, a, a.client, (a.priceDeposited ? a.terms.amount : 0) + (disputed ? a.terms.challengeBond : 0));
        _pay(id, a, a.terms.developer, a.bondDeposited ? a.terms.devBond : 0);
    }
    function _developerWins(uint256 id, Agreement storage a, uint256 challengeAward) private {
        require(a.sourceRevealed, "source required");
        a.state = State.Released;
        a.retained = a.terms.amount * a.terms.retentionBps / 10000;
        a.retentionDeadline = block.timestamp + a.terms.retentionPeriod;
        _pay(id, a, a.terms.developer, a.terms.amount - a.retained + a.terms.devBond + challengeAward);
    }
    function _get(uint256 id) private view returns (Agreement storage a) {
        a = agreements[id];
        require(a.client != address(0), "agreement");
    }
    function _depositOpen(Agreement storage a) private view {
        require(a.state == State.Accepted && block.timestamp < a.deliveryDeadline, "deposit closed");
    }
    function _funded(Agreement storage a) private {
        if (a.priceDeposited && a.bondDeposited) a.state = State.Funded;
    }
    function _authorityOpen(Agreement storage a) private view {
        require(msg.sender == a.client || msg.sender == a.terms.developer, "party");
        require(a.state <= State.Funded, "authority frozen");
    }
    function _clearProposals(Agreement storage a) private {
        a.clientProposal = bytes32(0);
        a.developerProposal = bytes32(0);
    }
    function _neutralRunner(address runner, address client, address developer) private view {
        require(runner != address(0) && runner != client && runner != developer && runner != address(this), "runner");
    }
    function _pull(Agreement storage a, address from, uint256 amount) private {
        if (amount == 0) return;
        IERC20 token = IERC20(a.terms.token);
        uint256 beforeEscrow = token.balanceOf(address(this));
        uint256 beforeSender = token.balanceOf(from);
        token.safeTransferFrom(from, address(this), amount);
        require(token.balanceOf(address(this)) == beforeEscrow + amount && token.balanceOf(from) + amount == beforeSender, "inexact transfer");
    }
    function _pay(uint256 id, Agreement storage a, address to, uint256 amount) private {
        if (amount == 0) return;
        IERC20 token = IERC20(a.terms.token);
        uint256 beforeEscrow = token.balanceOf(address(this));
        uint256 beforeRecipient = token.balanceOf(to);
        token.safeTransfer(to, amount);
        require(token.balanceOf(address(this)) + amount == beforeEscrow && token.balanceOf(to) == beforeRecipient + amount, "inexact transfer");
        emit Paid(id, to, amount);
    }
}
