import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { createReadStream, readdirSync, statSync, createWriteStream } from "fs";
import { createHash } from "crypto";
import { pipeline } from "stream/promises";
import dotenv from "dotenv";
import path from "path";
import fs from 'fs';

dotenv.config();

// ---------- 配置 ----------
const BUCKET_NAME = "my-novel-library";          // 修改为你的 R2 存储桶名
const MANIFEST_KEY = "manifest.json";        // 清单文件在 R2 中的路径
const LOCAL_UPLOAD_DIR = "./to-upload";      // 本地存放待上传 TXT 的文件夹

// 初始化 R2 客户端
const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// ---------- 辅助函数 ----------
// 计算本地文件的 SHA-256 哈希（返回 hex 字符串）
async function computeFileHash(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  await pipeline(stream, hash);  // 流式计算，不占用大量内存
  return hash.digest("hex");
}

// 从 R2 下载清单文件（如果不存在则返回空对象）
async function downloadManifest() {
  try {
    const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: MANIFEST_KEY });
    const response = await r2Client.send(command);
    const body = await response.Body.transformToString();
    return JSON.parse(body);
  } catch (err) {
    if (err.Code === "NoSuchKey") {
      console.log("📄 清单文件不存在，将创建新的清单");
      return {};
    }
    console.error("下载清单失败:", err);
    throw err;
  }
}

// 上传清单文件到 R2
async function uploadManifest(manifest) {
  const body = JSON.stringify(manifest, null, 2);
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: MANIFEST_KEY,
    Body: body,
    ContentType: "application/json",
  });
  await r2Client.send(command);
  console.log("✅ 已更新清单文件 manifest.json");
}

// 上传单个文件到 R2（保留原始文件名）
async function uploadFile(localPath, remoteKey) {
  const fileStream = createReadStream(localPath);
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: remoteKey,
    Body: fileStream,
  });
  await r2Client.send(command);
  console.log(`⬆️ 已上传: ${remoteKey}`);
}

// ---------- 主流程 ----------
async function main() {
  // 1. 检查本地待上传目录
  if (!fs.existsSync(LOCAL_UPLOAD_DIR)) {
    console.log(`❌ 目录不存在: ${LOCAL_UPLOAD_DIR}`);
    return;
  }
  const files = fs.readdirSync(LOCAL_UPLOAD_DIR).filter(f => f.endsWith('.txt'));
  if (files.length === 0) {
    console.log("📭 没有找到任何 .txt 文件，请将待上传的小说放入", LOCAL_UPLOAD_DIR);
    return;
  }
  console.log(`📂 找到 ${files.length} 个待上传文件`);

  // 2. 下载现有的清单
  const manifest = await downloadManifest();
  console.log(`📋 当前清单中有 ${Object.keys(manifest).length} 个文件记录`);

  // 3. 逐个处理本地文件
  let uploadedCount = 0;
  let skippedCount = 0;
  for (const fileName of files) {
    const localPath = path.join(LOCAL_UPLOAD_DIR, fileName);
    // 计算哈希
    const hash = await computeFileHash(localPath);
    // 检查哈希是否已存在
    if (manifest[hash]) {
      // 已经存在，跳过上传
      console.log(`⏭️  跳过重复文件: ${fileName} (已存在: ${manifest[hash]})`);
      skippedCount++;
      // 可选：删除本地文件（开启下一行）
      // fs.unlinkSync(localPath);
    } else {
      // 新文件，上传
      await uploadFile(localPath, fileName);
      manifest[hash] = fileName;
      uploadedCount++;
      console.log(`✨ 新文件已记录: ${fileName}`);
    }
  }

  // 4. 如果有新上传，更新清单到 R2
  if (uploadedCount > 0) {
    await uploadManifest(manifest);
  }

  console.log(`\n🎉 完成：上传 ${uploadedCount} 个，跳过 ${skippedCount} 个重复文件。`);
}

// 运行
main().catch(console.error);