import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { ChatMessage } from "../shared/chat.ts";
import { taskListSchema } from "../shared/tasks.ts";
import { model } from "../server/model.ts";

if (!process.env.DEEPSEEK_API_KEY?.trim()) {
  console.error(
    "未运行真实模型验收：请先在本地 .env 配置 DEEPSEEK_API_KEY。没有产生模型调用费用。",
  );
  process.exit(1);
}

console.log(`真实模型验收配置：${model}，reasoning_effort=none（非思考模式）。`);

const directory = await mkdtemp(join(tmpdir(), "xiaoming-live-"));
const filename = join(directory, "tasks.json");
let child: ChildProcess | undefined;
let base = "";
let history: ChatMessage[] = [];

async function start() {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--env-file-if-exists=.env", "server/index.ts"], {
    env: { ...process.env, PORT: String(port), TASKS_FILE: filename },
    stdio: ["ignore", "ignore", "inherit"],
  });
  let failure: Error | undefined;
  child.once("error", (error) => {
    failure = error;
  });
  for (let count = 0; count < 100; count++) {
    if (failure) throw failure;
    if (child.exitCode !== null) throw new Error("服务启动失败。");
    try {
      if ((await fetch(base + "/api/tasks")).ok) return;
    } catch {
      /* 等待端口就绪 */
    }
    await setTimeout(100);
  }
  throw new Error("等待服务启动超时。");
}

async function stop() {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  child = undefined;
}

async function chat(content: string, expectedReply: RegExp) {
  history.push({ role: "user", content });
  const response = await fetch(base + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ messages: history }),
    signal: AbortSignal.timeout(35_000),
  });
  assert.equal(response.status, 200);
  const body: { reply: string } = await response.json();
  assert.match(body.reply, expectedReply);
  history.push({ role: "assistant", content: body.reply });
  console.log(`✓ ${content}\n  ${body.reply}`);
}

async function state(expected: { title: string; done: boolean }[]) {
  const response = await fetch(base + "/api/tasks");
  assert.equal(response.status, 200);
  const tasks = taskListSchema.parse(await response.json());
  assert.deepEqual(
    tasks.map(({ title, done }) => ({ title, done })),
    expected,
  );
  const disk = taskListSchema.parse(JSON.parse(await readFile(filename, "utf8")));
  assert.deepEqual(tasks, disk);
}

try {
  await start();
  await chat("帮我记一下买牛奶", /已添加待办：买牛奶/);
  await state([{ title: "买牛奶", done: false }]);
  await chat("再记一条取快递", /已添加待办：取快递/);
  const two = [
    { title: "买牛奶", done: false },
    { title: "取快递", done: false },
  ];
  await state(two);
  await chat("我有哪些任务？", /未完成 · 买牛奶[\s\S]*未完成 · 取快递/);
  await state(two);
  await chat("牛奶买好了", /已完成：买牛奶/);
  await state([
    { title: "买牛奶", done: true },
    { title: "取快递", done: false },
  ]);
  await chat("取快递这条删掉吧", /已删除：取快递/);
  const remaining = [{ title: "买牛奶", done: true }];
  await state(remaining);
  await chat("再给我看看清单", /已完成 · 买牛奶/);
  await state(remaining);
  history = []; // 模拟刷新：聊天历史清空，任务保留。
  await chat("看看现在的任务清单", /已完成 · 买牛奶/);
  await state(remaining);
  await stop();
  await start(); // 真正退出并重启生产入口，使用相同的隔离任务文件。
  history = [];
  await chat("重新看看清单", /已完成 · 买牛奶/);
  await state(remaining);
  await chat("帮我记一下洗衣服", /已添加待办：洗衣服/);
  await chat("衣服洗好了", /已完成：洗衣服/);
  await state([...remaining, { title: "洗衣服", done: true }]);
  await chat("帮我记一下读书", /已添加待办：读书/);
  await chat("刚才那条完成了", /已完成：读书/);
  await state([...remaining, { title: "洗衣服", done: true }, { title: "读书", done: true }]);
  console.log(
    "真实模型验收通过：官方六步、空历史、进程重启、洗衣服语义变化和最近任务指代。共12次模型调用。",
  );
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
