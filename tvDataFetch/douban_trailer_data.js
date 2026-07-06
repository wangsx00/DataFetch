#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8";
const LOG_ENABLED = true;
const CURL_RETRY_LIMIT = 4;
const CURL_RETRY_DELAY_MS = 1500;
const DOUBAN_COOKIE = (process.env.DOUBAN_COOKIE || "").trim();

function logStep(message) {
  if (!LOG_ENABLED) return;
  const time = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.error(`[${time}] ${message}`);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendCookieArgs(args) {
  if (!DOUBAN_COOKIE) return args;
  return [...args, "-H", `Cookie: ${DOUBAN_COOKIE}`];
}

function usage() {
  console.error(
    [
      "Usage:",
      "  node douban_trailer_data.js 35517044 1292052",
      "  node douban_trailer_data.js --ids-file ids.txt --pretty",
      "",
      "Options:",
      "  --ids-file <path>   Text file with one subject id per line",
      "  --pretty            Pretty-print JSON output",
      "  --debug-dir <path>  Write fetched HTML and parsed candidates for debugging",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const ids = [];
  let idsFile = null;
  let pretty = false;
  let debugDir = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--ids-file") {
      idsFile = argv[++i];
    } else if (arg === "--pretty") {
      pretty = true;
    } else if (arg === "--debug-dir") {
      debugDir = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      ids.push(arg);
    }
  }

  if (idsFile) {
    const fileIds = fs
      .readFileSync(idsFile, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    ids.push(...fileIds);
  }

  const dedupedIds = [...new Set(ids)];
  if (dedupedIds.length === 0) {
    throw new Error("No subject ids provided");
  }

  return { ids: dedupedIds, pretty, debugDir };
}

function curl(args, options = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= CURL_RETRY_LIMIT; attempt += 1) {
    const result = spawnSync("curl", args, {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      ...options,
    });

    if (result.status === 0) {
      return result.stdout;
    }

    const stderr = (result.stderr || "").trim();
    lastError = new Error(`curl failed (${result.status}): ${stderr || "no stderr"}`);

    const retryable =
      /SSL_ERROR_SYSCALL|Connection reset|Empty reply from server|timeout|timed out|HTTP\/2 stream/i.test(
        stderr,
      );

    if (!retryable || attempt === CURL_RETRY_LIMIT) {
      throw lastError;
    }

    logStep(
      `curl 请求失败，准备重试 ${attempt}/${CURL_RETRY_LIMIT - 1}，原因: ${stderr || "unknown"}`,
    );
    sleepMs(CURL_RETRY_DELAY_MS * attempt);
  }

  throw lastError || new Error("curl failed");
}

function solvePow(challenge) {
  let nonce = 0;
  while (true) {
    nonce += 1;
    const hash = crypto
      .createHash("sha512")
      .update(challenge + nonce)
      .digest("hex");
    if (hash.startsWith("0000")) {
      return String(nonce);
    }
  }
}

function parseLocation(headers) {
  const match = headers.match(/^Location:\s*(\S+)/im);
  return match ? match[1] : null;
}

function matchOrThrow(text, regex, label) {
  const match = text.match(regex);
  if (!match) {
    throw new Error(`Failed to parse ${label}`);
  }
  return match[1];
}

function parseChallengeHtml(html) {
  return {
    tok: matchOrThrow(html, /id="tok"[^>]*value="([^"]+)"/, "tok"),
    cha: matchOrThrow(html, /id="cha"[^>]*value="([^"]+)"/, "cha"),
    red: matchOrThrow(html, /id="red"[^>]*value="([^"]+)"/, "red"),
  };
}

function decodeHtml(value) {
  return value
    .replace(/\\u002[Ff]/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeUrl(url) {
  if (!url) return null;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://movie.douban.com${url}`;
  return decodeHtml(url);
}

function stripTags(value) {
  return decodeHtml(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function writeDebugFile(debugDir, name, content) {
  if (!debugDir) return;
  fs.mkdirSync(debugDir, { recursive: true });
  fs.writeFileSync(path.join(debugDir, safeFileName(name)), content, "utf8");
}

function makeSession(subjectId) {
  const baseUrl = `https://movie.douban.com/subject/${subjectId}/trailer`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `douban-trailer-${subjectId}-`));
  const cookieJar = path.join(tempDir, "cookies.txt");
  const subjectReferer = `https://movie.douban.com/subject/${subjectId}/`;

  logStep(`[${subjectId}] 建立预告片会话，访问 trailer 页`);

  const headersAndBody = curl(appendCookieArgs([
    "--http1.1",
    "-sS",
    "-D",
    "-",
    "-c",
    cookieJar,
    baseUrl,
    "-H",
    `User-Agent: ${USER_AGENT}`,
    "-H",
    `Accept-Language: ${ACCEPT_LANGUAGE}`,
    "-H",
    `Referer: ${subjectReferer}`,
  ]));

  const secUrl = parseLocation(headersAndBody);
  if (!secUrl) {
    logStep(`[${subjectId}] trailer 页未触发校验，直接复用当前会话`);
    return { cookieJar, baseUrl, tempDir, subjectReferer };
  }

  logStep(`[${subjectId}] trailer 页触发豆瓣校验，开始获取挑战页`);

  const challengeHtml = curl(appendCookieArgs([
    "--http1.1",
    "-sS",
    "-b",
    cookieJar,
    "-c",
    cookieJar,
    secUrl,
    "-H",
    `User-Agent: ${USER_AGENT}`,
    "-H",
    `Accept-Language: ${ACCEPT_LANGUAGE}`,
    "-H",
    `Referer: ${baseUrl}`,
  ]));

  const { tok, cha, red } = parseChallengeHtml(challengeHtml);
  logStep(`[${subjectId}] 开始求解 trailer challenge`);
  const sol = solvePow(cha);

  curl(appendCookieArgs([
    "--http1.1",
    "-sS",
    "-L",
    "-b",
    cookieJar,
    "-c",
    cookieJar,
    "https://sec.douban.com/c",
    "-H",
    `User-Agent: ${USER_AGENT}`,
    "-H",
    `Accept-Language: ${ACCEPT_LANGUAGE}`,
    "-H",
    "Origin: https://sec.douban.com",
    "-H",
    `Referer: ${secUrl}`,
    "--data-urlencode",
    `tok=${tok}`,
    "--data-urlencode",
    `cha=${cha}`,
    "--data-urlencode",
    `sol=${sol}`,
    "--data-urlencode",
    `red=${red}`,
  ]));

  logStep(`[${subjectId}] trailer 会话校验通过`);
  return { cookieJar, baseUrl, tempDir, subjectReferer };
}

function fetchHtml(url, session, referer) {
  return curl(appendCookieArgs([
    "--http1.1",
    "-sS",
    "-b",
    session.cookieJar,
    "-c",
    session.cookieJar,
    url,
    "-H",
    `User-Agent: ${USER_AGENT}`,
    "-H",
    `Accept-Language: ${ACCEPT_LANGUAGE}`,
    "-H",
    `Referer: ${referer}`,
  ]));
}

function parseTrailerList(html) {
  const normalizedHtml = html.replace(/\r/g, "");
  const linkRegex =
    /<a[\s\S]{0,400}?href="((?:https?:\/\/movie\.douban\.com\/trailer\/\d+\/?)|(?:https?:\\\/\\\/movie\.douban\.com\\\/trailer\\\/\d+\\\/?)|(?:\/trailer\/\d+\/?)|(?:\\\/trailer\\\/\d+\\\/?))"[\s\S]{0,400}?>([\s\S]*?)<\/a>|((?:https?:\/\/movie\.douban\.com\/trailer\/\d+\/?)|(?:https?:\\\/\\\/movie\.douban\.com\\\/trailer\\\/\d+\\\/?)|(?:\/trailer\/\d+\/?)|(?:\\\/trailer\\\/\d+\\\/?))/g;
  const headingRegex = /<h2[^>]*id="(trailer|clip|blooper)"[^>]*>[\s\S]*?<\/h2>/g;
  const categorized = { 预告片: [], 片段: [], 花絮: [] };
  const seenByCategory = { 预告片: new Set(), 片段: new Set(), 花絮: new Set() };
  const fallbackTrailers = [];
  const fallbackSeen = new Set();
  const headingToCategory = {
    trailer: "预告片",
    clip: "片段",
    blooper: "花絮",
  };
  const categoryRanges = [];

  let headingMatch;
  while ((headingMatch = headingRegex.exec(normalizedHtml)) !== null) {
    categoryRanges.push({
      name: headingToCategory[headingMatch[1]],
      start: headingMatch.index,
      end: normalizedHtml.length,
    });
  }

  for (let i = 0; i < categoryRanges.length - 1; i += 1) {
    categoryRanges[i].end = categoryRanges[i + 1].start;
  }

  let linkMatch;
  while ((linkMatch = linkRegex.exec(normalizedHtml)) !== null) {
    const detailUrl = normalizeUrl(linkMatch[1] || linkMatch[3]);
    if (!detailUrl) continue;

    const title = stripTags(linkMatch[2] || "");
    const trailerItem = {
      detailUrl,
      title: title || null,
      category: null,
    };

    if (!fallbackSeen.has(detailUrl)) {
      fallbackSeen.add(detailUrl);
      fallbackTrailers.push(trailerItem);
    }

    const range = categoryRanges.find((item) => linkMatch.index >= item.start && linkMatch.index < item.end);
    if (!range) continue;

    trailerItem.category = range.name;
    if (!seenByCategory[range.name].has(detailUrl)) {
      seenByCategory[range.name].add(detailUrl);
      categorized[range.name].push(trailerItem);
    }
  }

  if (categorized["预告片"].length > 0) {
    return categorized["预告片"];
  }

  return fallbackTrailers;
}

function parseTrailerDetail(html) {
  const matchedUrls = [];
  const patterns = [
    /<source[^>]+src="([^"]+)"/i,
    /<video[^>]+src="([^"]+)"/i,
    /data-video="([^"]+)"/i,
    /data-play-url="([^"]+)"/i,
    /"videoUrl"\s*:\s*"([^"]+)"/i,
    /"playUrl"\s*:\s*"([^"]+)"/i,
    /"video"\s*:\s*"([^"]+)"/i,
  ];

  for (const pattern of patterns) {
    const globalPattern = new RegExp(pattern.source, `${pattern.flags.replace(/g/g, "")}g`);
    const matches = [...html.matchAll(globalPattern)];
    for (const match of matches) {
      if (!match?.[1]) continue;
      const videoUrl = normalizeUrl(match[1]);
      if (videoUrl) {
        matchedUrls.push(videoUrl);
      }
    }
  }

  if (matchedUrls.length > 0) {
    return matchedUrls[0];
  }

  const mp4Matches = [...html.matchAll(/https?:\/\/[^"'\\\s]+\.mp4[^"'\\\s<]*/gi)].map((match) =>
    decodeHtml(match[0]),
  );

  const escapedMp4Matches = [
    ...html.matchAll(/https?:\\\/\\\/[^"'\\\s]+\.mp4[^"'<\s]*/gi),
  ].map((match) => decodeHtml(match[0]));

  if (escapedMp4Matches.length > 0) {
    return escapedMp4Matches[0];
  }

  return mp4Matches[0] || null;
}

function parseTrailerDetailTitle(html) {
  const patterns = [
    /<title>([^<]+)<\/title>/i,
    /property="og:title" content="([^"]+)"/i,
    /name="title" content="([^"]+)"/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const title = stripTags(match[1]);
      if (title) {
        return title;
      }
    }
  }

  return null;
}

function buildDownloadCommand(videoUrl, referer) {
  return [
    "curl -L",
    `-H ${shellQuote(`Referer: ${referer}`)}`,
    `-H ${shellQuote(`User-Agent: ${USER_AGENT}`)}`,
    shellQuote(videoUrl),
    "-o trailer.mp4",
  ].join(" ");
}

/**
 * 调用外部脚本将视频准备到 assets 目录并获取永久链接
 */
function uploadToGithubAssets(subjectId, videoUrl, referer) {
  const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
  if (!GITHUB_REPOSITORY) return videoUrl;

  try {
    logStep(`[${subjectId}] 触发下载并准备同步到 assets 分支...`);
    const uploadScript = path.join(__dirname, "github_release_upload.js");
    const result = spawnSync("node", [
      uploadScript,
      subjectId,
      videoUrl,
      referer,
      USER_AGENT
    ], { encoding: "utf8", env: process.env });

    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
  } catch (e) {
    logStep(`[${subjectId}] 脚本调用失败: ${e.message}`);
  }
  return videoUrl;
}

async function processSubject(subjectId) {
  logStep(`[${subjectId}] 开始提取预告片`);
  const session = makeSession(subjectId);

  try {
    const trailerPageHtml = fetchHtml(session.baseUrl, session, session.subjectReferer);
    writeDebugFile(processSubject.debugDir, `${subjectId}_trailer_page.html`, trailerPageHtml);
    const trailers = parseTrailerList(trailerPageHtml);
    writeDebugFile(
      processSubject.debugDir,
      `${subjectId}_trailer_candidates.json`,
      JSON.stringify(trailers, null, 2),
    );
    logStep(`[${subjectId}] trailer 列表解析完成，找到 ${trailers.length} 个候选详情页`);

    if (trailers.length === 0) {
      return {
        subjectId,
        trailer: null,
      };
    }

    const trailer = trailers[trailers.length - 1];
    if (trailer) {
      logStep(`[${subjectId}] 尝试解析预告片详情页 ${trailer.detailUrl}`);
      const detailHtml = fetchHtml(trailer.detailUrl, session, session.baseUrl);
      writeDebugFile(processSubject.debugDir, `${subjectId}_trailer_detail.html`, detailHtml);
      let videoUrl = parseTrailerDetail(detailHtml);
      if (videoUrl) {
        logStep(`[${subjectId}] 最终视频链接: ${videoUrl}`);
        // --- 核心修改：在此处立即执行资源准备 ---
        videoUrl = uploadToGithubAssets(subjectId, videoUrl, trailer.detailUrl);

        const detailTitle = parseTrailerDetailTitle(detailHtml);
        const selectedTitle = trailer.title || detailTitle || null;
        if (!selectedTitle) {
          logStep(`[${subjectId}] 已提取到视频直链，但标题提取失败，按成功处理`);
        }
        logStep(`[${subjectId}] assets 资源链接: ${videoUrl}`);
        return {
          subjectId,
          trailer: {
            pageUrl: session.baseUrl,
            detailUrl: trailer.detailUrl,
            title: selectedTitle,
            videoUrl,
            referer: trailer.detailUrl,
            userAgent: USER_AGENT,
            downloadCommand: buildDownloadCommand(videoUrl, trailer.detailUrl),
          },
        };
      }
    }

    logStep(`[${subjectId}] 未能从 trailer 详情页中提取视频地址`);
    return {
      subjectId,
      trailer: null,
    };
  } finally {
    logStep(`[${subjectId}] 清理预告片临时会话文件`);
    fs.rmSync(session.tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const results = [];
  processSubject.debugDir = args.debugDir;
  logStep(`DOUBAN_COOKIE ${DOUBAN_COOKIE ? "已配置" : "未配置"}`);

  for (const subjectId of args.ids) {
    results.push(await processSubject(subjectId));
  }

  console.log(
    JSON.stringify(
      {
        results,
      },
      null,
      args.pretty ? 2 : 0,
    ),
  );
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
