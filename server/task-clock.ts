import { dateSchema, type TaskDateContext } from "../shared/dates.ts";

export type TaskClock = () => TaskDateContext;

export function createTaskClock({
  timeZone = process.env.TASK_TIME_ZONE ?? "Australia/Sydney",
  now = () => new Date(),
}: { timeZone?: string; now?: () => Date } = {}): TaskClock {
  // 启动时校验配置；错误的时区不能静默回退到主机或浏览器时区。
  if (!timeZone) throw new RangeError("TASK_TIME_ZONE 不能为空");
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return () => {
    const parts = formatter.formatToParts(now());
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
    return {
      today: dateSchema.parse(`${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`),
      timeZone,
    };
  };
}
