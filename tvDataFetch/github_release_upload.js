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

    // 1.5 检查大小并压缩 (如果 > 20MB)
    const stats = fs.statSync(localPath);
    const fileSizeInBytes = stats.size;
    const limitBytes = 20 * 1024 * 1024; // 20MB

    if (fileSizeInBytes >= limitBytes) {
      log(`[${subjectId}] 文件体积 (${(fileSizeInBytes / 1024 / 1024).toFixed(2)}MB) 超过限制，开始压缩...`);
      const compressedPath = localPath.replace(".mp4", "_compressed.mp4");

      try {
        // 获取视频时长 (秒)
        const duration = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${localPath}"`).toString().trim());

        if (duration > 0) {
          // 目标设定为 19MB 以留出余量，计算目标码率 (bits per second)
          // 码率 = (目标字节 * 8) / 时长
          const targetSizeBits = 19 * 1024 * 1024 * 8;
          const targetBitrate = Math.floor(targetSizeBits / duration);

          log(`[${subjectId}] 视频时长: ${duration}s, 目标码率: ${Math.floor(targetBitrate / 1000)}k`);

          // 使用 ffmpeg 压缩
          // -b:v 指定视频码率，-bufsize 设置缓冲区防止码率大幅波动，-maxrate 限制峰值
          execSync(`ffmpeg -y -i "${localPath}" -c:v libx264 -b:v ${targetBitrate} -pass 1 -an -f mp4 /dev/null && \
                    ffmpeg -y -i "${localPath}" -c:v libx264 -b:v ${targetBitrate} -pass 2 -c:a aac -b:a 128k "${compressedPath}"`, { stdio: 'ignore' });

          if (fs.existsSync(compressedPath)) {
            const newStats = fs.statSync(compressedPath);
            log(`[${subjectId}] 压缩完成，新体积: ${(newStats.size / 1024 / 1024).toFixed(2)}MB`);
            fs.renameSync(compressedPath, localPath); // 覆盖原文件
          }
        }
      } catch (err) {
        log(`[${subjectId}] 压缩过程中出错: ${err.message}，将保持原样上传。`);
      } finally {
        // 清理 ffmpeg 生成的日志文件
        const ffmpegLog = path.join(process.cwd(), "ffmpeg2pass-0.log");
        const ffmpegMbtree = path.join(process.cwd(), "ffmpeg2pass-0.log.mbtree");
        if (fs.existsSync(ffmpegLog)) fs.unlinkSync(ffmpegLog);
        if (fs.existsSync(ffmpegMbtree)) fs.unlinkSync(ffmpegMbtree);
      }
    }

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
