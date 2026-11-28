import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// 对实现、界面、脚本和校验配置取哈希；不读取 .env 或开发任务数据。
export async function sourceHashes() {
  const files = ["package.json", "package-lock.json", "tsconfig.json"];
  for (const directory of ["server", "shared", "src", "scripts", "public"]) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile()) files.push(join(directory, entry.name));
    }
  }
  return Object.fromEntries(
    await Promise.all(
      files.sort().map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      ]),
    ),
  );
}

export async function writeReport(path: string, report: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + "\n");
}
