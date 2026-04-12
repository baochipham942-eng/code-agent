# Code Agent 架构研究总结

> **日期**：2026-04-12
> **目的**：为 code-agent 的 protocol 层迁移提供完整背景、对比数据和决策依据
> **作者**：林晨（PM）+ Claude Code 协作分析
> **配套文档**：`protocol-layer-migration-plan.md`（执行清单）
> **原始数据**：`research-assets/` 目录下的 madge JSON、SVG 图、HTML 图

---

## 一句话故事（用于作品集/面试）

> 我对比了 **OpenAI Codex**（Rust, 1,418 文件）、归藏的 **CodePilot**（TS Electron, 603 文件, 16 天 Vibe Coding）、**Claude Code Agent SDK**（ccVersion 2.1.63 shipped prompts）和我自己的 **code-agent**（TS Electron, 706 文件, 2 月迭代），发现 **TypeScript Electron Agent 项目的循环依赖和 God Module 是结构性问题**——同规模的 CodePilot 有 9 条循环依赖，code-agent 做到 4 条；而 Codex 零循环依赖的真实原因不是工程师更细心，是 **Rust workspace 编译器强制 DAG + protocol crate 做中介层**。基于这个判断，我正在把 code-agent 的 services 类型层抽到独立 `protocol/` 目录，复刻 Codex 的 `codex-protocol` + Claude Code 的 AsyncIterable 消息流 + 16 种 hook event 的组合设计。

---

## 研究过程（按时间顺序）

1. **起点**：评估 `tirth8205/code-review-graph` 工具是否有用 → 结论：纯可视化价值不高，但思路（Tree-sitter 解析 + 图分析）可以借用
2. **第一步**：用 madge 扫 code-agent，得到 706 模块、4 条循环依赖、services fan-in 408 的事实
3. **第二步**：手绘目录级聚合图（madge 本身画不出）+ tech-diagram skill 版 PPT Warm 架构图
4. **第三步**：引入横向对比，发现我对 Codex/Aider/Cline 等的判断多数未验证
5. **第四步**：本地 clone Codex + CodePilot 源码，实跑 madge，拿到硬数据
6. **第五步**：读 `claude-code-system-prompts/` 里的 shipped prompts（ccVersion 2.1.53+），把 CC 从"🔴社区揣测"升到"🟢官方 prompt"
7. **第六步**：在 Codex protocol crate 里找到 `Submission`/`Op`/`EventMsg` 的 SQE/EQE 模式定义
8. **第七步**：在 CC Agent SDK 文档里找到 AsyncIterable 消息流 + 16 种 hook event 定义
9. **第八步**：整合得出最终改进清单 + Protocol 迁移计划

---

## 验证过的硬数据

### code-agent（本项目）

```
Total modules: 706
Total edges: 2076
Circular dependencies: 4（全在 agent/hybrid/agentSwarm 相关路径）

Top directories by file count:
  tools: 173 files
  agent: 77 files, fan-out 最高
  services: 70 files, fan-in 408 ← God Module
  ipc: 40 files
  evaluation: 35 files
  model: 34 files
  context: 33 files, fan-in 47
  shared: 33 files, fan-in 185

Top fan-in files:
  services/infra/logger.ts     306
  shared/constants/index.ts    106
  platform/index.ts             55
  services/index.ts             39
  shared/ipc/index.ts           36

Top cross-directory dependencies:
  tools -> services: 94
  agent -> services: 86
  ipc -> services: 55
  ipc -> shared: 38
  agent -> context: 30
  tools -> agent: 29  ← 循环依赖之一
  agent -> tools: 26  ← 循环依赖之一

Circular dependency paths:
  1) agentDefinition → hybrid/agentSwarm → swarm.ipc → parallelCoordinator → subagentExecutor
  2) swarm.ipc → parallelCoordinator → subagentExecutor → planApproval
  3) 同 1) 延伸到 scheduler/DAGScheduler
  4) swarm.ipc → swarmLaunchApproval
```

**已有的部分 EventBus 雏形**：
- `agent/eventBatcher.ts`
- `agent/parallelAgentCoordinator.ts`
- 但**没有走中立的 protocol 层**，所以没享受到解耦好处

### CodePilot（归藏）

```
仓库：https://github.com/op7418/CodePilot
开发方式：16 天 Vibe Coding，220 commits
技术栈：Electron + Next.js + TypeScript

madge 结果：
  Total modules: 603
  Total edges: 1710
  Circular dependencies: 9 ← 比 code-agent 多一倍

Top directories:
  components: 187 files, fan-in 39
  lib: 165 files, fan-in 412 ← God Module（和 code-agent services 408 几乎一致）
  app: 155 files
  hooks: 33 files, fan-in 179
  types: 3 files, fan-in 151

Top fan-in files:
  types/index.ts              147
  lib/db.ts                   123
  components/ui/button.tsx    114
  hooks/useTranslation.ts     110
  components/ui/icon.tsx       99
  lib/utils.ts                 98

Top cross-dir deps:
  app -> lib: 215
  components -> hooks: 170
  components -> lib: 123

Circular dependencies (9 条):
  1) lib/claude-client.ts ↔ lib/context-compressor.ts
  2) lib/agent-loop.ts → lib/agent-tools.ts → lib/tools/index.ts → lib/tools/agent.ts
  3) lib/agent-tools.ts ↔ lib/tools/index.ts → lib/tools/agent.ts
  4-9) lib/tools/index.ts 桶文件 ↔ 各 tool 文件（bash/edit/glob/grep/read/write）
```

**关键洞察**：CodePilot 和 code-agent 架构债**几乎一致**（lib 412 vs services 408；都有 agent↔tools 循环），但 CodePilot 多了 5 条 `tools/index.ts` 桶文件循环——这是 TS/JS 生态的经典 barrel file 反模式。

### Codex（OpenAI）

```
仓库：https://github.com/openai/codex
技术栈：Rust workspace（70+ crates）+ TypeScript CLI wrapper

规模：
  Rust 文件数: 1,418
  Workspace crates: 70+
  TS 文件数: 0（CLI 是 Node 壳子调 Rust binary）
  循环依赖: 0 ← Rust 编译器强制 DAG，编译期拒绝

Top crates by file count:
  core: 301 files
  tui: 162 files
  tools: 46 files ← 对比：code-agent tools 173，CodePilot lib/tools 更多
  app-server: 37 files
  codex-api: 32 files
  protocol: 27 files ← God Module 本体但只含类型定义

Crate 依赖关系（被依赖次数）:
  codex-protocol: depended by 33/70 crates ← 最重，但纯类型
  codex-config: 14 crates
  codex-core: 12 crates
  codex-state: 5 crates
  codex-mcp: 4 crates
  codex-tools: 2 crates ← 只被 2 个引用！
  codex-hooks: 1 crate

core crate 依赖的外部 crates: 50 个
```

**关键洞察**：
- Codex 的"God Module"是 protocol crate，但它只含类型/消息定义（Rust `enum` 和 `struct`），业务代码通过它解耦
- `codex-tools` 只被 2 个 crate 引用——证明 tools 和其他模块**没有直接耦合**，都通过 protocol 中介
- core 依赖 50 个其他 crates 但只被 12 个依赖——说明 core 是 orchestrator，不是 utility

### Codex 的 Event Bus 模式（关键发现）

**文件位置**：`codex-rs/protocol/src/protocol.rs`

```rust
// 客户端 → Agent：提交请求
pub struct Submission {
    pub id: String,      // 唯一 ID 做关联
    pub op: Op,          // 请求负载
    pub trace: Option<W3cTraceContext>,
}

pub enum Op {
    Interrupt,                        // 中断当前任务
    CleanBackgroundTerminals,
    RealtimeConversationStart(...),
    RealtimeConversationAudio(...),
    RealtimeConversationText(...),
    RealtimeConversationClose,
    RealtimeConversationListVoices,
    UserInput { items, ... },
    // ... 20+ 种 Op 变体
}

// Agent → 客户端：事件流
pub enum EventMsg {
    Error(ErrorEvent),
    Warning(WarningEvent),
    RealtimeConversationStarted(...),
    RealtimeConversationRealtime(...),
    RealtimeConversationClosed(...),
    ModelReroute(ModelRerouteEvent),
    ContextCompacted(ContextCompactedEvent),
    ThreadRolledBack(ThreadRolledBackEvent),
    TurnStarted(TurnStartedEvent),
    TurnComplete(TurnCompleteEvent),
    TokenCount(TokenCountEvent),
    AgentMessage(AgentMessageEvent),
    UserMessage(UserMessageEvent),
    AgentMessageDelta(AgentMessageDeltaEvent),
    AgentReasoning(AgentReasoningEvent),
    AgentReasoningDelta(AgentReasoningDeltaEvent),
    AgentReasoningRawContent(...),
    // ... 30+ 种 EventMsg 变体
}
```

**使用证据**：
- `EventMsg::` 在 core crate 被使用 **421 次**
- `Op::Interrupt` 的 doc 明确写：「This server sends `EventMsg::TurnAborted` in response」
- 这是典型的 **SQE/EQE 模式**（Submission Queue Entry / Event Queue Entry）

### Claude Code 的 Event Bus 模式（关键发现）

**文件位置**：`~/Downloads/ai/claude-code-system-prompts/system-prompts/data-agent-sdk-reference-typescript.md`（ccVersion 2.1.63）

```typescript
// CC 的请求 → 响应流
for await (const message of query({
  prompt: "...",
  options: { allowedTools, hooks, agents, ... }
})) {
  if ("result" in message) { ... }
  else if (message.type === "system" && message.subtype === "init") { ... }
}
```

**关键机制**：
- `query()` 返回 **AsyncIterable<Message>** —— 所有通信走消息流
- 每条消息是 **discriminated union**：`{ type: string, subtype: string, ...data }`
- 和 Codex 的 `EventMsg` enum **架构等价**，只是用 TS union 不是 Rust enum

**16 种 hook event 类型**（ccVersion 2.1.63 shipped）：

```
PreToolUse          PostToolUse         PostToolUseFailure
Notification        UserPromptSubmit
SessionStart        SessionEnd          Stop
SubagentStart       SubagentStop
PreCompact          PermissionRequest
Setup               TeammateIdle
TaskCompleted       ConfigChange
```

**其他关键发现**：
- Subagent 通过 Task tool spawn，返回 "single message" 给父 agent
- Subagent 可 resume（通过 agent ID）
- 支持 `isolation: "worktree"` 参数做 git 隔离
- 支持 `run_in_background` 做异步执行
- `SendMessage` tool 用于 teammate 之间的消息总线
- Tools 通过 `tool()` factory + `createSdkMcpServer` 注册（Schema-based）

### Trae Agent（ByteDance）

```
本地路径：~/Downloads/ai/trae-agent/trae_agent/
文件数：49 Python 文件

结构：
  utils: 24 files
  tools: 15 files
  agent: 6 files
  prompt: 2 files

依赖关系（弱循环，规模太小不算问题）：
  agent -> utils: 12
  agent -> tools: 7
  utils -> tools: 9
  utils -> agent: 4
  tools -> agent: 1
```

**观察**：Trae 是 proof-of-concept 规模，架构扁平，没到需要 protocol 层的规模。对比价值有限。

---

## 对比表总览

| 指标 | **code-agent** | **CodePilot** | **Codex** | **Trae** |
|------|:---:|:---:|:---:|:---:|
| 仓库 | 本项目 | github.com/op7418/CodePilot | github.com/openai/codex | ~/Downloads/ai/trae-agent |
| 语言 | TypeScript | TypeScript | Rust (+TS wrapper) | Python |
| 总源文件 | 706 | 603 | 1,418 Rust | 49 |
| 最大模块/crate | tools 173 | components 187 | core 301 | utils 24 |
| God Module fan-in | **services 408** | **lib 412** | protocol 33 crates（纯类型） | N/A |
| logger 类引用 | logger 306 次 | types 147 / db 123 | - | - |
| **循环依赖** | 4 条 | **9 条** | **0 条**（编译器强制） | 弱循环 |
| agent↔tools 循环 | ✅ 有 | ✅ 有 + 桶文件循环 | ❌ tools 只被 2 crate 引用 | 弱 |
| EventBus 架构 | 雏形（eventBatcher）不彻底 | 无 | SQE/EQE 完整实现 | 无 |
| Tool Schema Registry | ❌ | ❌ | ✅ dynamic_tools.rs | ❌ |
| 开发方式 | 2 月 908 commit | 16 天 Vibe Coding | 传统工程团队 | 字节内部 |

---

## 未验证项目（仅公开资料，可信度 🟠）

| 项目 | 语言 | 我的判断 | 可信度 |
|------|:---:|---------|:---:|
| **Aider** | Python | coders/ 有 God Object，没 subagent 所以没循环依赖问题 | 🟠 基于 GitHub 浏览 |
| **Cline** | TS | Cline.ts 早期 5000+ 行，后来拆开，没有 subagent | 🟠 基于社区讨论 |
| **Continue** | TS | core/ 分层较好，有 ProtocolHandler 隔离 | 🟠 基于文档浏览 |
| **Cursor** | TS | 闭源 Electron，无法评估 | 🔴 不可评估 |
| **GitHub Copilot** | TS | 闭源，仅 VS Code 扩展部分开源 | 🔴 不可评估 |

**注意**：面试/作品集**不要**引用这些未验证项目作为铁证。只讲 code-agent + CodePilot + Codex + Claude Code 四个。

---

## 关键洞察汇总（7 条）

### 1. TS Electron Agent 项目的架构债是**结构性**的

CodePilot 16 天 Vibe Coding 做出 lib fan-in 412，code-agent 2 月迭代做出 services fan-in 408——**差异只有 1%**。这证明 TS 生态的 Agent 项目做到 600+ 文件规模，都会长出同样的 God Module 和 agent↔tools 循环。不是工程师能力问题，是语言生态 + 开发模式导致的。

### 2. Codex 零循环依赖不是工程师更聪明

是两个结构性因素：
- **Rust workspace 编译器强制 DAG**——cargo 会拒绝编译循环依赖的 workspace
- **protocol crate 做类型中介**——33/70 crate 依赖 protocol，但它只含类型定义，业务代码通过它解耦

TS 项目想达到同样效果，必须**手动**建立 protocol 中介层 + ESLint 强制（软替代编译期强制）。

### 3. Codex 和 Claude Code 的 EventBus 架构是等价的

| 维度 | Codex | Claude Code |
|------|:---:|:---:|
| 请求 | `Submission { id, op: Op }` Rust struct | `query({ prompt, options })` TS 对象 |
| 响应流 | `Stream<EventMsg>` Rust enum 30+ 变体 | `AsyncIterable<Message>` TS discriminated union |
| Hook 订阅 | `codex-hooks` crate | `hooks: { PreToolUse: [...] }` option，16 种事件 |
| Tool 注册 | `dynamic_tools.rs` + JSON Schema | `tool()` + `createSdkMcpServer` |
| 中介层位置 | `codex-protocol` crate | `@anthropic-ai/claude-agent-sdk` 包 |

**同构**——架构形态完全相同，只是 Codex 用 Rust enum 做类型中介，CC 用 TypeScript discriminated union + SDK 包做中介。

### 4. code-agent 已有 EventBus 雏形但没享受到好处

`agent/eventBatcher.ts` 和 `parallelAgentCoordinator.ts` 已经是 Event Bus 思路的产物，但没有走中立的 protocol 层，所以循环依赖依然存在。**你走在正确方向上，只差一个 protocol 目录把 eventBatcher 升格成真正的 Event Bus。**

### 5. CC 的 16 种 hook event 命名是 1 年打磨的成果

`TeammateIdle` / `PreCompact` / `PermissionRequest` / `SubagentStart` 这些命名暴露了 CC 的架构：
- 有 swarm 心跳检测（TeammateIdle）
- 上下文压缩是可 hook 的拐点（PreCompact）
- 权限是事件驱动的（PermissionRequest）
- Subagent 有独立生命周期（SubagentStart/Stop）

**可以直接抄这 16 种事件名作为 protocol/events.ts 的起点**，省掉 1 年设计成本。

### 6. "合并 context 到 agent" 是错的建议（撤回）

原本对 code-agent 的建议是 context 专属 agent 所以应该合并进去。但对比 Codex 后发现 `codex-state` crate 独立（21 文件），说明 **context/state 独立是正确做法**。

### 7. 修复优先级必须按 ROI 排序，不是按问题严重度

services fan-in 408 是最严重的问题，但修它需要 1 个月。
抽类型层 + 建 protocol 目录只需要 1 天，就能让 fan-in 降 30-50。
**前者推到求职稳定后做，后者立刻做**。

---

## 技术模式速查

### 什么时候用哪种模式？

| 场景 | 模式 | 范本 |
|------|------|------|
| 主 agent ↔ 子 agent 通信 | **Actor Model**（消息 + ID） | Claude Code Task tool |
| Agent ↔ UI 实时更新 | **Event Bus / SQE**（discriminated union）| Codex EventMsg |
| Tool 调用 | **Schema Registry**（声明式注册）| Codex dynamic_tools + CC tool() |
| 跨模块类型共享 | **Protocol 中介层** | Codex codex-protocol crate |

**Codex 里三种模式共存**，都通过 protocol crate 的类型系统做中介。这是零循环依赖的真正原因——**所有跨层通信都走 protocol 的类型系统**。

---

## 文档导航

- **执行清单**：`protocol-layer-migration-plan.md`（P0/P1/P2 改进项 + 参考范本 + 验证命令）
- **本总结**（架构决策依据和研究背景）：本文件
- **原始数据**：`research-assets/`
  - `madge-code-agent.json` — code-agent 完整依赖图（706 模块）
  - `madge-codepilot.json` — CodePilot 完整依赖图（603 模块）
  - `madge-code-agent-full.svg` — 全量模块关系图（不可读，1.7MB）
  - `madge-code-agent-dirs.svg` — 目录级聚合图（可读）
  - `code-agent-arch.svg` — 暗色风格 V1 架构图
  - `code-agent-arch-v2.html` — PPT Warm 风格 V2 架构图（作品集推荐使用）

---

## 参考项目本地路径

| 项目 | 本地路径 |
|------|---------|
| code-agent | `~/Downloads/ai/code-agent/` |
| Codex | `~/Downloads/ai/code-agent-compare/codex/` |
| CodePilot | `~/Downloads/ai/code-agent-compare/CodePilot/` |
| Trae | `~/Downloads/ai/trae-agent/` |
| CC system prompts | `~/Downloads/ai/claude-code-system-prompts/` |

**重要**：下次打开新会话前，这些路径都已 clone/持久化，新会话的 Claude 可以直接读。

---

## 如果有新会话想复现分析

```bash
# 重新扫 code-agent
cd ~/Downloads/ai/code-agent
npx madge --ts-config tsconfig.json --extensions ts,tsx src/main --json > /tmp/madge-new.json
npx madge --ts-config tsconfig.json --extensions ts,tsx --circular src/main

# 对比 CodePilot
cd ~/Downloads/ai/code-agent-compare/CodePilot
npx madge --ts-config tsconfig.json --extensions ts,tsx src --json
npx madge --ts-config tsconfig.json --extensions ts,tsx --circular src

# 看 Codex protocol 核心
cat ~/Downloads/ai/code-agent-compare/codex/codex-rs/protocol/src/protocol.rs | head -500
# 看 EventMsg enum
grep -n "pub enum EventMsg" ~/Downloads/ai/code-agent-compare/codex/codex-rs/protocol/src/protocol.rs
# 看 Submission / Op
grep -n "pub struct Submission\|pub enum Op " ~/Downloads/ai/code-agent-compare/codex/codex-rs/protocol/src/protocol.rs

# 看 CC 的 Agent SDK 参考
cat ~/Downloads/ai/claude-code-system-prompts/system-prompts/data-agent-sdk-reference-typescript.md
cat ~/Downloads/ai/claude-code-system-prompts/system-prompts/tool-description-task.md
```
