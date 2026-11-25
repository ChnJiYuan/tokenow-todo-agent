# 本地开发指南

## 启动

安装 Node.js 24.12 或更高版本（含 npm）。在终端执行以下命令。

```sh
git clone https://github.com/ChnJiYuan/tokenow-todo-agent.git
cd tokenow-todo-agent
npm ci
npm run dev
```

浏览器打开 <http://127.0.0.1:3000>。前后端共用这个地址，修改服务端代码后服务会自动重启。修改聊天界面的 TSX 后，在另一个终端运行 `npm run build` 并刷新页面。若 3000 端口已占用，可以用 `PORT=3001 npm run dev` 指定其他端口（macOS / Linux）。

若本机默认 Node 版本过低，可先安装并切换 Node 24.12+。临时使用而不修改系统默认版本，也可以运行 `npm exec --yes --package=node@24.12.0 -- npm run dev`；同样可将末尾的命令替换为 `npm test` 等检查命令。

## 接入 DeepSeek

1. 在项目根目录将 `.env.example` 复制为 `.env`。
2. 在 `.env` 中填写 [DeepSeek 开放平台](https://platform.deepseek.com/) 的 API Key。可通过 `DEEPSEEK_MODEL` 更换模型。
3. 重启开发服务。在服务端使用 [server/model.ts](server/model.ts) 导出的 `getModelClient()` 获取客户端，使用 `model` 读取配置的模型名称。只有发起模型请求才会产生调用费用。

默认使用 `deepseek-flash`。规划请求显式设置 `reasoning_effort: "none"` 关闭思考模式，同时保留 JSON Output、800 token 输出上限和20秒请求超时。仅设置 `temperature: 0` 不会关闭思考；通过 `DEEPSEEK_MODEL` 更换模型时，仍沿用非思考模式。

## 代码入口

| 文件                                         | 用途                                       |
| -------------------------------------------- | ------------------------------------------ |
| [src/App.tsx](src/App.tsx)                   | 聊天界面，发送当前页面的对话历史并显示回复 |
| [server/index.ts](server/index.ts)           | 接入智能体与任务存储，启动服务             |
| [server/agent.ts](server/agent.ts)           | 候选人实现入口，接收消息数组，返回回复文本 |
| [server/model.ts](server/model.ts)           | 服务端 DeepSeek 客户端与模型配置           |
| [server/tasks.ts](server/tasks.ts)           | 任务 API 的输入校验和 HTTP 响应            |
| [server/app.ts](server/app.ts)               | 接收对话历史，调用智能体并挂载任务 API     |
| [server/task-store.ts](server/task-store.ts) | 读写本地 JSON 任务清单                     |
| [server/openapi.yaml](server/openapi.yaml)   | 任务请求和响应的完整定义                   |

## 手动验证接口

启动服务后，在另一个终端发送聊天消息。

```sh
curl -sS http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"你好"}]}'
```

当前智能体会调用模型生成操作计划；未配置密钥时会返回中文配置提示，不会修改任务。后续请求在 `messages` 中按顺序传入之前的用户消息和小明的回复，再追加最新的用户消息。历史仅用于理解上下文，当前任务状态从磁盘读取。

聊天接口可选传入 `Idempotency-Key` UUID 请求头。相同编号和相同正文在同一服务进程的 15 分钟内共享结果，避免网络重发产生重复写入；相同编号配不同正文返回 409。前端自动生成编号，原样重试失败请求时复用它。新的请求编号允许创建同名任务。

创建一条任务，然后检查列表。

```sh
curl -sS http://127.0.0.1:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"买牛奶"}'
curl -sS http://127.0.0.1:3000/api/tasks
```

首次创建任务时，服务会在项目根目录创建 `data/tasks.json`。这些任务会保留到下次启动，浏览器中的聊天记录则会在刷新后清空。

## 本地检查

```sh
npm test
npm run typecheck
npm run lint
npm run fmt:check
npm run build
```

测试使用独立的临时目录。要预览构建产物，先停止开发服务，再运行 `npm start` 并打开同一地址。

## 真实模型验收

```sh
npm run verify:live
```

需要本地 `.env` 中的有效密钥。脚本通过生产入口启动临时服务，执行 12 轮对话，每个阶段核对 API 与磁盘中的状态；中途真的停止并重启服务进程。端口和文件独立，不占用 3000，不修改开发任务，结束后自动清理。它模拟聊天历史清空，但浏览器刷新仍需在界面里手动复核。

## 浏览器界面 mock 验收

没有密钥也可以验证界面，先停止占用 3000 端口的其他服务：

```sh
npm run preview:mock
```

只支持 README 的六步原句及“帮我记一下洗衣服”“衣服洗好了”。任务保存在临时目录，退出时删除；这是固定输入的测试 fixture，不具备真实自然语言理解能力。生产入口没有离线 mock 开关。它不消耗模型费用，也不能代替 `verify:live`。

## 隔离文件与配置

默认任务文件是 `data/tasks.json`；可用 `TASKS_FILE=/绝对路径/tasks.json npm run dev` 指定其他位置。JSON 存储沿用模板的同步读写和临时文件替换方案，适用于单进程本地运行。请勿同时启动多个进程写同一个文件。

密钥只在服务端使用，`.env`、`data/`、`dist/` 被 Git 忽略。不要把密钥放进 React 源码、测试或录屏。`SUBMIT.md` 被格式化器排除，`npm run fmt` 不会修改该文件。
