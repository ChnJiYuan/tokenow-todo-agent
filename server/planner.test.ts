import assert from "node:assert/strict";
import { test } from "node:test";
import { createModelPlanner, InvalidPlanError } from "./planner.ts";

test("JSON Output拒绝空内容、非法JSON、截断和意外工具调用，不尝试修复后执行", async () => {
  for (const result of [
    { content: null, finishReason: "stop" },
    { content: " ", finishReason: "stop" },
    { content: "not json", finishReason: "stop" },
    { content: '{"action":"create","title":"洗衣服"}', finishReason: "length" },
    { content: "{}", finishReason: "tool_calls" },
  ]) {
    const planner = createModelPlanner(async () => result);
    await assert.rejects(
      planner({ messages: [{ role: "user", content: "记录" }], tasks: [] }),
      InvalidPlanError,
    );
  }
});
