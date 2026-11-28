import { z } from "zod";

// 不使用 Date.parse：它会将 2 月 30 日等无效日期滚动到下个月。
export const dateSchema = z
  .string()
  .length(10)
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return year >= 1 && year <= 9999 && day >= 1 && day <= (days[month - 1] ?? 0);
  }, "请使用真实的 YYYY-MM-DD 日历日期");

export const dateReferenceSchema = z.union([
  dateSchema,
  z.enum(["yesterday", "today", "tomorrow", "dayAfterTomorrow"]),
]);
export type DateReference = z.infer<typeof dateReferenceSchema>;

export const taskDateContextSchema = z.strictObject({
  today: dateSchema,
  timeZone: z.string().min(1),
});
export type TaskDateContext = z.infer<typeof taskDateContextSchema>;

export function resolveDate(reference: DateReference, today: string): string {
  const offsets = { yesterday: -1, today: 0, tomorrow: 1, dayAfterTomorrow: 2 };
  if (!Object.hasOwn(offsets, reference)) return dateSchema.parse(reference);
  const [year, month, day] = dateSchema.parse(today).split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day + offsets[reference as keyof typeof offsets]);
  // 按日历加天，不按本地时区的 24 小时加减，避免夏令时边界偏移。
  return dateSchema.parse(date.toISOString().slice(0, 10));
}
