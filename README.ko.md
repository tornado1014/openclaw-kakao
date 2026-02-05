# OpenClaw-Kakao

> OpenClaw Gateway와 Claude AI를 활용한 카카오톡 챗봇

[English](README.md)

## 주요 기능

- 🤖 **AI 자동 응답** - Claude AI가 텍스트 대화 처리
- 🖼️ **이미지 분석** - 카카오톡으로 보낸 이미지를 Claude Vision이 분석
- 📱 **BlueStacks 연동** - 안드로이드 에뮬레이터의 카카오톡과 연동
- 🔄 **세션 관리** - 사용자/방별 대화 컨텍스트 유지
- 🌉 **브릿지 아키텍처** - 경량 Node.js 서버로 컴포넌트 연결

## 아키텍처

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│  BlueStacks     │     │   브릿지     │     │  OpenClaw       │
│  카카오톡       │────▶│   서버       │────▶│  Gateway        │
│  + 메신저봇R    │     │  (Node.js)   │     │  (Claude AI)    │
└─────────────────┘     └──────────────┘     └─────────────────┘
                               │
                        ┌──────┴──────┐
                        │ ADB Watcher │
                        │  (Python)   │
                        └─────────────┘
```

### 데이터 흐름

**텍스트 메시지:**
1. 사용자가 카카오톡에서 메시지 전송
2. 메신저봇R이 알림 감지 후 브릿지로 전송
3. 브릿지가 OpenClaw Gateway로 전달
4. Claude AI가 응답 생성
5. 응답이 카카오톡으로 전달

**이미지 메시지:**
1. 사용자가 카카오톡으로 이미지 전송
2. 카카오톡이 자동으로 기기에 이미지 저장
3. ADB Watcher가 새 이미지 감지 및 다운로드
4. 브릿지 → Gateway → Claude Vision으로 전송
5. 분석 결과를 폴링하여 카카오톡으로 전달

## 빠른 시작

### 필수 요구사항

- [Node.js](https://nodejs.org/) 18+
- [Python](https://python.org/) 3.8+
- [BlueStacks 5](https://www.bluestacks.com/)
- [MessengerBotR](https://play.google.com/store/apps/details?id=com.xfl.msgbot) 앱
- [OpenClaw CLI](https://github.com/anthropics/openclaw) 설치 및 설정

### 설치

```bash
# 저장소 클론
git clone https://github.com/YOUR_USERNAME/openclaw-kakao.git
cd openclaw-kakao

# Node.js 의존성 설치
cd bridge
npm install
cd ..

# Python 의존성 설치
cd watcher
pip install -r requirements.txt
cd ..

# 환경 설정
cp .env.example .env
# .env 파일 편집
```

### 환경 설정

`.env` 파일 편집:

```env
# 필수 - 'openclaw gateway status'에서 확인
OPENCLAW_GATEWAY_URL=http://localhost:25382
OPENCLAW_GATEWAY_TOKEN=your-gateway-token

# 선택 - 이미지 분석 폴백용
GOOGLE_API_KEY=your-gemini-api-key
```

### 실행

1. **OpenClaw Gateway 시작**
   ```bash
   openclaw gateway start
   ```

2. **브릿지 서버 시작**
   ```bash
   cd bridge
   npm start
   ```

3. **ADB Watcher 시작** (이미지 지원용)
   ```bash
   cd watcher
   python adb_watcher.py --auto-port
   ```

4. **MessengerBotR 설정**
   - `messenger-bot/bot-script.js` 내용을 MessengerBotR 에디터에 복사
   - 봇 활성화

## 명령어

| 명령어 | 설명 |
|--------|------|
| `/ping` | 봇 상태 확인 |
| `/bridgeping` | 브릿지 연결 확인 |
| `/status` | 시스템 상태 |
| `/clear` | 대화 세션 초기화 |
| `/whoami` | 세션 키 확인 |
| `/help` | 도움말 |
| `/on` | 봇 활성화 |
| `/off` | 봇 비활성화 |

**개인 채팅:** 그냥 메시지를 보내면 AI가 응답

**그룹 채팅:** `/질문 <내용>`으로 AI에게 질문

## 문서

- [아키텍처 상세](docs/architecture.md)
- [BlueStacks 설정](docs/setup-bluestacks.md)
- [MessengerBotR 설정](docs/setup-messengerbot.md)
- [문제 해결](docs/troubleshooting.md)

## 문제 해결

### 브릿지 연결 실패
- 브릿지 서버가 8787 포트에서 실행 중인지 확인
- BlueStacks ADB가 활성화되어 있는지 확인

### AI 응답 없음
- OpenClaw Gateway 상태 확인: `openclaw gateway status`
- `.env`의 gateway 토큰 확인

### 이미지 분석 작동 안 함
- ADB Watcher가 실행 중인지 확인
- 카카오톡 "사진 자동 저장" 설정 확인

## 기여

기여를 환영합니다! 먼저 기여 가이드라인을 읽어주세요.

## 라이선스

MIT 라이선스 - 자세한 내용은 [LICENSE](LICENSE)를 참조하세요.
