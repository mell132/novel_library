// build.mjs
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

// 1. 加载 .env 环境变量
dotenv.config();

// 2. 定义R2客户端配置
const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const LOCAL_NOVEL_DIR = "./src/novels";
const BUCKET_NAME = "my-novels"; // 👈 改成你的存储桶名称

// 3. 确保本地 novels 文件夹存在，并清空旧文件
if (!fs.existsSync(LOCAL_NOVEL_DIR)) {
  fs.mkdirSync(LOCAL_NOVEL_DIR, { recursive: true });
} else {
  const files = fs.readdirSync(LOCAL_NOVEL_DIR);
  for (const file of files) {
    const filePath = path.join(LOCAL_NOVEL_DIR, file);
    fs.unlinkSync(filePath);
  }
}

// 4. 核心函数：从R2下载所有小说
async function downloadNovelsFromR2() {
  console.log("📡 正在连接R2，获取小说文件列表...");
  try {
    const listCommand = new ListObjectsV2Command({ Bucket: BUCKET_NAME });
    const listResult = await r2Client.send(listCommand);

    if (!listResult.Contents || listResult.Contents.length === 0) {
      console.log("⚠️ R2存储桶中没有找到任何文件。");
      return;
    }

    console.log(`✨ 在R2中找到 ${listResult.Contents.length} 个文件，开始下载...`);
    for (const object of listResult.Contents) {
      const key = object.Key;
      const localFilePath = path.join(LOCAL_NOVEL_DIR, path.basename(key));
      console.log(`⬇️  正在下载: ${key}`);
      const getCommand = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
      const response = await r2Client.send(getCommand);
      const fileContent = await response.Body.transformToByteArray();
      fs.writeFileSync(localFilePath, Buffer.from(fileContent));
    }
    console.log("✅ 所有小说文件下载并保存完毕！");
  } catch (error) {
    console.error("💥 下载过程中发生错误: ", error);
    process.exit(1);
  }
}

// 主流程：下载 -> 构建 -> 索引
async function build() {
  await downloadNovelsFromR2();

  console.log("🏗️  开始构建 Astro 静态网站...");
  try {
    execSync("npm run build", { stdio: "inherit" });
    console.log("🎉 Astro 构建和 Pagefind 索引创建成功！");
  } catch (error) {
    console.error("💥 Astro 构建过程中发生错误: ", error);
    process.exit(1);
  }
}

build();