# ADR-014: 调试快照系统 + CLI debug 命令树

> 状态: accepted
> 日期: 2026-04-28
> 关联 commits: `fedf09da` `3066fe4b` `8f147e1e` `9499e2ef` `a1e29f0c`

## 背景

调试 agent loop 异常缺乏完整事后回放能力。已有的 `TraceView` / `EvalSnapshot` / `replayKey` 偏向于**单 turn 的工具调用回放**，但下面这些场景没有合适抓手：

1. **某 case 跑出意外结果**：模型输出在 turn N 跑偏了，需要看 turn N 进入时的完整上下文（messages + system prompt + tool registry + memory inject）才能诊断
2. **上下文压缩前后行为变化**：autoCompressor 触发后某些信息丢了，但难以复盘"压缩前后 context diff"
3. **两个 session 行为分裂定位**：同一 testCase 同一模型两次跑结果不同，需要 turn-by-turn 对比哪一步分裂
4. **dev 时单步调试**：希望 agent loop 跑到某 turn 暂停，让人看到中间态再继续

历史上爸通过手工 dump session DB + grep webServer log 拼接定位——耗时且容易漏关键字段。

## 决策

**采纳**：建立**完整快照体系**，沿 5 层架构落地：DB schema → agent runtime hook → IPC → settings UI → CLI debug 命令树。

### 1. DB schema 层（commit `fedf09da`）

新增两张表 + CRUD 方法：

| 表名 | 用途 | 触发时机 |
|------|------|---------|
| `turn_snapshots` | 每 turn 进入时的完整上下文快照 | turn 开始时由 `turnSnapshotWriter` 写入 |
| `compaction_snapshots` | 上下文压缩前后双 snapshot | `autoCompressor.compress()` 调用前后 |

CLI 模式（`CLIDatabaseService`）和 Tauri 模式（`DatabaseService`）都加了表 + 方法（共 484 行）。这跟 [Code Agent 架构要点 — 双数据库陷阱](../knowledge/architecture.md) 段一致：两个 service 必须各自维护 schema。

### 2. Agent runtime hook 层（commit `3066fe4b`）

在 agent loop 关键位置加快照写入器（321 行）：

| 文件 | 职责 |
|------|------|
| `runtime/turnSnapshotWriter.ts`（新增 147 行） | 序列化 turn 进入态写入 `turn_snapshots` |
| `context/compactionSnapshotWriter.ts`（新增 96 行） | 压缩前后双写 `compaction_snapshots` |
| `runtime/conversationRuntime.ts`（+22 行） | 在 turn 开始前调 `turnSnapshotWriter` |
| `context/autoCompressor.ts`（+22 行） | 在 compress 前后调 `compactionSnapshotWriter` |
| `runtime/stepPause.ts`（新增 34 行） | 步进暂停机制（dev 时单 turn 卡住等指令） |

### 3. IPC 层（commit `8f147e1e`）

`data` domain 新增 3 个 IPC channel（共 81 行改动）：

```
data:snapshot-stats      → 统计 turn + compaction snapshot 占用空间
data:snapshot-clear      → 清理 snapshot（按时间 / session / 全部）
data:snapshot-retention  → 设置 retention（保留多久 / 保留多少条）
```

`initBackgroundServices.ts` +20 行注册 retention 后台清理任务。

### 4. 设置 UI 层（commit `9499e2ef`）

`DataSettings.tsx` +108 行加"调试快照"段：
- 显示当前占用空间（turn + compaction 分开）
- retention 选择器（保留 1 天 / 7 天 / 30 天 / 永久）
- 一键清理按钮

### 5. CLI debug 命令树层（commit `a1e29f0c`）

`code-agent debug` 子命令树（754 行 `debug.ts` + 配套 `_loadTestCase` `_runToolDirectly` helpers）：

```
code-agent debug
├── stats                               显示快照占用统计
├── clear [options]                     清理快照（同时清 turn + compaction）
├── session <sessionId>                 列出 session 的所有 turn 快照
├── context <sessionId>                 看具体 turn 的完整上下文（默认最后一个）
├── loop                                Agent loop 分析子命令
├── compact                             上下文压缩分析（diff）
├── tool                                工具直接执行（不经过 agent loop）
├── replay [caseId]                     加载 YAML test case 并真跑一遍
└── diff <sessionA> <sessionB>          两个 session turn-by-turn 对比
```

`execTool.ts` 重构（-110 行）抽出公共逻辑到 `_runToolDirectly`，让 `debug tool` 和 `exec-tool` 共用。

## 关键能力

### 能力 1：还原跑偏 case 的完整上下文

```bash
# 评测中心跑出某 case fail，拿 sessionId 查
code-agent debug session 7937dfe0-baa8-406d-b5ce-27a4529cefad

# 看具体 turn 进入时的完整 context（system prompt + messages + tools + memory）
code-agent debug context 7937dfe0-... --turn 3
```

### 能力 2：压缩前后 diff

```bash
# 看某 session 所有 compaction 节点
code-agent debug compact --session <sid>

# 对比压缩前后丢了什么
code-agent debug compact --session <sid> --diff
```

### 能力 3：复现某 testCase 的真实行为

```bash
# 真跑一遍 testCase（不经过评测中心 IPC）
code-agent debug replay task-create-js-file --model qwen3.5:9b --provider local
```

### 能力 4：两 session 行为分裂定位

```bash
# 同一 testCase 两次跑结果不同，直接 turn-by-turn diff
code-agent debug diff session_v1_id session_v2_id
```

### 能力 5：步进暂停（dev 调试）

`stepPause.ts` 提供机制让 agent loop 跑到指定 turn 后暂停等指令——便于 attach debugger 或人工检查。生产环境默认关闭。

## 选项考虑

**方案 A（采纳）**：DB 持久化 + IPC + CLI + UI 5 层 — **完整闭环**，可以脱离当前会话事后回放
**方案 B**：只内存中保留最近 N turn 的 snapshot — **不能跨进程**，重启就丢
**方案 C**：写文件而不是 DB — **不能 SQL 查询**，难做 session diff 这种关联查询

## retention 决策

默认 7 天 retention。`compaction_snapshots` 数据量比 `turn_snapshots` 小一个量级（每个 session 通常 0-3 次压缩 vs 几十 turn），但单条更大（要存压缩前后两份完整 context）。retention 后台清理跑在 `initBackgroundServices` 启动的定时器上。

## 不采纳

- 不在 turn snapshot 里存模型 raw response — `agentLoop` 已有 `modelDecision` 字段记录
- 不做 snapshot 的实时流式推送 — 只在 turn 边界写一次，不影响 agent loop 性能
- 不引入第三方 timeline DB（如 EventStore） — SQLite 索引足够支撑现有规模

## 关联

- ADR-005 评测工程：[005-eval-engineering.md](./005-eval-engineering.md)
- Code Agent 架构要点（双 DB schema 陷阱）
- Commits:
  - `fedf09da feat(db): add turn_snapshots + compaction_snapshots schema and methods`
  - `3066fe4b feat(agent): hook turn + compaction snapshot writers; add step pause`
  - `8f147e1e feat(ipc): expose snapshot stats/clear/retention via data domain`
  - `9499e2ef feat(settings): add 调试快照 section with retention selector`
  - `a1e29f0c feat(cli): add code-agent debug command tree`
