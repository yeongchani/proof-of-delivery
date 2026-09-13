# 코드 안내

[README](../README.md)

계약은 대금과 지급 조건을 관리하고, 러너는 납품물을 검사해 서명할 근거를 만듭니다. 아래에서 각 기능의 코드와 테스트를 찾을 수 있습니다.

## 계약과 정산

구현: [AuthorityEscrow.sol](../contracts/contracts/AuthorityEscrow.sol)

| 기능 | 주요 함수 | 동작 |
| --- | --- | --- |
| 계약 합의와 예치 | `createAgreement`, `acceptAgreement`, `fund`, `depositDevBond` | 양측 승인 후 대금과 개발자 보증금 예치 |
| 검증자 변경·권한 회수 | `approveAuthority`, `revokeAuthority` | 양측 동의로 검증자 변경, 권한 회수 시 새 결과 접수 중단 |
| 결과 접수 | `submitResult` | 등록된 검증자의 서명과 계약 조건 확인 |
| 소스 인계와 지급 | `revealSourceKey` | 이의 기간 이후 키 공개와 지급을 같은 거래에서 처리 |
| 이의 신청과 중재 | `challenge`, `resolve` | 발주자는 통과에, 개발자는 불통과에 이의 신청 |
| 요구사항 변경 | `approveReplacement` | 양측 합의로 기존 계약을 정산하고 후속 계약 연결 |
| 보관금 지급 | `releaseRetention` | 합의한 보관 기간 이후 남은 대금 지급 |
| 기한 초과 환불 | `refundTimeout` | 예치·납품·중재·인계 기한에 따른 반환 |

[계약 테스트](../contracts/test/AuthorityEscrow.test.ts)와 [상태 전환 테스트](../contracts/test/AuthorityEscrow.lifecycle.test.ts)에서 서명 재사용, 기한 경계, 이의 신청, 후속 계약, 잔액을 확인합니다. 운영 절차는 [계약 안내](authority.md)에 있습니다.

## 납품 검사와 AI 검토

| 기능 | 구현 | 테스트 |
| --- | --- | --- |
| 합의한 기준과 테스트 실행 | [실행기](../runner/src/run-tests.ts), [검수 묶음](../runner/src/approved-policy.ts) | [검수 묶음 테스트](../runner/test/approved-policy.test.ts) |
| 검사할 소스 수집과 지문 생성 | [소스 증거](../runner/src/source-review.ts) | [소스 테스트](../runner/test/source-review.test.ts) |
| 승인된 파일·패키지만 사용 | [의존성 검사](../runner/src/dependency-guard.ts) | [경로·패키지 테스트](../runner/test/dependency-guard.test.ts) |
| 두 관점의 AI 검토와 인용 확인 | [AI 검토](../runner/src/ai-review.ts) | [검토 테스트](../runner/test/ai-review.test.ts), [사용량 제한 테스트](../runner/test/ai-token-budget.test.ts) |
| 실행 결과·소스·AI 기록 연결 | [정산 근거](../runner/src/authority-evidence.ts) | [근거 검증 테스트](../runner/test/authority-evidence.test.ts) |
| 납품 파일 암호화와 복원 | [소스 인계](../runner/src/delivery.ts) | [인계 테스트](../runner/test/delivery.test.ts) |

AI에는 소스 원문과 실행 결과를 함께 제공합니다. 실행 검사가 실패하면 AI 의견만으로 지급용 통과 결과를 만들지 않습니다. 실제 모델 호출 기록과 측정 범위는 [실행 결과](codex-live.md)를 참고하세요.

## 명령줄 도구

- [계약 명령](../runner/src/authority-cli.ts): 근거 생성, 서명, 제출 전 시뮬레이션, 거래 제출
- [소스 인계 명령](../runner/src/delivery-cli.ts): 암호화 파일과 별도 키 생성
- [지급 호출 도구](../runner/src/keeper.ts): 기한이 도래한 계약 확인과 처리
- [배포 스크립트](../contracts/scripts/deploy-authority.ts): 배포 비용 추정과 명시적으로 선택한 배포

설정과 명령 예제는 [사용 방법](authority-cli.md)에 있습니다. [CLI 데모](../contracts/scripts/demo-cli.ts)는 로컬 체인에서 계약 생성부터 인계·지급까지 연결합니다.

## 검증 실행

```bash
npm ci --ignore-scripts
npm test
npm run typecheck
npm run demo
npm run demo:cli
```

기본 데모와 CI는 고정된 테스트용 AI 응답을 사용합니다. 실제 모델을 연결하려면 [AI 실행 안내](ai-review.md)를 따라 `npm run demo:codex`를 실행합니다.

현재 지원 범위는 제한된 JS/TS·Express 소스와 별도로 승인한 테스트 묶음입니다. 코드 지문과 서명은 기록의 일치 여부를 확인하며, 러너의 정직성이나 AI 판단의 정확도를 증명하지는 않습니다. 실행 환경과 운영상의 한계는 [README](../README.md#어디까지-믿을-수-있나요)에 정리했습니다.
