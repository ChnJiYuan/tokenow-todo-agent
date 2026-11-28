// 真实模型 + HTTP + 隔离 JSON；注入固定服务端日期，避免午夜/跨年验收依赖运行时刻。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "../shared/chat.ts";
import { taskListSchema, type Task } from "../shared/tasks.ts";
import { createAgent } from "../server/agent.ts";
import { createApp } from "../server/app.ts";
import { isInvalidDateClarification } from "./date-checks.ts";
import { sourceHashes as hashSources } from "./verification-support.ts";
import { dirname } from "node:path";
import { model } from "../server/model.ts";
import { createTaskClock } from "../server/task-clock.ts";
import { createJsonTaskStore } from "../server/task-store.ts";

if (!process.env.DEEPSEEK_API_KEY?.trim()) {
  console.error("请先配置 DEEPSEEK_API_KEY；没有发起真实模型调用。");
  process.exit(1);
}

const directory = await mkdtemp(join(tmpdir(), "xiaoming-due-live-"));
const filename = join(directory, "tasks.json");
const tasks = createJsonTaskStore(filename);
const clock = createTaskClock({
  timeZone: "Australia/Sydney",
  now: () => new Date("2026-12-31T12:00:00Z"),
});
const pending = tasks.create("今日待办", "2026-12-31");
const completed = tasks.create("今日已完成", "2026-12-31");
tasks.update(completed.id, { done: true });
tasks.create("逾期任务", "2026-12-30");
tasks.create("无日期任务");
const tomorrow = tasks.create("明日待办", "2027-01-01");
const server = createApp({ tasks, clock, reply: createAgent({ tasks, clock }) }).listen(
  0,
  "127.0.0.1",
);
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const history: ChatMessage[] = [];
const results: {
  input: string;
  reply?: string;
  passed: boolean;
  error?: string;
  tasks?: Task[];
}[] = [];
const startedAt = new Date().toISOString();
const sourceHashes = await hashSources();
const reportPath = process.env.LIVE_REPORT || "reports/due-dates-live-latest.json";

async function send(
  input: string,
  pattern: RegExp | ((reply: string) => boolean),
  check: (state: Task[], before: Task[]) => void,
  shownIds?: string[],
) {
  const before = tasks.list();
  const result: (typeof results)[number] = { input, passed: false };
  results.push(result);
  try {
    history.push({ role: "user", content: input });
    const response = await fetch(base + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ messages: history }),
      signal: AbortSignal.timeout(35_000),
    });
    assert.equal(response.status, 200);
    const { reply } = await response.json();
    result.reply = reply;
    const state = taskListSchema.parse(await (await fetch(base + "/api/tasks")).json());
    result.tasks = state;
    assert.deepEqual(state, JSON.parse(await readFile(filename, "utf8")));
    assert.deepEqual(
      state.slice(0, before.length).map((task) => task.id),
      before.map((task) => task.id),
      "原ID保持",
    );
    check(state, before);
    if (pattern instanceof RegExp) assert.match(reply, pattern);
    else assert.ok(pattern(reply), "必须指明非法日期、拒绝该值并请求更正日期");
    if (shownIds) {
      const shown = [...reply.matchAll(/^\s*\d+\. .*（#([a-zA-Z0-9-]+)）$/gm)].map(
        (match) => match[1],
      );
      assert.deepEqual(
        shown,
        shownIds.map((id) => id.slice(0, 8)),
      );
    }
    history.push({ role: "assistant", content: reply });
    result.passed = true;
    console.log(`通过 ${results.length}：${input}`);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

let failure: unknown;
try {
  await send("明天之前要买牛奶，帮我记一下。", /已添加待办.*2027-01-01/, (state) => {
    assert.equal(state.length, 6);
    assert.equal(state[5].title, "买牛奶");
    assert.equal(state[5].dueDate, "2027-01-01");
  });
  const milk = tasks.list()[5];
  await send(
    "明天到期的任务有哪些？",
    /2027-01-01 到期的未完成任务/,
    (state, before) => assert.deepEqual(state, before),
    [tomorrow.id, milk.id],
  );
  await send("把买牛奶改成今天到期。", /已修改到期日期.*2026-12-31/, (state) => {
    assert.deepEqual(state[5], { ...milk, dueDate: "2026-12-31" });
  });
  await send(
    "今天有哪些任务到期？",
    /2026-12-31 到期的未完成任务/,
    (state, before) => assert.deepEqual(state, before),
    [pending.id, milk.id],
  );
  await send(
    "今天到期的任务有哪些？包含已完成的。",
    /2026-12-31 到期的全部任务/,
    (state, before) => assert.deepEqual(state, before),
    [pending.id, completed.id, milk.id],
  );
  await send(
    "再看看今天到期的任务。",
    /2026-12-31 到期的未完成任务/,
    (state, before) => assert.deepEqual(state, before),
    [pending.id, milk.id],
  );
  await send("取消买牛奶的到期日期。", /已清除到期日期/, (state) => {
    const { dueDate: _removed, ...withoutDate } = milk;
    assert.deepEqual(state[5], withoutDate);
  });
  const before = await readFile(filename, "utf8");
  await send("明天上午9点提醒我买牛奶。", /不能.*提醒或发送通知/, (state, before) =>
    assert.deepEqual(state, before),
  );
  assert.equal(await readFile(filename, "utf8"), before);
  await send(
    "把买牛奶改成2027-02-29到期。",
    (reply) => isInvalidDateClarification(reply, "2027-02-29"),
    (state, before) => assert.deepEqual(state, before),
  );
  assert.equal(await readFile(filename, "utf8"), before);
  console.log(`真实模型日期验收：${results.length} 轮全部通过（${model}，固定今天 2026-12-31）。`);
} catch (error) {
  failure = error;
} finally {
  await server[Symbol.asyncDispose]();
  await rm(directory, { recursive: true, force: true });
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
        dateContext: clock(),
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
