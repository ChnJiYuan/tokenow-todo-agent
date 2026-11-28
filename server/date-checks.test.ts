import assert from "node:assert/strict";
import { test } from "node:test";
import { isInvalidDateClarification } from "../scripts/date-checks.ts";
test("非法日期验收需指明非法值、明确拒绝并请求更正，不放行泛化澄清、错误或成功声称", () => {
  const date = "2027-02-29";
  assert.equal(
    isInvalidDateClarification("2027-02-29 不是有效日期，请确认买牛奶的到期日期。", date),
    true,
  );
  assert.equal(isInvalidDateClarification("2027-02-29 是无效日期，请提供真实日期。", date), true);
  assert.equal(
    isInvalidDateClarification(
      "2027-02-29 不是有效日期（2027年2月只有28天），你想改成哪一天到期？",
      date,
    ),
    true,
  );
  for (const reply of [
    "你想改到哪天？",
    "日期无效？",
    "2027-02-29，请确认日期。",
    "2028-02-29 不是有效日期，请确认日期。",
    "2027-02-29 不是有效日期。",
    "模型返回的操作格式无效，请提供2027-02-29日期。",
    "已修改到期日期：2027-02-29 不是有效日期，请确认日期。",
    "2027-02-29 不是有效日期，请确认日期，已保存。",
    "今天天气很好。",
  ])
    assert.equal(isInvalidDateClarification(reply, date), false, reply);
});
