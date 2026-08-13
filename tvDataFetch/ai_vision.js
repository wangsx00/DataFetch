#!/usr/bin/env node

/**
 * AI 视觉封面评分模块（零依赖，curl 调用）
 *
 * 截图模式：接收一张豆瓣图片列表页的整页截图（每张缩略图带红色序号角标），
 * 调用视觉模型判断哪些序号适合作为该影视的横版(16:9)封面。
 *
 * 支持两种 provider（由 AI_PROVIDER 选择）：
 *   - gemini（默认）：Gemini 原生 API，GEMINI_API_KEY，模型默认 gemini-2.5-flash
 *   - openai：OpenAI 兼容接口，OPENAI_API_KEY / OPENAI_BASE_URL，模型默认 gpt-4o-mini
 *
 * 环境变量：
 *   AI_PROVIDER          gemini | openai，默认 gemini
 *   GEMINI_API_KEY       Gemini key（也可用 GOOGLE_API_KEY）
 *   GEMINI_BASE_URL      可选，默认 https://generativelanguage.googleapis.com
 *   OPENAI_API_KEY       OpenAI 兼容 key
 *   OPENAI_BASE_URL      可选，默认 https://api.openai.com/v1
 *   AI_VISION_MODEL      可选，覆盖默认模型
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const REQUEST_TIMEOUT_SEC = 120;

/**
 * 读取 AI 视觉评分配置。依据 AI_PROVIDER 选择 gemini 或 openai，
 * enabled 表示是否已配置可用 key（缺失则调用方应回退纯比例算法）。
 */
function getConfig() {
  const provider = (process.env.AI_PROVIDER || "gemini").trim().toLowerCase();
  let apiKey = "";
  let model = "";
  let baseUrl = "";

  if (provider === "gemini") {
    apiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
    model = (process.env.AI_VISION_MODEL || DEFAULT_GEMINI_MODEL).trim();
    baseUrl = (process.env.GEMINI_BASE_URL || DEFAULT_GEMINI_BASE_URL)
      .trim()
      .replace(/\/+$/, "");
  } else {
    apiKey = (process.env.OPENAI_API_KEY || "").trim();
    model = (process.env.AI_VISION_MODEL || DEFAULT_OPENAI_MODEL).trim();
    baseUrl = (process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || DEFAULT_OPENAI_BASE_URL)
      .trim()
      .replace(/\/+$/, "");
  }

  return { provider, apiKey, model, baseUrl, enabled: !!apiKey };
}

function logStep(message) {
  const time = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.error(`[ai-vision] [${time}] ${message}`);
}

function randomTempName(prefix) {
  return path.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`,
  );
}

/**
 * 构造视觉模型 prompt：要求按截图中的红色序号判断每张缩略图
 * 是否适合作为该影视的横版封面，并以 JSON 返回判断结果。
 */
function buildPrompt(title, count) {
  const promptPath = path.join(__dirname, "ai_vision_prompt.txt");
  let template = "";
  try {
    template = fs.readFileSync(promptPath, "utf-8");
  } catch (err) {
    logStep(`无法读取 prompt 模板文件: ${err.message}`);
    // 基础兜底，防止文件丢失导致流程崩溃
    return `请判断下面截图中哪些带有红色序号(1到${count})的图片适合作为《${title}》的横版封面，以 JSON 格式返回。`;
  }
  
  return template.replace(/\{title\}/g, title).replace(/\{count\}/g, count);
}

/** 从可能含多余文本的模型输出中提取首个 JSON 对象，失败返回 null。 */
function extractJsonObject(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 解析 vision API 响应：按 provider 提取模型文本内容，再从中解析 results 数组。
 * 返回 null 表示解析失败。
 */
function parseVisionResponse(respText, provider) {
  let payload;
  try {
    payload = JSON.parse(respText);
  } catch {
    logStep(`API 返回非 JSON: ${(respText || "").slice(0, 200)}`);
    return null;
  }

  let content = "";
  if (provider === "gemini") {
    content =
      payload?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    const finishReason = payload?.candidates?.[0]?.finishReason;
    if (!content && finishReason) {
      logStep(`Gemini 无内容，finishReason=${finishReason}`);
    }
  } else {
    content = payload?.choices?.[0]?.message?.content || "";
  }

  if (!content) {
    logStep(`模型输出为空: ${JSON.stringify(payload).slice(0, 200)}`);
    return null;
  }

  const parsed = extractJsonObject(content);
  if (!parsed) {
    logStep(`无法从模型输出解析 JSON: ${content.slice(0, 200)}`);
    return null;
  }

  const results = Array.isArray(parsed.results)
    ? parsed.results
    : Array.isArray(parsed)
      ? parsed
      : [];
  return results;
}

/**
 * 调用 Gemini 原生 generateContent 接口：
 * inline_data 传入截图，responseMimeType 强制返回合法 JSON。
 */
function callGemini({ apiKey, baseUrl, model, title, count, imageBase64, imageMime }) {
  const body = {
    contents: [
      {
        parts: [
          { text: buildPrompt(title, count) },
          { inline_data: { mime_type: imageMime, data: imageBase64 } },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0,
      maxOutputTokens: 8192,
    },
  };

  const bodyFile = randomTempName("aiv-body");
  fs.writeFileSync(bodyFile, JSON.stringify(body));

  const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const args = [
    "-sS",
    "--max-time",
    String(REQUEST_TIMEOUT_SEC),
    url,
    "-H",
    "Content-Type: application/json",
    "-d",
    `@${bodyFile}`,
  ];

  let respText = "";
  try {
    const res = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 60 * 1024 * 1024 });
    respText = res.stdout || "";
    if (res.status !== 0) {
      logStep(`curl 调用失败 exit=${res.status}: ${(res.stderr || "").trim().slice(0, 200)}`);
      return null;
    }
  } finally {
    if (fs.existsSync(bodyFile)) fs.unlinkSync(bodyFile);
  }

  return parseVisionResponse(respText, "gemini");
}

/**
 * 调用 OpenAI 兼容 chat/completions 接口：
 * image_url 传入截图 data URI，response_format 强制返回 JSON 对象。
 */
function callOpenAI({ apiKey, baseUrl, model, title, count, imageBase64, imageMime }) {
  const dataUri = `data:${imageMime};base64,${imageBase64}`;
  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: buildPrompt(title, count) },
          { type: "image_url", image_url: { url: dataUri, detail: "high" } },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 4096,
    response_format: { type: "json_object" },
  };

  const bodyFile = randomTempName("aiv-body");
  fs.writeFileSync(bodyFile, JSON.stringify(body));

  const args = [
    "-sS",
    "--max-time",
    String(REQUEST_TIMEOUT_SEC),
    `${baseUrl}/chat/completions`,
    "-H",
    "Content-Type: application/json",
    "-H",
    `Authorization: Bearer ${apiKey}`,
    "-d",
    `@${bodyFile}`,
  ];

  let respText = "";
  try {
    const res = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 60 * 1024 * 1024 });
    respText = res.stdout || "";
    if (res.status !== 0) {
      logStep(`curl 调用失败 exit=${res.status}: ${(res.stderr || "").trim().slice(0, 200)}`);
      return null;
    }
  } finally {
    if (fs.existsSync(bodyFile)) fs.unlinkSync(bodyFile);
  }

  return parseVisionResponse(respText, "openai");
}

/**
 * 对一张列表页截图打分。
 * @param {{subjectId:string, title:string, totalCount:number, screenshotBuffer:Buffer, config:object}} param0
 * @returns {Array<{index:number,suitable:boolean,score:number,reason:string}>|null}
 */
function scoreScreenshot({ subjectId, title, totalCount, screenshotBuffer, config }) {
  if (!screenshotBuffer || screenshotBuffer.length === 0) {
    logStep(`[${subjectId}] 截图为空，跳过 AI 评分`);
    return null;
  }

  const imageMime = "image/png";
  // puppeteer 在部分版本/平台返回 Uint8Array 而非 Buffer，
  // Uint8Array.toString("base64") 不生效（会返回逗号分隔的字节），故统一转 Buffer
  const imageBuf = Buffer.isBuffer(screenshotBuffer)
    ? screenshotBuffer
    : Buffer.from(screenshotBuffer);
  const imageBase64 = imageBuf.toString("base64");
  logStep(
    `[${subjectId}] 调用 ${config.provider} (${config.model}) 评分，截图 ${(imageBuf.length / 1024).toFixed(0)}KB`,
  );

  let results = null;
  try {
    if (config.provider === "gemini") {
      const geminiFallbackModels = [
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3-flash-preview",
        "gemini-3.5-flash-lite"
      ];
      // 将 config.model 作为最高优先级，并合并备选模型列表（去重）
      const candidateModels = Array.from(new Set([config.model, ...geminiFallbackModels]));

      for (const m of candidateModels) {
        logStep(`[${subjectId}] 尝试调用 Gemini 模型: ${m}`);
        results = callGemini({
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model: m,
          title,
          count: totalCount,
          imageBase64,
          imageMime,
        });
        
        if (results !== null) {
          break; // 成功获取结果，跳出循环
        }
        logStep(`[${subjectId}] 模型 ${m} 请求失败或无结果，尝试降级...`);
      }
    } else {
      results = callOpenAI({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        title,
        count: totalCount,
        imageBase64,
        imageMime,
      });
    }
  } catch (err) {
    logStep(`[${subjectId}] AI 评分异常: ${err.message}`);
    return null;
  }

  if (!results || results.length === 0) {
    logStep(`[${subjectId}] AI 未返回有效结果`);
    return null;
  }

  const cleaned = results
    .map((r) => ({
      index: Number(r.index),
      suitable: !!r.suitable,
      score: Number(r.score) || 0,
      reason: String(r.reason || "").slice(0, 120),
    }))
    .filter((r) => Number.isInteger(r.index) && r.index >= 1);

  logStep(`[${subjectId}] AI 返回 ${cleaned.length} 条判断`);
  return cleaned;
}

module.exports = {
  getConfig,
  scoreScreenshot,
};
