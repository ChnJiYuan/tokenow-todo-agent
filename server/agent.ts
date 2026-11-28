import OpenAI from "openai";
import type { ChatMessage } from "../shared/chat.ts";
import { shortTaskId, taskRows } from "../shared/task-view.ts";
import { resolveDate, type TaskDateContext } from "../shared/dates.ts";
import {
  effortLabels,
  filterTasks,
  isOverdue,
  priorityLabels,
  type Task,
} from "../shared/tasks.ts";
import { MissingModelKeyError } from "./model.ts";
import { createModelPlanner, InvalidPlanError, planSchema, type Planner } from "./planner.ts";
import type { TaskStore } from "./task-store.ts";
import { createTaskClock, type TaskClock } from "./task-clock.ts";
import { TaskRuleError } from "./task-rules.ts";

export type { ChatMessage } from "../shared/chat.ts";
class PlanningTimeoutError extends Error {}

function dueLabel(task: Task, today: string) {
  return task.dueDate ? ` · 到期 ${task.dueDate}${isOverdue(task, today) ? "（已逾期）" : ""}` : "";
}

function taskLine(task: Task, index: number, today: string, tasks: Task[]) {
  const parent = tasks.find((item) => item.id === task.parentId);
  const children = tasks.filter((item) => item.parentId === task.id);
  const context = parent ? ` · 所属：${parent.title} #${shortTaskId(parent, tasks)}` : "";
  const progress = children.length
    ? ` · 子任务 ${children.filter((child) => child.done).length}/${children.length} 完成`
    : "";
  return `${parent ? "  " : ""}${index + 1}. ${task.done ? "☑ 已完成" : "☐ 未完成"} · ${task.title} · 优先级${priorityLabels[task.priority]} · 工作量${effortLabels[task.effort]}${dueLabel(task, today)}${context}${progress}（#${shortTaskId(task, tasks)}）`;
}

function chooseMessage(tasks: Task[], candidates: Task[], today: string) {
  return `有多条可能的任务，请指定下面的“第几条”或 #编号：\n${candidates
    .map((task) =>
      taskLine(
        task,
        tasks.findIndex((item) => item.id === task.id),
        today,
        tasks,
      ),
    )
    .join("\n")}`;
}

// 同名任务不能靠模型随意选 ID；只有当前请求中的明确编号可以消除歧义。
function explicitPositions(message: string) {
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
  return [...message.matchAll(/第\s*(\d+|[一二三四五六七八九十两]+)\s*[条个项]/g)].map((match) => {
    const number = match[1];
    const [tens, units] = number.split("十");
    return /^\d+$/.test(number)
      ? Number(number)
      : number.includes("十")
        ? (digits[tens] || 1) * 10 + (digits[units] || 0)
        : digits[number];
  });
}

function referencedTask(reference: string, tasks: Task[]) {
  const exact = tasks.find((task) => task.id === reference);
  if (exact) return exact;
  const matches = tasks.filter((task) => task.id.startsWith(reference));
  return matches.length === 1 ? matches[0] : undefined;
}

function explicitlySelects(messages: ChatMessage[], task: Task, tasks: Task[]) {
  const message = messages.at(-1)!.content;
  // 旧ID可能很短，不能把标题里碰巧出现的一个字符当成用户指定完整ID。
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(task.id) && message.includes(task.id))
    return true;
  if (
    [...message.matchAll(/#([a-zA-Z0-9-]+)/g)].some(
      (match) => referencedTask(match[1], tasks)?.id === task.id,
    )
  )
    return true;
  return explicitPositions(message).length > 0 && matchesDisplayedPosition(messages, task, tasks);
}

// 清单编号可能因删除而变化。上轮展示的编号必须仍然指向本轮选择的 ID。
function matchesDisplayedPosition(messages: ChatMessage[], task: Task, tasks: Task[]) {
  const positions = explicitPositions(messages.at(-1)!.content);
  if (!positions.length) return true;
  for (const message of messages.slice(0, -1).reverse()) {
    if (message.role !== "assistant") continue;
    const lines = [...message.content.matchAll(/^\s*(\d+)\. .*（#([a-zA-Z0-9-]+)）$/gm)];
    if (!lines.length) continue;
    // 肯否定语义由规划器判断；执行器检查所选ID是否对应用户提及的某个编号。
    // 标题换行伪造同号列表行时，必须是唯一映射，不能随意挑一条引用。
    return positions.some((position) => {
      const references = [
        ...new Set(lines.filter((line) => Number(line[1]) === position).map((line) => line[2])),
      ];
      return references.length === 1 && referencedTask(references[0], tasks)?.id === task.id;
    });
  }
  return positions.some((position) => tasks[position - 1]?.id === task.id);
}

function resolveTarget(
  messages: ChatMessage[],
  current: Task[],
  ids: string[],
  today: string,
  scope = current,
  checkReference = true,
) {
  const unique = [...new Set(ids)];
  if (!unique.length)
    return { message: "没有找到对应的任务，本轮没有修改任务。请告诉我清单中的任务名称或 #编号。" };
  const candidates = scope.filter((task) => unique.includes(task.id));
  if (candidates.length !== unique.length)
    return {
      message: "目标任务已不存在、父子关系不符或编号无效，本轮没有修改任务。请重新查看清单。",
    };
  if (candidates.length > 1) return { message: chooseMessage(current, candidates, today) };
  const task = candidates[0];
  if (checkReference && !matchesDisplayedPosition(messages, task, current))
    return {
      message:
        "之前清单的编号已变化或与目标不符，本轮没有修改任务。请重新查看清单，或使用 #编号指定任务。",
    };
  const duplicates = scope.filter((item) => item.title === task.title);
  if (duplicates.length > 1 && !explicitlySelects(messages, task, current))
    return { message: chooseMessage(current, duplicates, today) };
  const references = [...messages.at(-1)!.content.matchAll(/#([a-zA-Z0-9-]+)/g)];
  if (
    checkReference &&
    references.length &&
    !references.some((match) => referencedTask(match[1], current)?.id === task.id)
  )
    return { message: "指定的 #编号无效、有歧义或与目标不符，本轮没有修改任务。请重新查看清单。" };
  return { task };
}

// 级联删除还需核对本轮明确授权，不能仅信任模型的 cascade 字段。
function authorizesCascade(messages: ChatMessage[], task: Task, current: Task[]) {
  let text = messages.at(-1)!.content;
  for (const [open, close] of [
    ["“", "”"],
    ["「", "」"],
    ["『", "』"],
    ["'", "'"],
    ['"', '"'],
  ])
    text = text.replaceAll(`${open}${task.title}${close}`, "目标任务");
  text = text.replaceAll(task.title, "目标任务");
  if (
    /[不别勿否没]|取消|暂缓|先放|保留|只删|如果|假如|要是|怎么|如何|是否|能否|吗|解释|讨论|举例|原文|标题|假设|记录|记下|[？?'‘’"“”「」『』`]/.test(
      text,
    )
  )
    return false;
  if (/子任务/.test(text) && /一起|一并|连同|全部|所有/.test(text) && /删除|删掉|移除/.test(text))
    return true;
  const previous = messages.at(-2);
  return (
    previous?.role === "assistant" &&
    previous.content.startsWith(`删除确认：（#${shortTaskId(task, current)}）`) &&
    /^(?:确认|同意|好的)?[，,\s]*(?:(?:一起|一并|全部)(?:删除|删掉)|连同子任务删除)(?:\s*#[a-zA-Z0-9-]+)?[。！!\s]*$/.test(
      text,
    )
  );
}

export function createAgent({
  tasks,
  planner = createModelPlanner(),
  planningTimeoutMs = 25_000,
  clock = createTaskClock(),
}: {
  tasks: TaskStore;
  planner?: Planner;
  planningTimeoutMs?: number;
  clock?: TaskClock;
}) {
  return async function reply(messages: ChatMessage[]): Promise<string> {
    let snapshot: Task[];
    let dateContext: TaskDateContext;
    try {
      snapshot = taskRows(tasks.list()).map(({ task }) => task);
      dateContext = clock();
    } catch {
      return "读取任务清单失败，请检查本地任务文件和读取权限后再试。";
    }

    let plan;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 每轮一个规划阶段（空白/非法JSON最多重试一次）；总超时后取消请求且不能写入。
      const output = await Promise.race([
        planner({ messages, tasks: snapshot, dateContext, signal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new PlanningTimeoutError());
          }, planningTimeoutMs);
        }),
      ]);
      const parsed = planSchema.safeParse(output);
      if (!parsed.success) {
        if (parsed.error.issues.some((issue) => issue.path[0] === "dueDate"))
          return "到期日期无效，请使用真实的 YYYY-MM-DD 日期，或说明今天、明天等相对日期。本轮没有修改任务。";
        if (
          parsed.error.issues.some(
            (issue) =>
              issue.path[0] === "title" && (issue.code === "too_big" || issue.code === "too_small"),
          )
        ) {
          return "请把任务标题控制在 1 至 200 个字符内，再告诉我要记录的事项。";
        }
        throw new InvalidPlanError();
      }
      plan = parsed.data;
      // 相对日期在请求开始时的同一服务端日期上解析，规划跨午夜也不会漂移。
      if ("dueDate" in plan && plan.dueDate != null) {
        try {
          plan.dueDate = resolveDate(plan.dueDate, dateContext.today);
        } catch {
          return "到期日期超出支持范围（0001-01-01 至 9999-12-31），本轮没有修改任务。";
        }
      }
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
      controller.abort();
    }

    try {
      if (plan.action === "help")
        return "我可以帮你创建、查看、完成、删除主任务和一级子任务，修改优先级、工作量及到期日期。试试“给准备面试加个子任务：整理项目介绍”或“看看高优先级任务”。工作量是粗略估计；到期日期不发送通知。";
      if (plan.action === "reminder")
        return "目前只能记录到期日期，不能在指定时间提醒或发送通知。你希望只记录任务及到期日期吗？";
      if (plan.action === "clarify") return plan.question;
      const current = taskRows(tasks.list()).map(({ task }) => task);
      if (
        (plan.action !== "list" || plan.parentIds !== undefined) &&
        JSON.stringify(current) !== JSON.stringify(snapshot)
      )
        return "任务清单在处理期间发生了变化，本轮没有修改任务。请重新查看清单后再操作。";
      let parent: Task | undefined;
      if ("parentIds" in plan && plan.parentIds !== undefined) {
        const resolved = resolveTarget(
          messages,
          current,
          plan.parentIds,
          dateContext.today,
          current.filter((item) => !item.parentId),
          plan.action === "create" || plan.action === "list",
        );
        if (!resolved.task) return resolved.message!;
        parent = resolved.task;
      }
      if (plan.action === "create") {
        const attributes = {
          ...(plan.priority === undefined ? {} : { priority: plan.priority }),
          ...(plan.effort === undefined ? {} : { effort: plan.effort }),
          ...(parent ? { parentId: parent.id } : {}),
        };
        const task = tasks.create(plan.title, plan.dueDate, attributes);
        if (parent)
          return `已添加子任务：${task.title}（未完成，#${shortTaskId(task, [...current, task])}），所属主任务：${parent.title}（#${shortTaskId(parent, current)}）。${parent.done ? "主任务已恢复为未完成。" : ""}`;
        return `已添加待办：${task.title}（未完成 · 优先级${priorityLabels[task.priority]} · 工作量${effortLabels[task.effort]}${dueLabel(task, dateContext.today)}，#${shortTaskId(task, [...current, task])}）。`;
      }
      if (plan.action === "list") {
        const selectedIds = new Set(
          filterTasks(current, { ...plan, ...(parent ? { parentId: parent.id } : {}) }).map(
            (task) => task.id,
          ),
        );
        const selected = taskRows(current, plan.sort).filter(({ task }) =>
          selectedIds.has(task.id),
        );
        const lines = selected
          .map(({ task, position }) => taskLine(task, position - 1, dateContext.today, current))
          .join("\n");
        if (parent) {
          const children = current.filter((item) => item.parentId === parent.id);
          return `“${parent.title}”（#${shortTaskId(parent, current)}）的子任务：${children.filter((item) => item.done).length}/${children.length} 完成，本次显示 ${selected.length} 条。${lines ? "\n" + lines : "没有符合条件的子任务。"}`;
        }
        if (plan.dueDate) {
          const status = plan.status ?? "pending";
          const label =
            status === "all"
              ? "全部任务（含已完成）"
              : status === "done"
                ? "已完成任务"
                : "未完成任务";
          const heading = `${plan.dueDate} 到期的${label}`;
          return selected.length
            ? `${heading}：共 ${selected.length} 条。\n${lines}`
            : `没有 ${heading}。`;
        }
        if (!current.length) return "清单还是空的。可以说“帮我记一下买牛奶”添加第一条任务。";
        if (!selected.length)
          return plan.priority || plan.effort
            ? "没有符合这些条件的任务。"
            : plan.status === "done"
              ? "还没有已完成的任务。"
              : "所有任务都已完成。";
        const done = current.filter((task) => task.done).length;
        return `任务清单：共 ${current.length} 条，未完成 ${current.length - done} 条，已完成 ${done} 条；本次显示 ${selected.length} 条。\n${lines}`;
      }

      if (JSON.stringify(current) !== JSON.stringify(snapshot))
        return "任务清单在处理期间发生了变化，本轮没有修改任务。请重新查看清单后再操作。";
      const resolved = resolveTarget(
        messages,
        current,
        plan.taskIds,
        dateContext.today,
        parent ? current.filter((item) => item.parentId === parent.id) : current,
      );
      if (!resolved.task) return resolved.message!;
      const task = resolved.task;
      if (plan.action === "update_attributes") {
        const updated = tasks.update(task.id, plan.changes);
        if (!updated) return "这条任务已不存在，请重新查看清单。";
        return `已修改属性：${updated.title} · 优先级${priorityLabels[updated.priority]} · 工作量${effortLabels[updated.effort]}（#${shortTaskId(updated, current)}）。`;
      }
      if (plan.action === "set_due_date") {
        if ((task.dueDate ?? null) === plan.dueDate)
          return plan.dueDate === null
            ? `“${task.title}”没有到期日期，无需清除。`
            : `“${task.title}”的到期日期已经是 ${plan.dueDate}，无需修改。`;
        const updated = tasks.update(task.id, { dueDate: plan.dueDate });
        if (!updated) return "这条任务已不存在，请重新查看清单。";
        return plan.dueDate === null
          ? `已清除到期日期：${updated.title}（#${shortTaskId(updated, current)}）。`
          : `已修改到期日期：${updated.title}${dueLabel(updated, dateContext.today)}（#${shortTaskId(updated, current)}）。`;
      }
      if (plan.action === "complete") {
        if (task.done) return `“${task.title}”已经完成，无需重复标记。`;
        const updated = tasks.update(task.id, { done: true });
        if (!updated) return "这条任务已不存在，请重新查看清单。";
        return `已完成：${updated.title}（#${shortTaskId(updated, current)}）。`;
      }
      const children = current.filter((item) => item.parentId === task.id);
      const cascade = plan.cascade === true && authorizesCascade(messages, task, current);
      if (children.length && !cascade)
        return `删除确认：（#${shortTaskId(task, current)}）“${task.title}”有 ${children.length} 条子任务，是否一并删除？本轮没有修改任务。请回复“确认一并删除 #${shortTaskId(task, current)}”。`;
      if (!tasks.remove(task.id, cascade)) return "这条任务已不存在，请重新查看清单。";
      return `已删除：${task.title}（#${shortTaskId(task, current)}）。${children.length ? `已一并删除 ${children.length} 条子任务。` : ""}`;
    } catch (error) {
      if (error instanceof TaskRuleError) {
        const current = taskRows(tasks.list()).map(({ task }) => task);
        return `${error.message}${
          error.relatedTasks.length
            ? "\n" +
              error.relatedTasks
                .map((task) =>
                  taskLine(
                    task,
                    current.findIndex((item) => item.id === task.id),
                    dateContext.today,
                    current,
                  ),
                )
                .join("\n")
            : ""
        }`;
      }
      return "任务存储操作失败，请检查本地文件和读写权限。结果可能不确定，请先查看清单再决定是否重试。";
    }
  };
}
