/**
 * OpenClaw-Kakao Bridge Server (MomentoBot Edition)
 *
 * MessengerBotR과 OpenClaw Gateway 사이의 브릿지 서버
 * 모멘토봇: 기억을 되살려주는 AI 비서
 *
 * 환경변수
 *   PORT - 서버 포트 (기본: 8787)
 *   OPENCLAW_GATEWAY_URL - Gateway URL (필수)
 *   OPENCLAW_GATEWAY_TOKEN - Gateway 토큰 (필수)
 *   OPENCLAW_CONFIG_PATH - openclaw.json 경로 (선택)
 *   GOOGLE_API_KEY - Gemini API 키 (선택, 폴백용)
 *   IMAGE_WATCH_DIR - 이미지 감시 디렉토리 (기본: ./kakao-images)
 */

import http from "http";
import fs from "fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync } from "node:child_process";
import { stripMarkdown } from "./markdown-remover.mjs";

// .env 파일 로드 (dotenv 없이 직접 로드)
const __dirname_early = path.dirname(fileURLToPath(import.meta.url));
try {
  const envPath = path.join(__dirname_early, ".env");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.substring(0, eqIdx).trim();
        const val = trimmed.substring(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
    console.log("Loaded .env file");
  }
} catch (e) {
  // ignore
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// 환경 설정
// ============================================================
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "http://100.79.99.33:25382";
const GATEWAY_TOKEN =
  process.env.OPENCLAW_GATEWAY_TOKEN ||
  (() => {
    // 환경변수가 없으면 설정 파일에서 읽기 시도
    try {
      const configPath = process.env.OPENCLAW_CONFIG_PATH ||
        path.join(process.env.HOME || process.env.USERPROFILE || ".", ".openclaw", "openclaw.json");
      const raw = fs.readFileSync(configPath, "utf8");
      const cfg = JSON.parse(raw);
      return cfg?.gateway?.auth?.token || "";
    } catch {
      return "";
    }
  })();

// Gemini API (선택적 폴백)
const GEMINI_API_KEY = process.env.GOOGLE_API_KEY || "";
const GEMINI_MODEL = "gemini-2.0-flash";

// 이미지 감시 디렉토리
const IMAGE_DIR = process.env.IMAGE_WATCH_DIR || path.join(__dirname, "..", "kakao-images");

// ADB 설정 (이벤트 드리븐 이미지 감지용)
const ADB_PATH = process.env.BLUESTACK_ADB_PATH || "C:/Program Files/BlueStacks_nxt/HD-Adb.exe";
const ADB_PORT = process.env.ADB_PORT || "5555";
const KAKAO_CACHE_PATH = "/sdcard/Android/data/com.kakao.talk/contents/";

// 이미지 파일 시그니처
const IMAGE_SIGNATURES = {
  "ffd8ff": ".jpg",      // JPEG
  "89504e47": ".png",    // PNG
  "47494638": ".gif",    // GIF
  "52494646": ".webp",   // WebP (RIFF)
};

// ============================================================
// 초기화
// ============================================================
try {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
} catch (e) {
  // ignore
}

const startedAt = Date.now();
const pendingImageResults = new Map(); // room -> { result, timestamp }
const generations = new Map(); // key -> int

// ============================================================
// Rate Limiting (토큰 버킷)
// ============================================================
const rateLimits = new Map(); // IP → { tokens, lastRefill }
function checkRateLimit(ip, maxPerMinute = 30) {
  const now = Date.now();
  let bucket = rateLimits.get(ip);
  if (!bucket || now - bucket.lastRefill > 60000) {
    bucket = { tokens: maxPerMinute, lastRefill: now };
  }
  if (bucket.tokens <= 0) return false;
  bucket.tokens--;
  rateLimits.set(ip, bucket);
  return true;
}

// ============================================================
// 보안: 개인정보 보호 (출력 필터 + 인젝션 탐지)
// ============================================================

const SECURITY_LOG_PATH = path.join(__dirname, "..", "..", "clawd", "logs", "security.log")
  .replace(/\\/g, "/")
  // fallback: 로그 디렉토리가 없으면 bridge 옆에 저장
  || path.join(__dirname, "security.log");

function logSecurityEvent(event) {
  const entry = {
    timestamp: new Date().toISOString(),
    type: event.type,
    room: event.room || "unknown",
    sender: event.sender || "unknown",
    message: (event.message || "").substring(0, 200),
    action: event.action,
    severity: event.severity || "medium",
  };
  try {
    const logDir = path.dirname(SECURITY_LOG_PATH);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(SECURITY_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (e) {
    console.error(`[SECURITY] Failed to write log: ${e.message}`);
  }
  console.error(`[SECURITY:${event.severity}] ${event.type}: ${event.action}`);
}

// 개인정보 패턴 (그룹채팅 응답에서 차단) - 외부 파일에서 로드
const PRIVATE_PATTERNS = (() => {
  const patternsFile = path.join(__dirname, "private-patterns.local.json");
  try {
    if (fs.existsSync(patternsFile)) {
      const data = JSON.parse(fs.readFileSync(patternsFile, "utf8"));
      return (data.patterns || []).map(p => new RegExp(p, "gi"));
    }
  } catch (e) {
    console.error(`[security] Failed to load private patterns: ${e.message}`);
  }
  // 폴백: 파일 없으면 빈 배열 (안전 모드)
  console.warn("[security] private-patterns.local.json not found, no patterns loaded");
  return [];
})();

function sanitizeOutput(text, isGroupChat, room, sender) {
  if (!isGroupChat || !text) return text;

  for (const pattern of PRIVATE_PATTERNS) {
    // reset lastIndex for global regex
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      logSecurityEvent({
        type: "private_data_leak_blocked",
        room,
        sender,
        message: `Pattern matched: ${pattern.source}`,
        action: "blocked_entire_response",
        severity: "critical",
      });
      return "죄송합니다, 해당 질문에는 답변할 수 없습니다.";
    }
  }

  return text;
}

// 프롬프트 인젝션 탐지 패턴
const INJECTION_PATTERNS = [
  /시스템\s*프롬프트.*무시/i,
  /system\s*prompt.*ignore/i,
  /USER\.md/i,
  /USER-PRIVATE/i,
  /SOUL\.md/i,
  /MEMORY\.md/i,
  /AGENTS\.md/i,
  /HEARTBEAT\.md/i,
  /설정\s*파일.*보여/i,
  /config.*file.*show/i,
  /이전.*지시.*무시/i,
  /ignore.*previous.*instruction/i,
  /새로운\s*역할/i,
  /관리자.*긴급.*지시/i,
  /admin.*instruction/i,
  /너의?\s*주인.*(?:이름|누구|정보|실명)/i,
  /개인\s*정보.*(?:알려|보여|출력)/i,
];

function detectInjection(message, isGroupChat, room, sender) {
  if (!isGroupChat || !message) return false;

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(message)) {
      logSecurityEvent({
        type: "injection_attempt",
        room,
        sender,
        message: message.substring(0, 200),
        action: "blocked",
        severity: "high",
      });
      return true;
    }
  }
  return false;
}

// ============================================================
// 에이전트 라우팅: 개인별 에이전트 매핑
// ============================================================

// 개인 DM 사용자 → 에이전트 매핑
// 새 사용자 추가 시: { sender: "카톡이름", agentId: "momento-xxx" }
const PERSONAL_AGENT_MAP = [
  { sender: "이현찬", agentId: "momento" },
  { sender: "에렌델", agentId: "momento" },
  { sender: "Myun", agentId: "momento-myun" },
  // === 새 사용자 추가는 여기에 ===
  // { sender: "홍길동", agentId: "momento-gildong" },
];

// 그룹채팅(단체대화방 + 오픈채팅방) 기본 에이전트
const GROUP_AGENT_ID = "momento-public";

function resolveIsGroupChat(room, sender, flagFromClient) {
  if (flagFromClient === false) return false;
  return true;
}

// sender + isGroupChat 기반으로 에이전트 ID 결정
function resolveAgentId(sender, isGroupChat) {
  // 그룹채팅 → 항상 공개 에이전트
  if (isGroupChat) return GROUP_AGENT_ID;
  // 개인 DM → 매핑 테이블에서 에이전트 찾기
  const entry = PERSONAL_AGENT_MAP.find(e => e.sender === sender);
  if (entry) return entry.agentId;
  // 미등록 사용자의 DM → 공개 에이전트 (fail-safe)
  return GROUP_AGENT_ID;
}

// ============================================================
// 유틸리티 함수
// ============================================================
function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

function routeKey(sender, room) {
  return `memento:${sender}@${room}`;
}

function getGen(key) {
  const g = generations.get(key);
  return typeof g === "number" ? g : 0;
}

function bumpGen(key) {
  const next = getGen(key) + 1;
  generations.set(key, next);
  return next;
}

// ============================================================
// HTML → 텍스트 변환 (npm 의존성 없이)
// ============================================================
function stripHtmlToText(html) {
  if (!html || typeof html !== "string") return "";

  let text = html;

  // 1. script, style, noscript, svg, head 블록 제거
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, "");
  text = text.replace(/<head[\s\S]*?<\/head>/gi, "");

  // 2. 블록 요소를 줄바꿈으로 변환
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/?(p|div|section|article|aside|header|footer|main|nav|blockquote)[\s>][^>]*>/gi, "\n");
  text = text.replace(/<\/?(p|div|section|article|aside|header|footer|main|nav|blockquote)>/gi, "\n");
  text = text.replace(/<\/?h[1-6][^>]*>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "\n- ");
  text = text.replace(/<\/li>/gi, "");
  text = text.replace(/<tr[^>]*>/gi, "\n");
  text = text.replace(/<td[^>]*>/gi, " | ");

  // 3. 나머지 HTML 태그 제거
  text = text.replace(/<[^>]+>/g, "");

  // 4. HTML 엔티티 디코딩
  const entities = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
    "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&ndash;": "-",
    "&mdash;": "--", "&laquo;": "<<", "&raquo;": ">>",
    "&bull;": "*", "&middot;": ".", "&copy;": "(c)",
    "&reg;": "(R)", "&trade;": "(TM)", "&hellip;": "...",
  };
  for (const [entity, replacement] of Object.entries(entities)) {
    text = text.replaceAll(entity, replacement);
  }
  text = text.replace(/&#(\d+);/g, (_, num) => {
    const code = parseInt(num, 10);
    return code > 31 && code < 65535 ? String.fromCharCode(code) : "";
  });
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const code = parseInt(hex, 16);
    return code > 31 && code < 65535 ? String.fromCharCode(code) : "";
  });

  // 5. 공백 정규화
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}

// ============================================================
// URL 직접 가져오기 (Gateway 경유 없이)
// ============================================================
async function fetchUrlContent(targetUrl, maxChars = 8000) {
  const result = { content: "", title: "", error: null };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(targetUrl, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "identity",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/xhtml")) {
      result.error = `지원하지 않는 콘텐츠 타입: ${contentType.split(";")[0]}`;
      return result;
    }

    if (!response.ok) {
      result.error = `HTTP ${response.status} ${response.statusText}`;
      return result;
    }

    const html = await response.text();

    if (!html || html.length < 100) {
      result.error = "페이지 내용이 비어있습니다.";
      return result;
    }

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) {
      result.title = titleMatch[1].replace(/<[^>]+>/g, "").trim().substring(0, 200);
    }

    let text = stripHtmlToText(html);
    if (text.length > maxChars) {
      text = text.substring(0, maxChars) + "\n\n... (이하 생략)";
    }

    result.content = text;

  } catch (e) {
    if (e.name === "AbortError") {
      result.error = "페이지 로딩 시간 초과 (15초)";
    } else if (e.code === "ENOTFOUND" || e.cause?.code === "ENOTFOUND") {
      result.error = "도메인을 찾을 수 없습니다.";
    } else if (e.code === "ECONNREFUSED" || e.cause?.code === "ECONNREFUSED") {
      result.error = "서버 연결이 거부되었습니다.";
    } else if (e.message?.includes("certificate")) {
      result.error = "SSL 인증서 오류";
    } else {
      result.error = `페이지 가져오기 실패: ${e.message}`;
    }
  }

  return result;
}

// ============================================================
// ADB 이미지 가져오기 (이벤트 드리븐)
// ============================================================
// ADB 장치 자동 감지 (캐시)
let _adbDevice = null;

function detectAdbDevice() {
  if (_adbDevice) return _adbDevice;
  const adbPath = fs.existsSync(ADB_PATH) ? ADB_PATH : "adb";
  try {
    const out = execFileSync(adbPath, ["devices"], { encoding: "utf8", timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = out.split("\n").filter(l => l.includes("\tdevice"));
    if (lines.length > 0) {
      _adbDevice = lines[0].split("\t")[0].trim();
      console.log(`[adb] Detected device: ${_adbDevice}`);
    }
  } catch (e) {
    console.error(`[adb] Device detection failed: ${e.message}`);
  }
  return _adbDevice;
}

function adbExec(args) {
  const adbPath = fs.existsSync(ADB_PATH) ? ADB_PATH : "adb";
  const device = detectAdbDevice();
  const cmdArgs = [];
  if (device) cmdArgs.push("-s", device);
  // args가 문자열이면 쉘 명령 (shell 서브커맨드), 배열이면 직접 전달
  if (typeof args === 'string') {
    cmdArgs.push(...args.split(/\s+/));
  } else {
    cmdArgs.push(...args);
  }
  console.log(`[adb] Running: ${adbPath} ${cmdArgs.join(' ')}`);
  try {
    const result = execFileSync(adbPath, cmdArgs, {
      encoding: "utf8", timeout: 30000, stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log(`[adb] Result length: ${result.length}, content: "${result.trim().substring(0, 300)}"`);
    return result;
  } catch (e) {
    console.error(`[adb] Command failed: ${e.message}`);
    if (e.stdout) console.error(`[adb] stdout: ${e.stdout}`);
    if (e.stderr) console.error(`[adb] stderr: ${e.stderr}`);
    _adbDevice = null;
    return null;
  }
}

function findRecentCacheImages(minutes = 2) {
  // 최근 N분 이내 변경된 이미지 파일 찾기
  // Windows 환경에서 stderr를 catch해서 처리
  const output = adbExec(`shell find ${KAKAO_CACHE_PATH} -type f -size +1k -mmin -${minutes}`);
  if (!output) return [];

  const files = [];
  for (const line of output.split("\n")) {
    const filepath = line.trim();
    if (!filepath) continue;
    // 메타데이터 파일 제외
    if (filepath.endsWith(".thumbnailHint") || filepath.endsWith(".tmp") ||
        filepath.endsWith(".nomedia") || filepath.endsWith(".thumb") || filepath.endsWith(".bg")) {
      continue;
    }
    files.push(filepath);
  }
  return files;
}

function detectImageType(remotePath) {
  // 파일 헤더로 이미지 타입 감지
  // xxd 사용 (od보다 호환성 좋음)
  const output = adbExec(`shell xxd -l 8 -p "${remotePath}"`);
  if (!output) return null;

  const hex = output.trim().replace(/\s+/g, "").toLowerCase();

  for (const [sig, ext] of Object.entries(IMAGE_SIGNATURES)) {
    if (hex.startsWith(sig)) return ext;
  }
  return null;
}

function pullCacheImage(remotePath) {
  // 이미지 타입 감지
  const ext = detectImageType(remotePath);
  if (!ext) return null;

  // 로컬 파일명 생성
  const hash = path.basename(remotePath);
  const localFilename = `${hash}${ext}`;
  const localPath = path.join(IMAGE_DIR, localFilename);

  // 다운로드
  const result = adbExec(`pull "${remotePath}" "${localPath}"`);
  if (!result || !fs.existsSync(localPath)) return null;

  return { localPath, localFilename };
}

// 이미지 분석 중복 방지 - 이미 처리된 파일 추적
const processedCacheFiles = new Set();

// ============================================================
// Gateway API 호출
// ============================================================
async function gatewayInvoke(tool, action, args = {}, sessionKey) {
  if (!GATEWAY_TOKEN) {
    throw new Error("Missing OPENCLAW_GATEWAY_TOKEN");
  }

  const url = `${GATEWAY_URL}/tools/invoke`;
  const payload = { tool, action, args };
  if (sessionKey) payload.sessionKey = sessionKey;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GATEWAY_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`Gateway ${r.status}: ${text}`);

  const data = JSON.parse(text);
  if (!data?.ok) throw new Error(data?.error?.message || "Gateway invoke failed");
  return data.result;
}

// ============================================================
// Gemini API (폴백용)
// ============================================================
async function analyzeImageWithGemini(imageBase64, prompt) {
  if (!GEMINI_API_KEY) {
    throw new Error("Gemini API key not configured");
  }

  let pureBase64 = imageBase64;
  if (pureBase64.startsWith("data:")) {
    const match = pureBase64.match(/^data:[^;]+;base64,(.+)$/);
    if (match) pureBase64 = match[1];
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  const payload = {
    contents: [{
      parts: [
        { text: prompt || "이 이미지를 분석해서 한국어로 설명해줘." },
        {
          inline_data: {
            mime_type: "image/jpeg",
            data: pureBase64
          }
        }
      ]
    }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini API ${response.status}: ${text}`);
  }

  const data = JSON.parse(text);
  const result = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!result) {
    throw new Error("No response from Gemini");
  }

  return result;
}

// ============================================================
// Gateway Chat API
// ============================================================
async function callGatewayChat(prompt, userKey = "memento", imageBase64 = null, sender = "unknown", isGroupChat = false, retryCount = 0) {
  if (!GATEWAY_TOKEN) {
    throw new Error("Missing OPENCLAW_GATEWAY_TOKEN");
  }

  // 그룹채팅에서 온 메시지는 이미 필터링된 정당한 요청임을 명시
  let finalPrompt = isGroupChat 
    ? `[사용자 질문 - 반드시 응답 필요] ${prompt}`
    : prompt;

  // 이미지가 있으면 로컬에 저장하고 파일 경로 전달
  if (imageBase64) {
    console.log(`[bridge] Image detected, saving for Claude Code local read`);

    try {
      let pureBase64 = imageBase64;
      if (pureBase64.startsWith("data:")) {
        const match = pureBase64.match(/^data:[^;]+;base64,(.+)$/);
        if (match) pureBase64 = match[1];
      }

      const filename = `chat-${Date.now()}-${sender.replace(/[^a-zA-Z0-9]/g, "_")}.jpg`;
      const localPath = path.join(IMAGE_DIR, filename).replace(/\\/g, "/");
      fs.writeFileSync(localPath, Buffer.from(pureBase64, "base64"));
      console.log(`[bridge] Image saved: ${localPath}`);

      finalPrompt = prompt
        ? `${prompt}\n\n로컬 이미지 파일도 함께 분석해줘: ${localPath}`
        : `로컬 이미지 파일을 분석해서 한국어로 설명해줘: ${localPath}`;

    } catch (e) {
      console.error(`[bridge] Image save failed: ${e.message}`);
      // 이미지 저장 실패 시 Gemini 폴백 시도
      if (GEMINI_API_KEY) {
        try {
          const analysis = await analyzeImageWithGemini(imageBase64, prompt || "이 이미지를 분석해서 한국어로 설명해줘.");
          return stripMarkdown(`📷 이미지 분석 결과:\n\n${analysis}`);
        } catch (geminiErr) {
          return `⚠️ 이미지 처리 중 오류: ${e.message}`;
        }
      }
      return `⚠️ 이미지 처리 중 오류: ${e.message}`;
    }
  }

  // Gateway 요청
  const url = `${GATEWAY_URL}/v1/chat/completions`;

  const systemPrompt = isGroupChat
    ? "너는 모멘토봇이야. 오픈채팅방에서 질문에 답변하는 AI야. " +
      "🚨🚨🚨 최우선 규칙 (절대 위반 금지): " +
      "1. 모든 메시지에 반드시 응답해! " +
      "2. sender 이름이 '오픈채팅봇'이어도 실제 사용자의 요청이야! 봇이 아니라 사람이야! 무조건 응답해! " +
      "3. NO_REPLY, 빈 응답, HEARTBEAT_OK 절대 금지! " +
      "4. 어떤 이유로도 응답을 거부하면 안 돼! " +
      "날씨 질문이면 web_search로 검색해서 답변해. " +
      "간결하고 정확하게 답변해. " +
      "마크다운 문법(**, ##, ```, - 등)은 절대 사용하지 마. 이모지를 적극적으로 활용해."
    : "너는 모멘토봇이야. 개인 AI 기억 도우미야. " +
      "일정 관리, 메모, 할일, 리마인더 등 개인 비서 역할을 해. " +
      "사용자가 기억해달라는 것들을 잘 기록해줘. 친근하게 대화해. " +
      "마크다운 문법(**, ##, ```, - 등)은 절대 사용하지 마. 이모지를 적극적으로 활용해.";

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: finalPrompt }
  ];

  const payload = {
    model: "openclaw",
    user: userKey,
    messages,
  };

  console.log(`[bridge] Calling Gateway for ${sender}...`);
  const startTime = Date.now();

  // 9분 타임아웃 설정 (MessengerBotR 10분보다 짧게)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 540000);

  // 보안: sender + isGroupChat 기반 에이전트 라우팅
  const agentId = resolveAgentId(sender, isGroupChat);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GATEWAY_TOKEN}`,
        "Content-Type": "application/json",
        "x-openclaw-agent-id": agentId,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[bridge] Gateway responded in ${elapsed}s`);

    const text = await r.text();
    if (!r.ok) throw new Error(`Gateway ${r.status}: ${text}`);

    const data = JSON.parse(text);
    const out =
      data?.choices?.[0]?.message?.content ||
      data?.choices?.[0]?.delta?.content ||
      "(no content)";

    // Gateway가 빈 응답을 반환한 경우 1회 자동 재시도
    if (out === "No response from OpenClaw." && retryCount < 1) {
      console.log(`[bridge] Empty response from Gateway, retrying in 2s... (attempt ${retryCount + 1})`);
      await new Promise(r => setTimeout(r, 2000));
      return callGatewayChat(prompt, userKey, imageBase64, sender, isGroupChat, retryCount + 1);
    }

    // 재시도 후에도 빈 응답이면 사용자 친화적 메시지로 변환
    if (out === "No response from OpenClaw.") {
      console.log(`[bridge] Empty response persisted after retry for ${sender}`);
      return "AI가 일시적으로 응답하지 못했어요. 잠시 후 다시 시도해주세요.";
    }

    // 카카오톡용 마크다운 제거
    return stripMarkdown(out);
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      throw new Error('Gateway 응답 시간 초과 (5분)');
    }
    throw e;
  }
}

// ============================================================
// HTTP 서버
// ============================================================
const server = http.createServer(async (req, res) => {
  // GET /ping - 헬스 체크
  if (req.method === "GET" && req.url === "/ping") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("pong");
  }

  // GET /images/{filename} - 정적 이미지 파일 서빙
  if (req.method === "GET" && req.url.startsWith("/images/")) {
    const filename = decodeURIComponent(req.url.replace("/images/", ""));

    if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Invalid filename");
    }

    const imagePath = path.join(IMAGE_DIR, filename);

    if (!fs.existsSync(imagePath)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Image not found");
    }

    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp"
    };

    const contentType = mimeTypes[ext] || "application/octet-stream";

    try {
      const stats = fs.statSync(imagePath);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": stats.size,
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "https://images.earendel.blog"
      });
      fs.createReadStream(imagePath).pipe(res);
    } catch (e) {
      console.error(`[bridge] Image read error: ${e.message}`);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Internal server error");
    }
    return;
  }

  // Rate limiting for webhook endpoints
  const clientIp = req.socket.remoteAddress || "unknown";
  if (req.method === "POST" && ["/webhook/memento", "/webhook/image", "/webhook/url-summary", "/trigger-image"].includes(req.url)) {
    if (!checkRateLimit(clientIp)) {
      res.writeHead(429, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: "Rate limit exceeded" }));
    }
  }

  // POST /webhook/image - ADB 이미지 모니터에서 이미지 수신
  if (req.method === "POST" && req.url === "/webhook/image") {
    const raw = await readBody(req);
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
    }

    const { imageBase64, filename } = data || {};

    if (!imageBase64) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: "Missing imageBase64" }));
    }

    console.log(`[bridge] ADB image received: ${filename || "unknown"}`);

    let localFilename = filename || `adb-${Date.now()}.jpg`;
    let analysisResult = null;

    // 1. 이미지를 로컬 파일로 저장
    try {
      let pureBase64 = imageBase64;
      if (pureBase64.startsWith("data:")) {
        const match = pureBase64.match(/^data:[^;]+;base64,(.+)$/);
        if (match) pureBase64 = match[1];
      }

      const localPath = path.join(IMAGE_DIR, localFilename);
      fs.writeFileSync(localPath, Buffer.from(pureBase64, "base64"));
      console.log(`[bridge] Image saved to: ${localPath}`);
    } catch (e) {
      console.error(`[bridge] Image save failed: ${e.message}`);
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: `Image save failed: ${e.message}` }));
    }

    // 2. 로컬 파일 경로 생성
    const localPath = path.join(IMAGE_DIR, localFilename).replace(/\\/g, "/");
    console.log(`[bridge] Local path for Claude: ${localPath}`);

    // 3. OpenClaw Gateway에 이미지 분석 요청
    try {
      console.log(`[bridge] Starting Claude vision analysis via Gateway...`);

      const prompt = `로컬 이미지 파일을 분석해서 한국어로 설명해줘: ${localPath}`;
      const url = `${GATEWAY_URL}/v1/chat/completions`;
      const payload = {
        model: "openclaw",
        user: "adb-watcher",
        messages: [{ role: "user", content: prompt }],
      };

      const r = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GATEWAY_TOKEN}`,
          "Content-Type": "application/json",
          "x-openclaw-agent-id": "momento",
        },
        body: JSON.stringify(payload),
      });

      const text = await r.text();
      if (!r.ok) throw new Error(`Gateway ${r.status}: ${text}`);

      const responseData = JSON.parse(text);
      analysisResult = responseData?.choices?.[0]?.message?.content || "(no content)";
      analysisResult = `📷 이미지 분석 결과:\n\n${analysisResult}`;

      console.log(`[bridge] Claude vision analysis complete`);

      // 결과 저장 (카카오톡에서 가져갈 수 있도록)
      pendingImageResults.set("default", {
        result: analysisResult,
        timestamp: Date.now(),
        filename: localFilename
      });

      console.log(`[bridge] 이미지 분석 완료 - 카카오톡 폴링 대기중`);

    } catch (e) {
      console.error(`[bridge] Vision analysis failed: ${e.message}`);
      analysisResult = `이미지 분석 실패: ${e.message}`;

      // Claude 실패 시 Gemini로 폴백
      if (GEMINI_API_KEY) {
        try {
          console.log(`[bridge] Falling back to Gemini...`);
          analysisResult = await analyzeImageWithGemini(imageBase64, "이 이미지를 분석해서 한국어로 설명해줘.");
          analysisResult = `📷 이미지 분석 결과 (Gemini 폴백):\n\n${analysisResult}`;

          pendingImageResults.set("default", {
            result: analysisResult,
            timestamp: Date.now(),
            filename: localFilename
          });
        } catch (geminiErr) {
          console.error(`[bridge] Gemini fallback also failed: ${geminiErr.message}`);
        }
      }
    }

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ok: true,
      localPath,
      analysisResult,
      message: "이미지 분석 완료"
    }));
  }

  // GET /check-image-result - 최근 이미지 분석 결과 확인
  if (req.method === "GET" && req.url === "/check-image-result") {
    const pending = pendingImageResults.get("default");

    if (pending && (Date.now() - pending.timestamp) < 300000) { // 5분 유효
      pendingImageResults.delete("default");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        hasResult: true,
        result: pending.result,
        filename: pending.filename
      }));
    }

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ hasResult: false }));
  }

  // POST /trigger-image - 이벤트 드리븐 이미지 감지 (MessengerBotR에서 호출)
  if (req.method === "POST" && req.url === "/trigger-image") {
    const raw = await readBody(req);
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
    }

    const room = data?.room ?? "unknown";
    const sender = data?.author?.name ?? data?.sender ?? "unknown";

    console.log(`[bridge] Image trigger from ${sender}@${room}`);

    // 1. 최근 캐시 이미지 찾기 (5분 이내)
    const cacheFiles = findRecentCacheImages(5);
    console.log(`[bridge] Found ${cacheFiles.length} recent cache files`);

    // 2. 아직 처리되지 않은 새 이미지 찾기
    let newImage = null;
    for (const filepath of cacheFiles) {
      if (!processedCacheFiles.has(filepath)) {
        newImage = filepath;
        processedCacheFiles.add(filepath);
        break;
      }
    }

    if (!newImage) {
      // 새 이미지 없음 - 잠시 대기 후 재시도
      console.log(`[bridge] No new image yet, waiting...`);
      await new Promise(r => setTimeout(r, 3000));

      const retryFiles = findRecentCacheImages(5);
      for (const filepath of retryFiles) {
        if (!processedCacheFiles.has(filepath)) {
          newImage = filepath;
          processedCacheFiles.add(filepath);
          break;
        }
      }
    }

    if (!newImage) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        ok: false,
        text: "이미지를 찾을 수 없습니다. 다시 한 번 시도해주세요."
      }));
    }

    // 3. 이미지 다운로드
    console.log(`[bridge] Pulling image: ${path.basename(newImage)}`);
    const pulled = pullCacheImage(newImage);

    if (!pulled) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        ok: false,
        text: "이미지 다운로드 실패. 지원하지 않는 형식일 수 있습니다."
      }));
    }

    console.log(`[bridge] Image saved: ${pulled.localFilename}`);

    // 4. 이미지 분석
    let analysisResult = null;
    const localPath = pulled.localPath.replace(/\\/g, "/");

    try {
      console.log(`[bridge] Starting Claude vision analysis...`);

      const prompt = `로컬 이미지 파일을 분석해서 한국어로 설명해줘: ${localPath}`;
      const key = routeKey(sender, room);
      const gen = getGen(key);
      const userKey = `${key}#${gen}`;

      // 보안: 이중 검증으로 그룹채팅 판별
      const imgIsGroup = resolveIsGroupChat(room, sender, data?.isGroupChat);
      const imgAgentId = resolveAgentId(sender, imgIsGroup);
      const imgSystemPrompt = imgIsGroup
        ? "너는 모멘토봇이야. 한국 특허업계 실무자들이 모인 오픈채팅방에서 질문에 답변하는 AI야. " +
          "특허업무에 AI를 활용하는 것에 관심이 많은 사람들이니, 관련 질문에 특히 도움이 되도록 해. " +
          "간결하고 정확하게 답변해. 개인정보를 기억하거나 언급하지 마. " +
          "마크다운 문법(**, ##, ```, - 등)은 절대 사용하지 마. 이모지를 적극적으로 활용해."
        : "너는 모멘토봇이야. 개인 AI 기억 도우미야. 친근하게 대화해. " +
          "마크다운 문법(**, ##, ```, - 등)은 절대 사용하지 마. 이모지를 적극적으로 활용해.";

      const url = `${GATEWAY_URL}/v1/chat/completions`;
      const payload = {
        model: "openclaw",
        user: userKey,
        messages: [
          { role: "system", content: imgSystemPrompt },
          { role: "user", content: prompt }
        ],
      };

      const r = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GATEWAY_TOKEN}`,
          "Content-Type": "application/json",
          "x-openclaw-agent-id": imgAgentId,
        },
        body: JSON.stringify(payload),
      });

      const text = await r.text();
      if (!r.ok) throw new Error(`Gateway ${r.status}: ${text}`);

      const responseData = JSON.parse(text);
      analysisResult = responseData?.choices?.[0]?.message?.content || "(no content)";
      analysisResult = `📷 이미지 분석 결과:\n\n${analysisResult}`;

      console.log(`[bridge] Analysis complete for ${sender}@${room}`);

    } catch (e) {
      console.error(`[bridge] Vision analysis failed: ${e.message}`);

      // Gemini 폴백
      if (GEMINI_API_KEY) {
        try {
          console.log(`[bridge] Falling back to Gemini...`);
          const imageBase64 = fs.readFileSync(pulled.localPath, "base64");
          analysisResult = await analyzeImageWithGemini(imageBase64, "이 이미지를 분석해서 한국어로 설명해줘.");
          analysisResult = `📷 이미지 분석 결과 (Gemini):\n\n${analysisResult}`;
        } catch (geminiErr) {
          analysisResult = `이미지 분석 실패: ${e.message}`;
        }
      } else {
        analysisResult = `이미지 분석 실패: ${e.message}`;
      }
    }

    // 5. 결과 반환 (보안: 출력 필터 적용 + 마크다운 제거)
    const imgIsGroup = resolveIsGroupChat(room, sender, data?.isGroupChat);
    const safeAnalysis = stripMarkdown(sanitizeOutput(analysisResult, imgIsGroup, room, sender));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ok: true,
      text: safeAnalysis,
      filename: pulled.localFilename
    }));
  }

  // POST /webhook/url-summary - URL 자동 감지 및 요약
  if (req.method === "POST" && req.url === "/webhook/url-summary") {
    const raw = await readBody(req);
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
    }

    const url = data?.url ?? "";
    const room = data?.room ?? "unknown";
    const sender = data?.author?.name ?? data?.sender ?? "unknown";

    if (!url) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: "Missing URL" }));
    }

    console.log(`[bridge] URL summary request: ${url} from ${sender}@${room}`);

    // ============================================================
    // Threads.com 특별 처리 (브라우저 스크래핑)
    // Firecrawl이 Threads를 지원하지 않아서 브라우저로 직접 스크래핑
    // ============================================================
    if (url.includes("threads.com") || url.includes("threads.net")) {
      console.log(`[bridge] Threads URL detected, using browser scraping...`);
      
      try {
        // 1. 브라우저로 페이지 열기
        const openResult = await gatewayInvoke("browser", "open", {
          targetUrl: url,
          profile: "openclaw"
        });
        
        // Gateway 응답 형식: { content: [...], details: { targetId, ... } }
        const targetId = openResult?.details?.targetId || openResult?.targetId;
        if (!targetId) {
          console.error(`[bridge] Browser open result:`, JSON.stringify(openResult, null, 2));
          throw new Error("Failed to open browser tab");
        }
        
        console.log(`[bridge] Browser tab opened: ${targetId}`);
        
        // 2. 5초 대기 (JS 렌더링)
        await new Promise(r => setTimeout(r, 5000));
        
        // 3. 스냅샷 가져오기
        const snapshot = await gatewayInvoke("browser", "snapshot", {
          targetId,
          profile: "openclaw"
        });
        
        // 4. 브라우저 탭 닫기
        await gatewayInvoke("browser", "close", {
          targetId,
          profile: "openclaw"
        }).catch(() => {}); // 닫기 실패는 무시
        
        console.log(`[bridge] Browser snapshot complete`);
        
        // 5. 스냅샷에서 콘텐츠 추출
        const snapshotText = typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot, null, 2);
        
        // 6. AI로 요약 요청
        const key = routeKey(sender, room);
        const gen = getGen(key);
        const userKey = `${key}#${gen}`;
        const threadsIsGroup = resolveIsGroupChat(room, sender, data?.isGroupChat);
        
        const summaryPrompt = `다음은 Threads 게시물의 브라우저 스냅샷이야. 핵심 내용을 한국어로 요약해줘.

형식:
👤 작성자: [이름]
📝 내용: [핵심 내용 요약]
💬 주요 포인트 (있으면)
📊 반응: 좋아요/댓글/리포스트 수 (있으면)

게시물 내용만 추출해서 깔끔하게 정리해. 네비게이션이나 UI 요소는 무시해.

스냅샷:
${snapshotText.substring(0, 15000)}`;

        const summaryResult = await callGatewayChat(summaryPrompt, userKey, null, sender, threadsIsGroup);
        
        const finalText = stripMarkdown(sanitizeOutput(`🧵 ${url}\n\n${summaryResult}`, threadsIsGroup, room, sender));
        
        console.log(`[bridge] Threads summary complete`);
        
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ ok: true, text: finalText }));
        
      } catch (e) {
        console.error(`[bridge] Threads scraping error: ${e.message}`);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          ok: false,
          text: `Threads 스크래핑 실패: ${e.message}`
        }));
      }
    }

    try {
      // 0. 단축 URL 해석 + 네이버 블로그 모바일 변환
      let resolvedUrl = url;
      try {
        const shortDomains = /^https?:\/\/(?:naver\.me|me2\.do|han\.gl|bit\.ly|vo\.la)\//i;
        if (shortDomains.test(url)) {
          let cur = url;
          for (let i = 0; i < 5; i++) {
            const rr = await fetch(cur, { method: "HEAD", redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } });
            const loc = rr.headers.get("location");
            if (!loc || ![301,302,303,307,308].includes(rr.status)) break;
            cur = new URL(loc, cur).toString();
          }
          resolvedUrl = cur;
          console.log(`[bridge] Short URL resolved: ${url} → ${resolvedUrl}`);
        }
        // 네이버 블로그 → 모바일 버전 (iframe 우회)
        if (resolvedUrl.includes("blog.naver.com") && !resolvedUrl.includes("m.blog.naver.com")) {
          resolvedUrl = resolvedUrl.replace("blog.naver.com", "m.blog.naver.com");
          console.log(`[bridge] Blog converted to mobile: ${resolvedUrl}`);
        }
      } catch (resolveErr) {
        console.log(`[bridge] URL resolve failed (using original): ${resolveErr.message}`);
      }

      // 0.5. 네이버 지도 URL → 모바일 페이지 Apollo State로 풍부한 장소 정보 가져오기
      const naverPlaceMatch = resolvedUrl.match(/map\.naver\.com\/p\/entry\/place\/(\d+)/);
      if (naverPlaceMatch) {
        const placeId = naverPlaceMatch[1];
        console.log(`[bridge] Naver Map detected, fetching rich place info: ${placeId}`);
        try {
          // m.place.naver.com/place/{id}/home → 자동 리다이렉트로 올바른 businessType으로 이동
          const mobileRes = await fetch(`https://m.place.naver.com/place/${placeId}/home`, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Linux; Android 10; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
              "Accept-Language": "ko-KR,ko;q=0.9"
            },
            redirect: "follow"
          });
          const mobileHtml = await mobileRes.text();
          const apolloMatch = mobileHtml.match(/window\.__APOLLO_STATE__\s*=\s*(\{.*?\});/s);

          if (apolloMatch) {
            const apollo = JSON.parse(apolloMatch[1]);
            const detail = apollo[`PlaceDetailBase:${placeId}`];

            if (detail && detail.name) {
              // --- 기본 정보 ---
              const lines = [];
              lines.push(`📍 ${detail.name}`);
              if (detail.category) lines.push(`📂 ${detail.category}`);
              if (detail.roadAddress) lines.push(`📫 ${detail.roadAddress}`);
              else if (detail.address) lines.push(`📫 ${detail.address}`);
              if (detail.phone) lines.push(`📞 ${detail.phone}`);

              // --- 영업 정보 ---
              if (detail.businessHours?.description) {
                lines.push(`🕐 ${detail.businessHours.description}`);
              } else if (detail.hideBusinessHours === false && detail.missingInfo?.isBizHourMissing) {
                // 영업시간 정보 없음
              }

              // --- 찾아오는 길 ---
              const subway = apollo[`SubwayStationInfo:${Object.keys(apollo).find(k => k.startsWith("SubwayStationInfo:"))?.split(":")[1]}`];
              if (subway) {
                lines.push(`🚇 ${subway.displayName || subway.name} ${subway.nearestExit ? subway.nearestExit + "번 출구" : ""} 도보 ${subway.walkTime}분 (${subway.walkingDistance}m)`);
              }
              if (detail.road) lines.push(`🚶 ${detail.road}`);

              // --- 별점 & 리뷰 요약 ---
              if (detail.visitorReviewsScore) {
                lines.push(`\n⭐ ${detail.visitorReviewsScore}/5.0 (방문자 리뷰 ${detail.visitorReviewsTotal || 0}건)`);
              }

              // --- 리뷰 키워드 (투표 기반, 상위 5개) ---
              const reviewStats = apollo[`VisitorReviewStatsResult:${placeId}`];
              const keywords = reviewStats?.analysis?.votedKeyword?.details;
              if (keywords && keywords.length > 0) {
                const topKw = keywords.slice(0, 5).map(k => `"${k.displayName}" ${k.count}`).join(", ");
                lines.push(`💬 키워드: ${topKw}`);
              }

              // --- 한줄 리뷰 ---
              if (detail.microReviews && detail.microReviews.length > 0) {
                lines.push(`💭 "${detail.microReviews[0]}"`);
              }

              // --- 메뉴 (최대 5개) ---
              const menuKeys = Object.keys(apollo).filter(k => k.startsWith(`Menu:${placeId}_`)).sort((a, b) => {
                const ai = parseInt(a.split("_").pop());
                const bi = parseInt(b.split("_").pop());
                return ai - bi;
              });
              if (menuKeys.length > 0) {
                lines.push(`\n🍽️ 메뉴`);
                menuKeys.slice(0, 5).forEach(k => {
                  const m = apollo[k];
                  if (m && m.name) {
                    const price = m.price ? ` - ${Number(m.price).toLocaleString()}원` : "";
                    const rec = m.recommend ? " ⭐추천" : "";
                    lines.push(`  • ${m.name}${price}${rec}`);
                  }
                });
                if (menuKeys.length > 5) lines.push(`  ... 외 ${menuKeys.length - 5}개`);
              }

              // --- 편의시설 ---
              if (detail.conveniences && detail.conveniences.length > 0) {
                lines.push(`\n🏷️ ${detail.conveniences.join(" · ")}`);
              }

              // --- 결제 정보 ---
              if (detail.paymentInfo && detail.paymentInfo.length > 0) {
                lines.push(`💳 ${detail.paymentInfo.join(", ")}`);
              }

              // --- 블로그 리뷰 (최대 2개, 제목+발췌) ---
              const blogKeys = Object.keys(apollo).filter(k => k.startsWith("FsasReview:blog_"));
              if (blogKeys.length > 0) {
                lines.push(`\n📝 블로그 리뷰`);
                blogKeys.slice(0, 2).forEach(k => {
                  const b = apollo[k];
                  if (b && b.title) {
                    const excerpt = b.contents ? b.contents.substring(0, 60) + "..." : "";
                    lines.push(`  • ${b.title}`);
                    if (excerpt) lines.push(`    ${excerpt}`);
                  }
                });
              }

              lines.push(`\n🔗 ${url}`);

              console.log(`[bridge] Naver Place rich info fetched: ${detail.name} (${menuKeys.length} menus, ${blogKeys.length} blog reviews)`);
              const placeIsGroup = resolveIsGroupChat(room, sender, data?.isGroupChat);
              const placeText = sanitizeOutput(lines.join("\n"), placeIsGroup, room, sender);
              res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
              return res.end(JSON.stringify({ ok: true, text: placeText }));
            }
          }

          // Apollo state 파싱 실패 시 Summary API 폴백
          console.log(`[bridge] Apollo state not found, falling back to summary API`);
          const summaryRes = await fetch(`https://map.naver.com/p/api/place/summary/${placeId}`, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              "Referer": "https://map.naver.com/"
            }
          });
          const summaryData = await summaryRes.json();
          const d = summaryData?.data?.placeDetail;
          if (d) {
            const info = [
              `📍 ${d.name}`,
              d.category?.category ? `📂 ${d.category.category}` : null,
              d.address?.roadAddress ? `📫 ${d.address.roadAddress}` : (d.address?.address ? `📫 ${d.address.address}` : null),
              d.businessHours?.description ? `🕐 ${d.businessHours.description}` : null,
              d.visitorReviews ? `⭐ ${d.visitorReviews.score}/5.0 (${d.visitorReviews.displayText})` : null,
              d.blogReviews?.total ? `📝 블로그 리뷰 ${d.blogReviews.total}건` : null,
              `\n🔗 ${url}`
            ].filter(Boolean).join("\n");

            console.log(`[bridge] Naver Place summary fetched: ${d.name}`);
            const placeIsGroup = resolveIsGroupChat(room, sender, data?.isGroupChat);
            const placeText = sanitizeOutput(info, placeIsGroup, room, sender);
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ ok: true, text: placeText }));
          }
        } catch (placeErr) {
          console.log(`[bridge] Naver Place fetch failed: ${placeErr.message}, falling through to normal fetch`);
        }
      }

      // 1. 직접 페이지 내용 가져오기
      console.log(`[bridge] Fetching URL directly: ${resolvedUrl}`);
      const fetchResult = await fetchUrlContent(resolvedUrl, 8000);

      let pageContent = fetchResult.content;
      let pageTitle = fetchResult.title;

      // 직접 fetch 실패 시 Gateway 폴백
      if (!pageContent || pageContent.length < 50) {
        if (fetchResult.error) {
          console.log(`[bridge] Direct fetch failed: ${fetchResult.error}, trying gateway fallback...`);
        }
        try {
          const gwResult = await gatewayInvoke("web_fetch", null, {
            url: resolvedUrl,
            extractMode: "markdown",
            maxChars: 8000
          });
          const gwContent = gwResult?.content || gwResult?.text || (typeof gwResult === "string" ? gwResult : "");
          if (gwContent && gwContent.length >= 50) {
            pageContent = gwContent;
            console.log(`[bridge] Gateway fallback succeeded (${gwContent.length} chars)`);
          }
        } catch (gwErr) {
          console.log(`[bridge] Gateway fallback also failed: ${gwErr.message}`);
        }
      }

      // 두 방법 모두 실패
      if (!pageContent || pageContent.length < 50) {
        const reason = fetchResult.error || "내용을 추출할 수 없습니다.";
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          ok: false,
          text: `페이지 내용을 가져올 수 없습니다. (${reason})`
        }));
      }

      console.log(`[bridge] Fetched ${pageContent.length} chars, title: "${pageTitle || "(no title)"}"`);

      // 2. AI로 요약 요청
      const key = routeKey(sender, room);
      const gen = getGen(key);
      const userKey = `${key}#${gen}`;

      const summaryPrompt = `다음 웹페이지 내용을 한국어로 요약해줘.

형식:
👉 [제목]
📣 핵심 포인트 1
💡 핵심 포인트 2
🎯 핵심 포인트 3

간결하고 핵심만 담아서 3-5개 포인트로 요약해. 이모지를 활용해서 보기 좋게.

URL: ${url}
${pageTitle ? `페이지 제목: ${pageTitle}\n` : ""}
페이지 내용:
${pageContent.substring(0, 6000)}`;

      const urlIsGroup = resolveIsGroupChat(room, sender, data?.isGroupChat);
      const summaryResult = await callGatewayChat(summaryPrompt, userKey, null, sender, urlIsGroup);

      // 3. 결과 포맷팅 (보안: 출력 필터 적용 + 마크다운 제거)
      const finalText = stripMarkdown(sanitizeOutput(`🔗 ${url}\n\n${summaryResult}`, urlIsGroup, room, sender));

      console.log(`[bridge] URL summary complete for ${url}`);

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, text: finalText }));

    } catch (e) {
      console.error(`[bridge] URL summary error: ${e.message}`);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        ok: false,
        text: `URL 요약 실패: ${e.message}`
      }));
    }
  }

  // POST /webhook/memento - 메신저봇R 웹훅
  if (req.method === "POST" && req.url === "/webhook/memento") {
    const raw = await readBody(req);
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }

    const content = data?.content ?? "";
    const imageBase64 = data?.imageBase64 ?? null;
    let sender = data?.author?.name ?? data?.sender ?? "unknown";
    const room = data?.room ?? "unknown";
    
    // "오픈채팅봇" sender를 "질문자"로 변환 (AI가 봇으로 오해하지 않도록)
    if (sender === "오픈채팅봇") {
      sender = "질문자";
      console.log(`[bridge] Renamed sender: 오픈채팅봇 → 질문자`);
    }

    // 보안: isGroupChat 이중 검증
    const isGroupChat = resolveIsGroupChat(room, sender, data?.isGroupChat);

    // 보안: 프롬프트 인젝션 탐지 (그룹채팅만)
    if (detectInjection(content, isGroupChat, room, sender)) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ text: "죄송합니다, 해당 요청은 처리할 수 없습니다." }));
    }

    const key = routeKey(sender, room);
    const gen = getGen(key);
    const userKey = `${key}#${gen}`;

    // Command mode
    if (data && data.kind === "command") {
      try {
        const cmd = String(data.command || "").toLowerCase();
        if (cmd === "clear") {
          const next = bumpGen(key);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ text: `OK. 초기화 완료 (세션 ${next})` }));
        }

        if (cmd === "whoami") {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ text: `whoami: ${userKey}` }));
        }

        if (cmd === "status") {
          let sessionsInfo = "";
          try {
            const r = await gatewayInvoke("sessions_list", "json", { limit: 5 });
            const n = Array.isArray(r) ? r.length : (r?.sessions?.length ?? "?");
            sessionsInfo = `sessions_list ok (count=${n})`;
          } catch (e) {
            sessionsInfo = `sessions_list err: ${e?.message || e}`;
          }

          const upSec = Math.floor((Date.now() - startedAt) / 1000);
          const text =
            `bridge: ok (uptime ${upSec}s)\n` +
            `gateway: ${GATEWAY_URL}\n` +
            `${sessionsInfo}`;

          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ text }));
        }

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ text: `Unknown command: ${cmd}` }));
      } catch (e) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ text: `BRIDGE_CMD_ERR: ${e?.message || e}` }));
      }
    }

    // Normal chat mode
    try {
      console.log(`[bridge] Received - content.length=${content.length}, hasImage=${!!imageBase64}, sender=${sender}, isGroupChat=${isGroupChat}`);
      
      // 참고: 그룹채팅 필터링은 MessengerBotR에서 처리 (.질문, .요약 명령어)
      // Bridge는 전달받은 모든 메시지 처리
      
      const reply = await callGatewayChat(content, userKey, imageBase64, sender, isGroupChat);
      // 보안: 출력 필터 (개인정보 최종 차단) + 마크다운 이중 제거
      const safeReply = stripMarkdown(sanitizeOutput(reply, isGroupChat, room, sender));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ text: safeReply }));
    } catch (e) {
      console.error(`[bridge] Error: ${e?.message || e}`);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ text: `BRIDGE_GATEWAY_ERR: ${e?.message || e}` }));
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});

// ============================================================
// 서버 시작
// ============================================================
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} already in use. Killing zombie process...`);
    try {
      const netstat = execSync(
        `netstat -ano | findstr ":${PORT}.*LISTENING"`,
        { windowsHide: true, timeout: 5000 }
      ).toString();
      const match = netstat.match(/LISTENING\s+(\d+)/);
      if (match && match[1] !== "0") {
        const pid = match[1];
        console.error(`Killing zombie PID ${pid} on port ${PORT}`);
        execSync(`taskkill /PID ${pid} /F`, { windowsHide: true, timeout: 5000 });
        setTimeout(() => {
          server.listen(PORT, "127.0.0.1");
        }, 2000);
        return;
      }
    } catch (e) {
      console.error(`Failed to kill zombie: ${e.message}`);
    }
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`memento-bridge listening on port ${PORT}`);
  console.log(`gateway: ${GATEWAY_URL}`);
  console.log(`image dir: ${IMAGE_DIR}`);
  if (!GATEWAY_TOKEN) {
    console.warn("WARNING: OPENCLAW_GATEWAY_TOKEN not set!");
  }
  if (GEMINI_API_KEY) {
    console.log("Gemini fallback: enabled");
  }
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("Forced exit after 10s timeout.");
    process.exit(1);
  }, 10000);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
