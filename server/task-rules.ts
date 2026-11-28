import type { Task } from "../shared/tasks.ts";

export class TaskRuleError extends Error {
  code: "invalid_parent" | "pending_children" | "has_children";
  relatedTasks: Task[];
  constructor(
    code: "invalid_parent" | "pending_children" | "has_children",
    message: string,
    relatedTasks: Task[] = [],
  ) {
    super(message);
    this.code = code;
    this.relatedTasks = relatedTasks;
  }

  get status() {
    return this.code === "invalid_parent" ? 400 : 409;
  }
}

export function validateRelationships(tasks: { id: string; parentId?: string }[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length)
    throw new TaskRuleError("invalid_parent", "任务 ID 重复，请修复任务文件。");
  for (const task of tasks) {
    if (!task.parentId) continue;
    const parent = byId.get(task.parentId);
    if (!parent || parent.id === task.id || parent.parentId)
      throw new TaskRuleError(
        "invalid_parent",
        "父任务必须是已存在的主任务，不能自引用、形成循环或创建更深层级。",
      );
  }
}

export function reopenParent(
  tasks: { id: string; done: boolean }[],
  task: { parentId?: string; done: boolean },
) {
  if (task.parentId && !task.done) tasks.find((item) => item.id === task.parentId)!.done = false;
}
