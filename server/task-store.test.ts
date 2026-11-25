import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { taskFixture } from "./test-support.ts";

test("写入临时文件失败时原JSON保持完整", async (t) => {
  const { filename, tasks } = await taskFixture(t);
  const task = tasks.create("买牛奶");
  const before = await readFile(filename, "utf8");
  await mkdir(filename + ".tmp");
  assert.throws(() => tasks.update(task.id, { done: true }));
  assert.equal(await readFile(filename, "utf8"), before);
  assert.deepEqual(tasks.list(), [task]);
});
