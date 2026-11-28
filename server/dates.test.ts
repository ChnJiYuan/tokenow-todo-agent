import assert from "node:assert/strict";
import { test } from "node:test";
import { dateSchema, resolveDate } from "../shared/dates.ts";
import { isOverdue, taskSchema } from "../shared/tasks.ts";
import { createTaskClock } from "./task-clock.ts";

test("日期严格校验格式、月份天数和公历闰年，不接受时间戳或日期滚动", () => {
  for (const date of ["0001-01-01", "2000-02-29", "2024-02-29", "2026-12-31", "9999-12-31"])
    assert.equal(dateSchema.parse(date), date);
  for (const date of [
    "0000-01-01",
    "1900-02-29",
    "2026-02-29",
    "2026-04-31",
    "2026-02-30",
    "2026-00-01",
    "2026-13-01",
    "2026-01-00",
    "2026-01-32",
    "2026-1-01",
    "2026-01-1",
    " 2026-01-01",
    "2026-01-01 ",
    "2026-01-01\n",
    "2026-01-01\r",
    "2026-01-01T00:00:00Z",
    "明天",
    "",
    null,
    20260101,
  ])
    assert.equal(dateSchema.safeParse(date).success, false, String(date));
});

test("相对日期按日历跨日、跨月、跨年，闰年和最小年份不受 Date 的 1900 偏移影响", () => {
  assert.equal(resolveDate("tomorrow", "2026-12-31"), "2027-01-01");
  assert.equal(resolveDate("dayAfterTomorrow", "2026-12-31"), "2027-01-02");
  assert.equal(resolveDate("yesterday", "2027-01-01"), "2026-12-31");
  assert.equal(resolveDate("tomorrow", "2024-02-28"), "2024-02-29");
  assert.equal(resolveDate("tomorrow", "2026-02-28"), "2026-03-01");
  assert.equal(resolveDate("today", "0001-01-01"), "0001-01-01");
  assert.equal(resolveDate("2027-04-30", "2026-12-31"), "2027-04-30");
  assert.throws(() => resolveDate("yesterday", "0001-01-01"));
  assert.throws(() => resolveDate("tomorrow", "9999-12-31"));
});

test("可控时钟按悉尼时区在UTC尚未跨日时跨年，支持其他时区并拒绝无效配置", (t) => {
  const previous = process.env.TASK_TIME_ZONE;
  t.after(() => {
    if (previous === undefined) delete process.env.TASK_TIME_ZONE;
    else process.env.TASK_TIME_ZONE = previous;
  });
  delete process.env.TASK_TIME_ZONE;
  let instant = new Date("2026-12-31T12:59:59Z");
  const clock = createTaskClock({ now: () => instant });
  assert.deepEqual(clock(), { today: "2026-12-31", timeZone: "Australia/Sydney" });
  instant = new Date("2026-12-31T13:00:00Z");
  assert.equal(clock().today, "2027-01-01");
  assert.equal(
    createTaskClock({ timeZone: "America/Los_Angeles", now: () => instant })().today,
    "2026-12-31",
  );
  process.env.TASK_TIME_ZONE = "UTC";
  assert.equal(createTaskClock({ now: () => instant })().today, "2026-12-31");
  assert.throws(() => createTaskClock({ timeZone: "Invalid/Zone" }), RangeError);
  assert.throws(() => createTaskClock({ timeZone: "" }), RangeError);
});

test("悉尼夏令时切换日的明天仍是下一日历日，逾期仅适用于已过日期的未完成任务", () => {
  for (const instant of ["2026-04-04T16:01:00Z", "2026-10-03T16:01:00Z"]) {
    const clock = createTaskClock({ timeZone: "Australia/Sydney", now: () => new Date(instant) });
    const today = clock().today;
    assert.equal(
      resolveDate("tomorrow", today),
      today === "2026-04-05" ? "2026-04-06" : "2026-10-05",
    );
  }
  const task = taskSchema.parse({ id: "a", title: "牛奶", done: false });
  assert.equal(isOverdue(task, "2027-01-01"), false);
  assert.equal(isOverdue({ ...task, dueDate: "2026-12-31" }, "2027-01-01"), true);
  assert.equal(isOverdue({ ...task, dueDate: "2027-01-01" }, "2027-01-01"), false);
  assert.equal(isOverdue({ ...task, dueDate: "2027-01-02" }, "2027-01-01"), false);
  assert.equal(isOverdue({ ...task, done: true, dueDate: "2026-12-31" }, "2027-01-01"), false);
});
