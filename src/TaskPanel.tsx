import { useEffect, useState } from "react";
import { shortTaskId, taskRows } from "../shared/task-view.ts";
import { taskDateContextSchema, type TaskDateContext } from "../shared/dates.ts";
import {
  effortLabels,
  effortSchema,
  filterTasks,
  isOverdue,
  priorityLabels,
  prioritySchema,
  taskListSchema,
  type Task,
} from "../shared/tasks.ts";

type Filter = "all" | "pending" | "done" | "today";
const filters: { value: Filter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "pending", label: "未完成" },
  { value: "done", label: "已完成" },
  { value: "today", label: "今日到期" },
];

export function TaskPanel({ version }: { version: number }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [priority, setPriority] = useState<Task["priority"] | "all">("all");
  const [effort, setEffort] = useState<Task["effort"] | "all">("all");
  const [priorityFirst, setPriorityFirst] = useState(false);
  const [reload, setReload] = useState(0);
  const [dateContext, setDateContext] = useState<TaskDateContext | null>(null);

  useEffect(() => {
    // 持续打开页面时也刷新服务端日期，不依据浏览器时区判断今天。
    const refresh = () => setReload((value) => value + 1);
    const interval = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setTasks(null);
    async function load() {
      try {
        const response = await fetch("/api/tasks", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("读取失败");
        const data = taskListSchema.parse(await response.json());
        const context = taskDateContextSchema.parse({
          today: response.headers.get("X-Task-Today"),
          timeZone: response.headers.get("X-Task-Time-Zone"),
        });
        if (!controller.signal.aborted) {
          setTasks(data);
          setDateContext(context);
        }
      } catch {
        if (!controller.signal.aborted) setError("清单读取失败，请检查服务后刷新清单。");
      }
    }
    void load();
    return () => controller.abort();
  }, [version, reload]);

  const done = tasks?.filter((task) => task.done).length ?? 0;
  const matched =
    tasks && dateContext
      ? filterTasks(tasks, {
          ...(filter === "today" ? { dueDate: dateContext.today } : { status: filter }),
          ...(priority === "all" ? {} : { priority }),
          ...(effort === "all" ? {} : { effort }),
          sort: priorityFirst ? "priority" : "created",
        })
      : null;
  const visible =
    tasks && matched
      ? taskRows(tasks, priorityFirst ? "priority" : "created").filter(({ task }) =>
          matched.some((item) => item.id === task.id),
        )
      : null;
  return (
    <aside className="task-panel" aria-label="任务清单">
      <div className="task-heading">
        <h2>我的清单</h2>
        <button type="button" onClick={() => setReload((value) => value + 1)}>
          刷新清单
        </button>
      </div>
      <p className="task-summary" aria-live="polite">
        {tasks
          ? `未完成 ${tasks.length - done} · 已完成 ${done} · 共 ${tasks.length} 条`
          : error
            ? "暂时无法读取清单"
            : "正在读取清单…"}
      </p>
      {dateContext && (
        <p className="task-date-context">
          今天 {dateContext.today} · {dateContext.timeZone}
        </p>
      )}
      <div className="task-filters" aria-label="筛选任务">
        {filters.map(({ value, label }) => (
          <button
            type="button"
            key={value}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="task-attribute-filters">
        <label>
          优先级
          <select
            value={priority}
            onChange={(event) =>
              setPriority(
                event.target.value === "all" ? "all" : prioritySchema.parse(event.target.value),
              )
            }
          >
            <option value="all">全部优先级</option>
            {prioritySchema.options.map((value) => (
              <option key={value} value={value}>
                {priorityLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          工作量
          <select
            value={effort}
            onChange={(event) =>
              setEffort(
                event.target.value === "all" ? "all" : effortSchema.parse(event.target.value),
              )
            }
          >
            <option value="all">全部工作量</option>
            {effortSchema.options.map((value) => (
              <option key={value} value={value}>
                {effortLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="task-sort">
          <input
            type="checkbox"
            checked={priorityFirst}
            onChange={(event) => setPriorityFirst(event.target.checked)}
          />
          高优先级优先
        </label>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {visible?.length === 0 && (
        <p className="task-empty">
          {tasks?.length ? "这个分类里还没有任务。" : "清单是空的，和小明聊聊要做的事吧。"}
        </p>
      )}
      <ol className="task-list">
        {visible?.map(({ task, position, parent, doneChildren, totalChildren }) => (
          <li
            key={task.id}
            value={position}
            data-task-id={task.id}
            className={`${task.done ? "task-done" : ""}${parent ? " task-child" : ""}`}
          >
            <span className="task-number">{position}. </span>
            <span className="task-title">{task.title}</span>
            <small>
              {task.done ? "已完成" : "未完成"} · #{shortTaskId(task, tasks!)}
            </small>
            {parent && (
              <small className="task-parent">
                所属：{parent.title} · #{shortTaskId(parent, tasks!)}
              </small>
            )}
            {totalChildren > 0 && (
              <small className="task-progress">
                子任务 {doneChildren}/{totalChildren} 完成
              </small>
            )}
            <small className="task-attributes">
              <span className={`task-priority task-priority-${task.priority}`}>
                优先级{priorityLabels[task.priority]}
              </span>
              <span>工作量{effortLabels[task.effort]}</span>
            </small>
            {task.dueDate && (
              <small
                className={dateContext && isOverdue(task, dateContext.today) ? "task-overdue" : ""}
              >
                到期 <time dateTime={task.dueDate}>{task.dueDate}</time>
                {dateContext && isOverdue(task, dateContext.today) ? " · 已逾期" : ""}
              </small>
            )}
          </li>
        ))}
      </ol>
      <p className="task-note">
        今日到期只显示未完成任务。工作量是用户指定的粗略估计，不代表固定工时。通过聊天管理主任务、一级子任务、属性及到期日期；仅记录日期，不发送通知。编号在筛选和排序后保留，优先使用
        #编号定位。主任务需明确完成；删除含子任务的主任务需确认一并删除。任务保存在本地；刷新只会清空对话。
      </p>
    </aside>
  );
}
