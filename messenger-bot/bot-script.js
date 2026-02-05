/**
 * MessengerBotR Script for OpenClaw-Kakao
 *
 * 이 스크립트를 MessengerBotR 앱 에디터에 복사하세요.
 *
 * 설정:
 *   BRIDGE_URL: 브릿지 서버 URL (기본: http://10.0.2.2:8787)
 *   - 10.0.2.2는 Android 에뮬레이터에서 호스트 머신을 가리킵니다
 *   - 실제 기기에서는 호스트 머신의 IP 주소를 사용하세요
 */

var bot = BotManager.getCurrentBot();

// ============================================================
// 설정 (필요에 따라 수정)
// ============================================================
var BRIDGE_URL = "http://10.0.2.2:8787/webhook/memento";
var BRIDGE_BASE = "http://10.0.2.2:8787";
var ENABLED = true;
var MAX_LEN = 800;
var ALLOW_ROOMS = {};  // 빈 객체 = 모든 방 허용, { "방이름": true } = 특정 방만 허용

// ============================================================
// 유틸리티 함수
// ============================================================
function isRoomAllowed(room) {
  var keys = Object.keys(ALLOW_ROOMS);
  if (!keys || keys.length === 0) return true;
  return !!ALLOW_ROOMS[room];
}

function httpGet(url) {
  var Jsoup = org.jsoup.Jsoup;
  return Jsoup.connect(url)
    .ignoreContentType(true)
    .timeout(10000)
    .method(org.jsoup.Connection.Method.GET)
    .execute()
    .body();
}

function postToBridge(payload) {
  var Jsoup = org.jsoup.Jsoup;
  return Jsoup.connect(BRIDGE_URL)
    .ignoreContentType(true)
    .header("Content-Type", "application/json")
    .requestBody(JSON.stringify(payload))
    .timeout(30000)
    .method(org.jsoup.Connection.Method.POST)
    .execute()
    .body();
}

function parseText(raw) {
  var data = null;
  try { data = JSON.parse(raw); } catch (e) { data = null; }
  if (data && data.text) return data.text;
  return "RAW: " + raw;
}

// ============================================================
// AI 요청 함수
// ============================================================
function askAI(msg, question) {
  if (!question) return;
  if (question.length > MAX_LEN) {
    question = question.substring(0, MAX_LEN) + "...";
  }
  var payload = {
    content: question,
    room: msg.room,
    author: { name: msg.author.name },
    isGroupChat: msg.isGroupChat,
    isDebugRoom: msg.isDebugRoom,
    packageName: msg.packageName
  };
  try {
    msg.reply(parseText(postToBridge(payload)));
  } catch (e) {
    msg.reply("BRIDGE_ERR: " + e);
  }
}

function bridgeCommand(msg, command) {
  var payload = {
    kind: "command",
    command: command,
    room: msg.room,
    author: { name: msg.author.name },
    isGroupChat: msg.isGroupChat,
    isDebugRoom: msg.isDebugRoom,
    packageName: msg.packageName
  };
  msg.reply(parseText(postToBridge(payload)));
}

// ============================================================
// 슬래시 명령어 처리
// ============================================================
function handleSlash(msg) {
  var text = String(msg.content || "").trim();
  if (text.indexOf("/") !== 0) return false;

  // /bridgeping - 브릿지 연결 확인
  if (text === "/bridgeping") {
    try {
      var resp = httpGet(BRIDGE_BASE + "/ping");
      msg.reply("BRIDGE: " + resp);
    } catch (e) {
      msg.reply("BRIDGE_FAIL: " + e);
    }
    return true;
  }

  // /질문 <내용> - 그룹 채팅에서 AI 질문
  if (text.indexOf("/질문") === 0) {
    var q = text.substring(3);
    q = q.replace(/^\s+/, "");
    if (!q) {
      msg.reply("사용: /질문 <내용>");
      return true;
    }
    askAI(msg, q);
    return true;
  }

  // /help - 도움말
  if (text === "/help") {
    msg.reply("개인톡: 그냥 말하면 AI 답변\n그룹톡: /질문 <내용>\n/bridgeping /clear /whoami /on /off");
    return true;
  }

  // /ping - 봇 상태 확인
  if (text === "/ping") { msg.reply("pong"); return true; }

  // /off - 봇 비활성화
  if (text === "/off") { ENABLED = false; msg.reply("OK. 비활성화"); return true; }

  // /on - 봇 활성화
  if (text === "/on") { ENABLED = true; msg.reply("OK. 활성화"); return true; }

  // /status - 시스템 상태
  if (text === "/status") { bridgeCommand(msg, "status"); return true; }

  // /whoami - 세션 키 확인
  if (text === "/whoami") { bridgeCommand(msg, "whoami"); return true; }

  // /clear - 세션 초기화
  if (text === "/clear") { bridgeCommand(msg, "clear"); return true; }

  msg.reply("알 수 없는 명령어. /help");
  return true;
}

// ============================================================
// 이미지 분석 (폴링 방식)
// ============================================================
function checkImageResult(msg, retryCount) {
  if (retryCount > 30) {
    msg.reply("이미지 분석 시간 초과 (90초). 이미지를 저장했는지 확인해주세요.");
    return;
  }

  try {
    var resp = httpGet(BRIDGE_BASE + "/check-image-result");
    var data = JSON.parse(resp);

    if (data.hasResult) {
      msg.reply(data.result);
    } else {
      java.lang.Thread.sleep(3000);
      checkImageResult(msg, retryCount + 1);
    }
  } catch (e) {
    msg.reply("이미지 결과 확인 실패: " + e);
  }
}

function isImageNotification(text) {
  if (!text) return false;
  var patterns = ["사진을 보냈습니다", "사진", "이미지를 보냈습니다"];
  for (var i = 0; i < patterns.length; i++) {
    if (text === patterns[i] || text.indexOf(patterns[i]) === 0) return true;
  }
  return false;
}

// ============================================================
// 메시지 핸들러
// ============================================================
function onMessage(msg) {
  var text = String(msg.content || "").trim();

  // 이미지 알림 감지 (ADB Watcher와 연동)
  if (isImageNotification(text)) {
    msg.reply("이미지를 분석하고 있어요... 잠시만 기다려 주세요.");
    java.lang.Thread.sleep(15000);  // 이미지 저장 대기
    checkImageResult(msg, 0);
    return;
  }

  // 슬래시 명령어 처리
  if (handleSlash(msg)) return;

  // 비활성화 상태면 무시
  if (!ENABLED) return;

  // 허용된 방이 아니면 무시
  if (!isRoomAllowed(msg.room)) return;

  // 개인 채팅에서만 자동 응답
  if (!msg.isGroupChat) {
    if (!text) return;
    askAI(msg, text);
    return;
  }
}

// ============================================================
// 이벤트 리스너 등록
// ============================================================
bot.addListener(Event.MESSAGE, onMessage);
