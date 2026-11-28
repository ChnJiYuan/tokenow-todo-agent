import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { shortTaskId, taskRows } from "../shared/task-view.ts";
import { filterTasks, taskSchema } from "../shared/tasks.ts";
import { createAgent } from "./agent.ts";
import { createModelPlanner } from "./planner.ts";
import { TaskRuleError } from "./task-rules.ts";
import { createJsonTaskStore } from "./task-store.ts";
import { httpFixture, taskFixture } from "./test-support.ts";

const user = (content: string): ChatMessage[] => [{ role: "user", content }];
const rule = (code: TaskRuleError["code"]) => (error: unknown) =>
  error instanceof TaskRuleError && error.code === code;

test("子任务六步验收：HTTP → JSON模型mock → 执行器 → 磁盘，连续指代与幂等重发", async (t) => {
  const { filename } = await taskFixture(t);
  let turn = 0;
  const app = await httpFixture(t, filename, async (input) => {
    const parent = input.tasks.find((task) => !task.parentId);
    const plans = [
      { action: "create", title: "准备面试" },
      { action: "create", title: "整理项目介绍", parentIds: [parent?.id] },
      { action: "create", title: "练习自我介绍", parentIds: [parent?.id] },
      { action: "list", status: "pending", parentIds: [parent?.id] },
      {
        action: "complete",
        taskIds: [input.tasks.find((task) => task.title === "整理项目介绍")?.id],
      },
      { action: "delete", taskIds: [parent?.id], cascade: true },
    ];
    const plan = plans[turn++];
    return createModelPlanner(async (request) => {
      assert.match(String(request.messages[0].content), /支持一级子任务/);
      assert.deepEqual(
        request.messages.filter((message) => message.role !== "system"),
        input.messages,
      );
      return { content: JSON.stringify(plan), finishReason: "stop" };
    })(input);
  });
  const texts = [
    "帮我记一下准备面试。",
    "给准备面试加个子任务：整理项目介绍。",
    "再加一个子任务：练习自我介绍。",
    "准备面试还有哪些子任务没完成？",
    "整理项目介绍做完了。",
    "把准备面试和它的子任务一起删除。",
  ];
  const history: ChatMessage[] = [];
  const replies: string[] = [];
  let parentId = "";
  for (const [index, text] of texts.entries()) {
    history.push({ role: "user", content: text });
    const key = randomUUID();
    const response = await app.chat(history, key);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(await (await app.chat(history, key)).json(), result);
    replies.push(result.reply);
    history.push({ role: "assistant", content: result.reply });
    const disk = JSON.parse(await readFile(filename, "utf8"));
    assert.deepEqual(disk, app.tasks.list());
    if (index === 0) parentId = disk[0].id;
    if (index > 0 && index < 5) {
      assert.equal(disk[0].id, parentId);
      assert.equal(disk[0].done, false);
      assert.ok(disk.slice(1).every((task: { parentId?: string }) => task.parentId === parentId));
    }
  }
  assert.equal(turn, 6);
  assert.match(replies[1], /已添加子任务：整理项目介绍/);
  assert.match(replies[2], /已添加子任务：练习自我介绍/);
  assert.match(replies[3], /0\/2 完成/);
  assert.match(replies[3], /2\. .*整理项目介绍/);
  assert.match(replies[3], /3\. .*练习自我介绍/);
  assert.match(replies[4], /已完成：整理项目介绍/);
  assert.match(replies[5], /一并删除 2 条子任务/);
  assert.deepEqual(createJsonTaskStore(filename).list(), []);
});

test("同名主任务创建/查询先澄清，即使模型只选一个；明确短ID后才创建", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  const first = tasks.create("准备面试");
  const second = tasks.create("准备面试");
  const before = await readFile(filename, "utf8");
  for (const parentIds of [[first.id], [first.id, second.id], [], ["missing"]]) {
    for (const action of ["create", "list"]) {
      const reply = createAgent({
        tasks,
        planner: async () =>
          action === "create"
            ? { action, title: "整理项目介绍", parentIds }
            : { action, status: "pending", parentIds },
      });
      assert.match(await reply(user("给准备面试添加/查看子任务")), /多条|没有找到|已不存在/);
      assert.equal(await readFile(filename, "utf8"), before);
    }
  }
  const reply = createAgent({
    tasks,
    planner: async () => ({ action: "create", title: "整理项目介绍", parentIds: [second.id] }),
  });
  assert.match(
    await reply(user(`给 #${second.id.slice(0, 8)} 加子任务：整理项目介绍`)),
    /已添加子任务/,
  );
  assert.equal(tasks.list().at(-1)?.parentId, second.id);
});

test("存储层拒绝不存在父任务、自引用、循环、深层关联和带子任务的主任务降级", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  const parent = tasks.create("准备面试");
  const child = tasks.create("整理项目介绍", undefined, { parentId: parent.id });
  const another = tasks.create("其他主任务");
  const before = await readFile(filename, "utf8");
  const operations = [
    () => tasks.create("孤儿", undefined, { parentId: "missing" }),
    () => tasks.create("孙任务", undefined, { parentId: child.id }),
    () => tasks.update(parent.id, { parentId: parent.id }),
    () => tasks.update(parent.id, { parentId: child.id }),
    () => tasks.update(parent.id, { parentId: another.id }),
    () => tasks.update(child.id, { parentId: child.id }),
    () => tasks.update(child.id, { parentId: "missing" }),
  ];
  for (const operation of operations) {
    assert.throws(operation, rule("invalid_parent"));
    assert.equal(await readFile(filename, "utf8"), before);
  }
});

test("父子完成规则由存储层执行：拒绝父任务提前完成，子任务全完成也不自动完成父任务", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  const parent = tasks.create("准备面试");
  const first = tasks.create("整理项目介绍", undefined, { parentId: parent.id });
  const second = tasks.create("练习自我介绍", undefined, { parentId: parent.id });
  tasks.update(first.id, { done: true });
  const before = await readFile(filename, "utf8");
  assert.throws(
    () => tasks.update(parent.id, { done: true, title: "偷改标题" }),
    (error) => {
      assert.ok(rule("pending_children")(error));
      assert.deepEqual(
        (error as TaskRuleError).relatedTasks.map((task) => task.id),
        [second.id],
      );
      return true;
    },
  );
  assert.equal(await readFile(filename, "utf8"), before);
  const reply = createAgent({
    tasks,
    planner: async () => ({ action: "complete", taskIds: [parent.id] }),
  });
  const refused = await reply(user("准备面试完成了"));
  assert.match(refused, /还有未完成子任务/);
  assert.match(refused, /3\. .*练习自我介绍/);
  assert.doesNotMatch(refused, /整理项目介绍/);
  tasks.update(second.id, { done: true });
  assert.equal(tasks.list()[0].done, false);
  assert.match(await reply(user("准备面试完成了")), /已完成：准备面试/);
  assert.equal(tasks.list()[0].done, true);
});

test("给已完成主任务添加子任务：一次写入同时新增和恢复，保留日期/属性", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  const parent = tasks.create("准备面试", "2026-11-27", { priority: "high", effort: "large" });
  tasks.update(parent.id, { done: true });
  const writes = t.mock.method(fs, "writeFileSync");
  const renames = t.mock.method(fs, "renameSync");
  const child = tasks.create("整理项目介绍", undefined, { parentId: parent.id });
  assert.equal(writes.mock.callCount(), 1);
  assert.equal(renames.mock.callCount(), 1);
  const saved = JSON.parse(String(writes.mock.calls[0].arguments[1]));
  assert.equal(saved[0].done, false);
  assert.equal(saved[1].id, child.id);
  assert.deepEqual(saved, JSON.parse(await readFile(filename, "utf8")));
  assert.equal(saved[0].dueDate, "2026-11-27");
  assert.equal(saved[0].priority, "high");
  assert.equal(saved[1].dueDate, undefined);
  assert.equal(saved[1].priority, "medium");
});

test("新增子任务失败时已完成主任务不被部分恢复", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  const parent = tasks.create("准备面试");
  tasks.update(parent.id, { done: true });
  const before = await readFile(filename, "utf8");
  await mkdir(filename + ".tmp");
  assert.throws(() => tasks.create("整理项目介绍", undefined, { parentId: parent.id }));
  assert.equal(await readFile(filename, "utf8"), before);
  assert.equal(tasks.list()[0].done, true);
});

test("删除有子任务的主任务默认拒绝；明确级联只写一次并保留其他任务", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  const parent = tasks.create("准备面试");
  const first = tasks.create("整理项目介绍", undefined, { parentId: parent.id });
  const second = tasks.create("练习自我介绍", undefined, { parentId: parent.id });
  tasks.update(second.id, { done: true });
  const other = tasks.create("买牛奶");
  const writes = t.mock.method(fs, "writeFileSync");
  const renames = t.mock.method(fs, "renameSync");
  assert.throws(() => tasks.remove(parent.id), rule("has_children"));
  assert.equal(writes.mock.callCount(), 0);
  assert.equal(tasks.remove(first.id), true);
  assert.ok(tasks.list().some((task) => task.id === parent.id));
  assert.throws(() => tasks.remove(parent.id, false), rule("has_children"));
  writes.mock.resetCalls();
  renames.mock.resetCalls();
  assert.equal(tasks.remove(parent.id, true), true);
  assert.equal(writes.mock.callCount(), 1);
  assert.equal(renames.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), [other]);
});

test("模型不能自行授权级联：普通删除、否定、引用、假设先确认；明确确认后才删", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  const parent = tasks.create("准备面试");
  tasks.create("整理项目介绍", undefined, { parentId: parent.id });
  const reply = createAgent({
    tasks,
    planner: async () => ({ action: "delete", taskIds: [parent.id], cascade: true }),
  });
  const before = await readFile(filename, "utf8");
  for (const text of [
    "删除准备面试",
    "不要把准备面试和子任务一起删除",
    "如果把准备面试和子任务一起删除会怎样",
    "解释‘一起删除所有子任务’这句话",
    "把准备面试和子任务一起删除吗？",
  ]) {
    assert.match(await reply(user(text)), /删除确认/);
    assert.equal(await readFile(filename, "utf8"), before);
  }
  const history = user("删除准备面试");
  history.push({ role: "assistant", content: await reply(history) });
  history.push({ role: "user", content: `确认一并删除 #${parent.id.slice(0, 8)}` });
  assert.match(await reply(history), /已一并删除 1 条子任务/);
  assert.deepEqual(tasks.list(), []);
});

test("REST 同样校验父子关联、完成阻塞及级联确认参数，不信任客户端字段", async (t) => {
  const { filename } = await taskFixture(t);
  const app = await httpFixture(t, filename, async () => ({ action: "help" }));
  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(app.base + "/api/tasks" + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }
  const parent = (await request("POST", "", { title: "准备面试" })).body;
  const child = (await request("POST", "", { title: "整理项目介绍", parentId: parent.id })).body;
  assert.equal(child.parentId, parent.id);
  assert.deepEqual((await request("GET", `?parentId=${parent.id}&status=pending`)).body, [child]);
  for (const parentId of ["missing", child.id, "", null, 12])
    assert.equal((await request("POST", "", { title: "非法", parentId })).status, 400);
  for (const parentId of [parent.id, child.id])
    assert.equal((await request("PATCH", `/${parent.id}`, { parentId })).status, 400);
  const blocked = await request("PATCH", `/${parent.id}`, { done: true });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "pending_children");
  assert.deepEqual(blocked.body.tasks, [child]);
  assert.equal((await request("DELETE", `/${parent.id}`)).status, 409);
  assert.equal((await request("DELETE", `/${parent.id}?cascade=false`)).status, 409);
  for (const query of ["1", "TRUE", "true&cascade=false", ""]) {
    assert.equal((await request("DELETE", `/${parent.id}?cascade=${query}`)).status, 400);
  }
  assert.equal((await request("PATCH", `/${child.id}`, { done: true })).status, 200);
  assert.equal(app.tasks.list()[0].done, false);
  assert.equal((await request("PATCH", `/${parent.id}`, { done: true })).status, 200);
  const added = await request("POST", "", { title: "练习自我介绍", parentId: parent.id });
  assert.equal(added.status, 201);
  assert.equal(app.tasks.list()[0].done, false);
  assert.equal((await request("DELETE", `/${parent.id}?cascade=true`)).status, 204);
  assert.deepEqual(app.tasks.list(), []);
});

test("同名子任务需明确目标，限定父任务可区分不同主任务下的同名子任务", async (t) => {
  const { tasks } = await taskFixture(t);
  const a = tasks.create("准备面试");
  const b = tasks.create("准备演讲");
  const childA = tasks.create("练习介绍", undefined, { parentId: a.id });
  const childB = tasks.create("练习介绍", undefined, { parentId: b.id });
  const unscoped = createAgent({
    tasks,
    planner: async () => ({ action: "complete", taskIds: [childA.id] }),
  });
  assert.match(await unscoped(user("练习介绍做完了")), /多条/);
  const scoped = createAgent({
    tasks,
    planner: async () => ({ action: "complete", taskIds: [childA.id], parentIds: [a.id] }),
  });
  assert.match(await scoped(user("准备面试的练习介绍做完了")), /已完成：练习介绍/);
  assert.equal(tasks.list().find((task) => task.id === childB.id)?.done, false);
  tasks.create("练习介绍", undefined, { parentId: a.id });
  assert.match(await scoped(user("准备面试的练习介绍做完了")), /多条/);
});

test("父子分组顺序、筛选编号和父任务上下文一致，排序保留全局编号", async (t) => {
  const { tasks } = await taskFixture(t);
  const a = tasks.create("准备面试");
  const b = tasks.create("准备演讲", undefined, { priority: "high" });
  const childA = tasks.create("整理项目介绍", undefined, { parentId: a.id });
  const childB = tasks.create("准备讲稿", undefined, { parentId: b.id });
  tasks.update(childA.id, { done: true });
  const all = tasks.list();
  assert.deepEqual(
    taskRows(all).map(({ task, position }) => [task.id, position]),
    [
      [a.id, 1],
      [childA.id, 2],
      [b.id, 3],
      [childB.id, 4],
    ],
  );
  assert.deepEqual(
    taskRows(all, "priority").map(({ task, position }) => [task.id, position]),
    [
      [b.id, 3],
      [childB.id, 4],
      [a.id, 1],
      [childA.id, 2],
    ],
  );
  const matched = new Set(filterTasks(all, { status: "done" }).map((task) => task.id));
  const visible = taskRows(all).filter(({ task }) => matched.has(task.id));
  assert.equal(visible[0].position, 2);
  assert.equal(visible[0].parent?.id, a.id);
  assert.equal(taskRows(all)[0].doneChildren, 1);
  const reply = createAgent({ tasks, planner: async () => ({ action: "list", status: "done" }) });
  const text = await reply(user("已完成任务"));
  assert.match(text, /2\. ☑ 已完成 · 整理项目介绍/);
  assert.match(text, new RegExp(`所属：准备面试 #${a.id.slice(0, 8)}`));
  assert.doesNotMatch(text, /1\. /);
});

test("新增子任务改变分组编号后，旧编号核对真实ID；拒绝把旧第二条误映射到新子任务", async (t) => {
  const { tasks } = await taskFixture(t);
  const a = tasks.create("准备面试");
  const b = tasks.create("买牛奶");
  const history = user("列清单");
  history.push({
    role: "assistant",
    content: await createAgent({ tasks, planner: async () => ({ action: "list", status: "all" }) })(
      history,
    ),
  });
  const child = tasks.create("整理项目介绍", undefined, { parentId: a.id });
  history.push({ role: "user", content: "第二条删掉" });
  const wrong = createAgent({
    tasks,
    planner: async () => ({ action: "delete", taskIds: [child.id] }),
  });
  assert.match(await wrong(history), /编号已变化或与目标不符/);
  const correct = createAgent({
    tasks,
    planner: async () => ({ action: "delete", taskIds: [b.id] }),
  });
  assert.match(await correct(history), /已删除：买牛奶/);
  assert.ok(tasks.list().some((task) => task.id === child.id));
});

test("规划快照按父子分组给出真实全局position，保留稳定parentId", async (t) => {
  const { tasks } = await taskFixture(t);
  const a = tasks.create("准备面试");
  const b = tasks.create("买牛奶");
  const child = tasks.create("整理项目介绍", undefined, { parentId: a.id });
  const planner = createModelPlanner(async (request) => {
    const snapshot = String(request.messages[1].content);
    const parsed = JSON.parse(snapshot.slice(snapshot.indexOf("：") + 1));
    assert.deepEqual(
      parsed.map((task: { id: string; position: number }) => [task.id, task.position]),
      [
        [a.id, 1],
        [child.id, 2],
        [b.id, 3],
      ],
    );
    assert.equal(parsed[1].parentId, a.id);
    return { content: '{"action":"list","status":"all"}', finishReason: "stop" };
  });
  assert.match(await createAgent({ tasks, planner })(user("列清单")), /子任务 0\/1 完成/);
});

test("旧JSON没有parentId视为主任务；不迁移未修改字段，按ID关联不受重命名影响", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  const old = { id: "legacy-parent", title: "准备面试", done: true, custom: { source: "旧系统" } };
  const untouched = {
    id: "legacy-other",
    title: "准备面试",
    done: false,
    priority: "high",
    extra: [1, 2],
  };
  const original = JSON.stringify([old, untouched]);
  await writeFile(filename, original);
  assert.equal(tasks.list()[0].parentId, undefined);
  assert.equal(await readFile(filename, "utf8"), original);
  const child = tasks.create("整理项目介绍", undefined, { parentId: old.id });
  const disk = JSON.parse(await readFile(filename, "utf8"));
  assert.deepEqual(disk[0], { ...old, done: false });
  assert.deepEqual(disk[1], untouched);
  tasks.update(old.id, { title: "准备技术面试" });
  assert.equal(
    createJsonTaskStore(filename)
      .list()
      .find((task) => task.id === child.id)?.parentId,
    old.id,
  );
});

test("非法持久化关系、重复ID和深层环不会被读取后覆盖", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  const a = { id: "a", title: "A", done: false };
  const b = { id: "b", title: "B", done: false };
  for (const invalid of [
    [{ ...a, parentId: "missing" }],
    [{ ...a, parentId: "a" }],
    [
      { ...a, parentId: "b" },
      { ...b, parentId: "a" },
    ],
    [a, { ...b, parentId: "a" }, { id: "c", title: "C", done: false, parentId: "b" }],
    [a, { ...a, title: "重复ID" }],
  ]) {
    const original = JSON.stringify(invalid);
    await writeFile(filename, original);
    assert.throws(() => tasks.list(), rule("invalid_parent"));
    assert.throws(() => tasks.create("新任务"), rule("invalid_parent"));
    assert.equal(await readFile(filename, "utf8"), original);
  }
});

test("重新关联或恢复未完成子任务会一次恢复新父任务；null可解除关系", async (t) => {
  const { tasks } = await taskFixture(t);
  const a = tasks.create("准备面试");
  const b = tasks.create("准备演讲");
  const child = tasks.create("练习介绍", undefined, { parentId: a.id });
  tasks.update(b.id, { done: true });
  const writes = t.mock.method(fs, "writeFileSync");
  tasks.update(child.id, { parentId: b.id });
  assert.equal(writes.mock.callCount(), 1);
  assert.equal(tasks.list().find((task) => task.id === b.id)?.done, false);
  tasks.update(child.id, { done: true });
  tasks.update(b.id, { done: true });
  writes.mock.resetCalls();
  tasks.update(child.id, { done: false });
  assert.equal(writes.mock.callCount(), 1);
  assert.equal(tasks.list().find((task) => task.id === b.id)?.done, false);
  tasks.update(child.id, { parentId: null });
  assert.equal(tasks.list().find((task) => task.id === child.id)?.parentId, undefined);
});

test("子任务创建拒绝过时父任务快照，超时取消后迟到计划不写入", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  const parent = tasks.create("准备面试");
  const stale = createAgent({
    tasks,
    planner: async () => {
      tasks.remove(parent.id);
      return { action: "create", title: "整理项目介绍", parentIds: [parent.id] };
    },
  });
  assert.match(await stale(user("给准备面试加子任务")), /发生了变化/);
  const next = tasks.create("准备面试");
  const before = await readFile(filename, "utf8");
  let finish!: (plan: unknown) => void;
  let signal: AbortSignal | undefined;
  const reply = createAgent({
    tasks,
    planningTimeoutMs: 5,
    planner: async (input) => {
      signal = input.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  assert.match(await reply(user("给准备面试加子任务")), /超时/);
  assert.equal(signal?.aborted, true);
  finish({ action: "create", title: "整理项目介绍", parentIds: [next.id] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await readFile(filename, "utf8"), before);
});

test("短ID前缀碰撞自动扩展，碰撞的旧编号不能消除同名歧义", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  const first = taskSchema.parse({ id: "12345678-a", title: "准备面试", done: false });
  const second = taskSchema.parse({ id: "12345678-b", title: "准备面试", done: false });
  await writeFile(filename, JSON.stringify([first, second]));
  assert.equal(shortTaskId(first, [first, second]), "12345678-a");
  const reply = createAgent({
    tasks,
    planner: async () => ({ action: "create", title: "介绍", parentIds: [first.id] }),
  });
  assert.match(await reply(user("给 #12345678 加子任务介绍")), /多条/);
  assert.match(await reply(user("给 #12345678-a 加子任务介绍")), /已添加子任务/);
});

test("中文按子任务编号删除只删指定子任务，父任务限定不误用子任务编号", async (t) => {
  const { tasks } = await taskFixture(t);
  const parent = tasks.create("准备面试");
  const child = tasks.create("整理项目介绍", undefined, { parentId: parent.id });
  const other = tasks.create("练习自我介绍", undefined, { parentId: parent.id });
  const history = user("查看清单");
  history.push({
    role: "assistant",
    content: await createAgent({ tasks, planner: async () => ({ action: "list", status: "all" }) })(
      history,
    ),
  });
  history.push({ role: "user", content: "删除准备面试的第二条任务" });
  const reply = createAgent({
    tasks,
    planner: async () => ({ action: "delete", taskIds: [child.id], parentIds: [parent.id] }),
  });
  assert.match(await reply(history), /已删除：整理项目介绍/);
  assert.deepEqual(
    tasks.list().map((task) => task.id),
    [parent.id, other.id],
  );
});

test("短ID与计划目标不符时不写入；旧单字符ID不会因标题包含该字符而消除同名歧义", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  const a = tasks.create("准备面试");
  const b = tasks.create("准备演讲");
  const wrong = createAgent({
    tasks,
    planner: async () => ({ action: "create", title: "整理介绍", parentIds: [a.id] }),
  });
  assert.match(await wrong(user(`给 #${b.id.slice(0, 8)} 加子任务：整理介绍`)), /编号.*不符/);
  assert.equal(tasks.list().length, 2);
  const legacy = [
    { id: "a", title: "plan", done: false },
    { id: "b", title: "plan", done: false },
  ];
  await writeFile(filename, JSON.stringify(legacy));
  const reply = createAgent({
    tasks,
    planner: async () => ({ action: "create", title: "介绍", parentIds: ["a"] }),
  });
  assert.match(await reply(user("给 plan 添加介绍子任务")), /多条/);
  assert.match(await reply(user("给 #a 添加介绍子任务")), /已添加子任务/);
});

test("可明确级联删除带引号的任务名；标题本身的删除文字不能充当级联授权", async (t) => {
  const { tasks } = await taskFixture(t);
  const parent = tasks.create("准备面试");
  tasks.create("整理项目介绍", undefined, { parentId: parent.id });
  const reply = createAgent({
    tasks,
    planner: async () => ({ action: "delete", taskIds: [parent.id], cascade: true }),
  });
  assert.match(await reply(user("把“准备面试”和它的子任务一起删除")), /一并删除 1 条子任务/);
  const dataTitle = tasks.create("一起删除所有子任务");
  tasks.create("待处理", undefined, { parentId: dataTitle.id });
  const quoted = createAgent({
    tasks,
    planner: async () => ({ action: "delete", taskIds: [dataTitle.id], cascade: true }),
  });
  assert.match(await quoted(user("删除“一起删除所有子任务”这条主任务")), /删除确认/);
  assert.equal(tasks.list().length, 2);
});
