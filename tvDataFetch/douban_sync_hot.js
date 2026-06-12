#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * 这是一个集成脚本，用于自动化处理流程：
 * 1. 抓取热门列表
 * 2. 为列表中的每个条目抓取最佳 16:9 横向封面
 * 3. 合并数据并输出到文件
 */

function log(msg) {
  const time = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${time}] ${msg}`);
}

function logError(error) {
  if (!error) return;
  console.error(`[ERROR] ${error.message || String(error)}`);
  if (error.stack) {
    console.error(error.stack);
  }
}

async function main() {
  try {
    // --- 步骤 1: 获取热门数据 ---
    log("正在获取豆瓣热门列表 (node douban_hot_data.js)...");
    const hotDataRaw = execSync("node douban_hot_data_python.js --limit 20", {
//    const hotDataRaw = execSync("node douban_hot_data.js --limit 20", {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "inherit"] // 允许 stderr 日志打印到控制台
    });
    const jsonList = JSON.parse(hotDataRaw);

    if (!jsonList || jsonList.length === 0) {
      console.error("未获取到热门数据，请检查网络或豆瓣接口。");
      return;
    }

    const ids = jsonList.map(item => item.id);
    log(`成功获取 ${ids.length} 个条目，准备提取横向封面...`);

    // --- 步骤 2: 获取横向封面 (16:9) ---
    // 我们一次性把所有 ID 传给 douban_best_image.js，它内部会串行处理
    const idsString = ids.join(" ");
    log(`正在执行: node douban_best_image.js --ratio 16:9 ${idsString}`);

    const bestImageRaw = execSync(`node douban_best_image.js --ratio 16:9 ${idsString}`, {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024, // 增加缓冲区防止结果过大
      stdio: ["inherit", "pipe", "inherit"] // 允许 stderr 日志实时打印到控制台
    });
    const bestImageData = JSON.parse(bestImageRaw);

    // --- 步骤 3: 获取预告片播放地址 ---
    log(`正在执行: node douban_trailer_data.js ${idsString}`);
    const trailerRaw = execSync(`node douban_trailer_data.js ${idsString}`, {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["inherit", "pipe", "inherit"]
    });
    const trailerData = JSON.parse(trailerRaw);

    // 建立 ID 到图片信息的映射表
    const imageMap = {};
    if (bestImageData && bestImageData.results) {
      bestImageData.results.forEach(res => {
        if (res.image) {
          imageMap[res.subjectId] = res.image;
        }
      });
    }

    // 建立 ID 到预告片信息的映射表
    const trailerMap = {};
    if (trailerData && trailerData.results) {
      trailerData.results.forEach(res => {
        if (res.trailer) {
          trailerMap[res.subjectId] = res.trailer;
        }
      });
    }

    log(`横版封面匹配数: ${Object.keys(imageMap).length}`);
    log(`预告片匹配数: ${Object.keys(trailerMap).length}`);

    // --- 步骤 4: 合并数据 ---
    log("正在合并数据...");
    const finalData = jsonList.map(item => {
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
        // 重组前：原始 URL
        horizontal_cover = bestImg.imageUrl || bestImg.thumbUrl;

        // 重组后：按照 mapDoubanToMediaItems 要求的复合格式
        horizontal_cover_composed = `${horizontal_cover}@User-Agent=${bestImg.userAgent}@Referer=${bestImg.referer}`;

        // 提取下载命令
        download_command = bestImg.downloadCommand;
      }

      if (trailer) {
        trailer_page_url = trailer.pageUrl || null;
        trailer_detail_url = trailer.detailUrl || null;
        trailer_title = trailer.title || null;
        trailer_video_url = trailer.videoUrl || null;
        trailer_video_composed = trailer_video_url
          ? `${trailer_video_url}@User-Agent=${trailer.userAgent}@Referer=${trailer.referer}`
          : null;
        trailer_download_command = trailer.downloadCommand || null;
      }

      const newItem = {
        ...item,
        horizontal_cover,           // 重组前
        horizontal_cover_composed,  // 重组后
        download_command,           // 下载命令
        trailer_page_url,
        trailer_detail_url,
        trailer_title,
        trailer_video_url,
        trailer_video_composed,
        trailer_download_command
      };

      // 去除冗余的详情对象
      delete newItem.best_image_detail;

      return newItem;
    });

    // --- 步骤 5: 写出文件 ---
    const outputPath = path.join(__dirname, "douban_hot_json");
    // 增加前置处理，将数组包装在 data 字段中，以匹配 DoubanResponse 模型
    const wrappedData = {
      data: finalData
    };
    fs.writeFileSync(outputPath, JSON.stringify(wrappedData, null, 2), "utf8");

    log(`✨ 处理流程全部结束！`);
    log(`- 原始条目数: ${jsonList.length}`);
    log(`- 成功匹配封面数: ${Object.keys(imageMap).length}`);
    log(`- 输出本地文件: ${outputPath}`);

  } catch (error) {
    console.error("❌ 执行过程中出错:");
    logError(error);
    process.exit(1);
  }
}

main();
