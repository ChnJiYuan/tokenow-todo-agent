import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

// 独立进程避免模块级模型配置受到测试加载顺序影响；拦截 SDK 的真实传输边界，绝不访问网络。
const exerciseModelRequest = `
  import assert from "node:assert/strict";
  import { createModelPlanner } from "./server/planner.ts";

  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), "https://api.deepseek.com/chat/completions");
    assert.equal(options.method, "POST");
    const request = JSON.parse(options.body);
    assert.equal(request.model, process.env.TOKENOW_EXPECTED_MODEL);
    assert.equal(request.reasoning_effort, "none");
    assert.deepEqual(request.response_format, { type: "json_object" });
    assert.equal(request.max_tokens, 800);
    assert.deepEqual(request.messages.at(-1), { role: "user", content: "我有哪些任务？" });
    return new Response(JSON.stringify({
      id: "chatcmpl-fixture",
      object: "chat.completion",
      created: 0,
      model: request.model,
      choices: [{ index: 0, finish_reason: "stop", message: {
        role: "assistant", content: JSON.stringify({ action: "list", status: "all" })
      } }],
    }), { headers: { "Content-Type": "application/json" } });
  };
  assert.deepEqual(await createModelPlanner()({
    messages: [{ role: "user", content: "我有哪些任务？" }], tasks: [],
  }), { action: "list", status: "all" });
  assert.equal(calls, 1);
`;

for (const configuredModel of [undefined, "deepseek-v4-pro"]) {
  test(
    configuredModel
      ? "自定义模型仍通过SDK显式关闭思考"
      : "未配置模型时SDK请求默认Flash且显式关闭思考",
    async () => {
      const env = { ...process.env };
      delete env.DEEPSEEK_MODEL;
      if (configuredModel) env.DEEPSEEK_MODEL = configuredModel;
      env.DEEPSEEK_API_KEY = "fixture-key-not-a-real-credential";
      env.TOKENOW_EXPECTED_MODEL = configuredModel ?? "deepseek-flash";
      const { stdout, stderr } = await run(
        process.execPath,
        ["--input-type=module", "-e", exerciseModelRequest],
        {
          env,
          timeout: 5_000,
        },
      );
      assert.equal(stdout, "");
      assert.equal(stderr, "");
    },
  );
}
