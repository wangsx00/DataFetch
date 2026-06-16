#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * 独立工具脚本：下载视频并上传到 GitHub Release
 * 参数: subjectId, videoUrl, referer, userAgent
 */

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function log(msg) {
  const time = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.error(`[Upload] [${time}] ${msg}`);
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
  const localPath = path.join(__dirname, fileName);

  try {
    log(`[${subjectId}] 正在下载并上传到 Release: ${videoUrl}`);

    // 1. 下载 (使用 -s 隐藏进度条，避免干扰 stdout)
    execSync(`curl -L -s -H ${shellQuote(`Referer: ${referer}`)} -H ${shellQuote(`User-Agent: ${userAgent}`)} ${shellQuote(videoUrl)} -o "${localPath}"`, { stdio: 'inherit' });

    // 2. 上传 (将 gh 的 stdout 重定向到 stderr，防止干扰调用者捕获 URL)
    execSync(`gh release upload assets "${localPath}#${fileName}" --clobber`, { stdio: ['inherit', 2, 'inherit'] });

    // 3. 构造并输出 GitHub 永久链接到 stdout，供调用者捕获
    const permanentUrl = `https://github.com/${GITHUB_REPOSITORY}/releases/download/assets/${fileName}`;
    process.stdout.write(permanentUrl);
    log(`[${subjectId}] 上传完成: ${permanentUrl}`);
  } catch (e) {
    log(`[${subjectId}] 转储失败，回退到原始链接。错误: ${e.message}`);
    process.stdout.write(videoUrl);
  } finally {
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
  }
}

upload();
