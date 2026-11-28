// 真实模型串联验收；生产子进程、隔离文件；DEMO_PAUSE=1 可在重启前后打开浏览器。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import type { ChatMessage } from "../shared/chat.ts";
import { taskListSchema, type Task } from "../shared/tasks.ts";
import { model } from "../server/model.ts";
import { createLiveServer } from "./live-server.ts";
import { sourceHashes, writeReport } from "./verification-support.ts";

if (!process.env.DEEPSEEK_API_KEY?.trim())
  throw new Error("请先配置 DEEPSEEK_API_KEY，未调用模型。");
const server = await createLiveServer();
const hashes = await sourceHashes();
const startedAt = new Date().toISOString();
const results: {
  input: string;
  reply?: string;
  before: Task[];
  after?: Task[];
  passed: boolean;
  error?: string;
}[] = [];
const persistence: { stage: string; tasks: Task[]; pid?: number }[] = [];
let history: ChatMessage[] = [];
let today = "";
let state: Task[] = [];
let failure: unknown;
const reportPath = process.env.LIVE_REPORT || "reports/completion/demo-live.json";
const find = (title: string) => {
  const task = state.find((task) => task.title === title);
  assert.ok(task, `缺少任务：${title}`);
  return task;
};
async function list() {
  const response = await fetch(server.base + "/api/tasks");
  assert.equal(response.status, 200);
  today = response.headers.get("X-Task-Today")!;
  const tasks = taskListSchema.parse(await response.json());
  const disk = await readFile(server.filename, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "[]"; // 空存储首次写入前允许尚无文件。
    throw error;
  });
  assert.deepEqual(tasks, JSON.parse(disk), "API与磁盘一致");
  return tasks;
}
async function send(input: string, pattern: RegExp, expected: (before: Task[]) => Task[]) {
  const before = await list();
  const row: (typeof results)[number] = { input, before, passed: false };
  results.push(row);
  try {
    history.push({ role: "user", content: input });
    const response = await fetch(server.base + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ messages: history }),
      signal: AbortSignal.timeout(35_000),
    });
    assert.equal(response.status, 200);
    const { reply } = await response.json();
    row.reply = reply;
    state = await list();
    row.after = state;
    // 与回复断言独立，完整核对ID、关系、状态、日期、属性及无关任务。
    assert.deepEqual(state, expected(before), "任务字段或原ID不符");
    assert.match(reply, pattern);
    history.push({ role: "assistant", content: reply });
    row.passed = true;
    console.log(`通过 ${results.length}：${input}`);
    return reply as string;
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
}
function created(
  before: Task[],
  fields: Pick<Task, "title" | "done" | "priority" | "effort" | "parentId" | "dueDate">,
) {
  assert.equal(state.length, before.length + 1);
  const task = state.at(-1)!;
  assert.ok(task.id && !before.some((item) => item.id === task.id));
  return [...before, { ...fields, id: task.id }];
}
function changed(before: Task[], id: string, patch: Partial<Task>) {
  return before.map((task) => (task.id === id ? { ...task, ...patch } : task));
}
async function pause(stage: string) {
  persistence.push({ stage, tasks: await list(), pid: server.pid });
  if (process.env.DEMO_PAUSE !== "1") return;
  // 先写阶段证据，用户/自动化完成浏览器检查后按回车继续。
  await writeReport(reportPath + ".progress.json", {
    stage,
    base: server.base,
    sourceHashes: hashes,
    persistence,
    results,
  });
  console.log(`浏览器阶段 ${stage}：${server.base}`);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await terminal.question("浏览器检查完成后按回车继续：");
  } finally {
    terminal.close();
  }
}
try {
  await server.start();
  state = await list();
  assert.equal(state.length, 0);
  await send("记一下准备面试，今天到期，低优先级，工作量大。", /已添加待办/, (before) =>
    created(before, {
      title: "准备面试",
      done: false,
      dueDate: today,
      priority: "low",
      effort: "large",
    }),
  );
  const parent = find("准备面试");
  await send(
    "给准备面试加个子任务：整理项目介绍，今天到期，高优先级，工作量小。",
    /已添加子任务/,
    (before) =>
      created(before, {
        title: "整理项目介绍",
        done: false,
        parentId: parent.id,
        dueDate: today,
        priority: "high",
        effort: "small",
      }),
  );
  const child = find("整理项目介绍");
  await send(
    "再加一个子任务：练习自我介绍，今天到期，低优先级，工作量中。",
    /已添加子任务/,
    (before) =>
      created(before, {
        title: "练习自我介绍",
        done: false,
        parentId: parent.id,
        dueDate: today,
        priority: "low",
        effort: "medium",
      }),
  );
  const second = find("练习自我介绍");
  await send("另记一条检查设备，今天到期，高优先级，工作量小。", /已添加待办/, (before) =>
    created(before, {
      title: "检查设备",
      done: false,
      dueDate: today,
      priority: "high",
      effort: "small",
    }),
  );
  const other = find("检查设备");
  const sorted = await send("按高优先级优先列出全部任务。", /任务清单/, (before) => before);
  assert.deepEqual(
    [...sorted.matchAll(/^\s*(\d+)\. .*（#([a-zA-Z0-9-]+)）$/gm)].map((match) => [
      Number(match[1]),
      match[2],
    ]),
    [other, parent, child, second].map((task) => [
      state.findIndex((item) => item.id === task.id) + 1,
      task.id.slice(0, 8),
    ]),
  );
  const due = await send("今天有哪些任务到期？", /到期的未完成任务：共 4 条/, (before) => before);
  for (const task of state) assert.ok(due.includes(task.id.slice(0, 8)));
  await send("把整理项目介绍改成中优先级、工作量大。", /已修改属性/, (before) =>
    changed(before, child.id, { priority: "medium", effort: "large" }),
  );
  await send("准备面试完成了。", /还有未完成子任务/, (before) => before);
  await send("整理项目介绍做完了。", /已完成：整理项目介绍/, (before) =>
    changed(before, child.id, { done: true }),
  );
  assert.equal(find("准备面试").done, false);
  await pause("before-restart");
  const saved = await list();
  const oldPid = server.pid;
  await server.stop();
  await server.start();
  assert.notEqual(server.pid, oldPid, "必须启动新进程");
  state = await list();
  assert.deepEqual(state, saved, "真正重启后所有字段及原ID保持");
  history = [];
  await pause("after-restart");
  await send("重新列出全部任务。", /任务清单/, (before) => before);
  await send("练习自我介绍做完了。", /已完成：练习自我介绍/, (before) =>
    changed(before, second.id, { done: true }),
  );
  assert.equal(find("准备面试").done, false, "子任务全部完成不自动完成主任务");
  await send("现在把准备面试标为完成。", /已完成：准备面试/, (before) =>
    changed(before, parent.id, { done: true }),
  );
  await send("再给准备面试加个子任务：录制视频。", /已添加子任务.*恢复为未完成/, (before) =>
    created(changed(before, parent.id, { done: false }), {
      title: "录制视频",
      done: false,
      parentId: parent.id,
      priority: "medium",
      effort: "medium",
    }),
  );
  await send("删除准备面试。", /删除确认/, (before) => before);
  await send(`确认一并删除 #${parent.id.slice(0, 8)}`, /已删除.*一并删除 3 条子任务/, (before) =>
    before.filter((task) => task.id !== parent.id && task.parentId !== parent.id),
  );
  assert.deepEqual(state, [other], "保留无关任务");
} catch (error) {
  failure = error;
} finally {
  await server.dispose();
  await writeReport(reportPath, {
    startedAt,
    finishedAt: new Date().toISOString(),
    realModel: true,
    model,
    nodeVersion: process.version,
    sourceHashes: hashes,
    passed: !failure,
    error: failure instanceof Error ? failure.message : failure ? String(failure) : undefined,
    turnsExecuted: results.length,
    persistence,
    results,
  });
}
if (failure) throw failure;
console.log(`真实模型串联验收 ${results.length} 轮通过：${reportPath}`);
