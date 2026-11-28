// 非法绝对日期的精确拒绝契约；不能仅凭问号或任意澄清算通过。
export function isInvalidDateClarification(reply: string, date: string) {
  if (/^(?:模型|暂时无法|尚未配置|读取任务|任务存储|已修改|已添加|已完成|已删除)/.test(reply))
    return false;
  const index = reply.indexOf(date);
  if (index < 0) return false;
  const rejection = reply.slice(index + date.length);
  return (
    /(?:不是有效日期|不是闰年|无效(?:的)?日期|日期无效|日期不存在)/.test(rejection) &&
    /请(?:确认|提供|重新指定|更正)[^\n。！？?]*日期|你(?:想|希望)(?:改成|改到|设置为|设为)(?:哪一天|哪天)(?:到期)?[？?]/.test(
      rejection,
    ) &&
    !/(?:已修改|已设置|已更新|已添加|已保存)/.test(reply)
  );
}
