# 当前版本验证记录

## 本轮范围与环境（2026-11-26）

本轮从已有日期、属性、一级子任务及展示扩展的未提交工作区继续，使用 **Node 25.9.0**（满足24.12+）。未编辑 `SUBMIT.md`，未暂存、提交、推送或发送邮件。测试均使用独立临时任务文件和端口；真实模型使用本地配置的 `deepseek-flash`，`reasoning_effort=none`。

以下结论只引用本轮实际执行。每份JSON保留运行时间、逐轮回复/状态及当时的源码哈希；中间轮次与历史报告不自动代表最终版本。最终核心实现哈希与报告的核对见 `reports/completion/evidence-index.json`。

## 当前自动化检查

最终检查输出、退出码与源码哈希见 [checks.json](../reports/completion/checks.json)。`npm run verify:checks` 顺序执行六项，任一失败退出码非零。`npm test` 不调用真实模型，模型边界使用mock，存储和HTTP使用真实隔离文件；进程测试实际退出并重启生产入口。

| 检查                | 本轮最终结果           |
| ------------------- | ---------------------- |
| `npm test`          | 90项通过，0失败、0跳过 |
| `npm run typecheck` | 通过                   |
| `npm run lint`      | 通过                   |
| `npm run fmt:check` | 通过                   |
| `npm run build`     | 通过                   |
| `git diff --check`  | 通过                   |

本轮新增明确不存在的删除/完成目标回归，分别断言固定回复、原ID、所有字段、API/磁盘一致及磁盘原文未变；保留原有同名歧义、旧编号、去重、超时取消、旧JSON与父子规则测试。还覆盖超长标题分类及非法日期判定的正反例，不能把任意澄清、故障或无关回复判为成功。

首轮工程检查仅格式失败，指出新报告JSON格式，其他检查通过；原始输出见 [checks-attempt1.json](../reports/completion/checks-attempt1.json)。随后只调整报告排版再完成最终检查。

## 缺失目标回复契约与修复前后

业务契约：用户明确要删除/完成某目标，但快照没有语义匹配时，返回未找到、不修改、不选择无关任务。规划器输出相应 `delete/complete` 和 `taskIds: []`；执行器已有固定反馈：

> 没有找到对应的任务，本轮没有修改任务。请告诉我清单中的任务名称或 #编号。

对象、指代或操作本身不明确时仍澄清；多候选与同名规则不变。`missing-target` 的预期仍只接受 `not_found`，判定器对未找到回复的规则未放宽。

- [修复前3次](../reports/completion/missing-target-before.json)：1通过、2失败，失败均为“没有交电费，你想删除哪条”被分类为clarify；0错误写入、0模型错误。
- [首次修复后3次](../reports/completion/missing-target-after.json)：3次通过。后续格式/属性默认提示调整后又独立重复。
- [最终定向3次](../reports/completion/missing-target-verified.json)：3次通过，然后才执行最终54场景。保留此前 `missing-target-final.json` 等中间运行。
- [最终完整54场景](../reports/completion/dialogues-verified.json)：54场景、65轮全部通过，0错误写入、0模型错误、0跳过。

中间全量 [dialogues-after.json](../reports/completion/dialogues-after.json) 曾54/54通过；属性默认提示修复后的 [dialogues-final.json](../reports/completion/dialogues-final.json) 为53/54，唯一失败是超长标题的明确缩短请求被分类unknown，状态正确且无写入。仅为该明确句式增加锚定分类，并补充负例；没有改黄金案例、预期或状态断言，也没有将任意“请提供”算澄清。

## 当前真实模型独立验证

| 范围                 | 本轮结果与报告                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 官方与基础连续对话   | [official-final.json](../reports/completion/official-final.json)：12轮通过，含空历史、真正进程重启、洗衣服语义及最近指代                                   |
| 属性                 | [attributes-final.json](../reports/completion/attributes-final.json)：18轮通过，核对属性、原ID、API/磁盘及查询显示                                         |
| 日期                 | [due-dates-accepted.json](../reports/completion/due-dates-accepted.json)：9轮通过，注入今天2026-12-31，覆盖跨年、修改/清除、默认未完成、通知边界及非法日期 |
| 日期/属性/子任务串联 | [demo-final.json](../reports/completion/demo-final.json)：15轮通过，生产子进程和完整字段持久化核对                                                         |

属性首跑 [attributes-attempt1.json](../reports/completion/attributes-attempt1.json) 第16轮新建同名任务错误继承旧任务高优先级。修复规划器本轮未指定属性不继承的约束后，原18轮不改预期重跑通过；离线存储回归也核对同名新任务默认中/中且使用新ID。

日期首跑 [due-dates-attempt1.json](../reports/completion/due-dates-attempt1.json) 及 [due-dates-final.json](../reports/completion/due-dates-final.json) 均因“不是有效日期，请确认…”未命中旧正则而失败。新的精确契约要求包含该非法日期、明确拒绝并请求更正，同时独立验证原ID、状态、API/磁盘及文件原文未变；删去了原先仅问号即可放行的宽泛判据。[due-dates-verified.json](../reports/completion/due-dates-verified.json) 另保留“你想改成哪一天到期？”的同义请求漏判，正反例补齐后再完整重跑，未删除案例或改业务预期。

串联脚本初跑在空存储尚无JSON文件时退出，未调用模型，见 [demo-attempt1.json](../reports/completion/demo-attempt1.json)。脚本按生产存储的合法空状态处理仅ENOENT，其他读取错误仍失败。`demo-live.json` 是修复缺失目标后的中间版本通过结果，最终以 `demo-final.json` 为准。

## 当前浏览器验收

记录见 [browser-observations.json](../reports/completion/browser-observations.json)，包含实际DOM观察到的编号、短ID、相等比较与控制台结果，不宣称存在自动化浏览器脚本或视频。

### 真实模型数据 + 生产入口

最终演示流程由HTTP脚本发送真实模型对话，浏览器检查其任务面板。刷新前、刷新后、真正停止并以不同PID重启后，4条任务的完整ID/展示文本完全一致：父子关系、1/2进度、完成状态、日期、优先级和工作量保留。最终短ID依次 `e79ad81e`、`e2c05d43`、`3cbabadf`、`51430957`；子任务单独筛选后仍显示父任务。浏览器error/warn均为空。不是全部对话都通过界面手工输入。

### 固定日期/固定数据 + 模型mock

`npm run preview:demo` 可复现6条数据和固定今天2026-12-31，fixture见 [browser-mock-fixture.json](../reports/completion/browser-mock-fixture.json)。实际检查默认1、2、3、4、5、6；优先级排序5、6、1、2、4、3；今日筛选5、1、4；叠加高优先级+大工作量仅4，保留所属主任务；改工作量中显示空态。排除已完成、逾期和明日，编号到ID始终保持。控制台无error/warn。此项不调用真实模型。

聊天和面板排序规则统一为：**主任务之间、同一父任务的子任务之间分别稳定排序，父子保持相邻**，筛选/排序不重新编号。REST仍返回平铺数组，`sort=priority` 对数组全局稳定排序，不返回展示编号；不能用REST下标替代聊天编号。[rest-contract.json](../reports/completion/rest-contract.json) 本轮实际核对了这一API行为，README、工程说明和OpenAPI已说明区别。

## 历史证据与边界

原先37项基础测试、84/85项扩展测试，以及更早的12轮、54场景、日期9轮、属性18轮和外部17轮子任务报告均属于历史代码，不作为本轮数量。仓库原始 `reports/live-dialogues-*.json`、`reports/attributes-live-latest.json` 和 `reports/due-dates-live-latest.json` 保留原样；外部目录不作为复现依赖。当前脚本全部使用仓库相对导入，隔离数据，不依赖原先本机绝对路径。

固定合成场景通过不能证明任意自由表达可靠。自然语言目标和属性仍依赖模型；仅支持一级子任务、日历日期，不发送定时通知。JSON只支持单进程写入；内存幂等不跨重启/过期，刷新清空对话及最近父任务上下文。未统计总token/账单和延迟分布，未录制视频。提交文件清单及本人需修改SUBMIT.md的条目见 [演示与提交整理](DEMO.md)。
