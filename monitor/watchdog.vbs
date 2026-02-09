Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """C:\Program Files\nodejs\node.exe"" ""C:\Work_with_Claude\openclaw-kakao\monitor\openclaw-monitor.mjs"" watchdog", 0, True
