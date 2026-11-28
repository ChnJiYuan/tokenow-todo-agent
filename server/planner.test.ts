import assert from "node:assert/strict";
import { test } from "node:test";
import { createModelPlanner, InvalidPlanError } from "./planner.ts";

const dateContext = { today: "2026-12-31", timeZone: "Australia/Sydney" };

test("空白或非法JSON重试次数有界，截断和意外工具调用直接拒绝", async () => {
  for (const result of [
    { content: null, finishReason: "stop" },
    { content: " ", finishReason: "stop" },
    { content: "not json", finishReason: "stop" },
    { content: '{"action":"create","title":"洗衣服"}', finishReason: "length" },
    { content: "{}", finishReason: "tool_calls" },
  ]) {
    let calls = 0;
    const planner = createModelPlanner(async () => {
      calls++;
      return result;
    });
    await assert.rejects(
      planner({ messages: [{ role: "user", content: "记录" }], tasks: [], dateContext }),
      InvalidPlanError,
    );
    assert.equal(calls, result.finishReason === "stop" ? 2 : 1);
  }
});

test("JSON模式空白响应仅重试规划一次，完整历史保留且最新用户前有格式提醒", async () => {
  let calls = 0;
  const messages = [
    { role: "user" as const, content: "帮我记一下买牛奶" },
    { role: "assistant" as const, content: "已添加待办：买牛奶。" },
    { role: "user" as const, content: "再给我看看清单" },
  ];
  const planner = createModelPlanner(async (request) => {
    assert.deepEqual(
      request.messages.filter((message) => message.role !== "system"),
      messages,
    );
    assert.match(String(request.messages.at(-2)?.content), /只生成一个操作计划 JSON/);
    if (calls++) {
      assert.match(String(request.messages.at(-2)?.content), /上次没有返回有效JSON/);
      return { content: '{"action":"list","status":"all"}', finishReason: "stop" };
    }
    return { content: "  \n  ", finishReason: "stop" };
  });
  assert.deepEqual(await planner({ messages, tasks: [], dateContext }), {
    action: "list",
    status: "all",
  });
  assert.equal(calls, 2);
});

test("模型请求异常不自动重试，取消后也不会继续发第二次请求", async () => {
  let calls = 0;
  const input = { messages: [{ role: "user" as const, content: "清单" }], tasks: [], dateContext };
  const failure = createModelPlanner(async () => {
    calls++;
    throw new Error("network failure");
  });
  await assert.rejects(failure(input), /network failure/);
  assert.equal(calls, 1);
  const controller = new AbortController();
  const cancelled = createModelPlanner(async (_request, signal) => {
    calls++;
    assert.equal(signal, controller.signal);
    controller.abort();
    return { content: " ", finishReason: "stop" };
  });
  await assert.rejects(cancelled({ ...input, signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 2);
});

test("每次规划及空JSON重试都将本轮服务端日期放在用户消息之前，历史中的今天不能覆盖", async () => {
  let calls = 0;
  const planner = createModelPlanner(async (request) => {
    const context = String(request.messages.at(-2)?.content);
    assert.match(context, /本轮服务端日期（唯一可信的今天/);
    assert.match(context, /2026-12-31/);
    assert.match(context, /Australia\/Sydney/);
    assert.deepEqual(request.messages.at(-1), { role: "user", content: "今天有哪些任务到期？" });
    return {
      content: calls++ === 0 ? " " : '{"action":"list","dueDate":"today"}',
      finishReason: "stop",
    };
  });
  assert.deepEqual(
    await planner({
      messages: [
        { role: "assistant", content: "今天是1900-01-01" },
        { role: "user", content: "今天有哪些任务到期？" },
      ],
      tasks: [],
      dateContext,
    }),
    { action: "list", dueDate: "today" },
  );
  assert.equal(calls, 2);
});
