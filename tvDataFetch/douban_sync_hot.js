#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * 这是一个集成脚本，用于自动化处理流程：
 * 1. 抓取热门列表
 * 2. 为列表中的每个条目抓取最佳 16:9 横向封面
 * 3. 获取预告片元数据
 * 4. 将视频资源转储到 GitHub Releases (永久链接)
 * 5. 合并所有数据并输出到文件
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
    // --- 步骤 0: 清理 GitHub Release 中的旧视频资源 ---
    if (GITHUB_REPOSITORY) {
      try {
        log("正在检查并清理 GitHub Release 中的旧视频资源 (*.mp4)...");
        // 获取 Release 中所有的资源名称，使用 stdio: ['inherit', 'pipe', 'ignore'] 隐藏 stderr 避免干扰
        const assetsOutput = execSync(`gh release view assets --json assets --jq '.assets[].name'`, {
          encoding: 'utf8',
          stdio: ['inherit', 'pipe', 'ignore']
        });

        const mp4Assets = assetsOutput.split(/\s+/).filter(name =>
          name.trim().toLowerCase().endsWith('.mp4')
        );

        if (mp4Assets.length > 0) {
          log(`发现 ${mp4Assets.length} 个旧视频资源，准备清理...`);
          for (const assetName of mp4Assets) {
            log(`正在清理旧资源: ${assetName}`);
            execSync(`gh release delete-asset assets ${shellQuote(assetName)} -y`, { stdio: 'inherit' });
          }
          log("旧视频资源清理完成。");
        } else {
          log("未发现需要清理的视频资源。");
        }
      } catch (e) {
        log("清理旧视频资源跳过 (Release 可能尚未创建，或当前处于本地环境)");
      }
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

    const ids = jsonList.map(item => item.id);
    log(`成功获取 ${ids.length} 个条目，准备提取封面与预告片...`);

    // --- 步骤 2: 获取横向封面 (16:9) ---
    const idsString = ids.join(" ");
    log(`正在提取最佳 16:9 封面...`);
    const bestImageRaw = execSync(`node douban_best_image.js --ratio 16:9 ${idsString}`, {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["inherit", "pipe", "inherit"]
    });
    const bestImageData = JSON.parse(bestImageRaw);

    // --- 步骤 3: 获取预告片播放地址 ---
    log(`正在提取预告片原始地址...`);
    const trailerRaw = execSync(`node douban_trailer_data.js ${idsString}`, {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["inherit", "pipe", "inherit"]
    });
    const trailerData = JSON.parse(trailerRaw);

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
          ? (trailer_video_url.includes('github.com')
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

    // --- 步骤 6: 写出文件 ---
    const outputPath = path.join(__dirname, "douban_hot_json");
    const wrappedData = { data: finalData };
    fs.writeFileSync(outputPath, JSON.stringify(wrappedData, null, 2), "utf8");

    // --- 步骤 7: 将生成的 JSON 上传到 GitHub Release ---
    if (GITHUB_REPOSITORY) {
      try {
        log("正在将最终 JSON 上传到 GitHub Release...");
        // 使用 --clobber 覆盖旧版本，确保 assets 里的永远是最新的
        execSync(`gh release upload assets ${shellQuote(outputPath)} --clobber`, { stdio: 'inherit' });
        log("JSON 上传成功！");
      } catch (e) {
        log(`JSON 上传失败: ${e.message}`);
      }
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
