# Second Read — 나를 읽는 마피아

> 기존 AI 마피아는 판이 끝나면 나를 잊는다. 이 게임은 판이 쌓일수록 AI가 나를 읽고, 나는 읽힌 나를 속인다.

턴제·클릭 전용 소셜 디덕션 게임입니다. AI 라이벌 4명이 **여러 판에 걸쳐** 당신의 습관(텔)을 기억하고, 다음 판에서 그 기록을 근거로 의심하거나 믿습니다. 읽혔다 싶으면 습관을 바꿔 속이세요. 속인 횟수도 기록됩니다.

- **ChatGPT Plus / Pro 구독자 전용 AI 플레이.** [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source)로 로그인하면 라이벌 대사가 본인 ChatGPT 플랜 사용량으로 생성됩니다. API 키가 필요 없습니다.
- 로그인 없이도 **AI 없이 규칙 체험**(미리 쓴 대사)으로 똑같은 판단 로직을 플레이할 수 있습니다.
- 텔 데이터는 **이 컴퓨터에만** 저장됩니다. 게임 안 클릭 기록 외의 개인정보는 저장하지 않습니다.

## 플레이

- 5명(당신 + 라이벌 4명), 마피아 1 · 예언자 1 · 시민 3. 최대 2일, 한 판 2~4분.
- 낮: 한 마디(의심 / 감싸기 / 관망 / 예언 결과 공개) → 처형 투표. 투표는 라이벌이 하나씩 표를 던지는 동안 **언제 던질지도** 당신의 선택입니다.
- 밤: 마피아는 제거, 예언자는 조사, 시민은 잠.
- 판이 끝나면 **AI가 본 당신** 화면에서 라이벌별 연구 노트(역할별 습관 통계), 기억 때문에 바뀐 투표, 누적 읽힘/속임 점수를 보여줍니다.

| 라이벌 | 성격 | 지켜보는 텔 |
| --- | --- | --- |
| 레온 (회계사) | 침착, 확신이 서야 움직임 | 투표 타이밍 (가장 먼저 투표하는가) |
| 미오 (바리스타) | 수다, 감으로 빠르게 찍음 | 첫 마디 성향 (의심부터 / 관망부터) |
| 브루노 (은퇴 형사) | 고집, 대세를 의심 | 대세 편승 (표 몰린 쪽에 붙는가) |
| 세라 (체스 기사) | 차분, 뒤끝 있음 | 보복 패턴 (나를 의심한 사람에게 투표 / 밤에 제거) |

## 설계 원칙

1. **기억은 판단에 들어간다.** 텔은 역할별 행동 빈도 차이(마피아일 때 vs 시민일 때)를 최근 판일수록 무겁게 센 뒤 우도비로 의심 점수에 더해집니다. 투표·발언 대상은 코드가 정합니다. 설정에서 기억을 끄면 이 항이 0이 되어 같은 판을 기억 없이 비교할 수 있습니다.
2. **기억은 지어내지 않는다.** 모델은 텔 통계나 기록을 보지 못하고, 코드가 만든 근거 문장(ID 포함)만 받습니다. 응답은 검증기를 통과해야 하며(근거 ID, 숫자, 대상 이름, 근거 없는 '지난 판' 언급 금지), 실패하면 같은 근거로 만든 템플릿 대사로 대체됩니다.
3. **AI는 틀릴 수 있다.** 텔은 확률로만 쓰이고(라플라스 평활, 상한 있음) 성격별 무작위성이 섞입니다. 습관을 바꾸면 라이벌이 오판하고, 그건 '속임'으로 기록됩니다.
4. **토큰은 판당 상한이 있다.** AI 호출은 판당 최대 3회(1일차 발언, 2일차 발언, 종료 후 한마디)이고, 매 호출은 필요한 맥락만 담아 상태 없이 보냅니다. 판이 쌓여도 입력 크기가 늘지 않습니다.

## 구조

```
src/core/     게임 엔진, 텔 추출·모델, 프로필 (순수 JS, DOM·네트워크 없음)
src/ai/       대사 서비스: 프롬프트, 검증기, 템플릿, 전송 계층 인터페이스
src/store/    텔 저장 계층 인터페이스 (Electron 파일 / localStorage / 메모리)
app/          Electron 메인: Sign in with ChatGPT, Responses API 스트리밍, 로컬 파일
renderer/     UI
sim/          헤드리스 시뮬레이션 (기억 켬/끔 비교)
test/         단위 테스트
```

AI 호출 계층(`src/ai/dialogue.js`의 transport)과 텔 저장 계층(`src/store/tellStore.js`)은 게임 로직과 분리되어 있어, 호스팅 승인이 나면 브라우저 빌드에서 전송/저장 구현만 바꿔 끼우면 됩니다.

### ChatGPT 연동 요약

- OAuth: `dynamic_agent_client` 최초 등록 → 발급된 `client_id` 재사용, `ext_agent_host_id`(`urn:uuid:`) 설치당 1회 생성·유지, PKCE S256, 콜백 `http://127.0.0.1:<포트>/auth/callback`(기본 1455, 사용 중이면 임의 포트).
- ID 토큰은 OpenAI JWKS로 서명·issuer·audience·nonce 검증, `chatgpt.tokens.use.direct` 스코프가 있을 때만 AI 사용.
- 토큰은 메인 프로세스에서만 다루며 사용자 데이터 폴더의 `auth/` 아래 0600 파일로 원자적 저장. 만료 5분 전 갱신(직렬화), 로그아웃 시 리프레시 토큰 폐기 요청.
- Responses API: `store:false`, `stream:true`, `instructions` + `input` 배열만 사용. `temperature`, `max_output_tokens` 등 미지원 필드는 보내지 않습니다. `reasoning.effort: low`와 JSON 스키마 출력은 모델이 거부하면 자동으로 빼고 재시도합니다.
- 사용 한도 오류 시 **Manage usage**(ChatGPT 설정 → Usage)를 1순위 동작으로 안내합니다.

## 개발

```bash
npm install
npm start            # 앱 실행
npm test             # 단위 테스트
npm run sim          # 시뮬레이션: 텔이 처음 드러나는 판, 기억 켬/끔 비교
npm run selfcheck    # 실제 앱 경로 자동 점검 (격리된 데이터 폴더, 브라우저 안 엶)
npm run dist:mac     # macOS universal dmg/zip (ad-hoc 서명)
npm run dist:win     # Windows x64 zip + 설치 파일
```

외장 디스크(exFAT 등)에서 mac universal 빌드가 asar 읽기 오류로 실패하면 출력 폴더를 로컬 디스크로 지정하세요: `npx electron-builder --mac -c.directories.output=/tmp/second-read-dist`.

### 서명·공증 (선택)

기본 mac 빌드는 ad-hoc 서명입니다. Apple Developer 계정이 있으면:

```bash
CSC_NAME="Developer ID Application: <이름> (<팀ID>)" \
APPLE_ID=<apple id> APPLE_APP_SPECIFIC_PASSWORD=<앱 암호> APPLE_TEAM_ID=<팀ID> \
npx electron-builder --mac -c.mac.identity="$CSC_NAME" -c.mac.hardenedRuntime=true -c.mac.notarize=true
```

## 저장 위치

| OS | 경로 |
| --- | --- |
| macOS | `~/Library/Application Support/Second Read/` |
| Windows | `%APPDATA%\Second Read\` |

`profile.json`(텔 기록), `metrics.json`(응답 시간·토큰 측정), `settings.json`(모델 선택), `auth/`(로그인 정보, 공유 금지).

## 라이선스

MIT. ChatGPT 로고는 OpenAI의 승인된 Sign in with ChatGPT 버튼 에셋이며 MIT 라이선스 대상이 아닙니다.
