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
import { execSync } from "node:child_process";

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

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "http://localhost:25382";
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
// ADB 이미지 가져오기 (이벤트 드리븐)
// ============================================================
// ADB 장치 자동 감지 (캐시)
let _adbDevice = null;

function detectAdbDevice() {
  if (_adbDevice) return _adbDevice;
  const adbPath = fs.existsSync(ADB_PATH) ? `"${ADB_PATH}"` : "adb";
  try {
    const out = execSync(`${adbPath} devices`, { encoding: "utf8", timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
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
  const adbPath = fs.existsSync(ADB_PATH) ? `"${ADB_PATH}"` : "adb";
  const device = detectAdbDevice();
  const deviceFlag = device ? `-s ${device}` : "";
  const cmd = `${adbPath} ${deviceFlag} ${args}`;
  console.log(`[adb] Running: ${cmd}`);
  try {
    const result = execSync(cmd, { encoding: "utf8", timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
    console.log(`[adb] Result length: ${result.length}, content: "${result.trim().substring(0, 300)}"`);
    return result;
  } catch (e) {
    console.error(`[adb] Command failed: ${e.message}`);
    if (e.stdout) console.error(`[adb] stdout: ${e.stdout}`);
    if (e.stderr) console.error(`[adb] stderr: ${e.stderr}`);
    // 장치 캐시 초기화 (다음 시도에서 재감지)
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

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
    headers: { "Content-Type": "application/json" },
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
async function callGatewayChat(prompt, userKey = "memento", imageBase64 = null, sender = "unknown", isGroupChat = false) {
  if (!GATEWAY_TOKEN) {
    throw new Error("Missing OPENCLAW_GATEWAY_TOKEN");
  }

  let finalPrompt = prompt;

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
          return `📷 이미지 분석 결과:\n\n${analysis}`;
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
    ? "너는 모멘토봇이야. 한국 특허업계 실무자들이 모인 오픈채팅방에서 질문에 답변하는 AI야. " +
      "특허업무에 AI를 활용하는 것에 관심이 많은 사람들이니, 관련 질문에 특히 도움이 되도록 해. " +
      "간결하고 정확하게 답변해. 개인 비서 기능(일정, 메모, 할일)은 제공하지 마. " +
      "개인정보를 기억하거나 언급하지 마."
    : "너는 모멘토봇이야. 개인 AI 기억 도우미야. " +
      "일정 관리, 메모, 할일, 리마인더 등 개인 비서 역할을 해. " +
      "사용자가 기억해달라는 것들을 잘 기록해줘. 친근하게 대화해.";

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

  // 5분 타임아웃 설정
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GATEWAY_TOKEN}`,
        "Content-Type": "application/json",
        "x-openclaw-agent-id": "momento",
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
    return out;
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
        "Access-Control-Allow-Origin": "*"
      });
      fs.createReadStream(imagePath).pipe(res);
    } catch (e) {
      console.error(`[bridge] Image read error: ${e.message}`);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Internal server error");
    }
    return;
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

      const imgIsGroup = !!data?.isGroupChat;
      const imgSystemPrompt = imgIsGroup
        ? "너는 모멘토봇이야. 한국 특허업계 실무자들이 모인 오픈채팅방에서 질문에 답변하는 AI야. " +
          "특허업무에 AI를 활용하는 것에 관심이 많은 사람들이니, 관련 질문에 특히 도움이 되도록 해. " +
          "간결하고 정확하게 답변해. 개인정보를 기억하거나 언급하지 마."
        : "너는 모멘토봇이야. 개인 AI 기억 도우미야. 친근하게 대화해.";

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
          "x-openclaw-agent-id": "momento",
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

    // 5. 결과 반환
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ok: true,
      text: analysisResult,
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

    try {
      // 1. Gateway의 web_fetch 도구로 페이지 내용 가져오기
      const fetchResult = await gatewayInvoke("web_fetch", null, { 
        url: url,
        extractMode: "markdown",
        maxChars: 8000
      });

      const pageContent = fetchResult?.content || fetchResult?.text || fetchResult || "";
      
      if (!pageContent || pageContent.length < 50) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ 
          ok: false, 
          text: "페이지 내용을 가져올 수 없습니다." 
        }));
      }

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

페이지 내용:
${pageContent.substring(0, 6000)}`;

      const summaryResult = await callGatewayChat(summaryPrompt, userKey, null, sender, !!data?.isGroupChat);

      // 3. 결과 포맷팅
      const finalText = `🔗 ${url}\n\n${summaryResult}`;

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
    const sender = data?.author?.name ?? data?.sender ?? "unknown";
    const room = data?.room ?? "unknown";

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
      console.log(`[bridge] Received - content.length=${content.length}, hasImage=${!!imageBase64}, sender=${sender}`);
      const reply = await callGatewayChat(content, userKey, imageBase64, sender, !!data?.isGroupChat);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ text: reply }));
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
server.listen(PORT, "0.0.0.0", () => {
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
