import OpenAI from "openai";
import type { ChatMessage } from "../shared/chat.ts";
import type { Task } from "../shared/tasks.ts";
import { MissingModelKeyError } from "./model.ts";
import { createModelPlanner, InvalidPlanError, planSchema, type Planner } from "./planner.ts";
import type { TaskStore } from "./task-store.ts";

export type { ChatMessage } from "../shared/chat.ts";
class PlanningTimeoutError extends Error {}

function taskLine(task: Task, index: number) {
  return `${index + 1}. ${task.done ? "☑ 已完成" : "☐ 未完成"} · ${task.title}（#${task.id.slice(0, 8)}）`;
}

function chooseMessage(tasks: Task[], candidates: Task[]) {
  return `有多条可能的任务，请指定下面的“第几条”或 #编号：\n${candidates
    .map((task) =>
      taskLine(
        task,
        tasks.findIndex((item) => item.id === task.id),
      ),
    )
    .join("\n")}`;
}

// 同名任务不能靠模型随意选 ID；只有当前请求中的明确编号可以消除歧义。
function explicitPosition(message: string) {
  const match = message.match(/第\s*(\d+|[一二三四五六七八九十两]+)\s*[条个项]/);
  if (!match) return undefined;
  const number = match[1];
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const [tens, units] = number.split("十");
  return /^\d+$/.test(number)
    ? Number(number)
    : number.includes("十")
      ? (digits[tens] || 1) * 10 + (digits[units] || 0)
      : digits[number];
}

function explicitlySelects(message: string, task: Task, tasks: Task[]) {
  if (message.includes(task.id)) return true;
  if (message.includes(`#${task.id.slice(0, 8)}`))
    return tasks.filter((item) => item.id.startsWith(task.id.slice(0, 8))).length === 1;
  return tasks[(explicitPosition(message) ?? 0) - 1]?.id === task.id;
}

// 清单编号可能因删除而变化。上轮展示的编号必须仍然指向本轮选择的 ID。
function matchesDisplayedPosition(messages: ChatMessage[], task: Task) {
  const position = explicitPosition(messages.at(-1)!.content);
  if (position === undefined) return true;
  for (const message of messages.slice(0, -1).reverse()) {
    if (message.role !== "assistant") continue;
    const lines = [...message.content.matchAll(/^(\d+)\. .*（#([a-zA-Z0-9-]+)）$/gm)];
    if (!lines.length) continue;
    const reference = lines.find((line) => Number(line[1]) === position)?.[2];
    return reference !== undefined && task.id.startsWith(reference);
  }
  return true;
}

export function createAgent({
  tasks,
  planner = createModelPlanner(),
  planningTimeoutMs = 25_000,
}: {
  tasks: TaskStore;
  planner?: Planner;
  planningTimeoutMs?: number;
}) {
  return async function reply(messages: ChatMessage[]): Promise<string> {
    let snapshot: Task[];
    try {
      snapshot = tasks.list();
    } catch {
      return "读取任务清单失败，请检查本地任务文件和读取权限后再试。";
    }

    let plan;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 每轮最多一次规划；超时后即使模型稍后返回，也没有执行写入的机会。
      const output = await Promise.race([
        planner({ messages, tasks: snapshot }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new PlanningTimeoutError()), planningTimeoutMs);
        }),
      ]);
      const parsed = planSchema.safeParse(output);
      if (!parsed.success) throw new InvalidPlanError();
      plan = parsed.data;
    } catch (error) {
      if (error instanceof MissingModelKeyError)
        return "尚未配置模型密钥。请在本地 .env 中设置 DEEPSEEK_API_KEY 后重启服务；当前没有修改任务。";
      if (
        error instanceof PlanningTimeoutError ||
        error instanceof OpenAI.APIConnectionTimeoutError
      )
        return "模型响应超时，本轮没有修改任务。请稍后重新发送。";
      if (error instanceof InvalidPlanError)
        return "模型返回的操作格式无效，本轮没有修改任务。请换一种说法重试。";
      if (error instanceof OpenAI.AuthenticationError)
        return "模型密钥验证失败，请检查本地 DEEPSEEK_API_KEY。本轮没有修改任务。";
      return "暂时无法连接模型，本轮没有修改任务。请检查网络、模型配置和账户额度后重试。";
    } finally {
      clearTimeout(timer);
    }

    try {
      if (plan.action === "help")
        return "我可以帮你创建、查看、完成和删除待办。试试“帮我记一下买牛奶”或“看看我的清单”。";
      if (plan.action === "clarify") return plan.question;
      if (plan.action === "create") {
        const task = tasks.create(plan.title);
        return `已添加待办：${task.title}（未完成，#${task.id.slice(0, 8)}）。`;
      }
      // 查询和写入前重新读取，不能把模型规划前的快照当成最新状态。
      const current = tasks.list();
      if (plan.action === "list") {
        const selected = current.filter((task) =>
          plan.status === "all" ? true : plan.status === "done" ? task.done : !task.done,
        );
        if (!current.length) return "清单还是空的。可以说“帮我记一下买牛奶”添加第一条任务。";
        if (!selected.length)
          return plan.status === "done" ? "还没有已完成的任务。" : "所有任务都已完成。";
        const done = current.filter((task) => task.done).length;
        return `任务清单：共 ${current.length} 条，未完成 ${current.length - done} 条，已完成 ${done} 条。\n${selected
          .map((task) =>
            taskLine(
              task,
              current.findIndex((item) => item.id === task.id),
            ),
          )
          .join("\n")}`;
      }

      if (JSON.stringify(current) !== JSON.stringify(snapshot))
        return "任务清单在处理期间发生了变化，本轮没有修改任务。请重新查看清单后再操作。";
      const ids = [...new Set(plan.taskIds)];
      if (!ids.length)
        return "没有找到对应的任务，本轮没有修改任务。请告诉我清单中的任务名称或 #编号。";
      const candidates = current.filter((task) => ids.includes(task.id));
      if (candidates.length !== ids.length)
        return "目标任务已不存在或编号无效，本轮没有修改任务。请重新查看清单。";
      if (candidates.length > 1) return chooseMessage(current, candidates);
      const task = candidates[0];
      if (!matchesDisplayedPosition(messages, task))
        return "之前清单的编号已变化或与目标不符，本轮没有修改任务。请重新查看清单，或使用 #编号指定任务。";
      const duplicates = current.filter((item) => item.title === task.title);
      if (duplicates.length > 1 && !explicitlySelects(messages.at(-1)!.content, task, current))
        return chooseMessage(current, duplicates);
      if (plan.action === "complete") {
        if (task.done) return `“${task.title}”已经完成，无需重复标记。`;
        const updated = tasks.update(task.id, { done: true });
        if (!updated) return "这条任务已不存在，请重新查看清单。";
        return `已完成：${updated.title}（#${updated.id.slice(0, 8)}）。`;
      }
      if (!tasks.remove(task.id)) return "这条任务已不存在，请重新查看清单。";
      return `已删除：${task.title}（#${task.id.slice(0, 8)}）。`;
    } catch {
      return "任务存储操作失败，请检查本地文件和读写权限。结果可能不确定，请先查看清单再决定是否重试。";
    }
  };
}
