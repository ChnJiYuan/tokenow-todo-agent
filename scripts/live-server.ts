import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

// 两套真实验收复用生产入口和隔离数据，不占用开发服务的3000端口。
export async function createLiveServer() {
  const directory = await mkdtemp(join(tmpdir(), "xiaoming-live-"));
  const filename = join(directory, "tasks.json");
  let child: ChildProcess | undefined;
  let base = "";

  async function stop() {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    child = undefined;
  }

  async function start() {
    const probe = createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--env-file-if-exists=.env", "server/index.ts"], {
      env: { ...process.env, PORT: String(port), TASKS_FILE: filename },
      stdio: ["ignore", "ignore", "inherit"],
    });
    let failure: Error | undefined;
    child.once("error", (error) => {
      failure = error;
    });
    for (let count = 0; count < 100; count++) {
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error("服务启动失败。");
      try {
        if ((await fetch(base + "/api/tasks")).ok) return;
      } catch {
        /* 等待启动 */
      }
      await setTimeout(100);
    }
    throw new Error("等待服务启动超时。");
  }

  return {
    filename,
    get base() {
      return base;
    },
    start,
    stop,
    async dispose() {
      await stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
