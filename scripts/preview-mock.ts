// 仅用于可复现的浏览器界面验收。生产入口 server/index.ts 始终使用真实模型。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createAgent } from "../server/agent.ts";
import { createApp } from "../server/app.ts";
import { createJsonTaskStore } from "../server/task-store.ts";
import type { Planner } from "../server/planner.ts";

const directory = mkdtempSync(join(tmpdir(), "xiaoming-browser-mock-"));
const tasks = createJsonTaskStore(join(directory, "tasks.json"));
const planner: Planner = async ({ messages, tasks: snapshot }) => {
  await setTimeout(400); // 留出可观察的等待状态。
  const text = messages.at(-1)!.content;
  if (["我有哪些任务？", "再给我看看清单", "看看我的待办"].includes(text))
    return { action: "list", status: "all" };
  if (["帮我记一下买牛奶", "提醒我买牛奶"].includes(text))
    return { action: "create", title: "买牛奶" };
  if (text === "再记一条取快递") return { action: "create", title: "取快递" };
  if (text === "帮我记一下洗衣服") return { action: "create", title: "洗衣服" };
  const title =
    text === "牛奶买好了"
      ? "买牛奶"
      : text === "衣服洗好了"
        ? "洗衣服"
        : text === "取快递这条删掉吧"
          ? "取快递"
          : undefined;
  if (title)
    return {
      action: text.includes("删") ? "delete" : "complete",
      taskIds: snapshot.filter((task) => task.title === title).map((task) => task.id),
    };
  throw new Error("浏览器测试fixture只接受官方六步和洗衣服场景的固定输入。");
};
const port = Number(process.env.PORT || 3000);
const server = createApp({ tasks, reply: createAgent({ tasks, planner }) }).listen(
  port,
  "127.0.0.1",
  () => {
    console.log(`仅用于界面测试的模型 MOCK：http://127.0.0.1:${port}`);
    console.log(`隔离任务文件：${join(directory, "tasks.json")}`);
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () =>
    server.close(() => {
      rmSync(directory, { recursive: true, force: true });
      process.exit();
    }),
  );
}
