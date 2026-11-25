import { createHash } from "node:crypto";
import type { ChatMessage } from "../shared/chat.ts";

export class ChatRequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// 小型单进程应用的请求去重：同时到达的相同请求共享 Promise，写入后响应丢失也可重放。
// 仅缓存 15 分钟，最多 500 项；服务重启后不保留，不能替代持久化事务日志。
export function createChatCache(reply: (messages: ChatMessage[]) => Promise<string>) {
  const entries = new Map<
    string,
    { fingerprint: string; result: Promise<string>; expiresAt: number }
  >();
  return (messages: ChatMessage[], key?: string): Promise<string> => {
    if (!key) return reply(messages);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key))
      throw new ChatRequestError(400, "请求编号无效，请刷新后重试。");
    const now = Date.now();
    for (const [id, entry] of entries) if (entry.expiresAt <= now) entries.delete(id);
    const fingerprint = createHash("sha256").update(JSON.stringify(messages)).digest("hex");
    const existing = entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new ChatRequestError(409, "同一请求编号不能用于不同消息。");
      return existing.result;
    }
    if (entries.size >= 500) throw new ChatRequestError(503, "请求较多，请稍后再试。");
    const entry = { fingerprint, expiresAt: Infinity, result: Promise.resolve("") };
    entry.result = Promise.resolve()
      .then(() => reply(messages))
      .finally(() => {
        entry.expiresAt = Date.now() + 15 * 60_000;
      });
    entries.set(key, entry);
    return entry.result;
  };
}
