# Code Agent 评测系统架构文档

> 最后更新：2026-02-08
> 源码位置：`src/main/evaluation/` + `src/renderer/components/features/evaluation/`

---

## 目录

1. [系统概览](#1-系统概览)
2. [后端架构](#2-后端架构)
3. [前端架构](#3-前端架构)
4. [数据流](#4-数据流)
5. [评测维度与评分算法](#5-评测维度与评分算法)
6. [三层评测引擎](#6-三层评测引擎)
7. [IPC 通道定义](#7-ipc-通道定义)
8. [数据库 Schema](#8-数据库-schema)
9. [文件清单](#9-文件清单)

---

## 1. 系统概览

评测系统对 Code Agent 的每次会话进行多维度打分，支持三层 fallback 评估引擎：

```
SwissCheeseEvaluator（4 个 LLM 评审员并发）
    ↓ 失败
AIEvaluator（单次 LLM 调用）
    ↓ 失败
RuleBasedEvaluation（6 个规则评估器，无 LLM）
```

评测分为两个层次：
- **客观指标**（Objective）：从数据库直接计算，无需 LLM，毫秒级返回
- **主观评测**（Subjective）：调用 LLM 进行语义级评估，按需触发

### 评分体系

| 等级 | 分数范围 | 颜色 |
|------|---------|------|
| S | ≥ 95 | 紫色 |
| A | 80–94 | 绿色 |
| B | 70–79 | 蓝色 |
| C | 60–69 | 黄色 |
| D | 50–59 | 橙色 |
| F | < 50 | 红色 |

### 六大评测维度

| 维度 | 权重 | 图标 |
|------|------|------|
| 任务完成度 (TASK_COMPLETION) | 30% | ✅ |
| 工具效率 (TOOL_EFFICIENCY) | 20% | 🔧 |
| 对话质量 (DIALOG_QUALITY) | 15% | 💬 |
| 代码质量 (CODE_QUALITY) | 15% | 📝 |
| 性能表现 (PERFORMANCE) | 10% | ⚡ |
| 安全性 (SECURITY) | 10% | 🔒 |

---

## 2. 后端架构

### 2.1 核心服务

#### EvaluationService（448 行）

主编排服务，单例模式。负责：
- 会话数据收集（messages + tool_uses 表）
- 三层 fallback 评估调度
- 结果持久化到 SQLite
- 导出报告（Markdown / JSON）

```
evaluateSession(sessionId, options)
  1. collectSessionData(sessionId) → SessionSnapshot
  2. try SwissCheeseEvaluator
     catch → try AIEvaluator
     catch → runRuleBasedEvaluation()
  3. 组装 EvaluationResult（综合得分、等级、建议）
  4. 可选保存到数据库
```

#### SessionAnalyticsService（399 行）

客观指标计算服务，单例模式，不依赖 LLM：

| 类别 | 指标 |
|------|------|
| 消息 | 总数、用户/助手消息数、平均长度 |
| 工具 | 调用总数、成功/失败数、成功率、按工具分类、平均延迟 |
| Token | 输入/输出 Token、总消耗、估算成本 |
| 代码 | 含代码消息数、代码块数量 |
| 时间 | 会话时长、平均响应时间、轮次数 |

成本公式：`inputTokens × $0.00003 + outputTokens × $0.00006`

#### SessionEventService（299 行）

SSE 事件流持久化服务：
- 存储表：`session_events`
- 事件类型：`tool_start`、`tool_result`、`thinking`、`error`、`message`
- 提供 `buildEventSummaryForEvaluation()` 构建评测用的事件摘要
- 自动清理 30 天前的旧事件

### 2.2 数据类型

#### SessionSnapshot（内部类型）

```typescript
interface SessionSnapshot {
  sessionId: string;
  messages: SessionMessage[];      // role + content + timestamp
  toolCalls: ToolCallRecord[];     // name + args + result + success + duration
  startTime: number;
  endTime: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
}
```

#### EvaluationResult（公开类型）

```typescript
interface EvaluationResult {
  id: string;                      // UUID
  sessionId: string;
  timestamp: number;
  overallScore: number;            // 0-100，加权平均
  grade: EvaluationGrade;          // S/A/B/C/D/F
  metrics: EvaluationMetric[];     // 各维度评分
  statistics: EvaluationStatistics; // 会话统计
  topSuggestions: string[];        // Top 5 改进建议
  aiSummary?: string;              // AI 生成的总结
}
```

---

## 3. 前端架构

### 3.1 技术栈

- **框架**：React（Electron 渲染进程）
- **状态管理**：Zustand（appStore + sessionStore）
- **可视化**：SVG 原生绘制（无第三方图表库）
- **样式**：Tailwind CSS

### 3.2 组件结构

```
src/renderer/components/features/evaluation/
├── EvaluationPanelV2.tsx     # 主面板（当前版本）
├── EvaluationPanel.tsx       # 旧版面板（向后兼容）
├── EvaluationTrigger.tsx     # 评测触发按钮
├── MetricCard.tsx            # 单维度评分卡片
└── RadarChart.tsx            # 雷达图可视化
```

#### EvaluationPanelV2（主面板）

工作流程：
1. 打开面板 → 自动加载客观指标（`EVALUATION_GET_SESSION_ANALYSIS`）
2. 显示统计卡片（会话时长、轮次、工具调用、Token、成本）
3. 显示 SSE 事件流摘要 + 历史评测记录
4. 用户点击"开始深度评测" → 调用 `EVALUATION_RUN_SUBJECTIVE`
5. 展示 4 位 AI 评审员结果（任务分析师、代码审查员、安全审计员、UX 专家）

主要内容块：
- **StatCard** 统计卡片 — 单项指标展示
- **综合得分** — 0-100 分 + 等级标识
- **评审员共识** — 各评审员通过/未通过
- **维度得分** — MetricCard 列表
- **代码验证** — 语法检查结果
- **改进建议** — AI 生成的建议清单

#### MetricCard（评分卡片）

- 可展开/折叠设计
- 显示：维度名称 + 等级 + 分数 + 权重 + 进度条
- 进度条颜色编码：绿 ≥80 / 蓝 ≥60 / 黄 ≥40 / 红 <40
- 展开后显示：AI 分析理由、子指标、改进建议

#### RadarChart（雷达图）

- SVG 原生实现，5 层网格 + 数据多边形
- 360° 展示各评测维度的分数分布

### 3.3 触发入口

| 入口 | 位置 | 方式 |
|------|------|------|
| 标题栏奶酪图标 | TitleBar.tsx 右上角 | 点击按钮（amber 色调） |
| 命令面板 | CommandPalette.tsx | Cmd+K → "会话评测" |
| 全局包装器 | App.tsx | EvaluationPanelWrapper 组件 |

### 3.4 状态管理

```typescript
// appStore.ts
showEvaluation: boolean;
setShowEvaluation: (show: boolean) => void;

// sessionStore.ts
currentSessionId: string | null;
```

---

## 4. 数据流

### 4.1 客观指标流（毫秒级）

```
用户点击奶酪图标
  → appStore.setShowEvaluation(true)
  → EvaluationPanelV2 挂载
  → ipcRenderer.invoke('evaluation:get-session-analysis', sessionId)
  → SessionAnalyticsService.getSessionAnalysis()
      ├─ calculateObjectiveMetrics()  → 从 DB 查询消息/工具/Token
      ├─ listHistory()               → 历史评测记录
      └─ SessionEventService.buildEventSummaryForEvaluation()
  → 返回 { objective, previousEvaluations, eventSummary }
  → StatCard + 事件摘要渲染
```

### 4.2 主观评测流（秒级）

```
用户点击"开始深度评测"
  → ipcRenderer.invoke('evaluation:run-subjective', { sessionId, save: true })
  → evaluation.ipc.ts handler:
      1. getObjectiveMetrics(sessionId)
      2. collectSessionSnapshot(sessionId)
      3. SwissCheeseEvaluator.evaluate(snapshot)
          ├─ 4 个评审员并发 LLM 调用（Kimi K2.5）
          ├─ 代码语法验证（正则括号匹配）
          └─ 结果聚合（40% 最低分 + 60% 平均分）
      4. convertToMetrics() → EvaluationMetric[]
      5. 保存到 evaluations 表
  → 返回 { overallScore, grade, reviewerResults, suggestions, ... }
  → MetricCard + RadarChart 渲染
```

### 4.3 完整架构图

```
┌──────────────────── Renderer Process ────────────────────┐
│                                                          │
│  TitleBar 🧀  ──→  appStore.showEvaluation = true       │
│  CommandPalette     ↓                                    │
│                  EvaluationPanelV2                        │
│                  ├─ StatCard × N                         │
│                  ├─ MetricCard × 6                       │
│                  └─ RadarChart (SVG)                     │
│                      │                                   │
└──────────────────────┼───────────────────────────────────┘
                       │ IPC
┌──────────────────────┼───── Main Process ────────────────┐
│                      ↓                                   │
│  evaluation.ipc.ts (8 个 handler)                        │
│      │                                                   │
│      ├─→ SessionAnalyticsService (客观，无 LLM)          │
│      │     └─ DB: messages, tool_uses, session_events    │
│      │                                                   │
│      └─→ EvaluationService (主观，三层 fallback)         │
│            ├─ SwissCheeseEvaluator (4 评审员并发)        │
│            ├─ AIEvaluator (单次 LLM)                     │
│            └─ RuleBasedEvaluation (6 个 DimensionEval)   │
│                  ├─ TaskCompletionEvaluator               │
│                  ├─ ToolEfficiencyEvaluator               │
│                  ├─ DialogQualityEvaluator                │
│                  ├─ CodeQualityEvaluator                  │
│                  ├─ PerformanceEvaluator                  │
│                  └─ SecurityEvaluator                     │
│                                                          │
│  ParallelEvaluator (候选方案选择，独立模块)               │
│  SessionEventService (SSE 事件持久化)                    │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

---

## 5. 评测维度与评分算法

### 5.1 任务完成度（30%）— taskCompletion.ts, 72 行

| 子指标 | 权重 | 计算方式 |
|--------|------|---------|
| 工具成功率 | 40% | `successCalls / totalCalls × 100` |
| 交互轮次效率 | 30% | `max(0, 100 - |userMessages - 4| × 10)`，理想 3-5 轮 |
| 任务完成状态 | 30% | 末尾消息匹配"完成/已/done/成功" → 100，否则 60 |

建议触发：成功率 < 80%；轮次 > 10

### 5.2 工具效率（20%）— toolEfficiency.ts, 107 行

| 子指标 | 权重 | 计算方式 |
|--------|------|---------|
| 成功率 | 50% | `successful / total × 100` |
| 冗余率 | 30% | 最近 10 次调用中 name+args 重复的比例，得分 = `100 - redundancyRate` |
| 工具多样性 | 20% | `min(distinctToolTypes × 10, 100)` |

冗余检测：跟踪最近 10 次调用，`name + JSON.stringify(args)` 完全相同视为冗余。

建议触发：冗余率 > 20%；失败率 > 30%

### 5.3 对话质量（15%）— dialogQuality.ts, 93 行

| 子指标 | 权重 | 计算方式 |
|--------|------|---------|
| 轮次评分 | 40% | 3-7 轮 = 100；< 3 = 70；> 7 = `max(50, 100 - (turns-7)×5)` |
| 平均响应长度 | 30% | 100-2000 字符 = 100；< 100 = 60；> 2000 递减 |
| 连贯性 | 30% | 消息平均间隔 > 5 分钟 = 70，否则 100 |

建议触发：平均长度 < 100 或 > 2000 字符

### 5.4 代码质量（15%）— codeQuality.ts, 85 行

监控工具：`write_file`、`edit_file`、`read_file`、`bash`

| 子指标 | 权重 | 计算方式 |
|--------|------|---------|
| 代码操作成功率 | 60% | `successCodeOps / totalCodeOps × 100` |
| 读写比例 | 40% | `readCalls / writeCalls ≥ 0.5` → 100，< 0.5 → 70 |

无代码操作时默认 85 分。

建议触发：成功率 < 70%；读写比 < 0.5

### 5.5 性能表现（10%）— performance.ts, 98 行

| 子指标 | 权重 | 计算方式 |
|--------|------|---------|
| 会话时长 | 30% | 1-10 分钟 = 100；< 1 = 90；> 10 递减，最低 50 |
| Token 比例 | 35% | output/input 在 0.5-3 = 100；> 3 = 80；其他 = 70 |
| 成本 | 35% | ≤ $0.01 = 100；≤ $0.05 = 90；≤ $0.10 = 80；> $0.10 递减 |

建议触发：时长 > 30 分钟；Token 比 > 3；成本 > $0.10

### 5.6 安全性（10%）— security.ts, 114 行

**危险命令检测**（10 个正则）：
`rm -rf /`、`sudo rm`、fork bomb、`dd if=`、`mkfs.`、`chmod -R 777`、`curl|bash`、`wget|sh`、`>/dev/sd*`

**敏感文件检测**（9 个正则）：
`.env`、`.pem`、`.key`、`id_rsa`、`credentials`、`password`、`secret`、`.aws/credentials`、`.ssh/`

评分：`100 - dangerousCount × 20 - sensitiveAccessCount × 10`，最低 0。

---

## 6. 三层评测引擎

### 6.1 第一层：SwissCheeseEvaluator（588 行）

瑞士奶酪模型 — 4 个独立评审员并发评估，互相补盲：

| 评审员 | 关注点 |
|--------|--------|
| 任务分析师 | 任务完成度 |
| 代码审查员 | 代码质量 |
| 安全审计员 | 安全风险 |
| UX 专家 | 沟通质量 |

**执行细节**：
- 4 个评审员通过 `ModelRouter` 并发调用 LLM
- 每个评审员打 5 个维度分（0-100）
- 对话截断：总 8000 字符，单条消息 1500 字符
- LLM 最大输出 Token：1500

**聚合策略**（保守模型）：
```
维度得分 = 最低分 × 40% + 平均分 × 60%
```

**最终加权**：
```
综合分 = 任务 × 30% + 质量 × 20% + 代码 × 20% + 效率 × 15% + 安全 × 15%
```

附加代码验证：正则括号匹配检查语法有效性（不执行代码）。

### 6.2 第二层：AIEvaluator（308 行）

单次 LLM 调用的快速评估：
- 5 个维度：任务完成、响应质量、代码质量、效率、沟通
- 评分标准：90-100 优秀 / 70-89 良好 / 50-69 一般 / 0-49 差
- 无代码场景默认 80 分
- 对话截断：12000 字符，单消息 2000 字符
- LLM 最大输出 Token：2000

### 6.3 第三层：RuleBasedEvaluation（6 个 DimensionEvaluator）

纯规则评估，无 LLM 依赖：
- 6 个独立评估器实现 `DimensionEvaluator` 接口
- 每个评估器异步返回 `EvaluationMetric`
- 加权平均得到综合分
- 详见第 5 节各维度算法

### 6.4 ParallelEvaluator（494 行，独立模块）

多候选方案选择引擎，用于比较多个代码方案的优劣：

| 策略 | 算法 | 适用场景 |
|------|------|---------|
| best | 单评估器比较 | 快速评估，低成本 |
| vote | 各维度多数投票 | 民主共识 |
| weighted | 加权求和 | 精细权衡 |

8 个评分维度：正确性 25%、效率 15%、可读性 15%、可维护性 15%、安全性 10%、性能 10%、覆盖率 5%、简洁性 5%。

---

## 7. IPC 通道定义

定义位置：`src/shared/ipc/channels.ts`

| 通道 | 方向 | 用途 |
|------|------|------|
| `evaluation:run` | renderer → main | 执行完整评测（三层 fallback） |
| `evaluation:get-result` | renderer → main | 获取单次评测结果 |
| `evaluation:list-history` | renderer → main | 获取评测历史列表 |
| `evaluation:export` | renderer → main | 导出报告（JSON / Markdown） |
| `evaluation:delete` | renderer → main | 删除评测记录 |
| `evaluation:get-objective-metrics` | renderer → main | 获取客观指标（无 LLM，即时返回） |
| `evaluation:get-session-analysis` | renderer → main | 获取完整会话分析（客观 + 历史） |
| `evaluation:run-subjective` | renderer → main | 执行 LLM 主观评测（SwissCheese） |

---

## 8. 数据库 Schema

存储位置：`~/.code-agent/code-agent.db`（SQLite）

### evaluations 表

```sql
CREATE TABLE evaluations (
  id        TEXT PRIMARY KEY,     -- UUID
  session_id TEXT NOT NULL,       -- 关联会话 ID
  timestamp  INTEGER NOT NULL,    -- 评测时间戳（ms）
  score      INTEGER NOT NULL,    -- 综合得分 0-100
  grade      TEXT NOT NULL,       -- 等级 S/A/B/C/D/F
  data       TEXT NOT NULL        -- 完整 EvaluationResult JSON
);
```

### session_events 表

```sql
CREATE TABLE session_events (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,       -- tool_start, tool_result, thinking, error, message
  event_data TEXT NOT NULL,       -- JSON
  timestamp  INTEGER NOT NULL
);
```

### 关联表

| 表名 | 用途 |
|------|------|
| `messages` | 会话消息（role, content, timestamp） |
| `tool_uses` | 工具调用记录（name, args, result, success, duration） |
| `telemetry_turns` | 轮次级遥测 |
| `telemetry_tool_calls` | 工具调用遥测 |

---

## 9. 文件清单

### 后端（Main Process）

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/main/evaluation/EvaluationService.ts` | 448 | 主编排服务，三层 fallback |
| `src/main/evaluation/swissCheeseEvaluator.ts` | 588 | 瑞士奶酪多评审员引擎 |
| `src/main/evaluation/aiEvaluator.ts` | 308 | 单次 LLM 评估 |
| `src/main/evaluation/parallelEvaluator.ts` | 494 | 多候选方案选择 |
| `src/main/evaluation/sessionAnalyticsService.ts` | 399 | 客观指标计算 |
| `src/main/evaluation/sessionEventService.ts` | 299 | SSE 事件持久化 |
| `src/main/evaluation/types.ts` | 62 | 内部类型定义 |
| `src/main/evaluation/index.ts` | 9 | 模块导出 |
| `src/main/evaluation/metrics/index.ts` | 11 | 指标评估器导出 |
| `src/main/evaluation/metrics/taskCompletion.ts` | 72 | 任务完成度评估 |
| `src/main/evaluation/metrics/toolEfficiency.ts` | 107 | 工具效率评估 |
| `src/main/evaluation/metrics/dialogQuality.ts` | 93 | 对话质量评估 |
| `src/main/evaluation/metrics/codeQuality.ts` | 85 | 代码质量评估 |
| `src/main/evaluation/metrics/performance.ts` | 98 | 性能表现评估 |
| `src/main/evaluation/metrics/security.ts` | 114 | 安全性评估 |
| `src/main/ipc/evaluation.ipc.ts` | 179 | IPC 桥接层 |
| `src/shared/types/evaluation.ts` | 143 | 公开类型 + 常量 |
| `src/shared/ipc/channels.ts` | — | IPC 通道名定义 |

### 前端（Renderer Process）

| 文件 | 职责 |
|------|------|
| `src/renderer/components/features/evaluation/EvaluationPanelV2.tsx` | 主评测面板（当前版本） |
| `src/renderer/components/features/evaluation/EvaluationPanel.tsx` | 旧版面板（向后兼容） |
| `src/renderer/components/features/evaluation/EvaluationTrigger.tsx` | 评测触发按钮 |
| `src/renderer/components/features/evaluation/MetricCard.tsx` | 单维度评分卡片（可展开） |
| `src/renderer/components/features/evaluation/RadarChart.tsx` | 雷达图（SVG 原生） |
| `src/renderer/stores/appStore.ts` | `showEvaluation` 状态 |
| `src/renderer/stores/sessionStore.ts` | `currentSessionId` 状态 |

### 触发集成点

| 文件 | 集成方式 |
|------|---------|
| `src/renderer/components/layout/TitleBar.tsx` | 右上角奶酪图标按钮 |
| `src/renderer/components/features/CommandPalette.tsx` | Cmd+K → "会话评测" |
| `src/renderer/App.tsx` | 全局 EvaluationPanelWrapper |

---

## 设计模式总结

| 模式 | 应用 |
|------|------|
| **Singleton** | 所有 Service 类（EvaluationService, SessionAnalyticsService 等） |
| **Fallback/Cascade** | 三层评测引擎自动降级 |
| **Strategy** | `DimensionEvaluator` 接口，可插拔维度评估器 |
| **Parallel Execution** | SwissCheeseEvaluator 4 个评审员并发 |
| **Adapter** | `convertToMetrics()` 统一不同引擎的输出格式 |
| **Observer/IPC** | Electron IPC 桥接前后端 |
