import assert from "node:assert/strict";
import { test } from "node:test";
import { requestReply } from "../src/chat-client.ts";

test("聊天客户端发送同一请求编号并读取真实回复", async (t) => {
  t.mock.method(globalThis, "fetch", async (_input: unknown, options?: RequestInit) => {
    assert.equal(new Headers(options?.headers).get("Idempotency-Key"), "request-id");
    return new Response(JSON.stringify({ reply: "已完成" }));
  });
  assert.equal(await requestReply([{ role: "user", content: "完成任务" }], "request-id"), "已完成");
});

test("聊天客户端将断网、超时和非法响应转换成中文", async (t) => {
  for (const [failure, expected] of [
    [new TypeError("Failed to fetch"), /无法连接服务/],
    [new DOMException("timeout", "TimeoutError"), /等待回复超时/],
  ] as const) {
    const mock = t.mock.method(globalThis, "fetch", async () => {
      throw failure;
    });
    await assert.rejects(requestReply([{ role: "user", content: "清单" }], "id"), expected);
    mock.mock.restore();
  }
  t.mock.method(globalThis, "fetch", async () => new Response("invalid"));
  await assert.rejects(requestReply([{ role: "user", content: "清单" }], "id"), /无效响应/);
});

test("聊天客户端保留HTTP错误，避免把失败响应当成成功回复", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify({ error: "同一请求编号不能用于不同消息。" }), { status: 409 }),
  );
  await assert.rejects(requestReply([{ role: "user", content: "清单" }], "id"), /同一请求编号/);
});
