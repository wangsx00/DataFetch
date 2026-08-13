#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * 这是一个集成脚本，用于自动化处理流程：
 * 1. 抓取热门列表
 * 2. 检查本地缓存 (douban_hot_json)，若命中则复用已有信息，跳过重复抓取
 * 3. 为新上榜的剧集抓取最佳 16:9 横向封面 (包含 AI 评分过滤)
 * 4. 获取新上榜剧集的预告片元数据，并将新视频下载到 assets 目录
 * 5. 从线上拉取已命中缓存的旧预告片视频，确保本地资源完整 (用于直接同步到 assets 分支)
 * 6. 合并所有数据(保留老图/老视频，更新最新评分)并输出最终文件
 *
 * 可选参数:
 *   --no-cache    禁用缓存机制，强制对所有热门剧集重新抓取图片和视频资源
 */

function log(msg) {
  const time = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${time}] ${msg}`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function logError(error) {
  if (!error) return;
  console.error(`[ERROR] ${error.message || String(error)}`);
  if (error.stack) {
    console.error(error.stack);
  }
}

async function main() {
  const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;

  try {
    // --- 步骤 0: 确保 assets 目录存在 ---
    const assetsDir = path.join(__dirname, "assets");
    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true });
    }

    // --- 步骤 1: 获取热门数据 ---
    log("正在获取豆瓣热门列表 (node douban_hot_data_python.js)...");
    const hotDataRaw = execSync("node douban_hot_data_python.js --limit 20", {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "inherit"]
    });
    const jsonList = JSON.parse(hotDataRaw);

    if (!jsonList || jsonList.length === 0) {
      console.error("未获取到热门数据，请检查网络或豆瓣接口。");
      return;
    }

    // --- 步骤 1.5: 读取本地缓存 ---
    const useCache = !process.argv.includes("--no-cache");
    const cacheFile = path.join(__dirname, "douban_hot_json");
    const cacheMap = {};
    if (useCache && fs.existsSync(cacheFile)) {
      try {
        const cacheData = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
        if (cacheData && Array.isArray(cacheData.data)) {
          cacheData.data.forEach(c => { cacheMap[c.id] = c; });
        }
      } catch (e) {
        log(`读取本地缓存失败: ${e.message}`);
      }
    }

    const idsToFetch = [];
    const cachedIds = [];
    jsonList.forEach(item => {
      if (!cacheMap[item.id]) {
        idsToFetch.push(item.id);
      } else {
        cachedIds.push(item.id);
      }
    });

    log(`总条目数: ${jsonList.length}，其中命中缓存 ${cachedIds.length} 个，需要新抓取 ${idsToFetch.length} 个`);

    let bestImageData = { results: [] };
    let trailerData = { results: [] };

    if (idsToFetch.length > 0) {
      const idsString = idsToFetch.join(" ");
      
      // --- 步骤 2: 获取横向封面 (16:9) ---
      log(`正在提取最佳 16:9 封面...`);
      const bestImageRaw = execSync(`node douban_best_image.js --ratio 16:9 ${idsString}`, {
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
        stdio: ["inherit", "pipe", "inherit"]
      });
      bestImageData = JSON.parse(bestImageRaw);

      // --- 步骤 3: 获取预告片播放地址 ---
      log(`正在提取预告片原始地址...`);
      const trailerRaw = execSync(`node douban_trailer_data.js ${idsString}`, {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        stdio: ["inherit", "pipe", "inherit"]
      });
      trailerData = JSON.parse(trailerRaw);
    }

    // --- 步骤 3.5: 拉取命中缓存的旧视频资源 ---
    if (cachedIds.length > 0) {
      log(`正在拉取命中缓存的老预告片视频 (${cachedIds.length} 个)...`);
      const assetsDir = path.join(__dirname, "assets");
      cachedIds.forEach(id => {
        const cachedItem = cacheMap[id];
        if (cachedItem && cachedItem.trailer_video_url && cachedItem.trailer_video_url.includes('githubusercontent.com')) {
          const videoUrl = cachedItem.trailer_video_url;
          const localPath = path.join(assetsDir, `${id}_trailer.mp4`);
          if (!fs.existsSync(localPath)) {
            try {
              log(`[${id}] 下载老视频复用: ${videoUrl}`);
              execSync(`curl -L -s ${shellQuote(videoUrl)} -o ${shellQuote(localPath)}`);
            } catch (e) {
              log(`[${id}] 下载老视频失败: ${e.message}`);
            }
          }
        }
      });
    }

    // 建立映射表
    const imageMap = {};
    if (bestImageData && bestImageData.results) {
      bestImageData.results.forEach(res => {
        if (res.image) imageMap[res.subjectId] = res.image;
      });
    }

    const trailerMap = {};
    if (trailerData && trailerData.results) {
      trailerData.results.forEach(res => {
        if (res.trailer) trailerMap[res.subjectId] = res.trailer;
      });
    }

    log(`横版封面匹配数: ${Object.keys(imageMap).length}`);
    log(`预告片匹配数: ${Object.keys(trailerMap).length}`);

    // --- 步骤 5: 合并数据 (不再包含 I/O 操作) ---
    log("正在合并最终数据...");
    const finalData = jsonList.map(item => {
      if (cacheMap[item.id]) {
        // 如果命中缓存，保留缓存中的封面和预告片等信息，同时用最新的基础信息（如评分）覆盖
        return {
          ...cacheMap[item.id],
          ...item
        };
      }

      const bestImg = imageMap[item.id];
      const trailer = trailerMap[item.id];
      let horizontal_cover = null;
      let horizontal_cover_composed = null;
      let download_command = null;
      let trailer_page_url = null;
      let trailer_detail_url = null;
      let trailer_title = null;
      let trailer_video_url = null;
      let trailer_video_composed = null;
      let trailer_download_command = null;

      if (bestImg) {
        horizontal_cover = bestImg.imageUrl || bestImg.thumbUrl;
        horizontal_cover_composed = `${horizontal_cover}@User-Agent=${bestImg.userAgent}@Referer=${bestImg.referer}`;
        download_command = bestImg.downloadCommand;
      }

      if (trailer) {
        trailer_page_url = trailer.pageUrl || null;
        trailer_detail_url = trailer.detailUrl || null;
        trailer_title = trailer.title || null;
        trailer_video_url = trailer.videoUrl || null;
        trailer_download_command = trailer.downloadCommand || null;

        // 根据最终的链接生成复合格式
        trailer_video_composed = trailer_video_url
          ? (trailer_video_url.includes('github.com') || trailer_video_url.includes('githubusercontent.com')
              ? trailer_video_url // GitHub 链接直接使用，无需 UA/Referer
              : `${trailer_video_url}@User-Agent=${trailer.userAgent}@Referer=${trailer.referer}`)
          : null;
      }

      const newItem = {
        ...item,
        horizontal_cover,
        horizontal_cover_composed,
        download_command,
        trailer_page_url,
        trailer_detail_url,
        trailer_title,
        trailer_video_url,
        trailer_video_composed,
        trailer_download_command
      };

      delete newItem.best_image_detail;
      return newItem;
    });

    // --- 步骤 6: 写出文件 (同时输出到 assets 目录供同步) ---
    const outputPath = path.join(__dirname, "douban_hot_json");
    const assetsOutputPath = path.join(__dirname, "assets", "douban_hot_json");
    const wrappedData = { data: finalData };
    fs.writeFileSync(outputPath, JSON.stringify(wrappedData, null, 2), "utf8");
    fs.writeFileSync(assetsOutputPath, JSON.stringify(wrappedData, null, 2), "utf8");

    // --- 步骤 7: 提示准备同步 ---
    if (GITHUB_REPOSITORY) {
      log(`✨ 处理流程结束，数据与资源已就绪在 assets/ 目录。`);
      log(`请将该目录内容推送到项目的 assets 孤儿分支。`);
    }

    log(`✨ 处理流程全部结束！`);
    log(`- 原始条目数: ${jsonList.length}`);
    log(`- 输出本地文件: ${outputPath}`);

  } catch (error) {
    console.error("❌ 执行过程中出错:");
    logError(error);
    process.exit(1);
  }
}

main();
