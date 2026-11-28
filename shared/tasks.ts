import { z } from "zod";
import { dateSchema } from "./dates.ts";

export const titleSchema = z.string().trim().min(1).max(200);
const parentIdSchema = z.string().trim().min(1);
export const prioritySchema = z.enum(["high", "medium", "low"]);
export const effortSchema = z.enum(["small", "medium", "large"]);
const optionalAttributes = {
  priority: prioritySchema.optional(),
  effort: effortSchema.optional(),
};
export const taskAttributesSchema = z
  .strictObject(optionalAttributes)
  .refine((changes) => Object.values(changes).some((value) => value !== undefined));
export type TaskAttributes = z.infer<typeof taskAttributesSchema>;
export const priorityLabels = { high: "高", medium: "中", low: "低" } as const;
export const effortLabels = { small: "小", medium: "中", large: "大" } as const;

export const createTaskSchema = z.strictObject({
  title: titleSchema,
  parentId: parentIdSchema.optional(),
  dueDate: dateSchema.optional(),
  priority: prioritySchema.default("medium"),
  effort: effortSchema.default("medium"),
});
export const updateTaskSchema = z
  .strictObject({
    title: titleSchema.optional(),
    done: z.boolean().optional(),
    parentId: parentIdSchema.nullable().optional(),
    dueDate: dateSchema.nullable().optional(),
    ...optionalAttributes,
  })
  .refine((changes) => Object.values(changes).some((value) => value !== undefined));

// 与模板一致：读取旧数据时保留未知扩展字段，写入 API 仍严格校验。
export const storedTaskSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string(),
  done: z.boolean(),
  parentId: parentIdSchema.optional(),
  dueDate: dateSchema.optional(),
  ...optionalAttributes,
});
export const taskSchema = storedTaskSchema.extend({
  priority: prioritySchema.default("medium"),
  effort: effortSchema.default("medium"),
});
export const taskListSchema = z.array(taskSchema);
export type Task = z.infer<typeof taskSchema>;

export const taskQuerySchema = z.strictObject({
  parentId: parentIdSchema.optional(),
  status: z.enum(["all", "pending", "done"]).optional(),
  dueDate: dateSchema.optional(),
  ...optionalAttributes,
  sort: z.enum(["created", "priority"]).optional(),
});
export type TaskQuery = z.infer<typeof taskQuerySchema>;

export function filterTasks(tasks: Task[], query: TaskQuery): Task[] {
  const status = query.status ?? (query.dueDate ? "pending" : "all");
  const ranks = { high: 0, medium: 1, low: 2 };
  const ordered =
    query.sort === "priority"
      ? tasks.toSorted((a, b) => ranks[a.priority] - ranks[b.priority])
      : tasks;
  return ordered.filter(
    (task) =>
      (!query.parentId || task.parentId === query.parentId) &&
      (!query.priority || task.priority === query.priority) &&
      (!query.effort || task.effort === query.effort) &&
      (!query.dueDate || task.dueDate === query.dueDate) &&
      (status === "all" || (status === "done" ? task.done : !task.done)),
  );
}

export function isOverdue(task: Task, today: string): boolean {
  return !task.done && !!task.dueDate && task.dueDate < today;
}
