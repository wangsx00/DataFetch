#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8";
const CURL_RETRY_LIMIT = 3;
const LOG_ENABLED = true;

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

  const headersAndBody = spawnSync("curl", [
    "-sS", "-D", "-", "-c", cookieJar, "-b", cookieJar,
    "-H", `User-Agent: ${USER_AGENT}`,
    testUrl
  ], { encoding: "utf8" }).stdout;

  const match = headersAndBody.match(/^Location:\s*(\S+)/im);
  if (!match) {
    logStep("会话有效或无需校验");
    return;
  }

  const secUrl = match[1];
  logStep(`触发安全验证: ${secUrl}`);

  const challengeHtml = curl(["-sS", "-b", cookieJar, "-c", cookieJar, "-H", `User-Agent: ${USER_AGENT}`, secUrl]);
  const { tok, cha, red } = parseChallengeHtml(challengeHtml);

  logStep("正在计算 PoW...");
  const sol = solvePow(cha);

  curl([
    "-sS", "-L", "-b", cookieJar, "-c", cookieJar,
    "https://sec.douban.com/c",
    "-H", `User-Agent: ${USER_AGENT}`,
    "--data-urlencode", `tok=${tok}`,
    "--data-urlencode", `cha=${cha}`,
    "--data-urlencode", `sol=${sol}`,
    "--data-urlencode", `red=${red}`
  ]);
  logStep("验证通过");
}

async function fetchHotData(options) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "douban-hot-"));
  const cookieJar = path.join(tempDir, "cookies.txt");

  try {
    ensureSession(cookieJar);

    const currentYear = new Date().getFullYear();
    // 保持与 HomeViewModel.kt 的 fetchDoubanHotData 参数一致
    let url = `https://movie.douban.com/j/new_search_subjects?sort=U&range=0,10&tags=&playable=1&start=0&year_range=${currentYear},${currentYear}`;

    // 如果命令行指定了 tag 或 type，则追加/覆盖
    if (options.tag && options.tag !== DEFAULT_TAG) {
        url += `&tag=${encodeURIComponent(options.tag)}`;
    }
    if (options.type && options.type !== DEFAULT_TYPE) {
        url += `&selectable_type=${options.type}`;
    }
    if (options.limit) {
        url += `&limit=${options.limit}`;
    }

    logStep(`抓取数据，URL: ${url}`);

    const response = curl([
      "-sS", "-b", cookieJar,
      "-H", `User-Agent: ${USER_AGENT}`,
      "-H", "Referer: https://movie.douban.com/explore",
      url
    ]);

    return JSON.parse(response).data;
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
