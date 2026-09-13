# AI 기준 초안과 두 관점 검토

[README](../README.md)

AI는 요구사항에서 기준을 제안하고, 제공된 증거에서 충족·미충족 근거를 검토합니다. 현재 입력은 문서화된 기준과 증거 JSON입니다. 저장소 전체를 자동으로 읽거나 코드를 실행하지 않습니다. 신뢰하지 않는 코드 실행과 AI API 키가 있는 검토 환경을 분리합니다.

## 키 없이 절차 확인

저장소 루트에서 실행합니다. 출력 파일이 이미 있으면 덮어쓰지 않으므로 새 파일명을 사용하세요.

```bash
npm run ai:review -- --synthetic --fixture runner/fixtures/ai-responses.synthetic.json --input runner/fixtures/ai-input.synthetic.json --output runner/out/review-example.json
npm run ai:draft -- --synthetic --fixture runner/fixtures/ai-draft-responses.synthetic.json --input runner/fixtures/ai-draft-input.synthetic.json --output runner/out/draft-example.json
```

`synthetic`는 준비된 응답으로 **실제 파싱·인용 검사·투표 알고리즘**을 실행합니다. 모델에게 질문한 결과나 정확도 평가가 아닙니다. `npm run demo`도 이 모드이며 로컬 체인에서만 동작합니다.

## 실제 모델 연결

사용할 공급자의 Chat Completions 호환 API 주소, 모델명, API 키를 신뢰하는 검토 환경에 설정합니다. CLI는 `.env`를 자동으로 읽지 않습니다. 키를 저장소나 증거 JSON에 넣지 마세요.

```powershell
$env:POD_AI_API_BASE_URL = 'https://api.openai.com/v1'
$env:POD_AI_MODEL = '<JSON 응답과 max_completion_tokens를 지원하는 모델명>'
# POD_AI_API_KEY는 로컬 비밀정보 관리 방식으로 주입
npm run ai:review -- --live --input runner/fixtures/ai-input.synthetic.json --output runner/out/live-example.json
```

이 예제 입력은 공개된 샘플입니다. 실제 납품물에 적용할 때는 개인정보·계약 당사자 정보·비밀정보를 제거한 자료를 사용합니다. 입력 형식이 계정 필드를 받지 않는다고 자유 텍스트가 자동 익명화되지는 않습니다. 라이브 호출에는 공급자 비용이 발생할 수 있으며 자동 재시도나 테스트 응답 대체는 없습니다.

HTTP 어댑터·오류 처리는 자동 테스트했지만, 이 구현 작업에서는 유료 모델을 호출하지 않았습니다. 공급자별 호환성 및 모델 성능은 별도 실험이 필요합니다.

## 판단 규칙

1. 같은 모델·자료로 Advocate와 Challenger가 각각 검토합니다.
2. 모든 항목에서 일치하면 2회 호출로 종료합니다.
3. 하나라도 다르면 역할별로 3회 더 검토합니다. 총 8표 중 항목별 엄격한 과반을 적용하고 4:4는 실패 처리합니다.
4. 항목 누락·중복·잘못된 JSON·없는 인용·시간 초과·거절은 전체 검토를 실패 처리합니다.
5. 실제 실행 검사 실패를 AI 통과로 덮어쓰지 않습니다. 계약에 제출할 근거는 [연결 코드](../runner/src/authority-evidence.ts)로 묶고, 운영자가 별도 환경에서 검토한 뒤 서명해야 합니다.

기본 요청 상한 8회, 회당 출력 상한 4,096토큰, 회당 제한 30초입니다. 모델·프롬프트·투표 방식·실행 제한·모드가 정책 지문에 포함됩니다. 출력에는 각 응답·인용·정책 및 입력 지문·토큰 사용량·소요 시간이 남습니다.

인용의 존재 여부만 기계적으로 검사합니다. 문맥에 맞는 인용인지, 같은 모델의 반복 판단이 정확한지는 보장하지 않습니다. 외부 자료의 지시를 따르지 않도록 프롬프트를 구성했지만, 프롬프트 주입 공격을 해결했다고 주장하지 않습니다.

초안 결과는 `requiresBilateralApproval: true`, `executable: false`입니다. 모호한 조건은 질문으로 남기며 사람이 테스트 코드로 구체화한 뒤 양측이 승인해야 합니다.
