# 검증 구조와 서명 절차

> 이 문서는 기존 v1 MilestoneEscrow 전용입니다. 새 권한 계약과 데모는 [AuthorityEscrow 운영](authority.md)을 참고하세요. v1 CLI의 서명을 v2에 제출할 수 없습니다.

[README로 돌아가기](../README.md)

## 두 환경을 분리합니다

| 환경 | 하는 일 | 서명 키 |
|---|---|---|
| 일회용 검증 환경 / GitHub Actions | 납품 코드 실행, 결과와 로그 저장 | 없음 |
| 신뢰하는 별도 서명 환경 | 코드·로그·결과 검토 후 서명·제출 | 이곳에만 보관 |

`pod-verify`는 **서명 없는 증거를 수집하는 작업**입니다. 결과의 `passed`가 false여도 보고서를 보관하기 위해 정상 종료할 수 있습니다. 반면 기준 파일 오류처럼 결과를 만들 수 없는 문제는 작업을 실패시킵니다. 초록 배지만으로 납품 합격을 판단하면 안 됩니다.

납품 코드는 파일·프로세스에 접근할 수 있는 임의의 Node.js 코드입니다. 테스트 프로세스에 필요한 환경변수만 전달하지만 이것은 OS 수준의 격리가 아닙니다. **개인 지갑, 배포 키, 다른 프로젝트의 비밀정보가 있는 PC에서 신뢰하지 않는 납품 코드를 실행하지 마세요.** 이 저장소의 로컬 데모는 함께 제공한 샘플 코드와 공개된 임시 지갑만 사용합니다.

검토 대상 브랜치가 검증 코드와 워크플로를 함께 바꿀 수도 있습니다. 운영자는 코드 리뷰로 승인한 러너 버전을 별도로 보관해야 합니다. 저장소 쓰기 권한이나 브랜치 보호가 자동으로 설정되는 프로젝트는 아닙니다.

## 합격 기준을 고정하는 방법

- `example-deliverable/acceptance.json`에는 검사 이름과 `testSuiteHash`가 들어갑니다.
- `testSuiteHash`는 `runner/acceptance/api.test.ts`와 실행 설정 파일의 내용을 묶은 지문입니다. 줄바꿈은 LF로 정규화합니다.
- 러너는 납품물의 `npm test`나 Vitest 설정을 실행하지 않고, 이 별도 테스트를 직접 실행합니다.
- 기준 파일이 러너가 보관한 기준과 다르거나 테스트 지문이 다르면 결과 생성을 거절합니다.
- 이름은 대소문자를 구분해 정확히 하나의 제목 또는 전체 이름과 일치해야 합니다. 부분 일치나 중복 이름은 합격시키지 않습니다.
- 필수 항목 통과뿐 아니라 프로세스 종료 코드 0과 전체 보고서 성공도 필요합니다. 로딩 실패, 시간 초과, 보고서 누락은 합격이 아닙니다.

```bash
npm run policy:hash
```

이 명령은 테스트 지문과 러너 코드·의존성 잠금 파일의 지문을 출력합니다. **지문을 출력하는 것만으로 합의가 갱신되지는 않습니다.** 테스트를 수정했다면 새 `testSuiteHash`를 기준 파일에 기록하고 고객과 새 기준을 합의해야 합니다. 이미 생성된 계약의 기준 해시는 수정할 수 없으므로 새 계약을 생성합니다.

`runnerImageDigest`라는 필드명은 기존 계약과의 호환성을 위해 유지했습니다. 지금은 검토된 러너 소스·테스트·잠금 파일의 식별값입니다. Docker 이미지나 실제 하드웨어 환경의 증명이 아니며, 다른 환경에서 같은 값을 작성하는 것을 막지 않습니다.

## 결과에 어떤 정보가 남나요?

| 필드 | 의미 |
|---|---|
| `agreementId`, `milestoneIndex` | 어느 계약의 어느 단계인지 |
| `acceptanceHash` | 합의한 기준 파일의 지문 |
| `commitHash` | 검사 시작 전 Git HEAD |
| `sourceHash` | 실제 `src/`와 기준 파일 내용의 지문 |
| `sourceCommitted` | 해당 입력이 모두 Git에 추적되며 미커밋 변경이 없는지 |
| `runnerImageDigest` | 검토된 러너 버전 식별값 |
| `criteria`, `passed` | 항목별 검사와 최종 판정 |
| `execution` | 프로세스 종료 코드와 보고서 전체 성공 여부 |
| `logUrl` | GitHub 실행 기록 또는 로컬 실행 표시 |

`sourceHash`는 파일별 base64 바이트를 경로와 함께 정렬한 JSON의 해시입니다. 커밋되지 않은 로컬 수정도 기록하되, 해당 결과는 서명 도구가 거절합니다. `sourceCommitted` 역시 러너가 보고한 정보이므로 검토자가 독립적으로 비교해야 합니다.

## 결과를 검토하고 서명하기

1. `pod-verify` 실행에서 `verification-result` artifact를 받습니다. 보관 기간은 30일입니다. 정산 증거가 필요하면 로그와 함께 별도로 보관합니다.
2. 신뢰하는 별도 환경에서 승인된 러너 버전을 준비하고 `npm ci --ignore-scripts`로 의존성을 설치합니다. 납품 코드는 이 환경에서 실행하지 않습니다.
3. 실행 커밋, 코드 변경, 기준 파일, 테스트 지문, 로그와 결과지의 일치를 검토합니다. 수신한 JSON의 `passed` 값만 확인하는 것은 검토가 아닙니다.
4. 별도로 확보한 해당 커밋의 소스 파일을 실행하지 않고 읽어 지문을 비교합니다.

```bash
npm run source:hash -- /path/to/reviewed-candidate/example-deliverable
```

5. 결과지의 정확한 해시를 계산하고, 검토를 마친 **그 값**을 `REVIEWED_RESULT_HASH`에 설정합니다. 새 artifact가 도착할 때 자동으로 이 값을 채워 서명하는 방식은 사용하지 않습니다.

PowerShell 예시 (신뢰하는 서명 환경의 저장소 루트):

```powershell
$env:RESULT_FILE = 'C:\reviewed-evidence\result.json'
$env:SIGNED_RESULT_FILE = 'C:\reviewed-evidence\result.signed.json'
$env:TS_NODE_PROJECT = 'runner/tsconfig.json'
node -r ts-node/register/transpile-only -e "const fs=require('fs'); console.log(require('./runner/src/hash').canonicalHash(JSON.parse(fs.readFileSync(process.env.RESULT_FILE,'utf8'))))"

# 검토 완료 후 위 해시를 직접 설정합니다.
$env:REVIEWED_RESULT_HASH = '<검토한 결과 해시>'
$env:CHAIN_ID = '421614'
$env:ESCROW_ADDRESS = '<계약 주소>'
# RUNNER_PRIVATE_KEY와 RPC_URL은 이 환경의 비밀정보 관리 방식으로 주입합니다.
npm run runner:sign
npm run runner:submit
```

Linux/macOS에서도 같은 환경변수를 `export NAME=value`로 설정한 뒤 명령을 실행합니다. 러너 CLI는 `.env`를 자동으로 읽지 않습니다.

서명 도구는 검토 해시, 기준·러너 지문, 커밋 정보, 항목별 결과와 최종 판정의 일관성을 검사합니다. 실패 결과도 일관된 보고서라면 서명할 수 있습니다. 제출 도구는 결과와 서명 메시지의 일치, 체인·컨트랙트 주소, 등록된 서명자를 확인합니다.

서명 키·주소 등 필수 환경변수가 아예 없으면 CLI는 `skipped`로 끝납니다. 환경을 설정한 상태에서 결과 파일이 없거나 검토 해시가 틀리면 오류로 종료합니다. 새 검증 실행은 이전 결과와 서명 파일을 지워 오래된 결과의 혼용을 줄입니다.

## 돈이 움직이는 규칙

| 현재 상태 | 조건 / 호출 | 다음 상태 |
|---|---|---|
| Unfunded — 미예치 | 고객이 대금을 예치 | Funded |
| Funded — 결과 대기 | 유효한 통과 결과 제출 | Submitted |
| Funded | 실패 결과 제출 | Funded 유지, 재작업 |
| Submitted — 이의 기간 | 종료 시각부터 `release()` 호출 | Released |
| Submitted | 종료 전 고객이 보증금을 걸고 이의 신청 | Challenged |
| Challenged — 중재 대기 | 중재자가 개발자 승으로 판정 | Released |
| Challenged | 중재자가 고객 승으로 판정 | Refunded |

이의 기간은 1~30일입니다. 고객·개발자·러너 주소는 서로 달라야 하며, 빈 주소·빈 해시·0원 마일스톤·존재하지 않는 번호를 거절합니다. 중재자 권한의 이전은 가능하지만 포기는 막았습니다. **러너 중단이나 중재 지연에 대한 기한 만료 환불은 미구현**입니다. 수수료를 떼거나 잔액이 자동 변동하는 토큰은 지원하지 않습니다.

<details>
<summary>서명과 해시의 기술 형식</summary>

EIP-712는 구조가 정해진 메시지에 서명하는 표준입니다. 체인 ID와 컨트랙트 주소도 서명에 포함해 다른 곳에서 재사용하지 못하게 합니다.

```text
Domain: ProofOfDelivery / version 1 / chainId / verifyingContract
VerificationResult:
  agreementId       uint256
  milestoneIndex    uint256
  acceptanceHash    bytes32
  commitHash        bytes32
  runnerImageDigest bytes32
  resultHash        bytes32
  passed            bool
  timestamp         uint64
```

`resultHash`는 전체 결과 JSON의 키를 재귀 정렬하고 공백을 제거한 뒤 keccak256을 적용합니다. 추가된 `execution`, `sourceHash`, `sourceCommitted`도 여기에 포함됩니다. 40자리 Git 커밋은 왼쪽을 0으로 채워 bytes32로 변환합니다.

[기준 스키마](../runner/schema/acceptance.schema.json) · [결과 스키마](../runner/schema/result.schema.json)

향후 AI가 인수 기준을 생성할 때도 이 스키마를 출력 형식으로 사용합니다. 생성된 문장만으로 합의가 끝나는 것은 아니며, 사람이 검사 코드와 함께 검토한 후 지문을 고정해야 합니다.

</details>
