# 优先级与工作量验证

## 当前版本（2026-11-26）

本轮使用Node 25.9.0、隔离任务文件和独立服务，保留原有未提交扩展；未编辑SUBMIT.md。全项目最新检查数量和六项结果以 [验证记录](VERIFICATION.md) 与 [checks.json](../reports/completion/checks.json) 为准。

离线 `server/attributes.test.ts` 使用真实临时JSON/HTTP及模型边界mock，覆盖默认中/中、缺字段旧记录读取不迁移、未知扩展字段保留、单项/双项修改、一次写入、组合查询、非法枚举/未知字段拒绝、同名澄清、编号与真实ID，以及修改时其他字段保持。新增同名新任务不继承旧属性、使用新ID的断言。

展示规则为主任务之间、同父子任务之间分别按高/中/低稳定排序，父子相邻，保留原编号与ID。REST平铺数组的 `sort=priority` 是按真实字段的全局稳定排序，不携带展示编号；聊天和面板通过 `taskRows` 分组，不使用REST下标作为聊天编号。

## 真实模型

本轮 [attributes-final.json](../reports/completion/attributes-final.json) 原18轮全部通过，模型为 `deepseek-flash`，非思考模式。覆盖用户5句验收示例、默认属性、查询交集、已完成任务查询、最高/紧急映射、模糊取值澄清、编号修改、同名和短ID选择；逐轮核对原ID、API、磁盘及查询显示。

首跑第16轮“再记一条准备面试”错误继承旧任务高优先级，失败证据见 [attributes-attempt1.json](../reports/completion/attributes-attempt1.json)。提示词明确本轮没指定就省略，不继承同名、父任务或历史字段后，保持原预期重跑通过。

含日期和子任务的组合语义另在 [demo-final.json](../reports/completion/demo-final.json) 验证15轮，包括完整字段和真正服务重启。不能把只含主任务的18轮当作子任务排序语义验证。

## 浏览器与历史

本轮浏览器使用固定日期、6条隔离数据和模型mock，检查分组排序、今日/属性交集、空态、编号到ID保持以及子任务父任务上下文；error/warn为空。真实模型演示的数据也在生产入口浏览器中检查刷新及真正进程重启。两类记录分开保存在 [browser-observations.json](../reports/completion/browser-observations.json)。复现命令为 `npm run preview:demo`；真实串联流程为 `DEMO_PAUSE=1 npm run verify:demo`。

根目录 [attributes-live-latest.json](../reports/attributes-live-latest.json) 是更早的18轮报告；当时84项全量测试和4条主任务的浏览器验证都是历史结果，不代表本轮。其源码哈希及原始内容保留，当前结论引用completion目录。

工作量是粗略估计，没有固定工时；默认值不代表模型可推断用户未指定的属性。固定场景不证明所有自由表达可靠，JSON并发和跨重启幂等边界未改变。
