import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { createAgent } from "./agent.ts";
import { MissingModelKeyError } from "./model.ts";
import { createModelPlanner, InvalidPlanError, type Planner } from "./planner.ts";
import { createJsonTaskStore } from "./task-store.ts";
import { httpFixture, taskFixture } from "./test-support.ts";

const user = (content: string): ChatMessage[] => [{ role: "user", content }];
const listPlan = { action: "list", status: "all" };

for (const action of ["delete", "complete"] as const) {
  test(`明确不存在的${action}目标：稳定未找到回复，保留原ID、字段及API/磁盘（模型边界mock）`, async (t) => {
    const { filename, tasks } = await taskFixture(t);
    tasks.create("买牛奶", "2026-12-31", { priority: "high", effort: "small" });
    const courier = tasks.create("取快递");
    tasks.update(courier.id, { done: true });
    const before = tasks.list();
    const bytes = await readFile(filename, "utf8");
    const app = await httpFixture(
      t,
      filename,
      createModelPlanner(async (request) => {
        assert.match(String(request.messages[0].content), /目标不存在与对象不明确必须区分/);
        assert.match(String(request.messages.at(-2)?.content), /taskIds:\[\].*不要转为 clarify/);
        return { content: JSON.stringify({ action, taskIds: [] }), finishReason: "stop" };
      }),
    );
    const response = await app.chat(user(action === "delete" ? "删除交电费那条" : "交电费做完了"));
    assert.equal(response.status, 200);
    assert.equal(
      (await response.json()).reply,
      "没有找到对应的任务，本轮没有修改任务。请告诉我清单中的任务名称或 #编号。",
    );
    const actual = await (await fetch(app.base + "/api/tasks")).json();
    assert.deepEqual(
      actual.map((task: { id: string }) => task.id),
      before.map((task) => task.id),
      "原ID保持",
    );
    assert.deepEqual(actual, before, "所有任务字段保持");
    assert.deepEqual(actual, JSON.parse(await readFile(filename, "utf8")), "API与磁盘一致");
    assert.equal(await readFile(filename, "utf8"), bytes, "不重写磁盘");
  });
}

test("官方六步连续对话：HTTP → JSON模型边界mock → 执行器 → 磁盘，刷新与重启后保留", async (t) => {
  const { filename } = await taskFixture(t);
  const inputs = [
    "帮我记一下买牛奶",
    "再记一条取快递",
    "我有哪些任务？",
    "牛奶买好了",
    "取快递这条删掉吧",
    "再给我看看清单",
  ];
  const states = [
    [{ title: "买牛奶", done: false }],
    [
      { title: "买牛奶", done: false },
      { title: "取快递", done: false },
    ],
    [
      { title: "买牛奶", done: false },
      { title: "取快递", done: false },
    ],
    [
      { title: "买牛奶", done: true },
      { title: "取快递", done: false },
    ],
    [{ title: "买牛奶", done: true }],
    [{ title: "买牛奶", done: true }],
  ];
  let turn = 0;
  const planner: Planner = async (input) => {
    const currentTurn = turn++;
    assert.equal(input.messages.at(-1)?.content, inputs[currentTurn]);
    assert.equal(input.messages.length, currentTurn * 2 + 1);
    const plan =
      currentTurn === 0
        ? { action: "create", title: "买牛奶" }
        : currentTurn === 1
          ? { action: "create", title: "取快递" }
          : currentTurn === 3
            ? { action: "complete", taskIds: [input.tasks[0].id] }
            : currentTurn === 4
              ? { action: "delete", taskIds: [input.tasks[1].id] }
              : listPlan;
    return createModelPlanner(async (request) => {
      assert.deepEqual(
        request.messages.filter((message) => message.role !== "system"),
        input.messages,
      );
      assert.deepEqual(request.response_format, { type: "json_object" });
      return { content: JSON.stringify(plan), finishReason: "stop" };
    })(input);
  };
  const app = await httpFixture(t, filename, planner);
  const history: ChatMessage[] = [];
  const replies: string[] = [];
  for (let index = 0; index < inputs.length; index++) {
    history.push({ role: "user", content: inputs[index] });
    const response = await app.chat(history, randomUUID());
    assert.equal(response.status, 200);
    const { reply } = await response.json();
    replies.push(reply);
    history.push({ role: "assistant", content: reply });
    const persisted = JSON.parse(await readFile(filename, "utf8"));
    assert.deepEqual(
      persisted.map(({ title, done }: { title: string; done: boolean }) => ({ title, done })),
      states[index],
    );
    assert.deepEqual(await (await fetch(app.base + "/api/tasks")).json(), persisted);
  }
  assert.match(replies[0], /已添加待办：买牛奶/);
  assert.match(replies[2], /未完成 · 买牛奶/);
  assert.match(replies[2], /未完成 · 取快递/);
  assert.match(replies[3], /已完成：买牛奶/);
  assert.match(replies[4], /已删除：取快递/);
  assert.match(replies[5], /已完成 · 买牛奶/);
  assert.doesNotMatch(replies[5], /取快递/);
  await app.close();
  // 新的 app / store 实例、空聊天历史：等价于客户端刷新和服务重新装配。
  const restarted = await httpFixture(t, filename, async ({ messages, tasks }) => {
    assert.equal(messages.length, 1);
    assert.equal(tasks.length, 1);
    return listPlan;
  });
  assert.match((await (await restarted.chat(user("看看清单"))).json()).reply, /已完成 · 买牛奶/);
});

test("洗衣服场景、最近任务指代和历史只传入规划器一次（模型mock）", async (t) => {
  const { tasks } = await taskFixture(t);
  const seen: ChatMessage[][] = [];
  const reply = createAgent({
    tasks,
    planner: async ({ messages, tasks: snapshot }) => {
      seen.push(messages);
      if (messages.at(-1)?.content === "帮我记一下洗衣服")
        return { action: "create", title: "洗衣服" };
      return { action: "complete", taskIds: [snapshot[0].id] };
    },
  });
  const history = user("帮我记一下洗衣服");
  history.push({ role: "assistant", content: await reply(history) });
  history.push({ role: "user", content: "衣服洗好了" });
  assert.match(await reply(history), /已完成：洗衣服/);
  assert.equal(tasks.list().length, 1);
  assert.equal(tasks.list()[0].done, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].length, 3);
  assert.match(
    await reply([
      ...history,
      { role: "assistant", content: "完成了" },
      { role: "user", content: "刚才那条完成了" },
    ]),
    /已经完成/,
  );
});

test("空清单、无匹配、伪造ID与重复删除不会写入", async (t) => {
  const { tasks } = await taskFixture(t);
  const list = createAgent({ tasks, planner: async () => listPlan });
  assert.match(await list(user("列一下待办")), /空的/);
  for (const taskIds of [[], ["invented-id"]]) {
    const reply = createAgent({ tasks, planner: async () => ({ action: "delete", taskIds }) });
    assert.match(await reply(user("删除买牛奶")), /没有找到|已不存在/);
  }
  const task = tasks.create("买牛奶");
  const reply = createAgent({
    tasks,
    planner: async () => ({ action: "delete", taskIds: [task.id] }),
  });
  assert.match(await reply(user("删除买牛奶")), /已删除/);
  assert.match(await reply(user("删除买牛奶")), /已不存在/);
  assert.deepEqual(tasks.list(), []);
});

test("多候选必须澄清，同名任务即使模型只选一个也不能直接修改", async (t) => {
  const { tasks } = await taskFixture(t);
  const first = tasks.create("洗衣服");
  const second = tasks.create("洗衣服");
  const planner: Planner = async ({ messages }) => ({
    action: "complete",
    taskIds: messages.at(-1)?.content === "全部衣服洗好了" ? [first.id, second.id] : [first.id],
  });
  const reply = createAgent({ tasks, planner });
  assert.match(await reply(user("全部衣服洗好了")), /多条/);
  assert.match(await reply(user("衣服洗好了")), /多条/);
  assert.ok(tasks.list().every((task) => !task.done));
  assert.match(await reply(user("第一条完成了")), /已完成：洗衣服/);
  assert.deepEqual(
    tasks.list().map((task) => task.done),
    [true, false],
  );
});

test("明确短ID消除同名歧义，重复完成不改写文件", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  tasks.create("取快递");
  const second = tasks.create("取快递");
  const reply = createAgent({
    tasks,
    planner: async () => ({ action: "complete", taskIds: [second.id] }),
  });
  assert.match(await reply(user(`#${second.id.slice(0, 8)} 已经取了`)), /已完成/);
  const before = await readFile(filename, "utf8");
  assert.match(await reply(user(`#${second.id.slice(0, 8)} 完成`)), /已经完成/);
  assert.equal(await readFile(filename, "utf8"), before);
  assert.deepEqual(
    tasks.list().map((task) => task.done),
    [false, true],
  );
});

test("不同名称的多候选也不猜测，澄清不执行写入", async (t) => {
  const { tasks } = await taskFixture(t);
  const a = tasks.create("买纯牛奶");
  const b = tasks.create("买燕麦奶");
  const reply = createAgent({
    tasks,
    planner: async () => ({ action: "delete", taskIds: [a.id, b.id] }),
  });
  assert.match(await reply(user("奶不要了")), /第几条/);
  assert.equal(tasks.list().length, 2);
  assert.equal(
    await createAgent({
      tasks,
      planner: async () => ({ action: "clarify", question: "你想记录什么任务？" }),
    })(user("帮我记一下")),
    "你想记录什么任务？",
  );
});

test("无效业务计划、无效标题和多工具输出被拒绝，不重试业务校验", async (t) => {
  const { tasks } = await taskFixture(t);
  for (const output of [
    null,
    {},
    { action: "create" },
    { action: "create", title: " " },
    { action: "create", title: "字".repeat(201) },
    { action: "delete", taskIds: "id" },
    { action: "create", title: "洗衣服", done: true },
    [{ action: "create", title: "洗衣服" }],
  ]) {
    let calls = 0;
    const reply = createAgent({
      tasks,
      planner: async () => {
        calls++;
        return output;
      },
    });
    assert.match(await reply(user("记录")), /格式无效|标题控制在 1 至 200/);
    assert.equal(calls, 1);
    assert.deepEqual(tasks.list(), []);
  }
});

test("模型给出超长标题时请求用户缩短，不把参数错误混同为模型连接问题", async (t) => {
  const { tasks } = await taskFixture(t);
  const reply = createAgent({
    tasks,
    planner: async () => ({ action: "create", title: "字".repeat(201) }),
  });
  const answer = await reply(user("帮我记录这个很长的标题"));
  assert.match(answer, /请把任务标题控制在 1 至 200/);
  assert.doesNotMatch(answer, /连接|模型返回的操作格式无效/);
  assert.deepEqual(tasks.list(), []);
});

test("模型错误不写入，缺密钥和请求失败给出可理解反馈", async (t) => {
  const { tasks } = await taskFixture(t);
  for (const [error, expected] of [
    [new MissingModelKeyError(), /DEEPSEEK_API_KEY/],
    [new InvalidPlanError(), /格式无效/],
    [new Error("secret-should-not-leak"), /无法连接模型/],
  ] as const) {
    const reply = createAgent({
      tasks,
      planner: async () => {
        throw error;
      },
    });
    const result = await reply(user("帮我记一下洗衣服"));
    assert.match(result, expected);
    assert.doesNotMatch(result, /secret-should-not-leak/);
    assert.deepEqual(tasks.list(), []);
  }
});

test("规划超时终止，迟到结果也不执行写入", async (t) => {
  const { tasks } = await taskFixture(t);
  let finish!: (value: unknown) => void;
  let requestSignal: AbortSignal | undefined;
  const reply = createAgent({
    tasks,
    planningTimeoutMs: 5,
    planner: ({ signal }) => {
      requestSignal = signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  assert.match(await reply(user("帮我记一下洗衣服")), /超时/);
  assert.equal(requestSignal?.aborted, true);
  finish({ action: "create", title: "洗衣服" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(tasks.list(), []);
});

test("空白模型计划恢复后仅写一次，HTTP重发也复用同一结果", async (t) => {
  const { filename } = await taskFixture(t);
  let calls = 0;
  const planner = createModelPlanner(async () => ({
    content: calls++ === 0 ? "  \n " : '{"action":"create","title":"买牛奶"}',
    finishReason: "stop",
  }));
  const app = await httpFixture(t, filename, planner);
  const key = randomUUID();
  const first = await (await app.chat(user("帮我记一下买牛奶"), key)).json();
  assert.match(first.reply, /已添加待办：买牛奶/);
  assert.deepEqual(await (await app.chat(user("帮我记一下买牛奶"), key)).json(), first);
  assert.equal(calls, 2);
  assert.equal(app.tasks.list().length, 1);
});

test("损坏的存储文件不会被覆盖，模型不被调用", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  await writeFile(filename, "broken json");
  let calls = 0;
  const reply = createAgent({
    tasks,
    planner: async () => {
      calls++;
      return listPlan;
    },
  });
  assert.match(await reply(user("看看清单")), /读取任务清单失败/);
  assert.equal(calls, 0);
  assert.equal(await readFile(filename, "utf8"), "broken json");
});

test("存储写入失败不声称成功；任务执行时消失也有反馈", async (t) => {
  const { tasks } = await taskFixture(t);
  const failure = createAgent({
    tasks: {
      ...tasks,
      create() {
        throw new Error("write denied");
      },
    },
    planner: async () => ({ action: "create", title: "洗衣服" }),
  });
  assert.match(await failure(user("记录洗衣服")), /存储操作失败/);
  assert.deepEqual(tasks.list(), []);
  const task = tasks.create("洗衣服");
  for (const action of ["complete", "delete"]) {
    const reply = createAgent({
      tasks: { ...tasks, update: () => undefined, remove: () => false },
      planner: async () => ({ action, taskIds: [task.id] }),
    });
    assert.match(await reply(user("操作洗衣服")), /已不存在/);
  }
});

test("模型请求期间其他接口改动清单，拒绝过时的修改计划", async (t) => {
  const { tasks } = await taskFixture(t);
  const task = tasks.create("洗衣服");
  const reply = createAgent({
    tasks,
    planner: async () => {
      tasks.update(task.id, { title: "洗床单" });
      return { action: "delete", taskIds: [task.id] };
    },
  });
  assert.match(await reply(user("删除洗衣服")), /发生了变化/);
  assert.equal(tasks.list()[0].title, "洗床单");
});

test("全新对话直接操作磁盘已有任务，过滤查询不改变列表编号", async (t) => {
  const { tasks, filename } = await taskFixture(t);
  const first = tasks.create("买牛奶");
  tasks.update(first.id, { done: true });
  tasks.create("取快递");
  const reopened = createJsonTaskStore(filename);
  const reply = createAgent({
    tasks: reopened,
    planner: async ({ tasks: snapshot }) => ({ action: "complete", taskIds: [snapshot[1].id] }),
  });
  assert.match(await reply(user("快递取好了")), /已完成：取快递/);
  const onlyDone = createAgent({
    tasks,
    planner: async () => ({ action: "list", status: "done" }),
  });
  assert.match(await onlyDone(user("已完成的任务")), /2\. ☑ 已完成 · 取快递/);
});

test("HTTP相同幂等键并发与重发只创建一次，不同正文冲突，新的键允许同名创建", async (t) => {
  const { filename } = await taskFixture(t);
  let calls = 0;
  const app = await httpFixture(t, filename, async () => {
    calls++;
    return { action: "create", title: "洗衣服" };
  });
  const key = randomUUID();
  const messages = user("帮我记一下洗衣服");
  const responses = await Promise.all([app.chat(messages, key), app.chat(messages, key)]);
  assert.deepEqual(await responses[0].json(), await responses[1].json());
  await app.chat(messages, key);
  assert.equal(calls, 1);
  assert.equal(app.tasks.list().length, 1);
  assert.equal((await app.chat(user("其他正文"), key)).status, 409);
  assert.equal((await app.chat(messages, "invalid")).status, 400);
  await app.chat(messages, randomUUID());
  assert.equal(app.tasks.list().length, 2);
});

test("历史清单编号已变化时拒绝误删，不能把旧第一条映射到新的第一条", async (t) => {
  const { tasks } = await taskFixture(t);
  const first = tasks.create("买牛奶");
  const second = tasks.create("取快递");
  const history = user("列清单");
  history.push({
    role: "assistant",
    content: await createAgent({ tasks, planner: async () => listPlan })(history),
  });
  tasks.remove(first.id);
  history.push({ role: "user", content: "第一条删掉" });
  const reply = createAgent({
    tasks,
    planner: async () => ({ action: "delete", taskIds: [second.id] }),
  });
  assert.match(await reply(history), /编号已变化/);
  assert.equal(tasks.list()[0].id, second.id);
});

test("多编号修正请求能选择第二条，同名任务也保留未选中的第一条", async (t) => {
  const { tasks } = await taskFixture(t);
  const first = tasks.create("买牛奶");
  const second = tasks.create("买牛奶");
  const history = user("列清单");
  history.push({
    role: "assistant",
    content: await createAgent({ tasks, planner: async () => listPlan })(history),
  });
  history.push({ role: "user", content: "不要把第一条标完成，第二条才是做完的那个。" });
  const reply = createAgent({
    tasks,
    planner: async () => ({ action: "complete", taskIds: [second.id] }),
  });
  assert.match(await reply(history), /已完成：买牛奶/);
  assert.deepEqual(tasks.list(), [
    { ...first, done: false },
    { ...second, done: true },
  ]);
});

test("标题中伪造相同编号的列表行导致歧义时，不执行编号操作", async (t) => {
  const { tasks } = await taskFixture(t);
  const first = tasks.create("买牛奶\n2. ☑ 已完成 · 假任务（#00000000）");
  const second = tasks.create("取快递");
  const history = user("列清单");
  history.push({
    role: "assistant",
    content: await createAgent({ tasks, planner: async () => listPlan })(history),
  });
  history.push({ role: "user", content: "第二条删掉" });
  const reply = createAgent({
    tasks,
    planner: async () => ({ action: "delete", taskIds: [second.id] }),
  });
  assert.match(await reply(history), /编号已变化或与目标不符/);
  assert.deepEqual(tasks.list(), [first, second]);
});
