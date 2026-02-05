# MessengerBotR Setup Guide

## What is MessengerBotR?

MessengerBotR is an Android app that allows you to create auto-response bots for KakaoTalk and other messaging apps. It works by reading notifications and can send automated replies.

## Installation

1. Open Google Play Store in BlueStacks
2. Search for "MessengerBotR" (메신저봇R)
3. Install the app

## Initial Setup

### 1. Grant Permissions

When you first open MessengerBotR:

1. **Notification Access** - Required to read messages
   - Go to Settings > Apps > Special Access > Notification Access
   - Enable for MessengerBotR

2. **Overlay Permission** - Required for some features
   - Settings > Apps > MessengerBotR > Display over other apps
   - Allow

### 2. Create a New Bot

1. Open MessengerBotR
2. Tap **+** to create a new bot
3. Name it (e.g., "OpenClaw Bot")
4. Select target apps (KakaoTalk)

### 3. Configure the Script

1. Tap on your bot
2. Tap **Edit Script**
3. Delete any existing code
4. Copy the entire contents of `messenger-bot/bot-script.js`
5. Paste into the editor
6. Save the script

### 4. Update Bridge URL

In the script, find this line:

```javascript
var BRIDGE_URL = "http://10.0.2.2:8787/webhook/memento";
```

- `10.0.2.2` is the host machine IP from Android emulator
- If using a real device, change to your PC's IP address

### 5. Enable the Bot

1. Go back to the bot list
2. Toggle the switch to enable your bot
3. You should see a notification that the bot is active

## Testing

### Test Bot Connection

Send `/ping` in KakaoTalk

Expected response: `pong`

### Test Bridge Connection

Send `/bridgeping` in KakaoTalk

Expected response: `BRIDGE: pong`

### Test AI Response

Send `/status` in KakaoTalk

Expected response: System status with bridge uptime and gateway info

## Script Configuration

### Room Filtering

To limit the bot to specific rooms, edit `ALLOW_ROOMS`:

```javascript
var ALLOW_ROOMS = {
  "My Chat Room": true,
  "Another Room": true
};
```

Empty object `{}` allows all rooms.

### Message Length Limit

```javascript
var MAX_LEN = 800;  // Maximum characters per message
```

### Custom Commands

Add new commands in the `handleSlash` function:

```javascript
if (text === "/mycommand") {
  msg.reply("Custom response");
  return true;
}
```

## Troubleshooting

### Bot Not Responding

1. Check if bot is enabled (toggle switch)
2. Verify notification access permission
3. Check if KakaoTalk is in target apps

### BRIDGE_ERR Messages

1. Verify bridge server is running
2. Check BRIDGE_URL is correct
3. Test with `/bridgeping` first

### Script Errors

1. Check for JavaScript syntax errors
2. Use `Log.d("debug", message)` for debugging
3. View logs in MessengerBotR app

### Image Analysis Not Working

1. KakaoTalk must have "Auto-save photos" enabled
2. ADB Watcher must be running
3. Wait for the polling to complete (~15-90 seconds)

## Best Practices

1. **Test in a private chat first** - Before deploying to group chats
2. **Use room filtering** - Limit bot to specific rooms initially
3. **Monitor performance** - Too many requests can slow down the bot
4. **Keep script simple** - Complex logic can cause timeouts
