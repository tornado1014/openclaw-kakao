# Troubleshooting Guide

## Common Issues

### Bridge Server

#### "BRIDGE_FAIL" or Connection Refused

**Symptoms:**
- `/bridgeping` returns "BRIDGE_FAIL"
- MessengerBotR shows connection errors

**Solutions:**
1. Check if bridge server is running:
   ```bash
   cd bridge
   npm start
   ```

2. Verify port 8787 is not blocked:
   ```bash
   netstat -ano | findstr :8787
   ```

3. Check Windows Firewall allows the connection

4. If using real device, ensure PC and phone are on same network

#### "Missing OPENCLAW_GATEWAY_TOKEN"

**Symptoms:**
- Bridge starts but requests fail
- "BRIDGE_GATEWAY_ERR: Missing OPENCLAW_GATEWAY_TOKEN"

**Solutions:**
1. Check `.env` file has valid token:
   ```env
   OPENCLAW_GATEWAY_TOKEN=your-token-here
   ```

2. Get token from:
   ```bash
   openclaw gateway status
   ```

3. Or from `~/.openclaw/openclaw.json`

### OpenClaw Gateway

#### Gateway Not Running

**Symptoms:**
- `/status` shows gateway connection error
- "Gateway 502" or connection refused errors

**Solutions:**
1. Start the gateway:
   ```bash
   openclaw gateway start
   ```

2. Check gateway status:
   ```bash
   openclaw gateway status
   ```

3. View logs:
   ```bash
   openclaw gateway logs
   ```

#### Gateway Authentication Failed

**Symptoms:**
- "unauthorized" or "403" errors

**Solutions:**
1. Verify token matches gateway configuration
2. Regenerate token if needed:
   ```bash
   openclaw gateway token
   ```

### ADB Watcher

#### "ADB 연결 실패"

**Symptoms:**
- ADB Watcher cannot connect to BlueStacks

**Solutions:**
1. Enable ADB in BlueStacks:
   - Settings > Advanced > Android Debug Bridge

2. Restart BlueStacks

3. Try auto-port detection:
   ```bash
   python adb_watcher.py --auto-port
   ```

4. Manually specify port:
   ```bash
   python adb_watcher.py --port 5556
   ```

#### "카카오톡 이미지 폴더를 찾을 수 없습니다"

**Symptoms:**
- ADB connects but can't find image folder

**Solutions:**
1. Send at least one image via KakaoTalk first

2. Enable "Auto-save photos" in KakaoTalk:
   - Settings > Chat > Auto-save photos

3. Check possible paths:
   ```bash
   adb shell ls /sdcard/Pictures/KakaoTalk/
   adb shell ls /sdcard/Download/KakaoTalk/
   ```

#### Duplicate Images Being Processed

**Symptoms:**
- Same image analyzed multiple times

**Solutions:**
1. Check hash tracking is working:
   - Look for `processed_hashes.json` in image directory

2. Reset tracking if corrupted:
   ```bash
   python adb_watcher.py --reset
   ```

### MessengerBotR

#### Bot Not Responding to Messages

**Symptoms:**
- No response from bot at all

**Solutions:**
1. Check bot is enabled (toggle switch in app)

2. Verify notification access:
   - Android Settings > Apps > Special Access > Notification Access
   - Enable for MessengerBotR

3. Check KakaoTalk is in target apps list

4. Test with `/ping` first (local bot check)

#### "RAW:" Responses

**Symptoms:**
- Responses start with "RAW:" followed by text

**Solutions:**
- This indicates JSON parsing failed
- Check bridge server logs for errors
- Verify bridge is returning proper JSON

### Image Analysis

#### "이미지 분석 시간 초과"

**Symptoms:**
- Image analysis times out after 90 seconds

**Solutions:**
1. Check ADB Watcher is running

2. Verify KakaoTalk image auto-save is enabled

3. Check bridge logs for errors

4. Wait longer (first analysis may take time)

#### Gemini Fallback Messages

**Symptoms:**
- Responses say "(Gemini 폴백)"

**Solutions:**
- This is expected when OpenClaw Gateway is unavailable
- To disable, remove `GOOGLE_API_KEY` from `.env`

## Log Locations

| Component | Log Location |
|-----------|-------------|
| Bridge Server | Console output |
| ADB Watcher | Console output |
| MessengerBotR | In-app log viewer |
| OpenClaw Gateway | `openclaw gateway logs` |

## Resetting Everything

If things are completely broken:

```bash
# Stop all services
# (Ctrl+C on bridge and watcher)

# Reset processed files
rm watcher/processed_files.json
rm watcher/processed_hashes.json
rm -rf kakao-images/*

# Restart services
cd bridge && npm start
# In another terminal
cd watcher && python adb_watcher.py --auto-port --reset
```

## Getting Help

1. Check logs for specific error messages
2. Test each component individually
3. Verify environment variables are set correctly
4. Open an issue on GitHub with:
   - Error message
   - Steps to reproduce
   - Environment details (OS, Node version, etc.)
