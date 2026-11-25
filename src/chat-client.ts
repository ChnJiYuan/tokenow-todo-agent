import type { ChatMessage } from "../shared/chat.ts";

export async function requestReply(messages: ChatMessage[], requestId: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": requestId },
      body: JSON.stringify({ messages }),
      signal: AbortSignal.timeout(35_000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("等待回复超时，请先刷新清单确认结果，再重试。");
    }
    throw new Error("无法连接服务，请检查服务是否已启动后重试。");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("服务返回了无效响应，请先刷新清单确认结果。");
  }
  if (typeof body === "object" && body !== null) {
    if (response.ok && "reply" in body && typeof body.reply === "string") return body.reply;
    if ("error" in body && typeof body.error === "string") throw new Error(body.error);
  }
  throw new Error("服务暂时不可用。");
}
