import { join } from "node:path";
import { createAgent } from "./agent.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore } from "./task-store.ts";
import { createTaskClock } from "./task-clock.ts";

const tasks = createJsonTaskStore(process.env.TASKS_FILE || join("data", "tasks.json"));
const clock = createTaskClock();
const reply = createAgent({ tasks, clock });
const app = createApp({ reply, tasks, clock });
const port = Number(process.env.PORT || 3000);
app.listen(port, "127.0.0.1", () => console.log(`小明智能体已启动：http://127.0.0.1:${port}`));
