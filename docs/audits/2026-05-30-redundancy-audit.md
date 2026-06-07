# Agent Neo 冗余代码审计报告

> 2026-05-30 初审 · 2026-05-31 按实际提交更新
> 范围 src/ 1946 文件 / 44.8 万行 · rtk rg-shim 修复后复验
> 当前代码清理进度截至 `898085cd chore: 删除 24 个死导出`

## 总账

| 状态 | 内容 | 证据 |
|---|---|---|
| 已提交删除 | 5 批，约 `+9/-15252` 行 | `a294c77e`, `a26ff435`, `bdc442e3`, `5f78c3c4`, `898085cd` |
| 仍需产品判断 | 2 组语义候选 | 见 C 节 |
| 建议保留参考 | planning/任务分解参考资产 | 见 D 节 |
| 依赖清理待执行 | 10 个疑似未用依赖 | 见 F 节 |

当前工作区另有 5 个 `task/planning` 未提交改动，属于任务状态/任务分解线，不属于本轮冗余代码清理。

---

## A. 已完成并提交

### A1. 第一批安全删除

- `a294c77e chore: 删除 19 个已验证死代码文件 (-4663 行)`
- 删除旧 file/shell legacy 工具、未接入 infra、重复/废弃 sanitizer/provider/context 辅助模块。

### A2. dead worker / teamManager

- `a26ff435 chore: 删除 dead worker 子系统 + teamManager (-318 行)`
- 删除未接入 worker 子系统和旧 teammate manager。

### A3. 第二批整文件死代码

- `bdc442e3 chore: 删除第二批死代码 35 文件 (-8189 行)`
- 删除 renderer 孤儿组件、废弃 panel/hook、research fallback/result aggregator、session fork/cost report、cowork orchestrator、cloudStorageService 等。

### A4. test-only 死模块

- `5f78c3c4 chore: 删除 ① test-only 死代码 7 模块 + 测试 (-1400 行)`
- 删除 `agentModelPolicy`、dashboard verifier、compression model router、request normalizer、DeepSeek wrapper、memory activity navigation、outputHandler 及对应测试。

### A5. 死导出精确清理

- `898085cd chore: 删除 24 个死导出`
- 删除或收窄 `AlertBanner`、`ConfirmModal`、`ModelIndicator`、`ipc/types`、`sessionAnalytics`、`nativeDesktop`、`settingsTabs`、`platform`、`contextBuckets` 等死导出。
- 验证：`git diff --check`、`npm run typecheck`、`npx vitest run tests/unit/channels/feishuPrivacy.test.ts tests/unit/channels/channelPrivacyFirewall.test.ts`、pre-commit `eslint --fix` 均通过。

---

## B. 已消化的原 B/C 候选

原报告里的“第二批待执行 53 项”已由 `bdc442e3` 和 `898085cd` 基本消化。原 C 档里以下项也已完成：

- `src/renderer/utils/outputHandler.ts`
- `src/main/agent/agentModelPolicy.ts`
- `src/main/context/compressionModelRouter.ts`
- `src/main/model/middleware/requestNormalizer.ts`
- `src/main/model/providers/wrappers/deepseekWrapper.ts`
- `src/renderer/utils/memoryActivityNavigation.ts`
- `src/main/agent/runtime/dashboard/DashboardVerifier.ts`
- `src/main/channels/feishu/feishuPrivacy.ts` 的 dead helper exports
- `src/renderer/services/localBridge.ts` 的 dead reset export
- `src/main/context/summarizer.ts`、`src/main/context/codePreserver.ts` 和对应测试
- `src/main/tools/decorators/**`、`src/main/tools/decorated/**` 和对应测试

---

## C. 仍需人工决策：按产品语义归类

### C1. 已决策：旧上下文摘要/代码块保护管线

| 文件 | 语义 | 当前状态 | 建议 |
|---|---|---|---|
| `src/main/context/summarizer.ts` | 早期 AI 会话摘要器：抽取决策、action items、code references | 已删除 | 不再复活 |
| `src/main/context/codePreserver.ts` | 为旧摘要器保留 code block 的辅助层 | 已删除 | 不再复活 |
| `src/main/context/tokenEstimator.ts` 部分导出 | token 估算核心仍在用，但旧详细分析导出偏 test-only | 文件保留 | 后续只做局部导出收缩 |

判断：现在 live 压缩链路已经是 `autoCompressor`、`compactionService`、`compressionPipeline` 和 context layers。用户可见的任务完成总结由当前 agent 基于真实动作和验证结果生成，不依赖旧 `summarizer/codePreserver`。如果后续要做机器可复用的完成记录，应该新建 `completion summary contract`，不要复活旧正则摘要器。

completion summary contract 方向：它应该是内部结构化事件，不改变用户看到的自然语言总结。字段建议来自 run events、git diff、测试结果和剩余 dirty 状态，服务后端排查、会话审计、失败复盘和后续 Review Queue，而不是直接替代聊天里的收尾文字。

### C2. 已决策：装饰器式工具声明实验

| 文件/目录 | 语义 | 当前状态 | 建议 |
|---|---|---|---|
| `src/main/tools/decorators/**` | `@Tool/@Param/@Description` 装饰器框架 | 已删除 | 不再维护第二套工具定义范式 |
| `src/main/tools/decorated/**` | Decorator 版 `GlobTool/ReadFileTool` 示例工具 | 已删除 | 不再保留 demo |

判断：当前工具体系已经走 module/schema/handler 注册，装饰器路线没有进入 registry。保留它会继续制造“双工具定义范式”的错觉。

### C3. 已决策：未接入的能力/连接器卡片

| 文件 | 语义 | 当前状态 | 建议 |
|---|---|---|---|
| `src/renderer/components/TaskPanel/ConnectorsCard.tsx` | 旧 TaskPanel 里的 connector/MCP/skill 启用状态、调用历史和快捷操作卡片 | 生产零引用；只被 `tests/renderer/components/taskPanel.connectors.test.ts` 覆盖 | 已删除组件和测试；产品意图迁到右侧任务分解的能力信息区 |

判断：这个方向本身有价值，但不该复活旧组件。它混在旧 TaskPanel card 里展示 Local/MCP 列表和历史调用，回答的是“有哪些能力存在”；右侧任务分解真正需要回答的是“当前任务用了哪些能力、哪些可用、哪些失败、哪些需要授权、用户能否一键处理”。

证据：当前 live 入口已经有两层更贴近任务的模型：`TaskMonitor` 的 `当前能力 / 路由异常 / 本轮调用` 承接 selected/allowed/blocked/invoked 和 quick action；`RunWorkbenchCards` 的 tool discovery 模型承接本轮 tool/source/callable/blockedReason。`ConnectorsCard` 的代码只剩整组件零引用。

同类产品方向：Cursor、Windsurf、Claude Code、GitHub Copilot coding agent 都会显露 agent 可用工具/MCP 和配置入口，但重点放在当前会话/任务的工具选择、授权状态、失败原因或日志，而不是在任务侧边栏常驻一个完整连接器清单。参考官方页：[Cursor MCP](https://docs.cursor.com/context/model-context-protocol)、[Windsurf MCP](https://docs.windsurf.com/windsurf/cascade/mcp)、[Claude Code MCP](https://docs.claude.com/en/docs/claude-code/cli-reference)、[GitHub Copilot coding agent MCP](https://docs.github.com/en/copilot/concepts/coding-agent/mcp-and-coding-agent)。

后续最小实施切片：在新的右侧任务分解里扩展现有 `CurrentTurnCapabilityScopeCard`，做一个“能力”信息区：默认显示本任务 selected/allowed/blocked/invoked；blocked 行保留授权、重试、打开设置等 quick action；invoked 行展示 top actions 和调用次数；全局可用清单仍回设置页或 InlineWorkbenchBar，不塞回任务分解面板。

### C4. 验收/生成质量检查实验

| 文件 | 语义 | 当前状态 | 建议 |
|---|---|---|---|
| `src/main/agent/runtime/acceptance/AcceptanceRunner.ts` | 对前端 UI、文档、research、handoff、deployment、game artifact 做规则验收 | 已删除；连同 scenarioSkills、scenarioAcceptance contract 和测试一起移除 | 后续若要生成物质检，另起新的 artifact verifier / artifact issue 模型 |
| `src/main/agent/runtime/game/skill-loader.ts` | game runtime 的 `SKILL.md` loader | 生产零引用；只被 game skill-loader 测试覆盖 | 倾向删除，除非继续做 game-specific checker |

判断：AcceptanceRunner 的产品语义不是普通死代码，它对应“生成物验收/Review Queue 自动质检”这一类能力。历史上 5/7 接过轻量 Delivery Review 半闭环，5/19 又随 evaluation 子系统删除 UI / IPC / DB 表。当前保留的 runner 只有静态规则，入口、数据模型和 UI 都断了。

建议动作：已按“不复活旧 Review Queue 质检”的方向删除 AcceptanceRunner + scenarioSkills + scenarioAcceptance contract + 测试。后续如果要做生成物质检，按具体 game/deck/dashboard verifier 和新的 artifact issue 模型重建，不复用旧 Delivery Review。

### C5. 多 agent handoff / mailbox 残留

| 文件 | 语义 | 当前状态 | 建议 |
|---|---|---|---|
| `src/renderer/stores/handoffStore.ts` | 前端 pending handoff proposal store | 生产零引用；后端 handoff proposal service 是 live | 暂缓删除，等 handoff UI 决策 |
| `src/main/agent/mailboxBridge.ts` | AgentBus mailbox 的 polling bridge | ✅ 已删除（2026-06-07，连同测试）；AgentBus mailbox 本身保留 live | — |

判断：handoff 后端现在是 live 的，`handoffStore` 是“缺 UI 入口”的前端尾巴，不等于整条 handoff 能力没用。`mailboxBridge` 只是把 AgentBus mailbox 轮询成回调的桥，当前没有 runtime 用它。

建议动作：`mailboxBridge.ts` 可直接删并删测试。`handoffStore.ts` 先由产品决定：如果右侧/侧栏要显示 handoff proposal，就接入；如果不做前端 pending handoff UI，再删。

### C6. live 文件里的局部 API 清理

| 文件 | 语义 | 当前状态 | 建议 |
|---|---|---|---|
| `src/renderer/utils/updatePrompt.ts` | optional update prompt 状态 | `isOptionalUpdateAvailable` live；其余 seen/shouldShow helper 主要 test-only | 只删未用 helper，不删文件 |
| `src/renderer/api/index.ts` | renderer transport 初始化 | `initTransport` live；`getTransportMode/setApiUrl` 被测试用 | 若不支持运行时切 API，删 helper 和测试 |
| `src/main/utils/truncate.ts` | shell/read 输出截断工具 | `truncateMiddle` live；`truncateHead` 只被测试用 | 删除 `truncateHead` 和测试段 |
| `src/renderer/utils/accessControl.ts` | admin-only UI gating | 多处 live import；不是死文件 | 保留，只清不再用的 helper 才能动 |

判断：这些不是“删文件”对象，而是局部导出收缩。动它们的收益小，但能减少 API 面。

建议动作：放到最后，按 export 逐个删，别和整文件删除混批。

---

## D. 建议保留：planning/任务分解参考资产

这些虽然有历史痕迹，但和当前右侧任务分解方向有关，不放进冗余清理：

- `src/main/planning/` 4 件后端：TaskPlan 数据模型 + 模板引擎。
- `src/renderer/components/PlanningPanel.tsx`：Gen-3 持久化规划面板 UI，已确认当前未挂载，但可作为任务分解 UI 反例/参考。
- `src/main/agent/agentLoopIterator.ts`：SDK 流式接口，aisdk 迁移可能用到。

---

## E. 假阳性/保留项

已复核为 live 或不应直接删除：

- `src/main/mcp/mcp-server-entry.ts`
- `src/renderer/utils/streamingPerformanceMetrics.ts`
- `src/shared/contract/agentTypes.ts`
- `CommandPalette`
- `src/renderer/utils/accessControl.ts`

---

## F. 依赖清理 ✅ 已执行（2026-06-07）

```bash
npm rm @ai-sdk/openai highlight.js ink ink-spinner ink-text-input marked openai autoprefixer clsx tailwind-merge
```

**执行前精确复核**：10 个包全项目 `from/require/import 'dep'` **真 import = 0**。注意 `openai` 有 166 处引用但**全是 provider-id 字符串 `'openai'`，无 SDK import**（差点误判保留）；`autoprefixer` 已被 `@tailwindcss/postcss`（Tailwind v4）内置替代。`@ai-sdk/openai-compatible` 仍 live，不在删除列表。
**验证全绿**：`npm run typecheck` ✅ + `build:web`（webServer.cjs 3.0s）✅ + `build:cli`（index.cjs 1.1s）✅ + `build:renderer` ✅。

---

## 建议执行顺序

1. 删除 `mailboxBridge.ts` 和对应测试。
2. `AcceptanceRunner` 已处理；剩余产品确认项是 `handoffStore`。
3. 单独审 `completion summary contract` 是否需要新增内部结构化记录。
4. 最后做 live 文件局部导出收缩和依赖清理。
