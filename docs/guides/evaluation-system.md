# Code Agent 评测系统架构文档

> 最后更新：2026-03-09
> 源码位置：`src/main/evaluation/` + `src/renderer/components/features/evaluation/`

---

## 目录

1. [系统概览](#1-系统概览)
2. [双管线架构](#2-双管线架构)
3. [后端架构](#3-后端架构)
4. [前端架构](#4-前端架构)
5. [数据流](#5-数据流)
6. [评测维度与评分算法](#6-评测维度与评分算法)
7. [评分配置](#7-评分配置)
8. [三层评测引擎](#8-三层评测引擎)
9. [失败漏斗分析](#9-失败漏斗分析)
10. [IPC 通道定义](#10-ipc-通道定义)
11. [CLI 批量评测](#11-cli-批量评测)
12. [日志系统](#12-日志系统)
13. [错误分类](#13-错误分类)
14. [数据库 Schema](#14-数据库-schema)
15. [文件清单](#15-文件清单)

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

## 2. 双管线架构

评测系统采用双管线（Dual-Pipeline）架构，分别处理会话评测和批量评测两种场景：

```
┌─────────────────────────────────────────────────────────────┐
│                    Pipeline A: 会话评测                       │
│  EvaluationService → SwissCheese 4-Reviewer → LLM-as-Judge  │
│  触发: 用户手动 / 会话结束自动                                  │
│  输出: evaluations 表（主观评分 + AI 建议）                     │
└─────────────────────────────────────────────────────────────┘
         ↕ ExperimentAdapter（桥接层）
┌─────────────────────────────────────────────────────────────┐
│                    Pipeline B: 批量评测                       │
│  TestRunner → 确定性断言（15+ 断言类型）→ 结果聚合              │
│  触发: eval-ci.ts CLI / CI 管道                               │
│  输出: experiments + experiment_cases 表                      │
└─────────────────────────────────────────────────────────────┘
```

### Pipeline A — EvaluationService（会话评测）

- **触发方式**：用户点击奶酪图标 / 命令面板 / 会话结束自动触发
- **评估引擎**：SwissCheese 4-Reviewer 共识机制（LLM-as-Judge）
- **输出**：多维度评分 + AI 改进建议，写入 `evaluations` 表
- **特点**：概率性判断，依赖 LLM 质量

### Pipeline B — TestRunner（批量评测）

- **触发方式**：`eval-ci.ts` CLI 命令 / CI/CD 管道
- **评估引擎**：确定性断言，15+ 断言类型（文件存在、内容匹配、JSON Schema、行数范围等）
- **输出**：pass/fail 结果 + 详细断言日志，写入 `experiments` + `experiment_cases` 表
- **特点**：可重复、确定性，无 LLM 依赖

### 桥接层 — ExperimentAdapter

将 TestRunner 的批量评测结果转换为实验系统的数据格式：

- `TestRunResult` → `experiments` 表（实验元数据）
- `TestCaseResult[]` → `experiment_cases` 表（用例级别结果）
- 支持失败漏斗分析和跨实验对比

### 新增 IPC 通道（4 个）

| 通道 | 用途 |
|------|------|
| `evaluation:list-experiments` | 获取实验列表 |
| `evaluation:load-experiment` | 加载实验详情 + 用例数据 |
| `evaluation:get-failure-funnel` | 获取失败漏斗分析数据 |
| `evaluation:get-cross-experiment` | 跨实验对比数据 |

---

## 3. 后端架构

### 3.1 核心服务

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
  5. 可选 Trajectory 分析（dynamic import，失败不影响主流程）
     → TrajectoryBuilder 构建事件流 → DeviationDetector 检测偏差
     → 结果写入 EvaluationResult.trajectoryAnalysis
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

### 3.2 数据类型

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
  trajectoryAnalysis?: TrajectoryAnalysis; // 可选，Trajectory 偏差检测结果
  aiSummary?: string;              // AI 生成的总结
}
```

---

## 4. 前端架构

### 4.1 技术栈

- **框架**：React（Electron 渲染进程）
- **状态管理**：Zustand（appStore + sessionStore）
- **可视化**：SVG 原生绘制（无第三方图表库）
- **样式**：Tailwind CSS

### 4.2 组件结构

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

### 4.3 触发入口

| 入口 | 位置 | 方式 |
|------|------|------|
| 标题栏奶酪图标 | TitleBar.tsx 右上角 | 点击按钮（amber 色调） |
| 命令面板 | CommandPalette.tsx | Cmd+K → "会话评测" |
| 全局包装器 | App.tsx | EvaluationPanelWrapper 组件 |

### 4.4 状态管理

```typescript
// appStore.ts
showEvaluation: boolean;
setShowEvaluation: (show: boolean) => void;

// sessionStore.ts
currentSessionId: string | null;
```

---

## 5. 数据流

### 5.1 客观指标流（毫秒级）

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

### 5.2 主观评测流（秒级）

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

### 5.3 完整架构图

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
│  evaluation.ipc.ts (12 个 handler)                       │
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

## 6. 评测维度与评分算法

### 6.1 任务完成度（30%）— taskCompletion.ts, 72 行

| 子指标 | 权重 | 计算方式 |
|--------|------|---------|
| 工具成功率 | 40% | `successCalls / totalCalls × 100` |
| 交互轮次效率 | 30% | `max(0, 100 - |userMessages - 4| × 10)`，理想 3-5 轮 |
| 任务完成状态 | 30% | 末尾消息匹配"完成/已/done/成功" → 100，否则 60 |

建议触发：成功率 < 80%；轮次 > 10

### 6.2 工具效率（20%）— toolEfficiency.ts, 107 行

| 子指标 | 权重 | 计算方式 |
|--------|------|---------|
| 成功率 | 50% | `successful / total × 100` |
| 冗余率 | 30% | 最近 10 次调用中 name+args 重复的比例，得分 = `100 - redundancyRate` |
| 工具多样性 | 20% | `min(distinctToolTypes × 10, 100)` |

冗余检测：跟踪最近 10 次调用，`name + JSON.stringify(args)` 完全相同视为冗余。

建议触发：冗余率 > 20%；失败率 > 30%

### 6.3 对话质量（15%）— dialogQuality.ts, 93 行

| 子指标 | 权重 | 计算方式 |
|--------|------|---------|
| 轮次评分 | 40% | 3-7 轮 = 100；< 3 = 70；> 7 = `max(50, 100 - (turns-7)×5)` |
| 平均响应长度 | 30% | 100-2000 字符 = 100；< 100 = 60；> 2000 递减 |
| 连贯性 | 30% | 消息平均间隔 > 5 分钟 = 70，否则 100 |

建议触发：平均长度 < 100 或 > 2000 字符

### 6.4 代码质量（15%）— codeQuality.ts, 85 行

监控工具：`write_file`、`edit_file`、`read_file`、`bash`

| 子指标 | 权重 | 计算方式 |
|--------|------|---------|
| 代码操作成功率 | 60% | `successCodeOps / totalCodeOps × 100` |
| 读写比例 | 40% | `readCalls / writeCalls ≥ 0.5` → 100，< 0.5 → 70 |

无代码操作时默认 85 分。

建议触发：成功率 < 70%；读写比 < 0.5

### 6.5 性能表现（10%）— performance.ts, 98 行

| 子指标 | 权重 | 计算方式 |
|--------|------|---------|
| 会话时长 | 30% | 1-10 分钟 = 100；< 1 = 90；> 10 递减，最低 50 |
| Token 比例 | 35% | output/input 在 0.5-3 = 100；> 3 = 80；其他 = 70 |
| 成本 | 35% | ≤ $0.01 = 100；≤ $0.05 = 90；≤ $0.10 = 80；> $0.10 递减 |

建议触发：时长 > 30 分钟；Token 比 > 3；成本 > $0.10

### 6.6 安全性（10%）— security.ts, 114 行

**危险命令检测**（10 个正则）：
`rm -rf /`、`sudo rm`、fork bomb、`dd if=`、`mkfs.`、`chmod -R 777`、`curl|bash`、`wget|sh`、`>/dev/sd*`

**敏感文件检测**（9 个正则）：
`.env`、`.pem`、`.key`、`id_rsa`、`credentials`、`password`、`secret`、`.aws/credentials`、`.ssh/`

评分：`100 - dangerousCount × 20 - sensitiveAccessCount × 10`，最低 0。

---

## 7. 评分配置

### 7.1 用户自定义权重

通过 `ScoringConfigPage` 页面，用户可自定义各评分维度的权重。配置文件存储在 `{userData}/scoring-config.json`，由 SwissCheese `evaluate()` 消费。

### 7.2 评分维度（7 + 1 缓冲）

| 维度 | 默认权重 | 说明 |
|------|---------|------|
| outcomeVerification | 35% | 任务结果验证 |
| codeQuality | 20% | 代码质量 |
| security | 15% | 安全性 |
| toolEfficiency | 8% | 工具使用效率 |
| selfRepair | 5% | 自修复能力 |
| verificationQuality | 4% | 验证质量 |
| forbiddenPatterns | 3% | 禁止模式检测 |
| buffer | 10% | 缓冲余量 |

### 7.3 权重归一化

- 自动归一化：所有权重总和 = 1.0
- 负数钳位：负权重自动设为 0
- 全零回退：所有权重为 0 时回退到默认配置

---

## 8. 三层评测引擎

### 8.1 第一层：SwissCheeseEvaluator（588 行）

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

### 8.2 第二层：AIEvaluator（308 行）

单次 LLM 调用的快速评估：
- 5 个维度：任务完成、响应质量、代码质量、效率、沟通
- 评分标准：90-100 优秀 / 70-89 良好 / 50-69 一般 / 0-49 差
- 无代码场景默认 80 分
- 对话截断：12000 字符，单消息 2000 字符
- LLM 最大输出 Token：2000

### 8.3 第三层：RuleBasedEvaluation（6 个 DimensionEvaluator）

纯规则评估，无 LLM 依赖：
- 6 个独立评估器实现 `DimensionEvaluator` 接口
- 每个评估器异步返回 `EvaluationMetric`
- 加权平均得到综合分
- 详见第 5 节各维度算法

### 8.4 ParallelEvaluator（494 行，独立模块）

多候选方案选择引擎，用于比较多个代码方案的优劣：

| 策略 | 算法 | 适用场景 |
|------|------|---------|
| best | 单评估器比较 | 快速评估，低成本 |
| vote | 各维度多数投票 | 民主共识 |
| weighted | 加权求和 | 精细权衡 |

8 个评分维度：正确性 25%、效率 15%、可读性 15%、可维护性 15%、安全性 10%、性能 10%、覆盖率 5%、简洁性 5%。

---

## 9. 失败漏斗分析

Failure Funnel 对实验用例的失败原因进行 5 阶段分类，区分确定性失败和概率性判断：

### 9.1 五阶段漏斗

```
Stage 1: Security Guard    → 安全检查未通过（危险命令/敏感文件）
Stage 2: Compilation       → 编译/语法错误（确定性失败）
Stage 3: Self-Repair       → 自修复尝试失败
Stage 4: Outcome Verify    → 结果验证未通过（断言失败）
Stage 5: LLM Scoring       → LLM 评分低于阈值（概率性判断）
```

### 9.2 分类机制

- 通过 `classifyFailureStage()` 函数实现
- 基于实验用例数据（`experiment_cases` 表）中的错误信息进行正则匹配
- 确定性失败（Stage 1-3）与概率性判断（Stage 4-5）分开统计
- 数据通过 `GET_FAILURE_FUNNEL` IPC 通道获取，前端 `ExperimentDetailPage` 渲染

---

## 10. IPC 通道定义

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
| `evaluation:list-experiments` | renderer → main | 获取实验列表（批量评测结果） |
| `evaluation:load-experiment` | renderer → main | 加载实验详情 + 用例数据 |
| `evaluation:get-failure-funnel` | renderer → main | 获取失败漏斗分析数据 |
| `evaluation:get-cross-experiment` | renderer → main | 跨实验对比数据 |

---

## 11. CLI 批量评测

### eval-ci.ts

CLI 入口，支持在 CI/CD 管道中批量运行评测用例。

**命令行参数**：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--real` | 使用真实 LLM 调用（非 mock） | false |
| `--model` | 指定评测模型 | 配置文件默认 |
| `--provider` | 指定 Provider | 配置文件默认 |
| `--concurrency` | 并发数（正整数校验） | 1 |
| `--max-cases` | 最大用例数 | 50 |
| `--force` | 跳过确认提示 | false |

**安全机制**：
- `--real` 模式下执行前显示成本预估
- `--max-cases` 默认 50，防止意外全量执行
- 并发数校验（必须为正整数）

---

## 12. 日志系统

评测日志采用 JSON 结构化格式，支持 `jq` 查询：

- **格式**：NDJSON（每行一个 JSON 对象）
- **写入方式**：异步写入流（non-blocking），不阻塞主线程
- **轮转策略**：按日轮转，保留最近 7 天
- **存储路径**：`{userData}/logs/` 或 `~/.code-agent/logs/`
- **兼容性**：`jq` 可直接解析

---

## 13. 错误分类

遥测系统将工具调用错误分为 11 个类别，存储在 `telemetry_tool_calls.error_category` 列：

| 类别 | 说明 |
|------|------|
| `syntax_error` | 语法错误 |
| `type_error` | 类型错误 |
| `import_error` | 导入/模块错误 |
| `runtime_error` | 运行时错误 |
| `timeout` | 超时 |
| `permission_error` | 权限错误 |
| `network_error` | 网络错误 |
| `file_not_found` | 文件未找到 |
| `path_hallucination` | 路径幻觉（模型编造不存在的路径） |
| `assertion_failure` | 断言失败 |
| `unknown` | 未分类 |

---

## 14. 数据库 Schema

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

### experiments 表

```sql
CREATE TABLE experiments (
  id          TEXT PRIMARY KEY,     -- 实验 ID
  name        TEXT NOT NULL,        -- 实验名称
  created_at  INTEGER NOT NULL,     -- 创建时间戳（ms）
  config      TEXT NOT NULL,        -- 实验配置 JSON（模型、Provider 等）
  summary     TEXT                  -- 结果摘要 JSON
);
```

### experiment_cases 表

```sql
CREATE TABLE experiment_cases (
  id            TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,       -- 关联实验 ID
  case_id       TEXT NOT NULL,       -- 测试用例 ID
  status        TEXT NOT NULL,       -- pass / fail / error / skip
  score         REAL,                -- 评分（0-100）
  duration_ms   INTEGER,             -- 执行耗时
  error_message TEXT,                -- 错误信息
  assertions    TEXT,                -- 断言结果 JSON
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (experiment_id) REFERENCES experiments(id)
);
```

### 关联表

| 表名 | 用途 |
|------|------|
| `messages` | 会话消息（role, content, timestamp） |
| `tool_uses` | 工具调用记录（name, args, result, success, duration） |
| `telemetry_turns` | 轮次级遥测 |
| `telemetry_tool_calls` | 工具调用遥测（含 `error_category` 列） |

---

## 15. 文件清单

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
| `src/main/evaluation/experimentAdapter.ts` | — | TestRunner → experiments/experiment_cases 桥接 |
| `src/main/evaluation/failureFunnel.ts` | — | 5 阶段失败漏斗分类 |
| `src/main/ipc/evaluation.ipc.ts` | 179+ | IPC 桥接层（12 handler） |
| `src/main/cli/eval-ci.ts` | — | CLI 批量评测入口 |
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
| `src/renderer/components/features/evaluation/ScoringConfigPage.tsx` | 评分权重配置页 |
| `src/renderer/components/features/evaluation/ExperimentDetailPage.tsx` | 实验详情 + 失败漏斗 |
| `src/renderer/components/features/evaluation/CrossExperimentPage.tsx` | 跨实验对比 |
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
