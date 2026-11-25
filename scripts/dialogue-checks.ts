import type { ReplyKind } from "./dialogue-cases.ts";

// 只分类回复，任务状态、原ID、磁盘一致性仍由独立断言核对。
export function classifyReply(reply: string): ReplyKind {
  if (
    /^(?:尚未配置模型|模型密钥验证失败|模型响应超时|模型返回的操作格式无效|暂时无法连接模型|读取任务清单失败|任务存储操作失败)/.test(
      reply,
    )
  )
    return "error";
  if (reply.startsWith("已添加待办：")) return "created";
  if (reply.startsWith("已完成：")) return "completed";
  if (reply.startsWith("已删除：")) return "deleted";
  if (/已经完成，无需重复标记/.test(reply)) return "already_done";
  if (/没有找到对应的任务|目标任务已不存在|这条任务已不存在/.test(reply)) return "not_found";
  if (/^任务清单：|^清单还是空的|^还没有已完成的任务|^所有任务都已完成/.test(reply))
    return "listed";
  if (reply.startsWith("我可以帮你创建")) return "help";
  if (
    /[？?]|请.*(?:重新|指定|告诉|确认|明确|缩短|补充|分开|拆分|选择)|哪|是否|什么|几条/.test(reply)
  )
    return "clarify";
  return "unknown";
}
