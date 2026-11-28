import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { ChatMessage } from "../shared/chat.ts";
import { taskListSchema, type Task } from "../shared/tasks.ts";
import { sourceHashes as hashSources } from "./verification-support.ts";
import { dirname } from "node:path";
import { model } from "../server/model.ts";
import { createLiveServer } from "./live-server.ts";

if (!process.env.DEEPSEEK_API_KEY?.trim()) {
  console.error("请先配置 DEEPSEEK_API_KEY；没有发起真实模型调用。");
  process.exit(1);
}

// 与离线模型mock测试分开：启动生产入口，真实调用模型，仅操作临时数据。
const server = await createLiveServer();
const history: ChatMessage[] = [];
type ExpectedTask = Pick<Task, "title" | "done" | "priority" | "effort">;
const expected: ExpectedTask[] = [];
const results: {
  input: string;
  reply?: string;
  passed: boolean;
  error?: string;
  tasks?: Task[];
}[] = [];
let previous: Task[] = [];
const startedAt = new Date().toISOString();
const sourceHashes = await hashSources();
const reportPath = process.env.LIVE_REPORT || "reports/attributes-live-latest.json";

async function list() {
  const response = await fetch(server.base + "/api/tasks");
  assert.equal(response.status, 200);
  return taskListSchema.parse(await response.json());
}
async function send(input: string, replyPattern: RegExp, shown?: number[]) {
  const result: (typeof results)[number] = { input, passed: false };
  results.push(result);
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
    result.reply = reply;
    const actual = await list();
    result.tasks = actual;
    assert.deepEqual(
      actual.map(({ title, done, priority, effort }) => ({ title, done, priority, effort })),
      expected,
    );
    previous.forEach((task, index) => assert.equal(actual[index].id, task.id, "原任务ID必须保持"));
    assert.deepEqual(
      actual,
      JSON.parse(await readFile(server.filename, "utf8")),
      "API与磁盘不一致",
    );
    if (shown) {
      const references = [...reply.matchAll(/^\s*\d+\. .*（#([a-zA-Z0-9-]+)）$/gm)].map(
        (match) => match[1],
      );
      assert.deepEqual(
        references,
        shown.map((index) => actual[index].id.slice(0, 8)),
        "查询必须展示真实筛选结果",
      );
    }
    assert.match(reply, replyPattern);
    previous = actual;
    history.push({ role: "assistant", content: reply });
    result.passed = true;
    console.log(`通过 ${results.length}：${input}`);
    return reply as string;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

let failure: unknown;
try {
  await server.start();
  expected.push({ title: "买牛奶", done: false, priority: "medium", effort: "medium" });
  await send("帮我记一下买牛奶。", /已添加待办/);
  expected.push({ title: "准备面试", done: false, priority: "high", effort: "large" });
  await send("记一下准备面试，高优先级，工作量大。", /已添加待办.*优先级高 · 工作量大/);
  expected[1].effort = "medium";
  await send("把准备面试的工作量改成中。", /已修改属性.*优先级高 · 工作量中/);
  Object.assign(expected[0], { priority: "low", effort: "small" });
  await send("把买牛奶改成低优先级、工作量小。", /已修改属性.*优先级低 · 工作量小/);
  await send("列出高优先级且未完成的任务。", /任务清单/, [1]);
  await send("有哪些工作量小的任务？", /任务清单/, [0]);
  expected[0].done = true;
  await send("牛奶买好了。", /已完成：买牛奶/);
  await send("哪些未完成任务工作量小？", /没有符合这些条件/, []);
  await send("有哪些工作量小的任务？", /任务清单/, [0]);
  expected[0].priority = "high";
  await send("把买牛奶的优先级改成最高。", /已修改属性.*优先级高 · 工作量小/);
  await send("把准备面试的工作量改得差不多。", /[？?]|请.*明确|大还是|小、中、大/);
  expected.push({ title: "写年度报告", done: false, priority: "high", effort: "medium" });
  await send("记一下写年度报告，这件事很紧急。", /已添加待办.*优先级高 · 工作量中/);
  await send("把准备面试的优先级改得合适一点。", /[？?]|请.*明确|高、中、低/);
  await send("按高优先级优先列出全部任务。", /任务清单/, [0, 1, 2]);
  expected[0].effort = "large";
  await send("把第一条的工作量改成大。", /已修改属性.*买牛奶.*工作量大/);
  expected.push({ title: "准备面试", done: false, priority: "medium", effort: "medium" });
  await send("再记一条准备面试。", /已添加待办/);
  await send("把准备面试的优先级改成低。", /多条|[？?]|第几条/);
  expected[1].priority = "low";
  await send(`把 #${previous[1].id.slice(0, 8)} 的优先级改成低。`, /已修改属性.*优先级低/);
  console.log(`真实模型属性验收：${results.length}轮全部通过（${model}）。`);
} catch (error) {
  failure = error;
} finally {
  await server.dispose();
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        model,
        realModel: true,
        nodeVersion: process.version,
        sourceHashes,
        passed: !failure,
        turns: results,
      },
      null,
      2,
    ) + "\n",
  );
}
if (failure) throw failure;
