import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyReply } from "../scripts/dialogue-checks.ts";

test("真实验收判定器识别参数澄清，但不把模型故障或无关回复算作澄清", () => {
  for (const reply of [
    "任务标题超过200字符，请缩短后再记录。",
    "请补充任务名称。",
    "请分开描述两个操作。",
    "你指的是哪一条？",
  ]) {
    assert.equal(classifyReply(reply), "clarify");
  }
  assert.equal(
    classifyReply("模型返回的操作格式无效，本轮没有修改任务。请换一种说法重试。"),
    "error",
  );
  assert.equal(classifyReply("今天的天气很好。"), "unknown");
});

test("任务标题中出现错误提示或问号，不改变执行器固定前缀的含义", () => {
  assert.equal(classifyReply("已添加待办：模型响应超时？（未完成，#12345678）。"), "created");
  assert.equal(classifyReply("任务清单：共1条。\n1. 未完成 · 模型返回的操作格式无效"), "listed");
});
