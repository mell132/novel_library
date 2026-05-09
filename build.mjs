// build.mjs
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createReadStream, createWriteStream, readdirSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { pipeline } from "stream/promises";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const BUCKET_NAME = "my-novel-library";        // 你的存储桶名称
const MANIFEST_KEY = "manifest.json";          // 清单文件
const LOCAL_NOVEL_DIR = "./src/novels";

const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

if (!existsSync(LOCAL_NOVEL_DIR)) mkdirSync(LOCAL_NOVEL_DIR, { recursive: true });

async function computeHash(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  await pipeline(stream, hash);
  return hash.digest("hex");
}

// 下载清单（格式：{ "哈希": "文件名.txt" }）
async function downloadManifest() {
  try {
    const cmd = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: MANIFEST_KEY });
    const res = await r2Client.send(cmd);
    const body = await res.Body.transformToString();
    return JSON.parse(body);
  } catch (err) {
    if (err.Code === "NoSuchKey") return null;
    throw err;
  }
}

// 上传清单（格式保持不变）
async function uploadManifest(manifest) {
  const body = JSON.stringify(manifest, null, 2);
  const cmd = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: MANIFEST_KEY,
    Body: body,
    ContentType: "application/json",
  });
  await r2Client.send(cmd);
  console.log("✅ 清单已更新");
}

async function downloadFile(key, localPath) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
  const res = await r2Client.send(cmd);
  const writeStream = createWriteStream(localPath);
  await pipeline(res.Body, writeStream);
  const hash = await computeHash(localPath);
  console.log(`⬇️  下载: ${key} -> ${localPath} (哈希 ${hash.slice(0,8)}...)`);
  return hash;
}

async function main() {
  console.log("📡 正在获取 R2 中的文件列表...");
  // 1. 获取所有文件（排除 manifest 自身）
  let allObjects = [];
  let continuationToken;
  do {
    const cmd = new ListObjectsV2Command({ Bucket: BUCKET_NAME, ContinuationToken: continuationToken });
    const res = await r2Client.send(cmd);
    if (res.Contents) {
      allObjects.push(...res.Contents.filter(obj => obj.Key !== MANIFEST_KEY));
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);
  console.log(`📁 R2 中有 ${allObjects.length} 个小说文件`);

  // 2. 下载远程清单
  const remoteManifest = await downloadManifest(); // 格式 { hash: filename }
  const localManifest = remoteManifest ? { ...remoteManifest } : {};

  // 构建反向映射：文件名 -> 哈希（便于查找）
  const filenameToHash = {};
  for (const [hash, filename] of Object.entries(localManifest)) {
    filenameToHash[filename] = hash;
  }

  // 3. 扫描本地现有文件及其哈希
  const localFiles = new Map(); // 文件名 -> 哈希
  const existingLocal = readdirSync(LOCAL_NOVEL_DIR).filter(f => f.endsWith('.txt'));
  for (const file of existingLocal) {
    const filePath = path.join(LOCAL_NOVEL_DIR, file);
    const hash = await computeHash(filePath);
    localFiles.set(file, hash);
  }

  // 4. 决定需要下载的文件
  const toDownload = [];
  for (const obj of allObjects) {
    const key = obj.Key;  // 文件名
    const remoteHashFromManifest = filenameToHash[key];
    const localHash = localFiles.get(key);
    if (!localHash) {
      toDownload.push(key); // 本地不存在
    } else if (remoteHashFromManifest && localHash !== remoteHashFromManifest) {
      console.log(`🔄 文件已变化: ${key}`);
      toDownload.push(key);
    } else if (!remoteHashFromManifest) {
      // 本地存在但清单无记录，说明可能是手动添加的，补记录到清单
      localManifest[localHash] = key;
      filenameToHash[key] = localHash;
    }
  }

  // 5. 下载缺失或更新的文件
  if (toDownload.length === 0) {
    console.log("✅ 所有文件已是最新，无需下载");
  } else {
    console.log(`📥 需要下载 ${toDownload.length} 个文件`);
    for (const filename of toDownload) {
      const localPath = path.join(LOCAL_NOVEL_DIR, filename);
      const hash = await downloadFile(filename, localPath);
      // 更新清单（以哈希为键）
      localManifest[hash] = filename;
      filenameToHash[filename] = hash;
    }
  }

  // 6. 清理本地多余文件（在 R2 中已删除的）
  const remoteFilenames = new Set(allObjects.map(obj => obj.Key));
  for (const localFile of existingLocal) {
    if (!remoteFilenames.has(localFile)) {
      const localPath = path.join(LOCAL_NOVEL_DIR, localFile);
      unlinkSync(localPath);
      // 从清单中删除对应条目（根据文件名找到哈希）
      const hashToDelete = filenameToHash[localFile];
      if (hashToDelete) delete localManifest[hashToDelete];
      delete filenameToHash[localFile];
      console.log(`🗑️  删除本地多余文件: ${localFile}`);
    }
  }

  // 7. 上传更新后的清单
  await uploadManifest(localManifest);

  // 8. 构建 Astro 网站
  console.log("🏗️  开始构建 Astro 网站...");
  const { execSync } = await import("child_process");
  execSync("npx astro build", { stdio: "inherit" });
  console.log("🚀 Astro 构建完成！");

  // 9. Pagefind 索引
  console.log("🔍 开始使用 Pagefind 建立搜索索引...");
  const pagefind = await import("pagefind");
  const { index } = await pagefind.createIndex();
  await index.addDirectory({ path: "dist" });
  await index.writeFiles({ outputPath: "dist/pagefind" });
  console.log("🎉 索引创建完成！");
}

main().catch(err => {
  console.error("构建失败:", err);
  process.exit(1);
});