// 固定数据/模型边界 mock，仅供浏览器筛选与排序验收，不调用真实模型。
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../server/agent.ts";
import { createApp } from "../server/app.ts";
import { createJsonTaskStore } from "../server/task-store.ts";
import { createTaskClock } from "../server/task-clock.ts";
import { sourceHashes, writeReport } from "./verification-support.ts";
const directory = await mkdtemp(join(tmpdir(), "xiaoming-demo-mock-"));
const tasks = createJsonTaskStore(join(directory, "tasks.json"));
const clock = createTaskClock({
  timeZone: "Australia/Sydney",
  now: () => new Date("2026-12-31T12:00:00Z"),
});
const parent = tasks.create("准备面试", "2026-12-31", { priority: "low", effort: "large" });
const done = tasks.create("整理项目介绍", "2026-12-31", {
  parentId: parent.id,
  priority: "high",
  effort: "small",
});
tasks.update(done.id, { done: true });
tasks.create("练习自我介绍", "2027-01-01", {
  parentId: parent.id,
  priority: "low",
  effort: "medium",
});
tasks.create("录制演示", "2026-12-31", { parentId: parent.id, priority: "high", effort: "large" });
tasks.create("检查设备", "2026-12-31", { priority: "high", effort: "small" });
tasks.create("逾期对照", "2026-12-30");
const server = createApp({
  tasks,
  clock,
  reply: createAgent({ tasks, clock, planner: async () => ({ action: "list", status: "all" }) }),
}).listen(Number(process.env.PORT || 0), "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("没有端口");
const base = `http://127.0.0.1:${address.port}`;
await writeReport("reports/completion/browser-mock-fixture.json", {
  realModel: false,
  sourceHashes: await sourceHashes(),
  dateContext: clock(),
  tasks: tasks.list(),
  base,
});
console.log(`界面 mock：${base}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void (async () => {
      await server[Symbol.asyncDispose]();
      await rm(directory, { recursive: true, force: true });
      process.exit();
    })();
  });
