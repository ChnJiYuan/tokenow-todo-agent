import { useEffect, useState } from "react";
import { taskListSchema, type Task } from "../shared/tasks.ts";

type Filter = "all" | "pending" | "done";
const filters: { value: Filter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "pending", label: "未完成" },
  { value: "done", label: "已完成" },
];

export function TaskPanel({ version }: { version: number }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [reload, setReload] = useState(0);

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
        if (!controller.signal.aborted) setTasks(data);
      } catch {
        if (!controller.signal.aborted) setError("清单读取失败，请检查服务后刷新清单。");
      }
    }
    void load();
    return () => controller.abort();
  }, [version, reload]);

  const done = tasks?.filter((task) => task.done).length ?? 0;
  const visible = tasks?.filter((task) =>
    filter === "all" ? true : filter === "done" ? task.done : !task.done,
  );
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
        {visible?.map((task) => (
          <li key={task.id} className={task.done ? "task-done" : ""}>
            <span className="task-title">{task.title}</span>
            <small>
              {task.done ? "已完成" : "未完成"} · #{task.id.slice(0, 8)}
            </small>
          </li>
        ))}
      </ol>
      <p className="task-note">通过聊天添加、完成或删除任务。任务保存在本地；刷新只会清空对话。</p>
    </aside>
  );
}
