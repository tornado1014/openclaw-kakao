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
// 그룹채팅 감지 (알림 기반 + 수동 토글 폴백)
// ============================================================
var _lastNotif = {};  // sender -> { subText, ts }
var _freeChatRooms = {};  // room -> true (수동 자유대화 모드)
var _notifApiWorking = false;  // 알림 API 작동 여부 추적

// 알림 처리 공통 로직
function handleNotification(sbn) {
  try {
    var pkg = String(sbn.getPackageName() || "");
    if (pkg !== "com.kakao.talk") return;

    var extras = sbn.getNotification().extras;
    if (!extras) return;

    var title = extras.getString("android.title");
    if (!title) return;
    title = String(title);

    var subText = extras.getString("android.subText");
    _lastNotif[title] = {
      subText: subText ? String(subText) : null,
      ts: java.lang.System.currentTimeMillis()
    };
    _notifApiWorking = true;
  } catch (e) { /* ignore */ }
}

// 방법 1: 새 API (Event.NOTIFICATION_POSTED)
try {
  bot.addListener(Event.NOTIFICATION_POSTED, function(sbn) {
    handleNotification(sbn);
  });
} catch (e) { /* Event.NOTIFICATION_POSTED 미지원 */ }

// 방법 2: 레거시 전역 함수 (구버전 MessengerBotR - function 선언문 필수)
function onNotificationPosted(sbn, sm) {
  handleNotification(sbn);
}

function isGroupMessage(sender) {
  // 알림 API가 작동하면 알림 기반 감지
  if (_notifApiWorking) {
    var info = _lastNotif[sender];
    if (!info) return false;
    if (java.lang.System.currentTimeMillis() - info.ts > 10000) return false;
    return !!info.subText;
  }
  // 알림 API 미작동 → 수동 모드 확인 (자유대화 아니면 그룹으로 간주)
  return !_freeChatRooms[sender];
}

function getRealRoom(sender) {
  var info = _lastNotif[sender];
  if (info && info.subText) return info.subText;
  return sender;
}

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
    .timeout(600000)  // 10분 타임아웃 (웹 검색, 복잡한 질문 대비)
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
// 채팅 컨텍스트 헬퍼
// ============================================================
function getChatContext(msg) {
  var sender = msg.author ? msg.author.name : "unknown";
  var isGroup = isGroupMessage(sender);
  return {
    room: isGroup ? getRealRoom(sender) : msg.room,
    isGroupChat: isGroup,
    sender: sender
  };
}

// ============================================================
// AI 요청 함수
// ============================================================
var THINKING_THRESHOLD = 50;  // 이 글자수 이상이면 "생각 중" 표시

var SPINNER_VERBS = [
  "묻고 더블로 가!",
  "동작 그만, 밑장 빼기냐?",
  "마포대교는 무너졌냐?",
  "아수라발발타!",
  "밥은 먹고 다니냐?",
  "누구냐 넌?",
  "호의가 계속되면, 그게 권리인 줄 알아요",
  "너 지금부터 범인 해라",
  "모히또 가서 몰디브나 한잔 할까..?",
  "아들아, 너는 계획이 다 있구나",
  "참으로 시의적절하다..",
  "살아있네",
  "명분이 없다 아입니꺼, 명분이..",
  "니 내 누군지 아니?",
  "혼자야? 어, 아직 싱글이야",
  "진실의 방으로~",
  "느그 아부지 뭐하시노?",
  "고마해라, 마이 묵었다 아이가",
  "니가 가라, 하와이",
  "너나 잘하세요"
];

var _javaRandom = new java.util.Random();
var _recentSpinners = [];  // 최근 사용된 인덱스 (절반까지 추적)

function getRandomSpinnerVerb() {
  var len = SPINNER_VERBS.length;
  var halfLen = Math.floor(len / 2);
  var idx;
  var tries = 0;
  do {
    idx = _javaRandom.nextInt(len);
    tries++;
  } while (_recentSpinners.indexOf(idx) !== -1 && tries < 20);
  _recentSpinners.push(idx);
  if (_recentSpinners.length > halfLen) {
    _recentSpinners.shift();
  }
  return SPINNER_VERBS[idx];
}

function askAI(msg, question) {
  if (!question) return;
  if (question.length > MAX_LEN) {
    question = question.substring(0, MAX_LEN) + "...";
  }

  // 항상 "생각 중" 메시지 먼저 전송
  msg.reply("🤔 (생각 중...) " + getRandomSpinnerVerb());

  var ctx = getChatContext(msg);
  var payload = {
    content: question,
    room: ctx.room,
    author: { name: ctx.sender },
    isGroupChat: ctx.isGroupChat,
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
  var ctx = getChatContext(msg);
  var payload = {
    kind: "command",
    command: command,
    room: ctx.room,
    author: { name: ctx.sender },
    isGroupChat: ctx.isGroupChat,
    isDebugRoom: msg.isDebugRoom,
    packageName: msg.packageName
  };
  msg.reply(parseText(postToBridge(payload)));
}

// ============================================================
// URL 감지 및 요약
// ============================================================
var URL_PATTERN = /https?:\/\/[^\s<>\[\]()]+/gi;

function extractUrls(text) {
  var matches = text.match(URL_PATTERN);
  return matches || [];
}

function summarizeUrl(msg, url) {
  var ctx = getChatContext(msg);
  var payload = {
    url: url,
    room: ctx.room,
    author: { name: ctx.sender },
    isGroupChat: ctx.isGroupChat
  };
  
  try {
    var Jsoup = org.jsoup.Jsoup;
    var resp = Jsoup.connect(BRIDGE_BASE + "/webhook/url-summary")
      .ignoreContentType(true)
      .header("Content-Type", "application/json")
      .requestBody(JSON.stringify(payload))
      .timeout(600000)  // 10분 타임아웃 (페이지 로딩 + AI 요약 시간)
      .method(org.jsoup.Connection.Method.POST)
      .execute()
      .body();

    var data = JSON.parse(resp);
    if (data.ok && data.text) {
      msg.reply(data.text);
    } else {
      msg.reply(data.text || "링크 요약에 실패했습니다.");
    }
  } catch (e) {
    msg.reply("링크 요약 오류: " + e);
  }
}

// ============================================================
// 명령어 처리 (슬래시 + 점)
// ============================================================
function handleCommand(msg) {
  var text = String(msg.content || "").trim();
  
  // 슬래시(/) 또는 점(.) 명령어 처리
  var isSlash = text.indexOf("/") === 0;
  var isDot = text.indexOf(".") === 0;
  
  if (!isSlash && !isDot) return false;

  // /bridgeping 또는 .bridgeping - 브릿지 연결 확인
  if (text === "/bridgeping" || text === ".bridgeping") {
    try {
      var resp = httpGet(BRIDGE_BASE + "/ping");
      msg.reply("BRIDGE: " + resp);
    } catch (e) {
      msg.reply("BRIDGE_FAIL: " + e);
    }
    return true;
  }

  // .질문 <내용> 또는 /질문 <내용> - AI 질문
  if (text.indexOf(".질문") === 0 || text.indexOf("/질문") === 0) {
    var q = text.substring(3);
    q = q.replace(/^\s+/, "");
    if (!q) {
      msg.reply("사용: .질문 <내용>");
      return true;
    }
    askAI(msg, q);
    return true;
  }

  // .날씨 또는 /날씨 - 날씨 질문 (AI에게 전달)
  if (text === ".날씨" || text === "/날씨") {
    askAI(msg, "오늘 날씨 알려줘");
    return true;
  }
  if (text.indexOf(".날씨 ") === 0 || text.indexOf("/날씨 ") === 0) {
    var loc = text.substring(4).replace(/^\s+/, "");
    askAI(msg, loc + " 날씨 알려줘");
    return true;
  }

  // .뉴스 또는 /뉴스 - 뉴스 브리핑 (AI에게 전달)
  if (text === ".뉴스" || text === "/뉴스") {
    askAI(msg, "오늘의 주요 뉴스 브리핑해줘");
    return true;
  }
  if (text.indexOf(".뉴스 ") === 0 || text.indexOf("/뉴스 ") === 0) {
    var topic = text.substring(4).replace(/^\s+/, "");
    askAI(msg, topic + " 관련 최신 뉴스 알려줘");
    return true;
  }

  // .요약 <url> 또는 /요약 <url> - URL 요약
  if (text.indexOf(".요약") === 0 || text.indexOf("/요약") === 0) {
    var urlArg = text.substring(3).replace(/^\s+/, "");
    var urls = extractUrls(urlArg);
    if (!urls || urls.length === 0) {
      msg.reply("사용: .요약 <URL>");
      return true;
    }
    msg.reply("🔗 링크를 요약하고 있어요...");
    summarizeUrl(msg, urls[0]);
    return true;
  }

  // /help 또는 .help - 도움말
  if (text === "/help" || text === ".help" || text === ".hlep") {
    msg.reply("🧠 모멘토봇 도움말\n\n" +
      ".질문 <내용> - AI에게 질문\n" +
      ".요약 <URL> - 링크 요약\n\n" +
      "기타: .ping .status .whoami .roomname");
    return true;
  }

  // .roomname - 방 이름 확인 (디버그용)
  if (text === "/roomname" || text === ".roomname") {
    var sender = msg.author ? msg.author.name : "unknown";
    var realRoom = getRealRoom(sender);
    var isGroup = isGroupMessage(sender);
    var notifInfo = _lastNotif[sender];
    var notifDebug = "없음 (알림 수신 안됨)";
    if (notifInfo) {
      var ageMs = java.lang.System.currentTimeMillis() - notifInfo.ts;
      var expired = ageMs > 10000 ? " [만료]" : " [유효]";
      notifDebug = "subText=" + String(notifInfo.subText) +
        " / age=" + ageMs + "ms" + expired;
    }
    var allKeys = Object.keys(_lastNotif);
    var isFree = !!_freeChatRooms[msg.room];
    msg.reply("msg.room: " + msg.room +
      "\nsender: " + sender +
      "\n그룹감지: " + isGroup +
      "\n자유대화: " + isFree +
      "\n알림API: " + (_notifApiWorking ? "작동" : "미작동") +
      "\n알림캐시: " + notifDebug +
      "\n캐시키: [" + allKeys.join(", ") + "]");
    return true;
  }

  // /ping 또는 .ping - 봇 상태 확인
  if (text === "/ping" || text === ".ping") { msg.reply("pong 🧠"); return true; }

  // /status 또는 .status - 시스템 상태
  if (text === "/status" || text === ".status") { bridgeCommand(msg, "status"); return true; }

  // /whoami 또는 .whoami - 세션 키 확인
  if (text === "/whoami" || text === ".whoami") { bridgeCommand(msg, "whoami"); return true; }

  // 알 수 없는 점(.) 명령어
  if (isDot) {
    var cmdSender = msg.author ? msg.author.name : "unknown";
    if (isGroupMessage(cmdSender)) {
      // 단톡방: 잘못된 명령어 안내
      msg.reply("잘못된 명령입니다.\n\n" +
        "사용 가능한 명령어:\n" +
        ".질문 <내용> - AI에게 질문\n" +
        ".요약 <URL> - 링크 요약\n" +
        ".help - 도움말\n" +
        ".ping .status");
      return true;
    }
    return false;  // 개인톡: 일반 메시지로 처리
  }

  msg.reply("알 수 없는 명령어. /help 또는 .help");
  return true;
}

// ============================================================
// 이미지 분석 (이벤트 드리븐 방식)
// ============================================================
function triggerImageAnalysis(msg) {
  // 브릿지에 이미지 트리거 요청 (ADB로 직접 가져옴)
  var payload = {
    room: msg.room,
    author: { name: msg.author.name },
    isGroupChat: msg.isGroupChat
  };

  try {
    var Jsoup = org.jsoup.Jsoup;
    var resp = Jsoup.connect(BRIDGE_BASE + "/trigger-image")
      .ignoreContentType(true)
      .header("Content-Type", "application/json")
      .requestBody(JSON.stringify(payload))
      .timeout(600000)  // 10분 타임아웃 (ADB 이미지 다운로드 + AI 분석 시간)
      .method(org.jsoup.Connection.Method.POST)
      .execute()
      .body();

    var data = JSON.parse(resp);
    if (data.ok && data.text) {
      msg.reply(data.text);
    } else {
      msg.reply(data.text || "이미지 분석에 실패했습니다.");
    }
  } catch (e) {
    msg.reply("이미지 분석 오류: " + e);
  }
}

// 폴링 방식 (폴백용)
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

  // 이미지 알림 감지 (이벤트 드리븐 방식 - ADB Watcher 불필요)
  if (isImageNotification(text)) {
    // 단톡방에서는 이미지 감지 비활성화
    java.lang.Thread.sleep(500);
    var imgSender = msg.author ? msg.author.name : "unknown";
    if (isGroupMessage(imgSender)) return;

    msg.reply("🖼️ 이미지를 분석하고 있어요...");
    java.lang.Thread.sleep(2000);  // 이미지 캐시 저장 대기 (짧게)
    triggerImageAnalysis(msg);     // 브릿지가 직접 ADB로 이미지 가져옴
    return;
  }

  // 명령어 처리 (슬래시 + 점)
  if (handleCommand(msg)) return;

  // 비활성화 상태면 무시
  if (!ENABLED) return;

  // 허용된 방이 아니면 무시
  if (!isRoomAllowed(msg.room)) return;

  // 알림 기반 그룹 감지: 알림이 MESSAGE보다 늦게 올 수 있으므로 대기
  java.lang.Thread.sleep(500);
  var sender = msg.author ? msg.author.name : "unknown";
  if (isGroupMessage(sender)) return;

  // 개인톡에서만 자동 응답
  if (!text) return;
  askAI(msg, text);
}

// ============================================================
// 이벤트 리스너 등록
// ============================================================
bot.addListener(Event.MESSAGE, onMessage);
