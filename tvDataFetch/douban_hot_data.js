#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path")
const { spawnSync } = require("node:child_process");

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8";
const CURL_RETRY_LIMIT = 3;
const LOG_ENABLED = true;
const DOUBAN_COOKIE = (process.env.DOUBAN_COOKIE || "").trim();

// 默认配置
const DEFAULT_TYPE = "movie"; // movie | tv
const DEFAULT_TAG = "热门";
const DEFAULT_LIMIT = 20;

function logStep(message) {
  if (!LOG_ENABLED) return;
  const time = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.error(`[${time}] ${message}`);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function curl(args) {
  for (let attempt = 1; attempt <= CURL_RETRY_LIMIT; attempt += 1) {
    const result = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    if (result.status === 0) return result.stdout;
    logStep(`curl 失败，正在重试 (${attempt}/${CURL_RETRY_LIMIT})`);
    sleepMs(1000 * attempt);
  }
  throw new Error("curl 最终失败");
}

function appendCookieArgs(args) {
  if (!DOUBAN_COOKIE) return args;
  return [...args, "-H", `Cookie: ${DOUBAN_COOKIE}`];
}

function parseLocation(headers) {
  const match = headers.match(/^Location:\s*(\S+)/im);
  return match ? match[1] : null;
}

function splitHeadersAndBody(headersAndBody) {
  const separator = headersAndBody.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
  const index = headersAndBody.indexOf(separator);
  if (index === -1) {
    return { headers: "", body: headersAndBody };
  }
  return {
    headers: headersAndBody.slice(0, index),
    body: headersAndBody.slice(index + separator.length),
  };
}

function safePreview(text, length = 160) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, length);
}

function parseHotResponse(responseText, sourceLabel) {
  if (/error code:\s*008/i.test(responseText)) {
    throw new Error(
      `${sourceLabel} 要求登录（error code: 008）。请在环境变量 DOUBAN_COOKIE 中提供已登录的豆瓣 Cookie 后重试。`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`${sourceLabel} 返回非 JSON: ${safePreview(responseText)}`);
  }

  if (!parsed || !Array.isArray(parsed.data)) {
    throw new Error(`${sourceLabel} JSON 结构异常: ${safePreview(responseText)}`);
  }

  return parsed.data;
}

function solvePow(challenge) {
  let nonce = 0;
  while (true) {
    nonce += 1;
    const hash = crypto.createHash("sha512").update(challenge + nonce).digest("hex");
    if (hash.startsWith("0000")) return String(nonce);
  }
}

function parseChallengeHtml(html) {
  const match = (regex, label) => {
    const m = html.match(regex);
    if (!m) throw new Error(`无法解析校验参数: ${label}`);
    return m[1];
  };
  return {
    tok: match(/id="tok"[^>]*value="([^"]+)"/, "tok"),
    cha: match(/id="cha"[^>]*value="([^"]+)"/, "cha"),
    red: match(/id="red"[^>]*value="([^"]+)"/, "red"),
  };
}

function ensureSession(cookieJar) {
  const currentYear = new Date().getFullYear();
  const testUrl = `https://movie.douban.com/j/new_search_subjects?sort=U&range=0,10&tags=&playable=1&start=0&year_range=${currentYear},${currentYear}&limit=1`;
  logStep("检查会话有效性...");

  const headersAndBody = spawnSync("curl", appendCookieArgs([
    "--http1.1", "-sS", "-D", "-", "-c", cookieJar, "-b", cookieJar,
    "-H", `User-Agent: ${USER_AGENT}`,
    "-H", `Accept-Language: ${ACCEPT_LANGUAGE}`,
    "-H", "Referer: https://movie.douban.com/explore",
    testUrl
  ]), { encoding: "utf8" }).stdout;

  const secUrl = parseLocation(headersAndBody);
  if (!secUrl) {
    logStep("会话有效或无需校验");
    return;
  }

  logStep(`触发安全验证: ${secUrl}`);

  const challengeHtml = curl(appendCookieArgs([
    "--http1.1", "-sS", "-b", cookieJar, "-c", cookieJar,
    "-H", `User-Agent: ${USER_AGENT}`,
    "-H", `Accept-Language: ${ACCEPT_LANGUAGE}`,
    "-H", "Referer: https://movie.douban.com/explore",
    secUrl
  ]));
  const { tok, cha, red } = parseChallengeHtml(challengeHtml);

  logStep("正在计算 PoW...");
  const sol = solvePow(cha);

  curl(appendCookieArgs([
    "--http1.1", "-sS", "-L", "-b", cookieJar, "-c", cookieJar,
    "https://sec.douban.com/c",
    "-H", `User-Agent: ${USER_AGENT}`,
    "-H", `Accept-Language: ${ACCEPT_LANGUAGE}`,
    "-H", "Origin: https://sec.douban.com",
    "-H", `Referer: ${secUrl}`,
    "--data-urlencode", `tok=${tok}`,
    "--data-urlencode", `cha=${cha}`,
    "--data-urlencode", `sol=${sol}`,
    "--data-urlencode", `red=${red}`
  ]));
  logStep("验证通过");
}

function buildRequestUrl(options) {
  const currentYear = new Date().getFullYear();
  let url = `https://movie.douban.com/j/new_search_subjects?sort=U&range=0,10&tags=&playable=1&start=0&year_range=${currentYear},${currentYear}`;

  if (options.tag && options.tag !== DEFAULT_TAG) {
    url += `&tag=${encodeURIComponent(options.tag)}`;
  }
  if (options.type && options.type !== DEFAULT_TYPE) {
    url += `&selectable_type=${encodeURIComponent(options.type)}`;
  }
  if (options.limit) {
    url += `&limit=${options.limit}`;
  }

  return url;
}

function fetchHotDataFromUrl(url, cookieJar) {
  logStep(`抓取数据，URL: ${url}`);

  const headersAndBody = curl(appendCookieArgs([
    "--http1.1",
    "-sS",
    "-D",
    "-",
    "-b",
    cookieJar,
    "-c",
    cookieJar,
    "-H",
    `User-Agent: ${USER_AGENT}`,
    "-H",
    `Accept-Language: ${ACCEPT_LANGUAGE}`,
    "-H",
    "Referer: https://movie.douban.com/explore",
    url
  ]));

  const { headers, body } = splitHeadersAndBody(headersAndBody);
  const secUrl = parseLocation(headers);
  if (secUrl) {
    throw new Error(`请求被重定向到校验页: ${secUrl}`);
  }

  return parseHotResponse(body, url);
}

async function fetchHotData(options) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "douban-hot-"));
  const cookieJar = path.join(tempDir, "cookies.txt");

  try {
    logStep(`DOUBAN_COOKIE ${DOUBAN_COOKIE ? "已配置" : "未配置"}`);
    ensureSession(cookieJar);
    const url = buildRequestUrl(options);
    return fetchHotDataFromUrl(url, cookieJar);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function usage() {
  console.log(`
用法: node douban_hot_data.js [选项]
选项:
  --type <movie|tv>  类型 (默认: movie)
  --tag <string>     标签 (热门|最新|豆瓣高分, 默认: 热门)
  --limit <number>   获取数量 (默认: 20)
  --ids-only         只输出 ID 列表 (空格分隔)
  --pretty           格式化输出 JSON
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const options = { type: DEFAULT_TYPE, tag: DEFAULT_TAG, limit: DEFAULT_LIMIT, idsOnly: false, pretty: false };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--type") options.type = argv[++i];
    else if (argv[i] === "--tag") options.tag = argv[++i];
    else if (argv[i] === "--limit") options.limit = Number(argv[++i]);
    else if (argv[i] === "--ids-only") options.idsOnly = true;
    else if (argv[i] === "--pretty") options.pretty = true;
    else if (argv[i] === "--help" || argv[i] === "-h") { usage(); return; }
  }

  try {
    const data = await fetchHotData(options);
    if (options.idsOnly) {
      console.log(data.map(s => s.id).join(" "));
    } else {
      console.log(JSON.stringify(data, null, options.pretty ? 2 : 0));
    }
  } catch (err) {
    console.error("执行出错:", err.message);
    process.exit(1);
  }
}

main();
