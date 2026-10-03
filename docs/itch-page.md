# itch.io 페이지 안내문 초안

아래 "본문 시작"부터 "본문 끝"까지를 페이지 설명에 그대로 붙여 넣으세요.

<!-- 본문 시작 -->
**ChatGPT Plus 또는 Pro 구독자만 AI 플레이가 가능합니다.**

## Second Read — 나를 읽는 마피아

기존 AI 마피아는 판이 끝나면 나를 잊습니다. 이 게임은 판이 쌓일수록 AI가 나를 읽고, 나는 읽힌 나를 속입니다.

- 클릭만으로 하는 턴제 마피아. 한 판 2~4분.
- AI 라이벌 4명이 각자 다른 습관을 지켜봅니다. "마피아일 때만 제일 먼저 투표하시네요." 3~4판째쯤 그 말이 나옵니다.
- 들켰다 싶으면 습관을 바꾸세요. 라이벌을 속이면 기록됩니다.
- 판이 끝날 때마다 **AI가 본 당신**: 라이벌들의 연구 노트와 기억 때문에 바뀐 표를 보여줍니다.

### ChatGPT로 로그인

게임을 열고 **Continue with ChatGPT**를 누르면 브라우저에서 ChatGPT 로그인이 열립니다. 허용하면 라이벌 대사가 **본인 ChatGPT 플랜 사용량**으로 생성됩니다(API 키 불필요). 판당 AI 호출은 최대 3회입니다. 사용량과 이 앱의 한도는 [ChatGPT 설정 → Usage](https://chatgpt.com/settings/usage)에서 관리할 수 있습니다.

로그인하지 않아도 **AI 없이 규칙 체험**으로 같은 규칙과 같은 기억 시스템을 미리 쓴 대사로 해볼 수 있습니다.

### 꼭 읽어주세요

- **받아서 직접 실행하세요.** itch.io 앱 안에서 실행하면 로컬 로그인(브라우저 → 127.0.0.1 콜백)이 막힐 수 있습니다. 파일을 내려받아 압축을 풀거나 설치한 뒤 직접 여세요.
- **macOS 보안 경고**: 이 앱은 Apple 공증을 받지 않았습니다. 처음 열 때 "확인되지 않은 개발자" 경고가 뜨면
  1. dmg에서 `Second Read`를 응용 프로그램 폴더로 옮깁니다.
  2. 앱을 한 번 열어 경고를 닫은 뒤 **시스템 설정 → 개인정보 보호 및 보안** 아래쪽의 **그래도 열기**를 누릅니다.
  3. (그래도 "손상되었습니다"라고 나오면) 터미널에서 `xattr -dr com.apple.quarantine "/Applications/Second Read.app"` 실행 후 다시 엽니다.
- **Windows SmartScreen**: "Windows의 PC 보호" 창이 뜨면 **추가 정보 → 실행**을 누르세요. zip 버전은 압축을 푼 폴더에서 `Second Read.exe`를 실행합니다.
- 기억(텔) 데이터는 내 컴퓨터에만 저장됩니다. 게임 밖 개인정보는 저장하지 않습니다. 설정에서 언제든 기억을 끄거나 초기화할 수 있습니다.

### 오픈소스

소스 코드(MIT): https://github.com/hanariago/second-read
<!-- 본문 끝 -->

---

## 업로드 설정 메모 (페이지에 넣지 않음)

- 페이지 종류: Downloadable (브라우저 플레이 아님)
- `SecondRead-<버전>-mac-universal.dmg` → **macOS** 표시
- `SecondRead-<버전>-win-x64.zip` 와 `SecondRead-<버전>-win-x64.exe`(설치형) → **Windows** 표시
- 파일은 GitHub Releases에서 받을 수 있음: https://github.com/hanariago/second-read/releases
