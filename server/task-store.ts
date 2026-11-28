import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { dirname } from "node:path";
import { reopenParent, TaskRuleError, validateRelationships } from "./task-rules.ts";
import {
  createTaskSchema,
  storedTaskSchema,
  taskSchema,
  updateTaskSchema,
  type Task,
  type TaskAttributes,
} from "../shared/tasks.ts";

type TaskChanges = Partial<Pick<Task, "title" | "done" | "priority" | "effort">> & {
  dueDate?: string | null;
  parentId?: string | null;
};

export interface TaskStore {
  list(): Task[];
  create(
    title: string,
    dueDate?: string,
    attributes?: TaskAttributes & { parentId?: string },
  ): Task;
  update(id: string, changes: TaskChanges): Task | undefined;
  remove(id: string, cascade?: boolean): boolean;
}

export function createJsonTaskStore(filename: string): TaskStore {
  function storedTasks() {
    if (!fs.existsSync(filename)) return [];
    const tasks = storedTaskSchema.array().parse(JSON.parse(fs.readFileSync(filename, "utf8")));
    validateRelationships(tasks);
    return tasks;
  }

  // 同一服务进程内同步完成读写；替换文件前，原清单始终完整可读。
  function save(tasks: ReturnType<typeof storedTasks>) {
    fs.mkdirSync(dirname(filename), { recursive: true });
    const temporary = filename + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(tasks, null, 2) + "\n");
    fs.renameSync(temporary, filename);
  }

  return {
    list: () => storedTasks().map((task) => taskSchema.parse(task)),

    create(title, dueDate, attributes = {}) {
      const input = createTaskSchema.parse({ title, dueDate, ...attributes });
      const task: Task = {
        id: randomUUID(),
        title: input.title,
        done: false,
        priority: input.priority,
        effort: input.effort,
        ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
      };
      if (input.parentId !== undefined) task.parentId = input.parentId;
      const tasks = [...storedTasks(), task];
      validateRelationships(tasks);
      reopenParent(tasks, task);
      save(tasks);
      return task;
    },

    update(id, changes) {
      const input = updateTaskSchema.parse(changes);
      const tasks = storedTasks();
      const task = tasks.find((item) => item.id === id);
      if (!task) return undefined;

      const { parentId, ...fields } = input;
      Object.assign(
        task,
        Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
      );
      if (input.dueDate === null) delete task.dueDate;
      if (parentId === null) delete task.parentId;
      else if (parentId !== undefined) task.parentId = parentId;
      validateRelationships(tasks);
      const pending = tasks.filter((item) => item.parentId === task.id && !item.done);
      if (input.done === true && pending.length)
        throw new TaskRuleError(
          "pending_children",
          "主任务还有未完成子任务，暂时不能完成。",
          pending.map((item) => taskSchema.parse(item)),
        );
      if (input.done === false || parentId !== undefined) reopenParent(tasks, task);
      save(tasks);
      return taskSchema.parse(task);
    },

    remove(id, cascade = false) {
      const tasks = storedTasks();
      if (!tasks.some((task) => task.id === id)) return false;
      const children = tasks.filter((task) => task.parentId === id);
      if (children.length && cascade !== true)
        throw new TaskRuleError(
          "has_children",
          "这条主任务有子任务，是否连同子任务一起删除？",
          children.map((item) => taskSchema.parse(item)),
        );
      const remaining = tasks.filter((task) => task.id !== id && task.parentId !== id);

      save(remaining);
      return true;
    },
  };
}
