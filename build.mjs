// build.mjs (修改版)
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import * as fs from "fs";
import * as path from "path";
import * as pagefind from "pagefind";
import dotenv from "dotenv";

dotenv.config();

const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const LOCAL_NOVEL_DIR = "./src/novels";
const TEMP_DOWNLOAD_DIR = "./src/novels_temp";  // 临时下载目录
const BUCKET_NAME = "my-novel-library";

// 确保两个目录存在
if (!fs.existsSync(LOCAL_NOVEL_DIR)) fs.mkdirSync(LOCAL_NOVEL_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DOWNLOAD_DIR)) fs.mkdirSync(TEMP_DOWNLOAD_DIR, { recursive: true });

async function downloadNovelsToTemp() {
  console.log(`📡 正在从 R2 获取小说列表...`);
  try {
    const listCommand = new ListObjectsV2Command({ Bucket: BUCKET_NAME });
    const listResult = await r2Client.send(listCommand);

    if (!listResult.Contents || listResult.Contents.length === 0) {
      console.log("⚠️ R2 存储桶中没有找到任何文件。");
      return false;
    }

    // 清空临时目录
    const tempFiles = fs.readdirSync(TEMP_DOWNLOAD_DIR);
    for (const file of tempFiles) {
      if (file !== '.gitkeep') fs.unlinkSync(path.join(TEMP_DOWNLOAD_DIR, file));
    }

    console.log(`✨ 找到 ${listResult.Contents.length} 个文件，开始下载到临时目录...`);
    for (const object of listResult.Contents) {
      const key = object.Key;
      const localFilePath = path.join(TEMP_DOWNLOAD_DIR, path.basename(key));
      console.log(`⬇️  正在下载: ${key}`);
      const getCommand = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
      const response = await r2Client.send(getCommand);
      const fileContent = await response.Body.transformToByteArray();
      fs.writeFileSync(localFilePath, Buffer.from(fileContent));
    }
    console.log("✅ 所有小说文件已下载到临时目录");
    return true;
  } catch (error) {
    console.error("💥 下载过程中发生错误:", error);
    return false;
  }
}

async function replaceNovelsWithTemp() {
  // 删除旧 novels 目录中的所有文件
  const oldFiles = fs.readdirSync(LOCAL_NOVEL_DIR);
  for (const file of oldFiles) {
    if (file !== '.gitkeep') fs.unlinkSync(path.join(LOCAL_NOVEL_DIR, file));
  }
  // 将临时目录中的文件移动到 novels 目录
  const tempFiles = fs.readdirSync(TEMP_DOWNLOAD_DIR);
  for (const file of tempFiles) {
    if (file !== '.gitkeep') {
      fs.renameSync(
        path.join(TEMP_DOWNLOAD_DIR, file),
        path.join(LOCAL_NOVEL_DIR, file)
      );
    }
  }
  console.log("✅ 已用新下载的小说替换旧文件");
}

async function buildAndIndex() {
  // 1. 下载到临时目录
  const downloadSuccess = await downloadNovelsToTemp();
  if (!downloadSuccess) {
    console.log("❌ 下载失败，保留原有 novels 文件不变（未替换）。");
    // 不进行后续构建，直接退出（或者你可以选择用旧文件继续构建）
    process.exit(1);
  }
  // 2. 替换 novels 文件夹
  await replaceNovelsWithTemp();

  // 3. 构建 Astro
  console.log("🏗️  开始构建 Astro 网站...");
  const { execSync } = await import("child_process");
  execSync("npx astro build", { stdio: "inherit" });
  console.log("🚀 Astro 构建完成！");

  // 4. Pagefind 索引
  console.log("🔍 开始使用 Pagefind 建立搜索索引...");
  const { index } = await pagefind.createIndex();
  await index.addDirectory({ path: "dist" });
  await index.writeFiles({ outputPath: "dist/pagefind" });
  console.log("🎉 Pagefind 索引创建完成！");
}

buildAndIndex().catch(console.error);