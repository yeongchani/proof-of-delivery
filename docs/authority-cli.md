# 샘플 밖의 납품 건 실행하기

[README](../README.md) · [계약 규칙](authority.md)

현재 계약용 명령은 `npm run authority`입니다. `runner:sign`, `runner:submit`, `deploy:sepolia`는 이전 `MilestoneEscrow` 전용으로 남겨 둡니다. 아래 새 명령은 기본적으로 거래를 시뮬레이션하며, `--send`를 붙일 때만 전송합니다.

## 1. 검수 기준과 소스 준비

납품물은 `src/`와 `acceptance.json`으로 구성합니다. 현재 실행 범위는 JS/TS, 승인된 Express 의존성과 제한된 Node 기본 모듈입니다. 소스는 UTF-8, 최대 32개 파일·총 48KB·파일당 7KB 범위입니다. 크기 초과 파일을 몰래 생략하지 않고 거절합니다. 다른 언어·의존성·외부 시스템 접근·큰 저장소 분석은 별도 승인이 가능한 실행기 확장이 필요합니다.

검수 테스트 묶음은 납품물과 다른 폴더에 둡니다. `approvedPolicySuiteHash`로 묶음 지문을 계산하고, 그 값을 `acceptance.json`의 `testSuiteHash`에 넣은 뒤 기준 문서의 지문도 계산합니다. 두 지문을 양측이 확인해야 합니다. [다른 검수 묶음을 실행하는 예제와 변조 검사](../runner/test/approved-policy.test.ts)

실행 옵션 JSON에는 `deliverableDir`, `outDir`, `agreementId`와 `approvedPolicy`를 지정합니다. `approvedPolicy`에는 `directory`, `expectedAcceptanceHash`, `expectedSuiteHash`가 필요하고, 선택적으로 `acceptancePath`, `configFile`을 지정합니다. 경로는 절대 경로 사용을 권장합니다. 후보 코드의 설정을 그대로 승인하는 절차가 아닙니다.

`result.json`, AI 입력·응답, 정산 증거와 서명 파일에는 **원본 소스가 포함됩니다.** 이 파일들은 검증자 측의 비공개 자료로 보관해야 합니다. 지급 전 발주자에게 전체 파일을 넘기면 최종 키 공개를 기다리는 의미가 없어집니다. 체인에는 서명된 지문만 전송하며 원본 자료를 자동 업로드하지 않습니다. 이의 검토를 위한 근거 공개 범위는 별도 합의가 필요합니다.

```bash
npm run runner:test -- --options /path/to/run-options.json
```

기본 샘플은 옵션 없이 실행할 수 있습니다. 실행 결과 `result.json`과 소스가 포함된 AI 입력 `review-input.json`을 출력 폴더에 남깁니다. 실행 중 소스·정책·러너가 바뀌면 중단합니다. 이 검사는 OS 격리나 실행 증명이 아닙니다.

소스 밖의 구현 파일, 승인되지 않은 상위 폴더의 패키지, 실행 중 구성하는 모듈 이름과 임의 로더, 미승인 경로 별칭을 거절합니다. 승인된 테스트도 정해진 설정과 의존성 범위에서 실행합니다. 설치된 러너 패키지는 잠금 파일로 준비한 신뢰된 실행 환경으로 취급하며, 설치 파일의 무결성을 하드웨어로 증명하지 않습니다.

## 2. 인계 파일 준비

```bash
npm run delivery -- seal --source /path/to/deliverable --output-dir /path/to/new-delivery
```

새 폴더에 `delivery.json`, `commitments.json`, `delivery.key`가 생성됩니다. **`delivery.key`는 서명 검증에 필요한 신뢰된 담당자에게만 전달하고, 최종 지급 전 공개 자료에 넣지 않습니다.** 나머지 두 파일은 암호화 패키지와 합의할 지문입니다. 기존 폴더를 덮어쓰지 않습니다.

계약 생성 전에 manifest를 합의합니다. 형식은 `{version:1, acceptance, aiPolicyHash, sourcePackageHash, sourceKeyHash, runnerDigest}`입니다. 계약의 `acceptanceHash`는 manifest 전체의 지문입니다. 실행 결과 안의 `acceptanceHash`는 기준 문서만의 지문이며, 서명 도구가 두 층의 연결을 검사합니다.

## 3. AI 검토와 정산 증거

```bash
npm run ai:review -- --codex --input /path/to/review-input.json --output /path/to/new-review.json
npm run authority -- evidence --chain-id CHAIN_ID --escrow ESCROW_ADDRESS --execution /path/to/result.json --review /path/to/new-review.json --acceptance /path/to/acceptance.json --expected-policy-hash POLICY_HASH --output /path/to/new-evidence.json
```

`POLICY_HASH`는 계약 전에 합의한 AI 모델·프롬프트·제한의 지문입니다. 증거 생성 결과의 `resultHash`와 파일 내용을 검증자가 확인합니다. 그 값을 다음 단계의 `REVIEWED_HASH`로 사용합니다. 자동으로 생성됐다는 이유만으로 독립 검토가 완료된 것으로 보지 않습니다.

## 4. 서명과 제출

서명 전용 환경의 `AUTHORITY_PRIVATE_KEY`는 등록된 러너 키입니다. 납품 코드를 실행하는 환경에 이 키를 주입하지 않습니다.

```bash
npm run authority -- sign --chain-id CHAIN_ID --escrow ESCROW_ADDRESS --execution /path/to/result.json --review /path/to/new-review.json --acceptance /path/to/acceptance.json --manifest /path/to/manifest.json --agreement-id AGREEMENT_ID --authority-version VERSION --expiry UNIX_SECONDS --expected-review-hash REVIEWED_HASH --expected-policy-hash POLICY_HASH --delivery /path/to/delivery.json --delivery-key-file /path/to/delivery.key --output /path/to/new-signed.json
```

서명 도구는 암호화 파일을 복원해 검수한 소스와 같은지 확인합니다. 서명 출력에는 복호화 키를 넣지 않습니다. 소스 인계가 없는 `sourceKeyHash=0` 계약만 인계 파일을 생략할 수 있습니다.

제출 환경에는 `RPC_URL`을 설정합니다. 아래 명령은 실제 체인·계약·등록 검증자·권한 버전·합의 지문·현재 기한을 검사한 뒤 시뮬레이션합니다.

```bash
npm run authority -- submit --chain-id CHAIN_ID --escrow ESCROW_ADDRESS --input /path/to/new-signed.json --acceptance /path/to/acceptance.json --expected-review-hash REVIEWED_HASH --expected-policy-hash POLICY_HASH
```

실제 제출은 가스 비용을 낼 `TRANSACTION_PRIVATE_KEY`를 주입하고 같은 명령에 `--send`를 추가합니다. 제출자는 지급액과 수령인을 바꿀 수 없습니다. 새 파일 경로가 필요하며 오류를 성공으로 건너뛰지 않습니다.

## 5. 계약 동의·예치·이의·변경

`call`은 컴파일된 새 계약의 함수를 실행합니다. 인수 파일은 JSON 배열이며 큰 정수는 문자열로 씁니다. 결과 제출은 별도 검증이 있는 `submit` 명령만 허용합니다.

```bash
# args.json 예: ["1"]
npm run authority -- call --chain-id CHAIN_ID --escrow ESCROW_ADDRESS --method acceptAgreement --args /path/to/args.json --from DEVELOPER_ADDRESS
```

| 목적 | 함수와 인수 배열 |
| --- | --- |
| 계약 제안 | `createAgreement`: `[terms]` |
| 조건 승인 | `acceptAgreement`: `[id]` |
| 대금·보증금 예치 | `fund`, `depositDevBond`: `[id]` |
| 결과 이의 | `challenge`: `[id]` |
| 요구사항 변경 합의 | `approveReplacement`: `[id, successorId, developerPayment, version]`를 양측이 각각 승인 |
| 최종 인계·지급 | `revealSourceKey`: `[id, key]`, 이의 기간 뒤 실행 |
| 계약 조회 | `getAgreement`: `[id]`, `--send` 없이 조회 |

토큰 승인은 `approve-token --token TOKEN_ADDRESS --amount AMOUNT`를 사용합니다. 이 명령도 `--from` 조회 또는 `TRANSACTION_PRIVATE_KEY`와 `--send`를 명시합니다. 예치금 이동과 토큰 사용 승인은 서로 다른 거래입니다.

공개 테스트넷에 배포하려면 `npm run deploy:authority:sepolia`를 사용합니다. `DEPLOYER_PRIVATE_KEY`, `CHAIN_ID`, `ARBITER_ADDRESS`, `AUTHORITY_DEPLOYMENT_FILE`이 필요합니다. 기본값은 배포 비용 추정이며 `DEPLOY_AUTHORITY_SEND=1`에서만 배포합니다. 중재자는 배포자와 다른 주소를 지정합니다. 실제 중립성을 주소 차이만으로 증명하지는 않습니다.

## 명령 자체의 재현 검사

`npm run demo:cli`는 로컬 RPC를 띄우고 공개 테스트 지갑으로 위 명령을 실제 실행합니다. 계약 생성·양측 승인·예치·오프라인 서명·제출 전 조회·실제 제출·인계·지급을 확인하고 로컬 RPC를 종료합니다. 결과는 `runner/out/authority-cli-smoke.json`에 남습니다. 실제 모델이나 공개 네트워크는 사용하지 않습니다.
