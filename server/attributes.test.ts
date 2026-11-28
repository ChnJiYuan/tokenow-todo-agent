import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { taskRows } from "../shared/task-view.ts";
import { filterTasks, taskSchema, type TaskAttributes } from "../shared/tasks.ts";
import { createAgent } from "./agent.ts";
import { createModelPlanner } from "./planner.ts";
import { httpFixture, taskFixture } from "./test-support.ts";

const user = (content: string): ChatMessage[] => [{ role: "user", content }];

test("属性默认均为中；旧文件读取不迁移，后续写入也保留其他旧记录原貌及扩展字段", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  const legacy = {
    id: "old",
    title: "买牛奶",
    done: true,
    dueDate: "2026-11-27",
    custom: { source: "legacy" },
  };
  const untouched = { id: "other", title: "取快递", done: false, extension: 42 };
  const original = JSON.stringify([legacy, untouched]);
  await writeFile(filename, original);
  assert.deepEqual(
    tasks.list(),
    [legacy, untouched].map((task) => ({ ...task, priority: "medium", effort: "medium" })),
  );
  assert.equal(await readFile(filename, "utf8"), original);
  const created = tasks.create("默认任务");
  assert.equal(created.priority, "medium");
  assert.equal(created.effort, "medium");
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8")).slice(0, 2), [legacy, untouched]);
  const priorityOnly = tasks.create("只指定优先级", undefined, { priority: "high" });
  assert.equal(priorityOnly.priority, "high");
  assert.equal(priorityOnly.effort, "medium");
  const effortOnly = tasks.create("只指定工作量", undefined, { effort: "large" });
  assert.equal(effortOnly.priority, "medium");
  assert.equal(effortOnly.effort, "large");
  const duplicate = tasks.create("只指定优先级");
  assert.deepEqual(duplicate, {
    id: duplicate.id,
    title: "只指定优先级",
    done: false,
    priority: "medium",
    effort: "medium",
  });
  assert.notEqual(duplicate.id, priorityOnly.id, "新建同名任务必须有新ID且不继承旧属性");
  const changed = tasks.update(legacy.id, { priority: "high" });
  assert.deepEqual(changed, { ...legacy, priority: "high", effort: "medium" });
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8"))[1], untouched);
});

test("REST 创建、单项/双项修改与组合筛选使用真实字段，修改保留标题、状态及日期", async (t) => {
  const { filename } = await taskFixture(t);
  const app = await httpFixture(t, filename, async () => ({ action: "help" }));
  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(app.base + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const created = await request("POST", "/api/tasks", {
    title: "准备面试",
    priority: "high",
    effort: "large",
    dueDate: "2026-11-27",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.priority, "high");
  assert.equal(created.body.effort, "large");
  const path = `/api/tasks/${created.body.id}`;
  const done = await request("PATCH", path, { done: true });
  const effort = await request("PATCH", path, { effort: "medium" });
  assert.deepEqual(effort.body, { ...done.body, effort: "medium" });
  const both = await request("PATCH", path, { priority: "low", effort: "small" });
  assert.deepEqual(both.body, { ...done.body, priority: "low", effort: "small" });
  assert.deepEqual(
    (await request("GET", "/api/tasks?priority=low&effort=small&status=done&dueDate=2026-11-27"))
      .body,
    [both.body],
  );
  assert.deepEqual((await request("GET", "/api/tasks?priority=high&status=pending")).body, []);
  assert.deepEqual((await request("GET", "/api/tasks?effort=small&status=pending")).body, []);
  for (const body of [
    { priority: "urgent" },
    { effort: "tiny" },
    { priority: null },
    { effort: 1 },
    { effort: "small", unexpected: true },
  ]) {
    assert.equal((await request("POST", "/api/tasks", { title: "非法任务", ...body })).status, 400);
    assert.equal((await request("PATCH", path, body)).status, 400);
  }
  for (const query of [
    "priority=urgent",
    "effort=小",
    "effort=small&effort=large",
    "unknown=1",
    "sort=effort",
  ]) {
    assert.equal((await request("GET", `/api/tasks?${query}`)).status, 400);
  }
  assert.deepEqual(app.tasks.list(), [both.body]);
});

test("中文验收对话通过 HTTP → JSON模型mock → 执行器 → 磁盘，查询不会虚构任务", async (t) => {
  const { filename } = await taskFixture(t);
  const app = await httpFixture(t, filename, async (input) => {
    const text = input.messages.at(-1)!.content;
    const plan = text.includes("记一下")
      ? { action: "create", title: "准备面试", priority: "high", effort: "large" }
      : text.includes("改成中")
        ? {
            action: "update_attributes",
            taskIds: [input.tasks[0].id],
            changes: { effort: "medium" },
          }
        : text.includes("买牛奶")
          ? {
              action: "update_attributes",
              taskIds: [input.tasks[1].id],
              changes: { priority: "low", effort: "small" },
            }
          : text.includes("高优先级")
            ? { action: "list", priority: "high", status: "pending" }
            : { action: "list", effort: "small", status: "all" };
    return createModelPlanner(async (request) => {
      const instructions = String(request.messages[0].content);
      assert.match(instructions, /不代表固定工时/);
      assert.match(instructions, /不确定要改哪个任务/);
      return { content: JSON.stringify(plan), finishReason: "stop" };
    })(input);
  });
  const history: ChatMessage[] = [];
  async function send(text: string) {
    history.push({ role: "user", content: text });
    const response = await app.chat(history);
    assert.equal(response.status, 200);
    const { reply } = await response.json();
    history.push({ role: "assistant", content: reply });
    return reply as string;
  }
  assert.match(await send("记一下准备面试，高优先级，工作量大。"), /优先级高 · 工作量大/);
  assert.match(await send("把准备面试的工作量改成中。"), /优先级高 · 工作量中/);
  app.tasks.create("买牛奶");
  assert.match(await send("把买牛奶改成低优先级、工作量小。"), /优先级低 · 工作量小/);
  const high = await send("列出高优先级且未完成的任务。");
  assert.match(high, /准备面试/);
  assert.doesNotMatch(high, /买牛奶/);
  const small = await send("有哪些工作量小的任务？");
  assert.match(small, /买牛奶/);
  assert.doesNotMatch(small, /准备面试/);
  assert.deepEqual(app.tasks.list(), JSON.parse(await readFile(filename, "utf8")));
});

test("单项修改不默认覆盖另一属性；双属性修改只调用一次真实持久化更新", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  const task = tasks.create("买牛奶");
  tasks.update(task.id, { done: true, dueDate: "2026-11-27", priority: "high", effort: "large" });
  let calls = 0;
  let writes = 0;
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    writes++;
    return write(...args);
  });
  let changes: TaskAttributes = { effort: "medium" };
  const reply = createAgent({
    tasks: {
      ...tasks,
      update(id, input) {
        calls++;
        return tasks.update(id, input);
      },
    },
    planner: async () => ({ action: "update_attributes", taskIds: [task.id], changes }),
  });
  const before = tasks.list()[0];
  assert.match(await reply(user("把买牛奶的工作量改成中")), /已修改属性/);
  assert.equal(calls, 1);
  assert.equal(writes, 1);
  assert.deepEqual(tasks.list(), [{ ...before, effort: "medium" }]);
  changes = { priority: "low", effort: "small" };
  calls = 0;
  writes = 0;
  await reply(user("把买牛奶改成低优先级、工作量小"));
  assert.equal(calls, 1);
  assert.equal(writes, 1);
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), [
    { ...before, priority: "low", effort: "small" },
  ]);
  changes = { priority: "high", effort: undefined };
  await reply(user("优先级改成高"));
  assert.deepEqual(tasks.list(), [{ ...before, effort: "small" }]);
});

test("非法枚举、空修改、未知字段及夹带标题/状态/日期的属性计划均拒绝写入", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  const task = tasks.create("买牛奶");
  const before = await readFile(filename, "utf8");
  for (const plan of [
    { action: "create", title: "准备面试", priority: "紧急" },
    { action: "create", title: "准备面试", effort: "unknown" },
    { action: "list", status: "all", priority: "urgent" },
    ...[
      {},
      { effort: "huge" },
      { priority: null },
      { priority: "low", title: "偷改" },
      { effort: "small", done: true },
      { effort: "small", dueDate: "2026-11-27" },
    ].map((changes) => ({ action: "update_attributes", taskIds: [task.id], changes })),
  ]) {
    const reply = createAgent({ tasks, planner: async () => plan });
    assert.match(await reply(user("修改属性")), /格式无效/);
    assert.equal(await readFile(filename, "utf8"), before);
  }
});

test("组合筛选交集与高优先级稳定排序，不改变源数据顺序", async (t) => {
  const { tasks } = await taskFixture(t);
  const specs = [
    { priority: "low", effort: "small", done: false },
    { priority: "high", effort: "small", done: true },
    { priority: "high", effort: "large", done: false },
    { priority: "high", effort: "small", done: false },
  ] as const;
  for (const [index, spec] of specs.entries()) {
    const task = tasks.create(`事项${index}`);
    tasks.update(task.id, spec);
  }
  const original = tasks.list();
  assert.deepEqual(
    filterTasks(original, { sort: "priority" }).map((task) => task.title),
    ["事项1", "事项2", "事项3", "事项0"],
  );
  const query = { status: "pending", priority: "high", effort: "small" } as const;
  assert.deepEqual(filterTasks(original, query), [original[3]]);
  const reply = createAgent({ tasks, planner: async () => ({ action: "list", ...query }) });
  const text = await reply(user("哪些未完成任务优先级高且工作量小"));
  assert.match(text, /事项3/);
  assert.doesNotMatch(text, /事项[012]/);
  assert.deepEqual(tasks.list(), original);
  const empty = createAgent({
    tasks,
    planner: async () => ({ action: "list", status: "pending", priority: "medium" }),
  });
  assert.match(await empty(user("中优先级未完成任务")), /没有符合这些条件/);
  assert.doesNotMatch(await empty(user("中优先级未完成任务")), /所有任务都已完成/);
});

test("同名修改先澄清，排序筛选后的编号按最近展示ID定位，并拒绝错误映射", async (t) => {
  const { tasks } = await taskFixture(t);
  const first = tasks.create("买牛奶");
  const second = tasks.create("买牛奶");
  tasks.update(first.id, { priority: "low", effort: "large" });
  tasks.update(second.id, { priority: "high", effort: "small" });
  const change = createAgent({
    tasks,
    planner: async () => ({
      action: "update_attributes",
      taskIds: [second.id],
      changes: { effort: "medium" },
    }),
  });
  assert.match(await change(user("把买牛奶工作量改成中")), /多条/);
  const list = createAgent({
    tasks,
    planner: async () => ({ action: "list", status: "all", effort: "small", sort: "priority" }),
  });
  const history = user("按高优先级优先列工作量小的任务");
  const displayed = await list(history);
  const displayedNumber = displayed.match(new RegExp(`(\\d+)\\. .*#${second.id.slice(0, 8)}`))?.[1];
  assert.ok(displayedNumber);
  history.push(
    { role: "assistant", content: displayed },
    { role: "user", content: `第${displayedNumber}条工作量改成中` },
  );
  const wrong = createAgent({
    tasks,
    planner: async () => ({
      action: "update_attributes",
      taskIds: [first.id],
      changes: { effort: "small" },
    }),
  });
  assert.match(await wrong(history), /编号已变化或与目标不符/);
  assert.match(await change(history), /已修改属性/);
  assert.equal(tasks.list()[0].effort, "large");
  assert.equal(tasks.list()[1].effort, "medium");
});

test("旧数据的有效默认值参与真实查询；非法存储枚举不能静默变成默认值", () => {
  const legacy = taskSchema.parse({ id: "legacy", title: "旧任务", done: false });
  assert.deepEqual(filterTasks([legacy], { priority: "medium", effort: "medium" }), [legacy]);
  assert.deepEqual(filterTasks([legacy], { priority: "high" }), []);
  for (const attributes of [{ priority: "urgent" }, { effort: "tiny" }, { effort: null }]) {
    assert.equal(taskSchema.safeParse({ ...legacy, ...attributes }).success, false);
  }
});

test("属性更新不改变其他任务状态；存在旧父子数据时也保持字段隔离", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  const parent = { id: "parent", title: "旧主任务", done: true };
  const child = { id: "child", title: "旧子任务", done: false, parentId: parent.id };
  await writeFile(filename, JSON.stringify([parent, child]));
  const before = tasks.list();
  const reply = createAgent({
    tasks,
    planner: async () => ({
      action: "update_attributes",
      taskIds: [child.id],
      changes: { priority: "high", effort: "small" },
    }),
  });
  assert.match(await reply(user("把旧子任务改成高优先级，工作量小")), /已修改属性/);
  assert.deepEqual(tasks.list(), [before[0], { ...before[1], priority: "high", effort: "small" }]);
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8"))[0], parent);
});

test("面板按主任务及同组子任务的真实优先级稳定排序，保留父子相邻、真实ID和原编号", () => {
  const tasks = [
    { id: "parent", title: "主任务", done: false, priority: "low" },
    { id: "middle", title: "另一主任务", done: false, priority: "medium" },
    { id: "child", title: "子任务", done: false, parentId: "parent", priority: "high" },
    { id: "other", title: "另一子任务", done: false, parentId: "parent", priority: "high" },
  ].map((task) => taskSchema.parse(task));
  const original = taskRows(tasks);
  const sorted = taskRows(tasks, "priority");
  assert.deepEqual(
    sorted.map(({ task }) => task.id),
    ["middle", "parent", "child", "other"],
  );
  for (const row of sorted)
    assert.equal(row.position, original.find(({ task }) => task.id === row.task.id)?.position);
  assert.deepEqual(taskRows(tasks), original);
});
