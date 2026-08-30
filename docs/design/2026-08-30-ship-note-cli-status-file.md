# Ship Note — feat/cli-status-file（neo run/chat --status-file 运行态心跳）

> 日期：2026-08-30 · 分支：feat/cli-status-file（headless orchestration PR3/5，基点 origin/main 67d19e3f）

## What / Why

`neo run` / `neo chat` 新增 `--status-file <path>`：给外部 headless 编排器（cron / 调度系统 / 上层 agent 框架）一个**可轮询的单文件 JSON 状态快照**，回答"这次 run 活着吗、跑到哪了、成功还是失败"，无需解析 stream-json 事件流：

- run 进行中每 ~2s 节流写一次快照（ticker 驱动，**不跟随事件流逐条写**，开销恒定与事件量无关）；ticker `unref`，不会阻止进程退出。
- **原子写**：先写同目录 `<file>.<pid>.tmp` 再 `rename`——轮询方任何时刻读到的都是完整可解析 JSON，不存在半截读。
- run 结束写终态：`status: success|error`（失败带 `error.message` + 可选 `error.class`）+ `metrics` 汇总（复用 MetricsCollector 的 SessionMetrics，与 `--metrics` 文件同一份数据）。
- 不传 flag：零行为/性能变化（writer 与 collector 均不创建，E2E 控制组验证）。

## JSON schema（version 1，外部契约，变更需递增 version）

```jsonc
{
  "version": 1,                       // 格式版本，恒为 1
  "phase": "starting|running|finished",
  "sessionId": "cli_session_...",
  "pid": 12345,
  "startedAt": 1788092587587,         // epoch ms
  "updatedAt": 1788092646916,         // 本快照写入时间 epoch ms
  "elapsedSeconds": 59.3,             // 一位小数
  "turn": 2,                          // 当前轮次（turn_start 计数）
  "tokens": { "input": 38958, "output": 337 },  // MetricsCollector 口径（按 model call 记账）
  "lastTool": { "name": "ListDirectory", "ts": 1788092618967 },  // 或 null
  // ↓ 仅 phase=finished 出现
  "status": "success",                // 或 "error"
  "error": { "message": "Bad Request", "class": "Error" },       // 仅 status=error；class 可选
  "metrics": { /* SessionMetrics 全量：token/工具/轮次/时延/错误明细/cacheReadTokens 等 */ }
}
```

## 实现

- `src/cli/utils/statusFile.ts`（新增）：`StatusFileWriter`——`start()` 立即写 starting 快照并启动 2s ticker；`onTurnStart/onToolStart/markRunning` 由 adapter 事件流喂入；token 通过构造时注入的 `tokensProvider` 在**每次写快照时**实时拉取（不落事件时序的坑）；`finish()` 写终态并停 ticker；任何写入失败一次即永久降级停用（warn 日志），绝不影响 run 本体。
- `src/cli/adapter.ts`：hook 与 stream-json **同一条事件流**与 finish 路径。`--status-file` 与 `--metrics` 任一设置即创建 MetricsCollector；writer 的 tokensProvider 闭包捕获本 run collector——终态 `tokens` 与 `metrics.inputTokens/outputTokens` 恒一致。**刻意不用** adapter 的 `realInputTokens`：部分 provider 同发 `stream_usage` 与 `model_response`，该计数器会双计（既有行为，本 PR 不动）。
- flag 线程：`run.ts` / `chat.ts` 加 `--status-file` 选项 → `CLIGlobalOptions.statusFile` → `buildCLIConfig` → `CLIConfig.statusFilePath`（镜像 PR1 `--tools` 的模式）。

## 验证证据

### 静态门

- `npm run typecheck` 0 错；`npm run build:cli` 成功（dist/cli/index.cjs）；改动文件 eslint 0 error 0 warning。
- `npm run gates:local`（38 项）：**38/38 全绿**。第一轮曾命中 knip production dead-export ratchet（`STATUS_FILE_VERSION` 仅测试引用被判 dead export）——已改为模块内常量 + 测试断言字面量 `1`（契约字段本就该钉死），第二轮全绿。

### 单测

- `tests/unit/cli/statusFile.test.ts`（+9）：初始快照字段、节流（间隔内不重写/到点重写）、turn/tool/token 事件反映、原子写（tmp 不残留 + 每次采样可解析）、finish success（ticker 停止 + metrics 汇总）、finish error（message/class）、目录自动创建、不可写路径降级不抛错、elapsedSeconds 推进、tokensProvider 实时值优先。
- `tests/unit/cli/adapter.cliAgent.test.ts`（+3）：终态成功快照反映 turn/lastTool/token（collector 口径）/metrics；agentLoop.run 抛错 → 终态 error 带 message+class；未配置时行为不变（不创建 MetricsCollector，createAgentLoop 第 5 参 undefined）。
- 全量 `npx vitest run`：见 PR 描述（分支 vs 基线对照）。

### E2E（真模型 glm-5.3-flash，sandbox /tmp/neo-e2e-statusfile，新构建 dist/cli/index.cjs）

- 成功 run（多步任务：列目录+计数）：轮询 ~93 次采样 **0 次解析失败**；快照演进 `starting(turn 0)` → `running(turn 1)` → `turn 2, lastTool=Bash, tokens 19431/128` → `turn 3, lastTool=ListDirectory, tokens 19466/205`，elapsed 持续前进；终态 `status: success`，`tokens` 与 `metrics` 完全一致（39676/359），`metrics.toolCallsByName` 有真实工具计数。
- 错误 run（`--model no-such-model-xyz`）：exit 1；终态 `status: error`、`error.message: "Bad Request"`、`metrics.errorCount: 1`。
- 无 flag 控制组：exit 0，不创建任何 status 文件。
