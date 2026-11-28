import type { Task } from "./tasks.ts";

// 聊天、规划快照和面板共用顺序；筛选保留全局编号。
export function taskRows(tasks: Task[], sort: "created" | "priority" = "created") {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const children = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.parentId) {
      const siblings = children.get(task.parentId) ?? [];
      siblings.push(task);
      children.set(task.parentId, siblings);
    }
  }
  const canonical = tasks
    .filter((task) => !task.parentId)
    .flatMap((task) => [task, ...(children.get(task.id) ?? [])]);
  const ranks = { high: 0, medium: 1, low: 2 };
  // 父子始终相邻；优先级只在主任务之间及同父子任务之间排序，保留原编号。
  const sorted =
    sort === "priority"
      ? canonical.toSorted((a, b) => ranks[a.priority] - ranks[b.priority])
      : canonical;
  const ordered = sorted
    .filter((task) => !task.parentId)
    .flatMap((task) => [task, ...sorted.filter((child) => child.parentId === task.id)]);
  return ordered.map((task) => {
    const subtasks = children.get(task.id) ?? [];
    return {
      task,
      position: canonical.findIndex((item) => item.id === task.id) + 1,
      parent: task.parentId ? byId.get(task.parentId) : undefined,
      totalChildren: subtasks.length,
      doneChildren: subtasks.filter((child) => child.done).length,
    };
  });
}

export function shortTaskId(task: Task, tasks: Task[]) {
  let length = Math.min(8, task.id.length);
  while (
    length < task.id.length &&
    tasks.some((other) => other.id !== task.id && other.id.startsWith(task.id.slice(0, length)))
  )
    length++;
  return task.id.slice(0, length);
}
