#!/usr/bin/env node

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const pythonScript = path.join(__dirname, "douban_hot_data.py");
const result = spawnSync("python3", [pythonScript, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(`执行出错: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 0);
