# OpenClaw-Kakao

> KakaoTalk chatbot powered by OpenClaw Gateway and Claude AI

[한국어](README.ko.md)

## Features

- 🤖 **AI-powered responses** - Claude AI handles text conversations
- 🖼️ **Image analysis** - Claude Vision analyzes images sent via KakaoTalk
- 📱 **BlueStacks integration** - Works with KakaoTalk on Android emulator
- 🔄 **Session management** - Maintains conversation context per user/room
- 🌉 **Bridge architecture** - Lightweight Node.js server connects components

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│  BlueStacks     │     │   Bridge     │     │  OpenClaw       │
│  KakaoTalk      │────▶│   Server     │────▶│  Gateway        │
│  + MessengerBotR│     │  (Node.js)   │     │  (Claude AI)    │
└─────────────────┘     └──────────────┘     └─────────────────┘
                               │
                        ┌──────┴──────┐
                        │ ADB Watcher │
                        │  (Python)   │
                        └─────────────┘
```

### Data Flow

**Text Messages:**
1. User sends message in KakaoTalk
2. MessengerBotR detects notification and sends to Bridge
3. Bridge forwards to OpenClaw Gateway
4. Claude AI generates response
5. Response sent back to KakaoTalk

**Image Messages:**
1. User sends image in KakaoTalk
2. KakaoTalk auto-saves image to device storage
3. ADB Watcher detects new image and downloads it
4. Image sent to Bridge → Gateway → Claude Vision
5. Analysis result polled back to KakaoTalk

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Python](https://python.org/) 3.8+
- [BlueStacks 5](https://www.bluestacks.com/)
- [MessengerBotR](https://play.google.com/store/apps/details?id=com.xfl.msgbot) app
- [OpenClaw CLI](https://github.com/anthropics/openclaw) installed and configured

### Installation

```bash
# Clone repository
git clone https://github.com/YOUR_USERNAME/openclaw-kakao.git
cd openclaw-kakao

# Install Node.js dependencies
cd bridge
npm install
cd ..

# Install Python dependencies
cd watcher
pip install -r requirements.txt
cd ..

# Configure environment
cp .env.example .env
# Edit .env with your settings
```

### Configuration

Edit `.env` file:

```env
# Required - get from 'openclaw gateway status'
OPENCLAW_GATEWAY_URL=http://localhost:25382
OPENCLAW_GATEWAY_TOKEN=your-gateway-token

# Optional - for image analysis fallback
GOOGLE_API_KEY=your-gemini-api-key
```

### Running

1. **Start OpenClaw Gateway**
   ```bash
   openclaw gateway start
   ```

2. **Start Bridge Server**
   ```bash
   cd bridge
   npm start
   ```

3. **Start ADB Watcher** (for image support)
   ```bash
   cd watcher
   python adb_watcher.py --auto-port
   ```

4. **Configure MessengerBotR**
   - Copy contents of `messenger-bot/bot-script.js` to MessengerBotR editor
   - Enable the bot

## Commands

| Command | Description |
|---------|-------------|
| `/ping` | Check bot status |
| `/bridgeping` | Check bridge connection |
| `/status` | Show system status |
| `/clear` | Reset conversation session |
| `/whoami` | Show session key |
| `/help` | Show help |
| `/on` | Enable bot |
| `/off` | Disable bot |

**In private chat:** Just send a message for AI response

**In group chat:** Use `/질문 <message>` to ask AI

## Documentation

- [Architecture Details](docs/architecture.md)
- [BlueStacks Setup](docs/setup-bluestacks.md)
- [MessengerBotR Setup](docs/setup-messengerbot.md)
- [Troubleshooting](docs/troubleshooting.md)

## Troubleshooting

### Bridge connection failed
- Check if bridge server is running on port 8787
- Verify BlueStacks ADB is enabled

### No AI response
- Check OpenClaw Gateway status: `openclaw gateway status`
- Verify gateway token in `.env`

### Image analysis not working
- Ensure ADB Watcher is running
- Check KakaoTalk "Auto-save photos" setting is enabled

## Contributing

Contributions are welcome! Please read the contributing guidelines first.

## License

MIT License - see [LICENSE](LICENSE) for details.
