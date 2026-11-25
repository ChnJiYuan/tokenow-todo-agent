import { z } from "zod";

export const titleSchema = z.string().trim().min(1).max(200);
export const createTaskSchema = z.strictObject({ title: titleSchema });
export const updateTaskSchema = createTaskSchema
  .partial()
  .extend({ done: z.boolean().optional() })
  .refine((changes) => Object.keys(changes).length > 0);

// 与模板一致：读取旧数据时保留未知扩展字段，写入 API 仍严格校验。
export const taskSchema = z.looseObject({ id: z.string(), title: z.string(), done: z.boolean() });
export const taskListSchema = z.array(taskSchema);
export type Task = z.infer<typeof taskSchema>;
