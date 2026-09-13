# Arbitrum Sepolia 시연 준비

[README로 돌아가기](../README.md) · [결과 검토·서명 절차](verification.md)

**현재 공개 배포 주소와 실제 거래 기록은 없습니다.** 아래는 이를 만들기 위한 수동 시연 절차입니다. `npm run deploy:sepolia`는 배포만 수행하며, 계약 생성·예치·지급까지 자동으로 진행하지 않습니다.

## 1. 배포

신뢰하는 배포 환경에서 `.env.example`을 `.env`로 복사하고 `ARB_SEPOLIA_RPC`, `DEPLOYER_PRIVATE_KEY`, `USE_MOCK_TOKEN=1`을 설정합니다. 배포 지갑에는 Arbitrum Sepolia의 가스용 ETH가 필요합니다.

```bash
npm ci --ignore-scripts
npm run deploy:sepolia
```

주소는 `contracts/deployments/arbitrumSepolia.json`에 저장됩니다. 테스트 토큰 10,000개가 배포자에게 발행됩니다. 기존 배포는 수정되지 않으므로 이번 계약 검증 변경을 반영하려면 새로 배포해야 합니다.

## 2. 계약 생성과 예치

시연에서는 배포자를 고객 겸 중재자로 사용합니다. 개발자와 러너는 고객과 서로 다른 주소를 준비하세요. 러너의 제출 지갑에도 가스용 ETH가 필요합니다. 아래 명령은 신뢰하는 저장소에서 실행합니다.

```bash
cd contracts
npx hardhat console --network arbitrumSepolia
```

콘솔에서 순서대로 실행합니다. `<개발자 주소>`와 `<러너 주소>`를 실제 주소로 바꿉니다.

```javascript
const fs = require('fs');
const deployment = JSON.parse(fs.readFileSync('deployments/arbitrumSepolia.json', 'utf8'));
const escrow = await ethers.getContractAt('MilestoneEscrow', deployment.escrow);
const token = await ethers.getContractAt('MockERC20', deployment.token);
const { canonicalHash } = require('../runner/src/hash');
const { runnerFingerprint } = require('../runner/src/policy');
const acceptance = JSON.parse(fs.readFileSync('../example-deliverable/acceptance.json', 'utf8'));
const amount = ethers.parseUnits('300', 6);
const createTx = await escrow.createAgreement('<개발자 주소>', '<러너 주소>', runnerFingerprint(), deployment.token, 3 * 86400, ethers.parseUnits('50', 6), [amount], [canonicalHash(acceptance)]);
const receipt = await createTx.wait();
const created = receipt.logs.map(log => { try { return escrow.interface.parseLog(log); } catch { return null; } }).find(log => log?.name === 'AgreementCreated');
const agreementId = created.args.agreementId;
console.log('agreementId', agreementId.toString(), 'create tx', createTx.hash);
await (await token.approve(deployment.escrow, amount)).wait();
const fundTx = await escrow.fundMilestone(agreementId, 0);
await fundTx.wait();
console.log('fund tx', fundTx.hash);
```

계약 ID를 기록합니다. 여러 계약을 만들었다면 기본값 1을 그대로 사용하지 마세요.

## 3. 검증, 검토, 결과 제출

비밀정보 없는 검증 환경에서 승인된 러너와 납품 커밋을 준비합니다. 납품물과 기준 파일은 커밋된 상태여야 합니다. 해당 계약의 `AGREEMENT_ID`, `MILESTONE_INDEX=0`을 설정한 뒤 `npm run runner:test`를 실행합니다.

`pod-verify`의 기본 예시는 계약 1 / 마일스톤 0을 대상으로 합니다. 다른 계약은 수동 실행 입력으로 ID를 지정합니다. 코드와 기준·러너 지문이 계약 생성 시의 값과 일치해야 합니다.

결과와 로그를 별도 환경에서 검토한 뒤 [서명 절차](verification.md#결과를-검토하고-서명하기)에 따라 `runner:sign`, `runner:submit`을 실행합니다. 서명 키는 납품 코드를 실행하는 환경에 넣지 않습니다.

## 4. 이의 기간 후 지급

테스트넷에서는 실제 시간이 지나야 합니다. 로컬 데모의 시간 이동은 사용할 수 없습니다. 누구든 가스가 있는 지갑으로 아래 함수를 호출할 수 있습니다.

```javascript
await escrow.releasableAt(agreementId, 0);
// 위 시각 이후에 실행합니다.
const releaseTx = await escrow.release(agreementId, 0);
await releaseTx.wait();
console.log('release tx', releaseTx.hash);
```

## 5. 공개할 시연 기록

배포·시연이 끝나면 README에 아래 주소와 거래 링크를 추가합니다. 로컬 체인의 거래 해시는 공개 테스트넷 거래 기록으로 사용할 수 없습니다.

| 항목 | 현재 상태 |
|---|---|
| 컨트랙트 주소 | 미배포 |
| 테스트 토큰 주소 | 미배포 |
| 계약 생성 거래 | 없음 |
| 대금 예치 거래 | 없음 |
| 결과 제출 거래 | 없음 |
| 지급 거래 | 없음 |
