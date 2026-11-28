// 可重复的提交前检查；全部执行并记录每项退出码，不掩盖失败。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sourceHashes, writeReport } from "./verification-support.ts";
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 24 || (major === 24 && minor < 12))
  throw new Error("需要 Node.js 24.12.0 或更高版本。");
const startedAt = new Date().toISOString();
const before = createHash("sha256")
  .update(await readFile("SUBMIT.md"))
  .digest("hex");
const results = [];
for (const [command, ...args] of [
  ["npm", "test"],
  ["npm", "run", "typecheck"],
  ["npm", "run", "lint"],
  ["npm", "run", "fmt:check"],
  ["npm", "run", "build"],
  ["git", "diff", "--check"],
]) {
  const result = spawnSync(command, args, { encoding: "utf8", env: process.env });
  results.push({
    command: [command, ...args].join(" "),
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message,
  });
  console.log(`${results.at(-1)!.command}: ${result.status}`);
}
const after = createHash("sha256")
  .update(await readFile("SUBMIT.md"))
  .digest("hex");
const passed = results.every((result) => result.exitCode === 0) && before === after;
await writeReport(process.env.CHECK_REPORT || "reports/completion/checks.json", {
  startedAt,
  finishedAt: new Date().toISOString(),
  nodeVersion: process.version,
  sourceHashes: await sourceHashes(),
  submitHashBefore: before,
  submitHashAfter: after,
  passed,
  results,
});
if (!passed) process.exitCode = 1;
