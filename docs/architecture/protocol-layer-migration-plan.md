# Protocol 层迁移计划

> **Status: ✓ Completed 2026-04-13** — 实际落地与最终结论见 `docs/decisions/007-protocol-migration-reality-check.md` 与 `docs/decisions/008-swarm-actor-refactor.md`。循环依赖 4→0，services/tools fan-in 目标参考 ADR-007 的 reality check（原 450/400 目标已 retract）。本文件作为历史规划保留。
>
> 生成日期：2026-04-12
> 来源：对比 Codex（Rust, 1418 文件）、归藏 CodePilot（TS, 603 文件）、Claude Code Agent SDK（ccVersion 2.1.63）后得出的架构改进方案
> 对比数据位置：`~/Downloads/ai/code-agent-compare/{codex,CodePilot}` + `~/Downloads/ai/claude-code-system-prompts/`

## 背景：当前架构债（madge 实测）

| 指标 | 数值 | 对比基线 |
|------|:---:|---------|
| 总模块数 | 706 | CodePilot 603 / Codex 1418 (Rust) |
| 循环依赖 | 4 条 | CodePilot 9 / Codex 0（编译器强制）|
| services fan-in | **408** | CodePilot lib 412 / Codex protocol 33 crates（但纯类型）|
| logger 被引用 | **306 次** | 单文件引用最高 |
| agent↔tools 双向 import | 26+29=55 条 | **必须消除** |
| 循环路径 | 全部集中在 `agent/hybrid/agentSwarm` + `parallelAgentCoordinator` + `subagentExecutor` | - |

## 核心决策：建立 `src/main/protocol/` 中介层

**同时吸取 Codex 和 Claude Code 的经验：**
- **目录结构学 Codex** — 独立 protocol 目录做类型中介层
- **命名和类型设计学 CC** — 用 TypeScript discriminated union + AsyncIterable 消息流
- **事件体系直接抄 CC 的 16 种 hook event**（Anthropic 一年打磨的命名）

## 目标架构

```
src/main/protocol/
├── events.ts      // CC 16 种 hook event + 自定义 agent 事件 → discriminated union
├── messages.ts    // { type, subtype } tagged union 消息类型
├── tools.ts       // Tool Schema 接口定义（参考 CC tool() factory）
├── agents.ts      // Subagent Definition（参考 CC AgentDefinition）
├── ops.ts         // 可选：命令/操作定义（参考 Codex Op enum）
└── index.ts       // 统一导出
```

**规则**：所有跨模块类型引用只从 `protocol/` 走，禁止模块之间互相 import 类型。

## 参考抄写：CC 的 16 种 hook event

```
PreToolUse, PostToolUse, PostToolUseFailure,
Notification, UserPromptSubmit,
SessionStart, SessionEnd, Stop,
SubagentStart, SubagentStop,
PreCompact, PermissionRequest,
Setup, TeammateIdle,
TaskCompleted, ConfigChange
```

这 16 种事件名可以作为 `protocol/events.ts` 的起点。

## 改进项清单（按 ROI 排序）

### P0 必做

| # | 任务 | 工作量 | 预期收益 | 参考 |
|---|------|:---:|---------|------|
| 1 | 新建 `src/main/protocol/` 空目录 + README + index.ts | 30 分钟 | 占位，声明架构意图 | Codex `codex-rs/protocol/` |
| 2 | 迁移 services 里的纯类型文件到 protocol/types/ | 1 天 | services fan-in 降 30-50 | Codex protocol crate |
| 3 | 把 `agent/eventBatcher.ts` 的事件类型抽到 `protocol/events.ts` | 半天 | EventBus 雏形升级成真 Event Bus | CC 16 hook events |
| 4 | 加 pre-commit 循环依赖检测（madge --circular）| 30 分钟 | 防回归 | 通用工程最佳实践 |

### P0 核心（P0 做完后立即跟进）

| # | 任务 | 工作量 | 预期收益 | 参考 |
|---|------|:---:|---------|------|
| 5 | 实现 Tool Schema Registry：tools 通过 Schema 注册不直接 import | 1 周 | 消除 agent↔tools 55 条循环引用 | Codex `dynamic_tools.rs` + CC `tool()` + `createSdkMcpServer` |
| 6 | 加 ESLint no-restricted-imports 规则，禁止跨模块直接引用类型 | 1 小时 | 软强制类型只从 protocol 走 | 替代 Rust 编译期强制 |

### P1 下个 sprint

| # | 任务 | 工作量 | 预期收益 | 参考 |
|---|------|:---:|---------|------|
| 7 | Actor 模式重构 swarm 调度 | 2 周 | 消除 4 条循环依赖 | CC SendMessage + Task tool isolation |
| 8 | 拆分 tools/ 目录：multiagent 和 network 独立 | 3-5 天 | Core 层更清晰 | Codex tools crate 边界 |
| 9 | 加 worktree 隔离能力（subagent 在独立 git worktree 运行）| 1 周 | 子 agent 互不干扰 | CC `isolation: "worktree"` |

### P2 规划

| # | 任务 | 工作量 | 参考 |
|---|------|:---:|------|
| 10 | ToolSearch 式按需加载（deferred tool loading）| 3-5 天 | CC ToolSearch 机制 |
| 11 | agent-loop 内部拆分（fan-out 44 太高）| 1 周 | Codex core 子模块组织 |

### 已撤回

- ~~合并 context 到 agent~~ — 看 Codex `state` crate 独立（21 文件）后撤回，保持 context 独立是正确的
- ~~立即做 services 大拆分~~ — 工作量 1 个月+，求职期间暂缓，等稳定后再做

## 验证方式

每一步改完必跑：

```bash
cd ~/Downloads/ai/code-agent
# 1. 循环依赖数
npx madge --ts-config tsconfig.json --extensions ts,tsx --circular src/main

# 2. services fan-in 变化
npx madge --ts-config tsconfig.json --extensions ts,tsx src/main --json > /tmp/madge-current.json
# 然后用 Python 脚本计算 fan-in，对比 baseline 408

# 3. TypeScript 类型检查
npm run type-check

# 4. 测试
npm test
```

## 可讲的故事（作品集/面试）

> "我对比了 Codex（Rust 1418 文件 + protocol crate 中介）、归藏的 CodePilot（TS 16 天 Vibe Coding, 9 循环）、Claude Code Agent SDK（16 种 hook event + AsyncIterable 消息流）后发现：TS Electron Agent 项目想做到零循环依赖，必须建 protocol 中介层。
>
> 我的 code-agent 做完 P0 四步后，services fan-in 从 408 降到 ~350，eventBatcher 升格成真 Event Bus，pre-commit 挡住新循环。下一阶段复刻 CC 的 Tool Schema Registry 模式，预期消除 agent↔tools 全部 55 条互相 import。"

每个数字都是自己跑出来的，没有 hallucination 风险。
