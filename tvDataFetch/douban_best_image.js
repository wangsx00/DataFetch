#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const aiVision = require("./ai_vision");

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8";
const CATEGORY_PRIORITY = [
  { code: "W", name: "wallpaper", label: "壁纸" },
  { code: "S", name: "screenshot", label: "剧照" },
  { code: "R", name: "poster", label: "海报" },
];
const PAGE_SIZE = 30;
const LOG_ENABLED = true;
const CURL_RETRY_LIMIT = 4;
const CURL_RETRY_DELAY_MS = 1500;
const DEFAULT_SORTBY = "size";
const ASPECT_DIFF_THRESHOLD = 0.1;
const DOUBAN_COOKIE = (process.env.DOUBAN_COOKIE || "").trim();

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function logStep(message) {
  if (!LOG_ENABLED) return;
  const time = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.error(`[${time}] ${message}`);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function appendCookieArgs(args) {
  if (!DOUBAN_COOKIE) return args;
  return [...args, "-H", `Cookie: ${DOUBAN_COOKIE}`];
}

function usage() {
  console.error(
    [
      "Usage:",
      "  node douban_best_image.js --ratio 16:9 35517044 1292052",
      "  node douban_best_image.js --ratio 1.777777 --ids-file ids.txt",
      "",
      "Options:",
      "  --ratio <value>     Target aspect ratio, like 16:9 or 1.777777",
      "  --ids-file <path>   Text file with one subject id per line",
      "  --concurrency <n>   Detail page concurrency, default 6",
      `  --sortby <value>    Category page sort, like/size/time, default ${DEFAULT_SORTBY}`,
      "  --pretty            Pretty-print JSON output",
      "  --ai                Enable AI vision content filtering (needs GEMINI_API_KEY/OPENAI_API_KEY)",
      "  --no-ai             Disable AI vision content filtering",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const ids = [];
  let ratioArg = null;
  let idsFile = null;
  let concurrency = 6;
  let sortby = DEFAULT_SORTBY;
  let pretty = false;
  let ai = "auto";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--ratio") {
      ratioArg = argv[++i];
    } else if (arg === "--ids-file") {
      idsFile = argv[++i];
    } else if (arg === "--concurrency") {
      concurrency = Number(argv[++i]);
    } else if (arg === "--sortby") {
      sortby = argv[++i];
    } else if (arg === "--pretty") {
      pretty = true;
    } else if (arg === "--ai") {
      ai = true;
    } else if (arg === "--no-ai") {
      ai = false;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      ids.push(arg);
    }
  }

  if (!ratioArg) {
    throw new Error("Missing required option: --ratio");
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

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }

  if (!["like", "size", "time"].includes(sortby)) {
    throw new Error("--sortby must be one of: like, size, time");
  }

  return {
    ratio: parseRatio(ratioArg),
    ratioArg,
    ids: dedupedIds,
    concurrency,
    sortby,
    pretty,
    ai,
  };
}

function parseRatio(input) {
  if (/^\d+:\d+$/.test(input)) {
    const [w, h] = input.split(":").map(Number);
    if (h === 0) throw new Error(`Invalid ratio: ${input}`);
    return w / h;
  }

  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ratio: ${input}`);
  }
  return value;
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

function parseChallengeHtml(html) {
  return {
    tok: matchOrThrow(html, /id="tok"[^>]*value="([^"]+)"/, "tok"),
    cha: matchOrThrow(html, /id="cha"[^>]*value="([^"]+)"/, "cha"),
    red: matchOrThrow(html, /id="red"[^>]*value="([^"]+)"/, "red"),
  };
}

function matchOrThrow(text, regex, label) {
  const match = text.match(regex);
  if (!match) {
    throw new Error(`Failed to parse ${label}`);
  }
  return match[1];
}

function makeSession(subjectId) {
  const baseUrl = `https://movie.douban.com/subject/${subjectId}/all_photos`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `douban-${subjectId}-`));
  const cookieJar = path.join(tempDir, "cookies.txt");

  logStep(`[${subjectId}] 建立会话，访问 all_photos`);

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
    `Referer: https://movie.douban.com/subject/${subjectId}/`,
  ]));

  const secUrl = parseLocation(headersAndBody);
  if (!secUrl) {
    logStep(`[${subjectId}] 未触发校验，直接复用当前会话`);
    return { cookieJar, baseUrl, tempDir };
  }

  logStep(`[${subjectId}] 触发豆瓣校验，开始获取挑战页`);

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
  logStep(`[${subjectId}] 开始求解校验 challenge`);
  const sol = solvePow(cha);
  logStep(`[${subjectId}] 校验求解完成，提交 challenge`);

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

  logStep(`[${subjectId}] 会话校验通过`);

  return { cookieJar, baseUrl, tempDir };
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

function parseCategoryCounts(allPhotosHtml) {
  const counts = { R: 0, W: 0, S: 0 };
  for (const code of Object.keys(counts)) {
    const regex = new RegExp(
      `photos\\?type=${code}[^"]*"[^>]*>共(\\d+)张<`,
      "i",
    );
    const match = allPhotosHtml.match(regex);
    counts[code] = match ? Number(match[1]) : 0;
  }
  return counts;
}

function parsePhotoCards(categoryHtml) {
  const items = [];
  const regex =
    /<div class="cover">\s*<a href="(https:\/\/movie\.douban\.com\/photos\/photo\/(\d+)\/)">\s*<img src="([^"]+)"/g;
  let match;
  while ((match = regex.exec(categoryHtml)) !== null) {
    items.push({
      photoId: match[2],
      detailUrl: match[1],
      thumbUrl: match[3],
    });
  }
  return items;
}

function parsePhotoDetail(detailHtml) {
  const sizeMatch = detailHtml.match(/大图尺寸：(\d+)x(\d+)/);
  if (!sizeMatch) return null;

  const imageMatch =
    detailHtml.match(/data-image="(https:\/\/img\d+\.doubanio\.com\/view\/photo\/l\/public\/[^"]+)"/) ||
    detailHtml.match(/<img src="(https:\/\/img\d+\.doubanio\.com\/view\/photo\/l\/public\/[^"]+)"/);

  return {
    width: Number(sizeMatch[1]),
    height: Number(sizeMatch[2]),
    imageUrl: imageMatch ? imageMatch[1] : null,
  };
}

/**
 * 抓取豆瓣条目页的影视标题，供 AI 评分时识别作品归属。
 * 依次尝试 og:title、h1、title 标签；失败返回 null。
 */
function fetchSubjectTitle(subjectId, session) {
  try {
    const url = `https://movie.douban.com/subject/${subjectId}/`;
    const html = fetchHtml(url, session, "https://movie.douban.com/");
    const og = html.match(/property="og:title"\s+content="([^"]+)"/);
    if (og) return og[1].trim();
    const h1 = html.match(/<h1>\s*<span[^>]*>([^<]+)<\/span>/);
    if (h1) return h1[1].trim();
    const t = html.match(/<title>([^<]+)<\/title>/);
    if (t) return t[1].replace(/\s*\(豆瓣\)\s*/, "").trim();
  } catch (err) {
    logStep(`[${subjectId}] 获取标题失败: ${err.message}`);
  }
  return null;
}

function aspectDiff(width, height, targetRatio) {
  return Math.abs(width / height - targetRatio);
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function fetchCategoryPhotos(subjectId, categoryCode, count, session, sortby) {
  const photos = [];
  const seen = new Set();
  const category = CATEGORY_PRIORITY.find((item) => item.code === categoryCode);
  const categoryLabel = category ? category.label : categoryCode;

  logStep(
    `[${subjectId}] 开始抓取${categoryLabel}列表第一页，共 ${count} 张，仅抓取前 ${PAGE_SIZE} 条候选，排序=${sortby}`,
  );

  const url =
    `https://movie.douban.com/subject/${subjectId}/photos?type=${categoryCode}` +
    `&start=0&sortby=${sortby}&size=a&subtype=a`;
  const html = fetchHtml(url, session, session.baseUrl);
  const pageItems = parsePhotoCards(html);
  logStep(
    `[${subjectId}] ${categoryLabel}第一页抓取完成，得到 ${pageItems.length} 条`,
  );
  for (const item of pageItems) {
    if (seen.has(item.photoId)) continue;
    seen.add(item.photoId);
    photos.push(item);
  }

  logStep(`[${subjectId}] ${categoryLabel}列表抓取结束，候选数 ${photos.length} 条`);

  return photos;
}

async function chooseBestForCategory(
  subjectId,
  category,
  targetRatio,
  session,
  counts,
  sortby,
  aiConfig,
  useAi,
  title,
) {
  const categoryUrl =
    `https://movie.douban.com/subject/${subjectId}/photos?type=${category.code}` +
    `&start=0&sortby=${sortby}&size=a&subtype=a`;
  const count = counts[category.code];
  if (!count) return null;

  logStep(
    `[${subjectId}] 按优先级尝试类目 ${category.label}，共 ${count} 张，目标比例 ${targetRatio}，排序=${sortby}`,
  );

  // 候选来源：AI 模式用截图过滤，否则用全部列表候选
  let candidates;
  let aiJudgements = null;
  // index -> AI 判断结果，供后续候选关联评分与审计
  const aiJudgeMap = new Map();

  if (useAi && aiConfig && aiConfig.enabled && title) {
    logStep(`[${subjectId}] ${category.label} AI 模式：准备截图列表页并过滤`);
    let captured = null;
    try {
      // 惰性加载，避免非 AI 模式下因缺少 puppeteer 而崩溃
      const { captureCategoryPage } = require("./page_screenshot");
      captured = await captureCategoryPage({
        subjectId,
        categoryCode: category.code,
        sortby,
        cookie: DOUBAN_COOKIE,
        userAgent: USER_AGENT,
      });
    } catch (err) {
      logStep(`[${subjectId}] ${category.label} 截图模块异常: ${err.message}`);
      captured = { screenshotBuffer: null, mapping: [], blocked: true };
    }

    if (captured.blocked || !captured.screenshotBuffer || captured.mapping.length === 0) {
      logStep(`[${subjectId}] ${category.label} 截图失败/被拦，回退纯比例算法`);
      candidates = fetchCategoryPhotos(subjectId, category.code, count, session, sortby);
    } else {
      // 调用视觉模型对整页截图按序号打分
      aiJudgements = aiVision.scoreScreenshot({
        subjectId,
        title,
        totalCount: captured.mapping.length,
        screenshotBuffer: captured.screenshotBuffer,
        config: aiConfig,
      });

      // 汇总 AI 判断：收集适合项序号，并建立 index -> 判断 映射
      const suitableSet = new Set();
      if (aiJudgements) {
        for (const j of aiJudgements) {
          aiJudgeMap.set(j.index, j);
          if (j.suitable) suitableSet.add(j.index);
        }
        logStep(
          `[${subjectId}] ${category.label} AI 判定：适合 ${suitableSet.size}/${aiJudgements.length}`,
        );
      }

      // 将截图映射项转为详情页候选对象（detailUrl 由 photoId 构造）
      const toCandidate = (m) => ({
        photoId: m.photoId,
        detailUrl: `https://movie.douban.com/photos/photo/${m.photoId}/`,
        thumbUrl: null,
        _aiIndex: m.index,
      });

      if (suitableSet.size > 0) {
        candidates = captured.mapping
          .filter((m) => m.photoId && suitableSet.has(m.index))
          .map(toCandidate);
        logStep(
          `[${subjectId}] ${category.label} AI 筛选通过 ${candidates.length}/${captured.mapping.length}`,
        );
      } else {
        logStep(`[${subjectId}] ${category.label} AI 无适合项，回退全部候选`);
        candidates = captured.mapping.filter((m) => m.photoId).map(toCandidate);
      }
    }
  } else {
    candidates = fetchCategoryPhotos(subjectId, category.code, count, session, sortby);
  }

  // 根据 AI 打分从高到低对候选列表进行排序，确保高分图片被优先比对和提前命中
  if (aiJudgeMap.size > 0) {
    candidates.sort((a, b) => {
      const scoreA = (a._aiIndex != null && aiJudgeMap.has(a._aiIndex)) ? aiJudgeMap.get(a._aiIndex).score : 0;
      const scoreB = (b._aiIndex != null && aiJudgeMap.has(b._aiIndex)) ? aiJudgeMap.get(b._aiIndex).score : 0;
      return scoreB - scoreA;
    });
  }

  let processed = 0;
  const progressStep = Math.max(1, Math.floor(candidates.length / 10));
  let best = null;

  for (const photo of candidates) {
    const html = fetchHtml(photo.detailUrl, session, categoryUrl);
    const parsed = parsePhotoDetail(html);
    processed += 1;
    if (processed === 1 || processed === candidates.length || processed % progressStep === 0) {
      logStep(
        `[${subjectId}] ${category.label}详情进度 ${processed}/${candidates.length}`,
      );
    }
    if (!parsed) {
      continue;
    }

    // 关联 AI 评分（仅截图模式候选带 _aiIndex，否则为 null）
    const aiInfo = photo._aiIndex != null ? aiJudgeMap.get(photo._aiIndex) : null;
    const candidate = {
      ...photo,
      ...parsed,
      aspectRatio: parsed.width / parsed.height,
      diff: aspectDiff(parsed.width, parsed.height, targetRatio),
      // AI 内容评分与理由，便于调试与结果审计
      aiScore: aiInfo ? aiInfo.score : null,
      aiReason: aiInfo ? aiInfo.reason : null,
    };

    if (!best) {
      best = candidate;
    } else {
      const scoreCand = candidate.aiScore || 0;
      const scoreBest = best.aiScore || 0;
      if (scoreCand !== scoreBest) {
        if (scoreCand > scoreBest) best = candidate;
      } else if (candidate.diff < best.diff) {
        best = candidate;
      }
    }

    const isAiSatisfied = candidate.aiScore == null || candidate.aiScore >= 4;
    if (candidate.diff < ASPECT_DIFF_THRESHOLD && isAiSatisfied) {
      logStep(
        `[${subjectId}] ${category.label}提前命中 photoId=${candidate.photoId} 尺寸=${candidate.width}x${candidate.height} diff=${candidate.diff} threshold=${ASPECT_DIFF_THRESHOLD} aiScore=${candidate.aiScore ?? "无"}`,
      );
      return {
        category: category.name,
        categoryLabel: category.label,
        availableCount: count,
        selected: candidate,
        matchedByThreshold: true,
      };
    }
  }

  if (!best) {
    logStep(`[${subjectId}] ${category.label}详情页未提取到有效尺寸，继续下一个类目`);
    return null;
  }

  logStep(
    `[${subjectId}] ${category.label}未命中 threshold=${ASPECT_DIFF_THRESHOLD}，回退到最接近图片 photoId=${best.photoId} 尺寸=${best.width}x${best.height} diff=${best.diff} aiScore=${best.aiScore ?? "无"} url=${best.detailUrl}`,
  );

  return {
    category: category.name,
    categoryLabel: category.label,
    availableCount: count,
    selected: best,
    matchedByThreshold: false,
  };
}

async function processSubject(subjectId, targetRatio, concurrency, sortby, aiConfig, useAi) {
  logStep(`[${subjectId}] 开始处理条目`);
  const session = makeSession(subjectId);
  try {
    const allPhotosHtml = fetchHtml(session.baseUrl, session, session.baseUrl);
    const counts = parseCategoryCounts(allPhotosHtml);
    logStep(
      `[${subjectId}] 类目统计 poster=${counts.R}, wallpaper=${counts.W}, screenshot=${counts.S}`,
    );

    // AI 模式需要影视标题，作为视觉模型判断作品归属的依据
    let title = null;
    if (useAi && aiConfig && aiConfig.enabled) {
      title = fetchSubjectTitle(subjectId, session);
      logStep(`[${subjectId}] 影视标题: ${title || "未知"}`);
    }

    let bestFallback = null;

    for (const category of CATEGORY_PRIORITY) {
      if (!counts[category.code]) continue;
      const result = await chooseBestForCategory(
        subjectId,
        category,
        targetRatio,
        session,
        counts,
        sortby,
        aiConfig,
        useAi,
        title,
      );

      if (result) {
        if (result.matchedByThreshold) {
          bestFallback = result;
          break; // 找到满足阈值的图片，直接中断类目遍历
        }
        // 如果没有命中阈值，则将此图加入到候选对比，优先比较 aiScore，如果 aiScore 相同再比较 diff
        if (!bestFallback) {
          bestFallback = result;
        } else {
          const scoreResult = result.selected.aiScore || 0;
          const scoreFallback = bestFallback.selected.aiScore || 0;
          if (scoreResult !== scoreFallback) {
            if (scoreResult > scoreFallback) bestFallback = result;
          } else if (result.selected.diff < bestFallback.selected.diff) {
            bestFallback = result;
          }
        }
      }
    }

    if (bestFallback) {
      const result = bestFallback;
      return {
        subjectId,
        matchedCategory: result.category,
        matchedCategoryLabel: result.categoryLabel,
        categoryCounts: {
          poster: counts.R,
          wallpaper: counts.W,
          screenshot: counts.S,
        },
        targetRatio,
        image: {
          photoId: result.selected.photoId,
          openUrl: result.selected.detailUrl,
          detailUrl: result.selected.detailUrl,
          imageUrl: result.selected.imageUrl || result.selected.thumbUrl,
          referer: result.selected.detailUrl,
          userAgent: USER_AGENT,
          downloadCommand: [
            "curl -L",
            `-H ${shellQuote(`Referer: ${result.selected.detailUrl}`)}`,
            `-H ${shellQuote(`User-Agent: ${USER_AGENT}`)}`,
            shellQuote(result.selected.imageUrl || result.selected.thumbUrl),
            `-o ${shellQuote(`${result.selected.photoId}.jpg`)}`,
          ].join(" "),
          width: result.selected.width,
          height: result.selected.height,
          aspectRatio: result.selected.aspectRatio,
          diff: result.selected.diff,
          matchedByThreshold: result.matchedByThreshold,
          threshold: ASPECT_DIFF_THRESHOLD,
          aiScore: result.selected.aiScore ?? null,
          aiReason: result.selected.aiReason ?? null,
        },
        aiUsed: useAi,
      };
    }

    logStep(`[${subjectId}] 三个类目都没有可用结果`);

    return {
      subjectId,
      matchedCategory: null,
      matchedCategoryLabel: null,
      categoryCounts: {
        poster: counts.R,
        wallpaper: counts.W,
        screenshot: counts.S,
      },
      targetRatio,
      image: null,
      aiUsed: useAi,
    };
  } finally {
    logStep(`[${subjectId}] 清理临时会话文件`);
    fs.rmSync(session.tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // AI 视觉过滤开关：auto 时按是否配置 key 自动启用，--ai/--no-ai 可强制
  const aiConfig = aiVision.getConfig();
  const useAi = args.ai === "auto" ? aiConfig.enabled : !!args.ai;
  logStep(`DOUBAN_COOKIE ${DOUBAN_COOKIE ? "已配置" : "未配置"}`);
  logStep(
    `AI 视觉过滤: ${useAi ? `启用 (provider=${aiConfig.provider}, model=${aiConfig.model})` : "未启用"}`,
  );
  logStep(
    `任务开始，条目数=${args.ids.length}，目标比例=${args.ratioArg}(${args.ratio})，并发=${args.concurrency}，排序=${args.sortby}`,
  );
  const results = [];

  for (const subjectId of args.ids) {
    const result = await processSubject(
      subjectId,
      args.ratio,
      args.concurrency,
      args.sortby,
      aiConfig,
      useAi,
    );
    results.push(result);
  }

  const output = {
    ratioInput: args.ratioArg,
    ratioValue: args.ratio,
    sortby: args.sortby,
    priority: CATEGORY_PRIORITY.map((item) => item.name),
    results,
  };

  logStep("任务完成，输出最终 JSON 结果");
  console.log(JSON.stringify(output, null, args.pretty ? 2 : 0));
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
