import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { taskFixture } from "./test-support.ts";
import { createJsonTaskStore } from "./task-store.ts";

test("写入临时文件失败时原JSON保持完整", async (t) => {
  const { filename, tasks } = await taskFixture(t);
  const task = tasks.create("买牛奶");
  const before = await readFile(filename, "utf8");
  await mkdir(filename + ".tmp");
  assert.throws(() => tasks.update(task.id, { done: true }));
  assert.equal(await readFile(filename, "utf8"), before);
  assert.deepEqual(tasks.list(), [task]);
});

test("旧数据不补日期；修改、清除和重读到期日期保留其他扩展字段", async (t) => {
  const { filename, tasks } = await taskFixture(t);
  const stored = {
    id: "old",
    title: "旧任务",
    done: false,
    customPriority: 1,
    custom: { tags: ["保留"] },
  };
  const legacy = { ...stored, priority: "medium", effort: "medium" };
  await writeFile(filename, JSON.stringify([stored]));
  assert.deepEqual(tasks.list(), [legacy]);
  const dated = tasks.create("买牛奶", "2026-12-31");
  assert.deepEqual(tasks.update("old", { dueDate: "2027-01-01" }), {
    ...legacy,
    dueDate: "2027-01-01",
  });
  tasks.update("old", { done: true });
  assert.equal(tasks.list()[0].dueDate, "2027-01-01");
  assert.deepEqual(tasks.update("old", { dueDate: null }), { ...legacy, done: true });
  const reopened = createJsonTaskStore(filename);
  assert.deepEqual(reopened.list(), [{ ...legacy, done: true }, dated]);
  assert.equal(Object.hasOwn(reopened.list()[0], "dueDate"), false);
});

test("存储边界同样拒绝非法日期和未知修改字段，不改变文件；非法已有日期不被覆盖", async (t) => {
  const { filename, tasks } = await taskFixture(t);
  const task = tasks.create("买牛奶", "2026-12-31");
  const before = await readFile(filename, "utf8");
  for (const dueDate of ["2026-02-30", "2026-12-31T09:00:00Z", "tomorrow", ""]) {
    assert.throws(() => tasks.create("非法", dueDate));
    assert.throws(() => tasks.update(task.id, { dueDate }));
    assert.equal(await readFile(filename, "utf8"), before);
  }
  assert.throws(() => tasks.update(task.id, { extra: true } as never));
  assert.equal(await readFile(filename, "utf8"), before);
  const corrupt = JSON.stringify([{ ...task, dueDate: "2026-02-30" }]);
  await writeFile(filename, corrupt);
  assert.throws(() => tasks.list());
  assert.throws(() => tasks.create("不能覆盖坏数据"));
  assert.equal(await readFile(filename, "utf8"), corrupt);
});
