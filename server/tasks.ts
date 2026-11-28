import { Router } from "express";
import {
  createTaskSchema,
  filterTasks,
  taskQuerySchema,
  updateTaskSchema,
} from "../shared/tasks.ts";
import { createTaskClock, type TaskClock } from "./task-clock.ts";
import type { TaskStore } from "./task-store.ts";
import { TaskRuleError } from "./task-rules.ts";

const taskNotFound = { error: "找不到这条任务。" };

export function taskRouter(tasks: TaskStore, clock: TaskClock = createTaskClock()) {
  const router = Router();

  router.get("/", (req, res) => {
    const query = taskQuerySchema.safeParse(req.query);
    if (!query.success)
      return res.status(400).json({
        error: "请提供有效的 status、parentId、dueDate、priority、effort 或 sort 筛选排序字段。",
      });
    const { today, timeZone } = clock();
    res.set("X-Task-Today", today);
    res.set("X-Task-Time-Zone", timeZone);
    res.json(filterTasks(tasks.list(), query.data));
  });

  router.post("/", (req, res) => {
    const input = createTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({
        error:
          "请提供有效标题、parentId、日期、priority（high/medium/low）或 effort（small/medium/large），不接受其他字段。",
      });
    }
    const { title, dueDate, ...attributes } = input.data;
    res.status(201).json(tasks.create(title, dueDate, attributes));
  });

  router.patch("/:id", (req, res) => {
    const input = updateTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({
        error:
          "请提供有效的 title、done、parentId、dueDate、priority 或 effort；parentId、dueDate 支持 null 清除。",
      });
    }

    const updated = tasks.update(req.params.id, input.data);
    if (!updated) return res.status(404).json(taskNotFound);
    res.json(updated);
  });

  router.delete("/:id", (req, res) => {
    if (
      req.query.cascade !== undefined &&
      req.query.cascade !== "true" &&
      req.query.cascade !== "false"
    )
      return res.status(400).json({ error: "cascade 只能为 true 或 false。" });
    if (!tasks.remove(req.params.id, req.query.cascade === "true"))
      return res.status(404).json(taskNotFound);
    res.sendStatus(204);
  });

  router.use(((error, _req, res, next) => {
    if (!(error instanceof TaskRuleError)) return next(error);
    res
      .status(error.status)
      .json({ error: error.message, code: error.code, tasks: error.relatedTasks });
  }) satisfies import("express").ErrorRequestHandler);

  return router;
}
