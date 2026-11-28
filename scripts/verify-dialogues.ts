import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ChatMessage } from "../shared/chat.ts";
import { taskListSchema, taskSchema, type Task } from "../shared/tasks.ts";
import { model } from "../server/model.ts";
import { dialogueCases, type FixtureTask, type ReplyKind } from "./dialogue-cases.ts";
import { createLiveServer } from "./live-server.ts";
import { sourceHashes as hashSources } from "./verification-support.ts";
import { classifyReply } from "./dialogue-checks.ts";

if (!process.env.DEEPSEEK_API_KEY?.trim()) {
  console.error("请先在本地 .env 配置 DEEPSEEK_API_KEY；没有发起模型调用。");
  process.exit(1);
}
const selectedIds = process.env.LIVE_CASES?.split(",")
  .map((id) => id.trim())
  .filter(Boolean);
if (selectedIds?.some((id) => !dialogueCases.some((item) => item.id === id)))
  throw new Error("LIVE_CASES 包含未知用例编号。");
const cases = dialogueCases.filter((item) => !selectedIds?.length || selectedIds.includes(item.id));
const repeats = Number(process.env.LIVE_REPEATS || 1);
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 3, "LIVE_REPEATS 只允许1至3。");
const reportPath = resolve(process.env.LIVE_REPORT || "reports/live-dialogues-latest.json");
const server = await createLiveServer();

async function request(method: string, path: string, body?: unknown, key?: string) {
  return fetch(server.base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(35_000),
  });
}
async function list() {
  const response = await request("GET", "/api/tasks");
  assert.equal(response.status, 200);
  return taskListSchema.parse(await response.json());
}
async function diskState() {
  try {
    return taskListSchema.parse(JSON.parse(await readFile(server.filename, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
function logical(tasks: Task[], ids: Map<string, string>): FixtureTask[] {
  return tasks.map(({ id, title, done }) => ({
    key: [...ids].find((entry) => entry[1] === id)?.[0] ?? `unknown:${id}`,
    title,
    done,
  }));
}
function validateState(
  actual: Task[],
  expected: FixtureTask[],
  ids: Map<string, string>,
  kind: ReplyKind,
) {
  assert.equal(actual.length, expected.length, "任务数量不符");
  for (let index = 0; index < expected.length; index++) {
    const task = actual[index];
    const spec = expected[index];
    assert.equal(task.title, spec.title, "任务标题或顺序不符");
    assert.equal(task.done, spec.done, "完成状态不符");
    const knownId = ids.get(spec.key);
    if (knownId) assert.equal(task.id, knownId, "原任务ID不应被替换");
    else {
      assert.equal(kind, "created", "只有明确创建时可以出现新ID");
      assert.ok(![...ids.values()].includes(task.id), "新任务不能复用已有ID");
      ids.set(spec.key, task.id);
    }
  }
}

interface TurnResult {
  input: string;
  reply: string;
  kind: ReplyKind;
  expectedKinds: ReplyKind[];
  beforeTasks: Task[];
  actualTasks: Task[];
  before: FixtureTask[];
  expected: FixtureTask[];
  actual: FixtureTask[];
  durationMs: number;
  passed: boolean;
  statePassed: boolean;
  wrongMutation: boolean;
  failure?: string;
}
const results: {
  id: string;
  category: string;
  rationale: string;
  repeat: number;
  turnsPlanned: number;
  passed: boolean;
  turns: TurnResult[];
  skippedTurns: number;
}[] = [];
const startedAt = new Date().toISOString();
const sourceHashes = await hashSources();
let infrastructureError: string | undefined;
try {
  await server.start();
  console.log(`真实对话测试：${cases.length}个场景 × ${repeats}次，${model}，非思考模式。`);
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const scenario of cases) {
      // 仅清理该验收服务的临时文件，不访问开发数据。
      for (const task of await list())
        assert.equal((await request("DELETE", `/api/tasks/${task.id}`)).status, 204);
      const ids = new Map<string, string>();
      for (const fixture of scenario.seed) {
        const response = await request("POST", "/api/tasks", { title: fixture.title });
        assert.equal(response.status, 201);
        const task = taskSchema.parse(await response.json());
        ids.set(fixture.key, task.id);
        if (fixture.done)
          assert.equal(
            (await request("PATCH", `/api/tasks/${task.id}`, { done: true })).status,
            200,
          );
      }
      const history: ChatMessage[] = [];
      const result = {
        id: scenario.id,
        category: scenario.category,
        rationale: scenario.rationale,
        repeat,
        turnsPlanned: scenario.turns.length,
        passed: false,
        turns: [] as TurnResult[],
        skippedTurns: 0,
      };
      results.push(result);
      for (const [index, turn] of scenario.turns.entries()) {
        if (turn.removeBefore)
          assert.equal(
            (await request("DELETE", `/api/tasks/${ids.get(turn.removeBefore)}`)).status,
            204,
          );
        const before = await list();
        const content = typeof turn.text === "string" ? turn.text : turn.text(ids);
        history.push({ role: "user", content });
        const began = performance.now();
        const response = await request(
          "POST",
          "/api/chat",
          { messages: history },
          crypto.randomUUID(),
        );
        assert.equal(response.status, 200);
        const body: { reply: string } = await response.json();
        assert.equal(typeof body.reply, "string");
        const kind = classifyReply(body.reply);
        const actual = await list();
        assert.deepEqual(actual, await diskState(), "API与磁盘状态不一致");
        const row: TurnResult = {
          input: content,
          reply: body.reply,
          kind,
          expectedKinds: turn.kinds,
          beforeTasks: before,
          actualTasks: actual,
          before: logical(before, ids),
          expected: turn.expected,
          actual: logical(actual, ids),
          durationMs: Math.round(performance.now() - began),
          passed: true,
          statePassed: true,
          wrongMutation: false,
        };
        try {
          validateState(actual, turn.expected, ids, kind);
          row.actual = logical(actual, ids);
        } catch (error) {
          row.statePassed = false;
          row.wrongMutation = JSON.stringify(before) !== JSON.stringify(actual);
          row.failure = error instanceof Error ? error.message : String(error);
        }
        try {
          assert.ok(row.statePassed, row.failure);
          assert.ok(turn.kinds.includes(kind), `回复类型${kind}不属于预期${turn.kinds.join("/")}`);
          for (const text of turn.includes ?? [])
            assert.ok(body.reply.includes(text), `回复缺少${text}`);
          for (const text of turn.excludes ?? [])
            assert.ok(!body.reply.includes(text), `回复不应包含${text}`);
        } catch (error) {
          row.passed = false;
          row.failure = error instanceof Error ? error.message : String(error);
        }
        result.turns.push(row);
        history.push({ role: "assistant", content: body.reply });
        if (!row.passed) {
          result.passed = false;
          result.skippedTurns = scenario.turns.length - index - 1;
          break;
        }
      }
      result.passed =
        result.turns.length === scenario.turns.length && result.turns.every((turn) => turn.passed);
      console.log(
        `${result.passed ? "✓" : "✗"} ${scenario.id} (${result.turns.map((turn) => turn.kind).join(" → ")})`,
      );
      if (!result.passed)
        console.log(`  ${result.turns.at(-1)?.failure}\n  回复：${result.turns.at(-1)?.reply}`);
    }
  }
} catch (error) {
  infrastructureError = error instanceof Error ? error.message : String(error);
  console.error(`验收中断：${infrastructureError}`);
  process.exitCode = 1;
} finally {
  await server.dispose();
  for (const result of results) result.skippedTurns = result.turnsPlanned - result.turns.length;
  const turns = results.flatMap((result) => result.turns);
  const summary = {
    scenariosPlanned: cases.length * repeats,
    scenariosExecuted: results.length,
    scenariosCompleted: results.filter((result) => result.turns.length === result.turnsPlanned)
      .length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    turnsExecuted: turns.length,
    skippedTurns: results.reduce((sum, result) => sum + result.skippedTurns, 0),
    wrongMutations: turns.filter((turn) => turn.wrongMutation).length,
    modelErrors: turns.filter((turn) => turn.kind === "error").length,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        model,
        reasoningEffort: "none",
        realModel: true,
        nodeVersion: process.version,
        sourceHashes,
        infrastructureError,
        summary,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(summary));
  console.log(`结果文件：${reportPath}`);
  if (summary.failed || summary.scenariosExecuted !== summary.scenariosPlanned)
    process.exitCode = 1;
}
