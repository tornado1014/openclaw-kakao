# Architecture

## System Overview

OpenClaw-Kakao consists of four main components:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Host Machine (Windows)                    │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │  Bridge Server  │  │  ADB Watcher    │  │  OpenClaw       │ │
│  │  (Node.js)      │  │  (Python)       │  │  Gateway        │ │
│  │  Port: 8787     │  │                 │  │  Port: 25382    │ │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘ │
│           │                    │                     │          │
│           │    ┌───────────────┘                     │          │
│           │    │                                     │          │
│  ┌────────┴────┴─────────────────────────────────────┘          │
│  │                                                              │
│  └──────────────────────────────┐                               │
│                                 │                               │
│  ┌──────────────────────────────┴────────────────────────────┐ │
│  │                    BlueStacks (Android)                    │ │
│  │  ┌─────────────────┐  ┌─────────────────────────────────┐ │ │
│  │  │   KakaoTalk     │  │      MessengerBotR              │ │ │
│  │  │   (Chat App)    │  │  (Auto-response bot framework)  │ │ │
│  │  └─────────────────┘  └─────────────────────────────────┘ │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Bridge Server (Node.js)

**Purpose:** Central hub connecting all components

**Endpoints:**
- `GET /ping` - Health check
- `POST /webhook/memento` - Receives messages from MessengerBotR
- `POST /webhook/image` - Receives images from ADB Watcher
- `GET /check-image-result` - Returns pending image analysis results
- `GET /images/{filename}` - Serves saved images

**Key Functions:**
- Session management (per user/room)
- Message routing to Gateway
- Image storage and serving
- Gemini fallback for image analysis

### 2. ADB Watcher (Python)

**Purpose:** Monitors BlueStacks for new KakaoTalk images

**Process:**
1. Connects to BlueStacks via ADB (port 5555)
2. Polls KakaoTalk image folder (e.g., `/sdcard/Pictures/KakaoTalk/`)
3. Downloads new images to local storage
4. Sends images to Bridge server

**Features:**
- Auto-port detection
- Duplicate detection (MD5 hash)
- Persistent file tracking

### 3. MessengerBotR Script

**Purpose:** Captures KakaoTalk messages and sends to Bridge

**Process:**
1. Listens for KakaoTalk notification events
2. Extracts message content, sender, room info
3. Sends to Bridge via HTTP POST
4. Receives response and sends reply

**Features:**
- Slash command handling
- Group chat support (`/질문` prefix)
- Image notification detection
- Session management commands

### 4. OpenClaw Gateway

**Purpose:** AI backend providing Claude API access

**Features:**
- Chat completions API
- Session/conversation management
- Tool invocation
- Multi-agent support

## Data Flow

### Text Message Flow

```
User → KakaoTalk → MessengerBotR → Bridge → Gateway → Claude
                                                          │
User ← KakaoTalk ← MessengerBotR ← Bridge ← Gateway ←────┘
```

### Image Message Flow

```
User → KakaoTalk → [Auto-save to /sdcard]
                           │
                    ADB Watcher (poll)
                           │
                    Download via ADB
                           │
                    Bridge Server → Gateway → Claude Vision
                           │
                    Store result (pending)
                           │
MessengerBotR → Bridge (poll /check-image-result)
     │
User ← KakaoTalk ← [Reply with analysis]
```

## Network Configuration

### BlueStacks Internal Network

- `10.0.2.2` - Host machine from Android emulator
- `127.0.0.1:5555` - ADB connection to BlueStacks

### Ports

| Port | Service |
|------|---------|
| 8787 | Bridge Server |
| 25382 | OpenClaw Gateway |
| 5555 | BlueStacks ADB |

## Session Management

Sessions are managed per user/room combination:

```
Session Key: memento:{sender}@{room}#{generation}
```

- **sender**: User's KakaoTalk display name
- **room**: Chat room name
- **generation**: Incremented on `/clear` command

## Error Handling

### Bridge Server
- Returns error messages in JSON format
- Logs errors to console
- Gemini fallback for image analysis failures

### ADB Watcher
- Automatic reconnection on ADB disconnection
- File hash tracking prevents duplicate processing
- Graceful shutdown on Ctrl+C

### MessengerBotR
- Timeout handling for HTTP requests
- Retry mechanism for image polling
- Error message display to user
