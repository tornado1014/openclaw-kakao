# BlueStacks Setup Guide

## Prerequisites

- Windows 10/11
- 8GB+ RAM recommended
- Virtualization enabled in BIOS

## Installation

### 1. Download BlueStacks

Download BlueStacks 5 from [bluestacks.com](https://www.bluestacks.com/)

### 2. Install BlueStacks

Run the installer and follow the setup wizard.

### 3. Enable ADB

1. Open BlueStacks
2. Click **Settings** (gear icon)
3. Go to **Advanced**
4. Enable **Android Debug Bridge (ADB)**
5. Note the ADB port (default: 5555)

![ADB Settings](https://via.placeholder.com/600x400?text=BlueStacks+ADB+Settings)

### 4. Install KakaoTalk

1. Open Google Play Store in BlueStacks
2. Search for "KakaoTalk"
3. Install and sign in with your account

### 5. Configure KakaoTalk

**Enable auto-save for images:**

1. Open KakaoTalk
2. Go to **Settings** > **Chat**
3. Enable **Auto-save photos**
4. Choose storage location (default is fine)

**Notification settings:**

1. Go to **Settings** > **Notifications**
2. Enable notifications for messages
3. Set notification style to show message content

### 6. Install MessengerBotR

1. Open Google Play Store
2. Search for "MessengerBotR" or "메신저봇R"
3. Install the app

## Verify ADB Connection

Open PowerShell/Command Prompt on your host machine:

```bash
# Check if ADB is available
adb version

# Connect to BlueStacks
adb connect 127.0.0.1:5555

# Verify connection
adb devices
# Should show: 127.0.0.1:5555    device

# Test shell access
adb shell echo "Hello"
# Should print: Hello
```

### BlueStacks ADB Path

If you don't have system ADB installed, use BlueStacks built-in ADB:

```
C:\Program Files\BlueStacks_nxt\HD-Adb.exe
```

## Troubleshooting

### ADB Connection Failed

1. Restart BlueStacks
2. Disable and re-enable ADB in settings
3. Try different ports: 5555, 5556, 5557

### KakaoTalk Not Saving Images

1. Check storage permissions for KakaoTalk
2. Verify "Auto-save photos" is enabled
3. Ensure sufficient storage space

### BlueStacks Performance Issues

1. Allocate more RAM in BlueStacks settings
2. Enable virtualization in BIOS
3. Update graphics drivers
