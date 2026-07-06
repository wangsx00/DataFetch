#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * 独立工具脚本：下载视频并准备同步到 GitHub assets 分支
 * 参数: subjectId, videoUrl, referer, userAgent
 */

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function log(msg) {
  const time = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.error(`[Assets] [${time}] ${msg}`);
}

async function upload() {
  const [,, subjectId, videoUrl, referer, userAgent] = process.argv;

  if (!subjectId || !videoUrl) {
    console.error("缺少必要参数: subjectId 或 videoUrl");
    process.exit(1);
  }

  const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
  if (!GITHUB_REPOSITORY) {
    // 如果没有环境变量，直接输出原链接（不报错，方便本地测试）
    process.stdout.write(videoUrl);
    return;
  }

  const fileName = `${subjectId}_trailer.mp4`;
  // 将资源保存到项目根目录下的 assets 文件夹，后续由主脚本统一处理
  const assetsDir = path.join(process.cwd(), "assets");
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }
  const localPath = path.join(assetsDir, fileName);

  try {
    log(`[${subjectId}] 正在下载预告片: ${videoUrl}`);

    // 1. 下载 (使用 -s 隐藏进度条，避免干扰 stdout)
    execSync(`curl -L -s -H ${shellQuote(`Referer: ${referer}`)} -H ${shellQuote(`User-Agent: ${userAgent}`)} ${shellQuote(videoUrl)} -o "${localPath}"`, { stdio: 'inherit' });

    // 2. 构造并输出 GitHub Raw 永久链接到 stdout，供调用者捕获
    // 假设孤儿分支名为 assets
    const permanentUrl = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/assets/${fileName}`;
    process.stdout.write(permanentUrl);
    log(`[${subjectId}] 资源已就绪: ${permanentUrl}`);
  } catch (e) {
    log(`[${subjectId}] 下载失败，回退到原始链接。错误: ${e.message}`);
    process.stdout.write(videoUrl);
  }
}

upload();
