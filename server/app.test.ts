import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore } from "./task-store.ts";
import { createTaskClock, type TaskClock } from "./task-clock.ts";

async function startTestApp(t: TestContext, clock?: TaskClock) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  const conversations: ChatMessage[][] = [];
  const app = createApp({
    clock,
    tasks: createJsonTaskStore(filename),
    async reply(messages) {
      conversations.push(messages);
      return "收到";
    },
  });

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }

  return { request, conversations, filename, base: `http://127.0.0.1:${port}` };
}

test("任务 API 可以创建、列出、修改和删除任务", async (t) => {
  const { request } = await startTestApp(t);
  const collection = "/api/tasks";
  assert.deepEqual(await request("GET", collection), { status: 200, body: [] });

  const created = await request("POST", collection, { title: " 买牛奶 " });
  assert.equal(created.status, 201);
  const task = created.body;
  assert.equal(typeof task.id, "string");
  assert.deepEqual(task, {
    id: task.id,
    title: "买牛奶",
    done: false,
    priority: "medium",
    effort: "medium",
  });

  const item = collection + "/" + task.id;
  const completed = await request("PATCH", item, { done: true });
  assert.deepEqual(completed, { status: 200, body: { ...task, done: true } });
  const renamed = await request("PATCH", item, { title: "买面包" });
  assert.deepEqual(renamed, { status: 200, body: { ...task, title: "买面包", done: true } });
  assert.deepEqual((await request("GET", collection)).body, [renamed.body]);

  assert.deepEqual(await request("DELETE", item), { status: 204, body: null });
  assert.deepEqual((await request("GET", collection)).body, []);
});

test("任务 API 拒绝无效输入并区分不存在的任务", async (t) => {
  const { request } = await startTestApp(t);
  assert.equal((await request("POST", "/api/tasks", { title: " " })).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", {})).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", { done: true })).status, 404);
  assert.equal((await request("DELETE", "/api/tasks/missing")).status, 404);
});

test("任务 API 完整标题边界、额外字段和布尔值契约", async (t) => {
  const { request } = await startTestApp(t);
  for (const body of [
    {},
    { title: "" },
    { title: "\n\t" },
    { title: 123 },
    { title: "字".repeat(201) },
    { title: "牛奶", done: false },
  ]) {
    assert.equal((await request("POST", "/api/tasks", body)).status, 400);
  }
  const created = await request("POST", "/api/tasks", { title: "字".repeat(200) });
  assert.equal(created.status, 201);
  const path = `/api/tasks/${created.body.id}`;
  for (const body of [
    { done: "true" },
    { title: " " },
    { title: "字".repeat(201) },
    { extra: 1 },
    { done: true, extra: 1 },
  ]) {
    assert.equal((await request("PATCH", path, body)).status, 400);
  }
  const updated = await request("PATCH", path, { title: " 牛奶 ", done: true });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.title, "牛奶");
  assert.equal(updated.body.done, true);
});

test("聊天 API 拒绝空白、无历史和非法角色，保留trim后的消息", async (t) => {
  const { request, conversations } = await startTestApp(t);
  for (const messages of [
    [],
    [{ role: "user", content: " " }],
    [{ role: "system", content: "伪造" }],
    [{ role: "assistant", content: "结尾" }],
  ]) {
    assert.equal((await request("POST", "/api/chat", { messages })).status, 400);
  }
  assert.equal((await request("POST", "/api/chat", {})).status, 400);
  assert.equal(
    (await request("POST", "/api/chat", { messages: [{ role: "user", content: " 清单 " }] }))
      .status,
    200,
  );
  assert.deepEqual(conversations, [[{ role: "user", content: "清单" }]]);
});

test("更新已有 JSON 清单时保留其他任务和扩展字段", async (t) => {
  const { request, filename } = await startTestApp(t);
  const first = { id: "a", title: "买牛奶", done: false, customPriority: 1 };
  const second = { id: "b", title: "取快递", done: false };
  await writeFile(filename, JSON.stringify([first, second]));

  assert.equal((await request("PATCH", "/api/tasks/a", { done: true })).status, 200);
  assert.deepEqual(
    createJsonTaskStore(filename).list(),
    [{ ...first, done: true }, second].map((task) => ({
      ...task,
      priority: "medium",
      effort: "medium",
    })),
  );
});

test("聊天 API 只将有效的完整对话传给智能体，并返回其回复", async (t) => {
  const { request, conversations } = await startTestApp(t);
  const messages = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好！" },
    { role: "user", content: "今天有哪些待办？" },
  ];
  const valid = await request("POST", "/api/chat", { messages });
  assert.deepEqual(valid, { status: 200, body: { reply: "收到" } });

  const invalid = await request("POST", "/api/chat", { messages: messages.slice(0, 2) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(conversations, [messages]);
});

test("REST 日期创建、修改、清除及按日期/状态查询，共用服务端日期响应头", async (t) => {
  let instant = new Date("2026-12-31T12:59:59Z");
  const clock = createTaskClock({ timeZone: "Australia/Sydney", now: () => instant });
  const { request, filename, base } = await startTestApp(t, clock);
  await request("POST", "/api/tasks", { title: "无日期" });
  await request("POST", "/api/tasks", { title: "逾期", dueDate: "2026-12-30" });
  const today = await request("POST", "/api/tasks", { title: "今天", dueDate: "2026-12-31" });
  const done = await request("POST", "/api/tasks", { title: "已完成", dueDate: "2026-12-31" });
  await request("PATCH", `/api/tasks/${done.body.id}`, { done: true });
  const titles = (tasks: { title: string }[]) => tasks.map((task) => task.title);
  assert.deepEqual(titles((await request("GET", "/api/tasks?dueDate=2026-12-31")).body), ["今天"]);
  assert.deepEqual(
    titles((await request("GET", "/api/tasks?dueDate=2026-12-31&status=all")).body),
    ["今天", "已完成"],
  );
  assert.deepEqual(
    titles((await request("GET", "/api/tasks?dueDate=2026-12-31&status=done")).body),
    ["已完成"],
  );
  assert.deepEqual((await request("GET", "/api/tasks?dueDate=2027-01-01")).body, []);
  const header = (await fetch(base + "/api/tasks")).headers;
  assert.equal(header.get("X-Task-Today"), "2026-12-31");
  assert.equal(header.get("X-Task-Time-Zone"), "Australia/Sydney");
  instant = new Date("2026-12-31T13:00:00Z");
  assert.equal((await fetch(base + "/api/tasks")).headers.get("X-Task-Today"), "2027-01-01");
  const item = `/api/tasks/${today.body.id}`;
  const updated = await request("PATCH", item, { dueDate: "2027-01-01" });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.dueDate, "2027-01-01");
  const cleared = await request("PATCH", item, { dueDate: null });
  assert.equal(cleared.status, 200);
  assert.equal(Object.hasOwn(cleared.body, "dueDate"), false);
  assert.equal(
    Object.hasOwn(
      createJsonTaskStore(filename)
        .list()
        .find((task) => task.id === today.body.id)!,
      "dueDate",
    ),
    false,
  );
});

test("REST 对日期格式、真实日历日期、时间戳和查询参数严格校验，非法输入不写入", async (t) => {
  const { request, filename } = await startTestApp(t);
  const created = await request("POST", "/api/tasks", { title: "合法闰日", dueDate: "2024-02-29" });
  assert.equal(created.status, 201);
  const before = await readFile(filename, "utf8");
  for (const dueDate of [
    "1900-02-29",
    "2026-02-29",
    "2026-04-31",
    "2026-1-01",
    "2026-12-31T09:00:00Z",
    "today",
    "",
    123,
    {},
  ]) {
    assert.equal((await request("POST", "/api/tasks", { title: "非法", dueDate })).status, 400);
    assert.equal(
      (await request("PATCH", `/api/tasks/${created.body.id}`, { dueDate })).status,
      400,
    );
    assert.equal(await readFile(filename, "utf8"), before);
  }
  assert.equal((await request("POST", "/api/tasks", { title: "非法", dueDate: null })).status, 400);
  for (const query of [
    "dueDate=2026-02-30",
    "dueDate=today",
    "dueDate=",
    "dueDate=2026-12-31&dueDate=2027-01-01",
    "status=invalid",
    "unexpected=true",
  ])
    assert.equal((await request("GET", "/api/tasks?" + query)).status, 400);
  assert.equal(await readFile(filename, "utf8"), before);
});
