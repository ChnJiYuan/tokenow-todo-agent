import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { taskFixture } from "./test-support.ts";

test("生产入口真实进程重启后任务仍可读取（无模型调用）", async (t) => {
  const { filename } = await taskFixture(t);
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  async function stop() {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    child = undefined;
  }
  t.after(stop);
  async function start() {
    child = spawn(process.execPath, ["server/index.ts"], {
      env: { ...process.env, PORT: String(port), TASKS_FILE: filename, DEEPSEEK_API_KEY: "" },
      stdio: ["ignore", "ignore", "inherit"],
    });
    let failure: Error | undefined;
    child.once("error", (error) => {
      failure = error;
    });
    for (let count = 0; count < 100; count++) {
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error("服务启动失败");
      try {
        if ((await fetch(base + "/api/tasks")).ok) return;
      } catch {
        /* 等待启动 */
      }
      await setTimeout(50);
    }
    throw new Error("服务启动超时");
  }
  await start();
  assert.equal((await fetch(base + "/")).status, 200);
  const created = await fetch(base + "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "买牛奶" }),
  });
  assert.equal(created.status, 201);
  const task = await created.json();
  await fetch(base + `/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ done: true }),
  });
  await stop();
  await start();
  assert.deepEqual(await (await fetch(base + "/api/tasks")).json(), [{ ...task, done: true }]);
  const response = await fetch(base + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "看看清单" }] }),
  });
  assert.match((await response.json()).reply, /尚未配置模型密钥/);
  assert.deepEqual(await (await fetch(base + "/api/tasks")).json(), [{ ...task, done: true }]);
});
