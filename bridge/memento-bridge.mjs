/**
 * OpenClaw-Kakao Bridge Server
 *
 * MessengerBotR과 OpenClaw Gateway 사이의 브릿지 서버
 *
 * 환경변수:
 *   PORT - 서버 포트 (기본: 8787)
 *   OPENCLAW_GATEWAY_URL - Gateway URL (필수)
 *   OPENCLAW_GATEWAY_TOKEN - Gateway 토큰 (필수)
 *   OPENCLAW_CONFIG_PATH - openclaw.json 경로 (선택)
 *   GOOGLE_API_KEY - Gemini API 키 (선택, 폴백용)
 *   IMAGE_WATCH_DIR - 이미지 저장 디렉토리 (기본: ./kakao-images)
 */

import http from "http";
import fs from "fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// 이미지 저장 디렉토리
const IMAGE_DIR = process.env.IMAGE_WATCH_DIR || path.join(__dirname, "..", "kakao-images");

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
async function callGatewayChat(prompt, userKey = "memento", imageBase64 = null, sender = "unknown") {
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
        ? `${prompt}\n\n이 로컬 이미지 파일을 함께 분석해줘: ${localPath}`
        : `이 로컬 이미지 파일을 분석해서 한국어로 설명해줘: ${localPath}`;

    } catch (e) {
      console.error(`[bridge] Image save failed: ${e.message}`);
      // 이미지 저장 실패 시 Gemini 폴백 시도
      if (GEMINI_API_KEY) {
        try {
          const analysis = await analyzeImageWithGemini(imageBase64, prompt || "이 이미지를 분석해서 한국어로 설명해줘.");
          return `📷 이미지 분석 결과:\n\n${analysis}`;
        } catch (geminiErr) {
          return `📷 이미지 처리 중 오류: ${e.message}`;
        }
      }
      return `📷 이미지 처리 중 오류: ${e.message}`;
    }
  }

  // Gateway로 요청
  const url = `${GATEWAY_URL}/v1/chat/completions`;
  const payload = {
    model: "openclaw",
    user: userKey,
    messages: [{ role: "user", content: finalPrompt }],
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GATEWAY_TOKEN}`,
      "Content-Type": "application/json",
      "x-openclaw-agent-id": "main",
    },
    body: JSON.stringify(payload),
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`Gateway ${r.status}: ${text}`);

  const data = JSON.parse(text);
  const out =
    data?.choices?.[0]?.message?.content ||
    data?.choices?.[0]?.delta?.content ||
    "(no content)";
  return out;
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

    // 3. OpenClaw Gateway로 이미지 분석 요청
    try {
      console.log(`[bridge] Starting Claude vision analysis via Gateway...`);

      const prompt = `이 로컬 이미지 파일을 분석해서 한국어로 설명해줘: ${localPath}`;
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
          "x-openclaw-agent-id": "main",
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

      console.log(`[bridge] 이미지 분석 완료 - 카카오톡 폴링 대기 중`);

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
      const reply = await callGatewayChat(content, userKey, imageBase64, sender);
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
