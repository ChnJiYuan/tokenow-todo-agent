import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { createApp } from "./app.ts";
import { createAgent } from "./agent.ts";
import type { Planner } from "./planner.ts";
import { createJsonTaskStore } from "./task-store.ts";
import type { TaskClock } from "./task-clock.ts";

export async function taskFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "xiaoming-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  return { filename, tasks: createJsonTaskStore(filename) };
}

export async function httpFixture(
  t: TestContext,
  filename: string,
  planner: Planner,
  clock?: TaskClock,
) {
  const tasks = createJsonTaskStore(filename);
  const server = createApp({ tasks, clock, reply: createAgent({ tasks, planner, clock }) }).listen(
    0,
    "127.0.0.1",
  );
  const close = async () => {
    if (server.listening) await server[Symbol.asyncDispose]();
  };
  t.after(close);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  async function chat(messages: ChatMessage[], key?: string) {
    return fetch(base + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
      body: JSON.stringify({ messages }),
    });
  }
  return { tasks, base, chat, close };
}
