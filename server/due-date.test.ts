import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { createAgent } from "./agent.ts";
import { createModelPlanner } from "./planner.ts";
import { createTaskClock } from "./task-clock.ts";
import { httpFixture, taskFixture } from "./test-support.ts";

const user = (content: string): ChatMessage[] => [{ role: "user", content }];
const clock = createTaskClock({
  timeZone: "Australia/Sydney",
  now: () => new Date("2026-12-31T12:00:00Z"),
});

test("日期验收对话：HTTP → 模型JSON边界mock → 执行器 → JSON，创建/修改/查询/清除且重发不重复写入", async (t) => {
  const { filename } = await taskFixture(t);
  const prompts = [
    "明天之前要买牛奶，帮我记一下。",
    "把买牛奶改成今天到期。",
    "今天有哪些任务到期？",
    "取消买牛奶的到期日期。",
  ];
  let turn = 0;
  const app = await httpFixture(
    t,
    filename,
    async (input) => {
      assert.deepEqual(input.dateContext, { today: "2026-12-31", timeZone: "Australia/Sydney" });
      assert.equal(input.messages.at(-1)?.content, prompts[turn]);
      const plan =
        turn === 0
          ? { action: "create", title: "买牛奶", dueDate: "tomorrow" }
          : turn === 1
            ? { action: "set_due_date", taskIds: [input.tasks[0].id], dueDate: "today" }
            : turn === 2
              ? { action: "list", dueDate: "today" }
              : { action: "set_due_date", taskIds: [input.tasks[0].id], dueDate: null };
      turn++;
      return createModelPlanner(async (request) => {
        assert.match(String(request.messages.at(-2)?.content), /2026-12-31/);
        assert.match(String(request.messages.at(-2)?.content), /Australia\/Sydney/);
        return { content: JSON.stringify(plan), finishReason: "stop" };
      })(input);
    },
    clock,
  );
  const history: ChatMessage[] = [];
  for (let index = 0; index < prompts.length; index++) {
    history.push({ role: "user", content: prompts[index] });
    const key = randomUUID();
    const result = await (await app.chat(history, key)).json();
    assert.match(
      result.reply,
      [
        /已添加.*2027-01-01/,
        /已修改.*2026-12-31/,
        /2026-12-31 到期的未完成任务.*1 条/,
        /已清除到期日期/,
      ][index],
    );
    const persisted = await readFile(filename, "utf8");
    assert.deepEqual(await (await app.chat(history, key)).json(), result);
    assert.equal(await readFile(filename, "utf8"), persisted);
    const saved = JSON.parse(persisted);
    assert.equal(saved.length, 1);
    assert.equal(
      saved[0].dueDate,
      index === 0 ? "2027-01-01" : index === 3 ? undefined : "2026-12-31",
    );
    assert.equal(saved[0].done, false);
    history.push({ role: "assistant", content: result.reply });
  }
  assert.equal(turn, 4);
});

test("今日/明日查询默认未完成，显式含已完成或只查已完成；无日期和逾期不混入且保留全局编号", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  tasks.create("无日期任务");
  tasks.create("逾期任务", "2026-12-30");
  tasks.create("今日待办", "2026-12-31");
  const done = tasks.create("今日已完成", "2026-12-31");
  tasks.update(done.id, { done: true });
  tasks.create("明日待办", "2027-01-01");
  const before = await readFile(filename, "utf8");
  const query = (plan: unknown) =>
    createAgent({ tasks, clock, planner: async () => plan })(user("到期查询"));
  const today = await query({ action: "list", dueDate: "today" });
  assert.match(today, /3\. ☐ 未完成 · 今日待办/);
  assert.doesNotMatch(today, /今日已完成|逾期任务|无日期任务|明日待办/);
  const all = await query({ action: "list", dueDate: "today", status: "all" });
  assert.match(all, /共 2 条/);
  assert.match(all, /今日已完成/);
  const completed = await query({ action: "list", dueDate: "today", status: "done" });
  assert.match(completed, /今日已完成/);
  assert.doesNotMatch(completed, /今日待办/);
  const tomorrow = await query({ action: "list", dueDate: "tomorrow" });
  assert.match(tomorrow, /2027-01-01.*共 1 条/);
  assert.match(tomorrow, /明日待办/);
  assert.doesNotMatch(tomorrow, /今日待办|逾期任务|无日期任务/);
  assert.match(
    await query({ action: "list", dueDate: "2027-01-02" }),
    /没有.*2027-01-02.*未完成任务/,
  );
  assert.equal(await readFile(filename, "utf8"), before);
});

test("服务端跨日/跨年后下一轮使用新日期，同轮规划跨午夜仍固定请求开始的日期", async (t) => {
  const { tasks } = await taskFixture(t);
  tasks.create("去年", "2026-12-31");
  tasks.create("新年", "2027-01-01");
  let instant = new Date("2026-12-31T12:59:59Z");
  const seen: string[] = [];
  const reply = createAgent({
    tasks,
    clock: createTaskClock({ timeZone: "Australia/Sydney", now: () => instant }),
    planner: async ({ dateContext }) => {
      seen.push(dateContext.today);
      instant = new Date("2026-12-31T13:00:00Z");
      return { action: "list", dueDate: "today" };
    },
  });
  const first = await reply(user("今天有哪些任务到期？"));
  assert.match(first, /去年/);
  assert.doesNotMatch(first, /新年/);
  const second = await reply(user("今天有哪些任务到期？"));
  assert.match(second, /新年/);
  assert.doesNotMatch(second, /去年/);
  assert.deepEqual(seen, ["2026-12-31", "2027-01-01"]);
});

test("日期修改与并发加入的属性/子任务兼容，保留父子关系及属性，不继承或连带清除日期", async (t) => {
  const { tasks } = await taskFixture(t);
  const parent = tasks.create("准备面试", "2026-12-31", { priority: "high", effort: "large" });
  const child = tasks.create("整理项目介绍", undefined, {
    parentId: parent.id,
    priority: "low",
    effort: "small",
  });
  assert.equal(child.dueDate, undefined);
  const reply = createAgent({
    tasks,
    clock,
    planner: async () => ({ action: "set_due_date", taskIds: [child.id], dueDate: "tomorrow" }),
  });
  assert.match(await reply(user("把整理项目介绍改成明天到期")), /已修改到期日期/);
  assert.deepEqual(
    tasks.list().find((task) => task.id === child.id),
    { ...child, dueDate: "2027-01-01" },
  );
  const clearParent = createAgent({
    tasks,
    clock,
    planner: async () => ({ action: "set_due_date", taskIds: [parent.id], dueDate: null }),
  });
  assert.match(await clearParent(user("取消准备面试的到期日期")), /已清除/);
  assert.equal(tasks.list().find((task) => task.id === child.id)?.dueDate, "2027-01-01");
  assert.equal(tasks.list().find((task) => task.id === parent.id)?.dueDate, undefined);
  assert.equal(tasks.list().find((task) => task.id === parent.id)?.priority, "high");
});

test("日期修改每轮至多一次写入，重复设置/清除不写入；提醒请求解释边界且不创建任务", async (t) => {
  const { tasks } = await taskFixture(t);
  const task = tasks.create("买牛奶");
  let writes = 0;
  const tracked = {
    ...tasks,
    update: (...args: Parameters<typeof tasks.update>) => {
      writes++;
      return tasks.update(...args);
    },
  };
  const set = (dueDate: string | null) =>
    createAgent({
      tasks: tracked,
      clock,
      planner: async () => ({ action: "set_due_date", taskIds: [task.id], dueDate }),
    })(user("修改牛奶日期"));
  assert.match(await set("today"), /已修改到期日期/);
  assert.equal(writes, 1);
  assert.match(await set("today"), /无需修改/);
  assert.equal(writes, 1);
  assert.match(await set(null), /已清除/);
  assert.equal(writes, 2);
  assert.match(await set(null), /无需清除/);
  assert.equal(writes, 2);
  const reply = createAgent({
    tasks: tracked,
    clock,
    planner: async () => ({ action: "reminder" }),
  });
  assert.match(await reply(user("明天上午9点通知我买牛奶")), /不能.*提醒或发送通知/);
  assert.equal(writes, 2);
  assert.equal(tasks.list().length, 1);
});

test("日期修改和清除反馈使用无碰撞的短ID，保留旧数据中的真实目标", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  const first = { id: "12345678-a", title: "牛奶", done: false };
  const second = { id: "12345678-b", title: "牛奶", done: false };
  await writeFile(filename, JSON.stringify([first, second]));
  for (const dueDate of ["today", null]) {
    const reply = createAgent({
      tasks,
      clock,
      planner: async () => ({ action: "set_due_date", taskIds: [second.id], dueDate }),
    });
    assert.match(
      await reply(user(`#${second.id} ${dueDate ? "今天到期" : "清除到期日期"}`)),
      /（#12345678-b）/,
    );
    assert.equal(tasks.list()[0].dueDate, undefined);
  }
});

test("日期动作对多候选、同名、无效ID、过时快照及过时清单编号拒绝写入", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  const a = tasks.create("牛奶");
  const b = tasks.create("牛奶");
  const before = await readFile(filename, "utf8");
  for (const taskIds of [[], ["fake"], [a.id, b.id], [a.id]]) {
    const reply = createAgent({
      tasks,
      clock,
      planner: async () => ({ action: "set_due_date", taskIds, dueDate: "today" }),
    });
    assert.match(await reply(user("牛奶今天到期")), /没有找到|编号无效|多条/);
    assert.equal(await readFile(filename, "utf8"), before);
  }
  const list = createAgent({ tasks, clock, planner: async () => ({ action: "list" }) });
  const history = user("清单");
  history.push({ role: "assistant", content: await list(history) });
  tasks.remove(a.id);
  const afterRemoval = await readFile(filename, "utf8");
  history.push({ role: "user", content: "第一条今天到期" });
  const stalePosition = createAgent({
    tasks,
    clock,
    planner: async () => ({ action: "set_due_date", taskIds: [b.id], dueDate: "today" }),
  });
  assert.match(await stalePosition(history), /编号已变化/);
  assert.equal(await readFile(filename, "utf8"), afterRemoval);
  const staleSnapshot = createAgent({
    tasks,
    clock,
    planner: async () => {
      tasks.update(b.id, { title: "燕麦奶" });
      return { action: "set_due_date", taskIds: [b.id], dueDate: "today" };
    },
  });
  assert.match(await staleSnapshot(user("牛奶今天到期")), /发生了变化/);
  assert.equal(tasks.list()[0].dueDate, undefined);
});

test("非法日期、多操作和夹带字段计划不写入，日期规划超时后迟到结果不执行", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  const task = tasks.create("牛奶");
  const before = await readFile(filename, "utf8");
  for (const plan of [
    { action: "create", title: "坏日期", dueDate: "2026-02-30" },
    { action: "create", title: "坏日期", dueDate: null },
    { action: "set_due_date", taskIds: [task.id], dueDate: "2026-02-29" },
    { action: "set_due_date", taskIds: [task.id], dueDate: "2026-12-31T09:00:00Z" },
    { action: "set_due_date", taskIds: [task.id], dueDate: "today", done: true },
    { action: "set_due_date", taskIds: [task.id] },
    { action: "list", dueDate: "2026-13-01" },
    [
      { action: "create", title: "a" },
      { action: "set_due_date", taskIds: [task.id], dueDate: "today" },
    ],
  ]) {
    const reply = createAgent({ tasks, clock, planner: async () => plan });
    assert.match(await reply(user("修改日期")), /日期无效|格式无效/);
    assert.equal(await readFile(filename, "utf8"), before);
  }
  let finish!: (value: unknown) => void;
  const timedOut = createAgent({
    tasks,
    clock,
    planningTimeoutMs: 5,
    planner: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  assert.match(await timedOut(user("牛奶明天到期")), /超时/);
  finish({ action: "set_due_date", taskIds: [task.id], dueDate: "tomorrow" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await readFile(filename, "utf8"), before);
});
