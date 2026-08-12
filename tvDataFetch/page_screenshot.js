#!/usr/bin/env node

/**
 * 列表页截图模块（依赖 puppeteer）
 *
 * 打开豆瓣图片列表页，给每张缩略图注入红色序号角标，整页截图，
 * 同时返回 index -> photoId 映射，供 AI 视觉评分后精确回指。
 *
 * 若触发反爬/登录墙（抓不到 .cover），返回 blocked=true，调用方回退纯比例算法。
 */

const puppeteer = require("puppeteer");

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

/** 将 "k=v; k2=v2" 形式的 Cookie 字符串解析为 puppeteer setCookie 所需对象。 */
function parseCookieString(cookieStr, domain) {
  if (!cookieStr) return [];
  return cookieStr
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf("=");
      if (idx === -1) return null;
      return {
        name: pair.slice(0, idx).trim(),
        value: pair.slice(idx + 1).trim(),
        domain,
        path: "/",
      };
    })
    .filter(Boolean);
}

function logStep(message) {
  const time = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.error(`[screenshot] [${time}] ${message}`);
}

/**
 * 抓取某个类目列表页的截图与 index->photoId 映射。
 * @param {{subjectId:string, categoryCode:string, sortby:string, cookie?:string, userAgent?:string}} param0
 * @returns {Promise<{screenshotBuffer:Buffer|null, mapping:Array<{index:number,photoId:string}>, blocked:boolean}>}
 */
async function captureCategoryPage({ subjectId, categoryCode, sortby, cookie, userAgent }) {
  const ua = userAgent || USER_AGENT;
  const url =
    `https://movie.douban.com/subject/${subjectId}/photos?type=${categoryCode}` +
    `&start=0&sortby=${sortby}&size=a&subtype=a`;

  logStep(`[${subjectId}] 打开列表页 ${url}`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(ua);
    if (cookie) {
      const cookies = parseCookieString(cookie, ".douban.com");
      if (cookies.length > 0) {
        await page.setCookie(...cookies);
        logStep(`[${subjectId}] 已注入 ${cookies.length} 条 Cookie`);
      }
    }
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });

    const response = await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    const status = response ? response.status() : 0;
    logStep(`[${subjectId}] 页面响应状态 ${status}`);

    // 等待缩略图容器出现
    try {
      await page.waitForSelector(".cover", { timeout: 15000 });
    } catch {
      logStep(`[${subjectId}] 未找到 .cover 元素，可能触发反爬或登录墙`);
      return { screenshotBuffer: null, mapping: [], blocked: true };
    }

    // 注入序号角标并提取 index -> photoId
    const mapping = await page.evaluate(() => {
      const covers = Array.from(document.querySelectorAll(".cover"));
      const list = [];
      covers.forEach((el, i) => {
        const a = el.querySelector('a[href*="/photos/photo/"]');
        const href = a ? a.getAttribute("href") : "";
        const m = href.match(/photo\/(\d+)\//);
        const photoId = m ? m[1] : null;

        const badge = document.createElement("div");
        badge.textContent = String(i + 1);
        badge.style.cssText =
          "position:absolute;top:4px;left:4px;background:#e0234e;color:#fff;" +
          "font:bold 16px/1 Arial,sans-serif;padding:3px 7px;border-radius:5px;" +
          "z-index:99999;box-shadow:0 1px 4px rgba(0,0,0,.7);pointer-events:none;";
        if (window.getComputedStyle(el).position === "static") {
          el.style.position = "relative";
        }
        el.appendChild(badge);

        list.push({ index: i + 1, photoId });
      });
      return list;
    });

    if (mapping.length === 0) {
      logStep(`[${subjectId}] 映射为空，可能页面结构异常`);
      return { screenshotBuffer: null, mapping: [], blocked: true };
    }

    logStep(`[${subjectId}] 已为 ${mapping.length} 张缩略图注入序号角标`);

    // 等待角标渲染
    await new Promise((resolve) => setTimeout(resolve, 400));

    const screenshotBuffer = await page.screenshot({ fullPage: true, type: "png" });
    logStep(`[${subjectId}] 截图完成，共 ${mapping.length} 张缩略图，体积 ${(screenshotBuffer.length / 1024).toFixed(0)}KB`);

    return { screenshotBuffer, mapping, blocked: false };
  } catch (err) {
    logStep(`[${subjectId}] 截图失败: ${err.message}`);
    return { screenshotBuffer: null, mapping: [], blocked: true };
  } finally {
    await browser.close();
  }
}

module.exports = {
  captureCategoryPage,
};
