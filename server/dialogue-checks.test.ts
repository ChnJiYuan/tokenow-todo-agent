import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyReply } from "../scripts/dialogue-checks.ts";

test("超长标题的明确拒绝与缩短请求算澄清，不能把任意请提供回复算成功", () => {
  assert.equal(classifyReply("这个任务标题超过200字，请提供一个简短的任务标题。"), "clarify");
  assert.equal(classifyReply("请提供你的邮箱。"), "unknown");
  assert.equal(classifyReply("这个任务标题超过200字，我已经缩短并添加。"), "unknown");
  assert.equal(
    classifyReply("模型响应超时。任务标题超过200字，请提供一个简短的任务标题。"),
    "error",
  );
});

test("未找到分类只接受现有执行反馈，不将任意澄清或模型故障放行", () => {
  assert.equal(
    classifyReply("没有找到对应的任务，本轮没有修改任务。请告诉我清单中的任务名称或 #编号。"),
    "not_found",
  );
  assert.equal(classifyReply("当前任务清单里没有“交电费”这条任务，你想删除哪一条？"), "clarify");
  assert.equal(classifyReply("你想删除哪一条？"), "clarify");
  assert.equal(classifyReply("暂时无法连接模型，本轮没有修改任务。"), "error");
  assert.equal(classifyReply("交电费很重要。"), "unknown");
});

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
