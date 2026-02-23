# SpreadsheetBench 评测工具分析

> 来源：翟老师直播截图分析（2026-02-08）
> 用途：后续优化自有评测系统的参考

---

## 1. 工具概述

**SpreadsheetBench** 是一个专门评测 AI Agent 执行 Excel/电子表格操作能力的 Benchmark 平台。

- **被测 Agent**: ExcelMaster Agent（基于 kimi-k2.5 模型）
- **测试规模**: 408 个用例
- **界面组成**:
  - **SpreadsheetBench Viewer** — 用例总览 + Excel 文件 Cell-Level 对比
  - **Agent Debug Console** — 单条用例的深度调试与逐轮追踪

---

## 2. 评测维度（11 个）

### 核心维度（高权重）

| 维度 | 权重 | 评测内容 |
|------|------|---------|
| **outcome_verification** | 35% | 最终结果是否正确，Cell-Level 逐格对比 |
| **code_quality** | 20% | 生成代码/公式质量，是否使用了正确 API（如 openpyxl） |
| **task_understanding** | 15% | Agent 是否正确理解了用户任务需求 |
| **execution_errors** | 10% | Bash 执行过程中的错误数量和错误率 |

### 过程维度（中低权重）

| 维度 | 权重 | 评测内容 |
|------|------|---------|
| **self_repair** | 5% | Agent 遇到报错后能否自行修复，而非放弃 |
| **verification_quality** | 5% | Agent 是否主动验证了结果（如截图确认、读取输出对比） |
| **forbidden_patterns** | 5% | 是否使用了禁止操作（如 `machine_hooks`、文件越权、`HIGHCRITICAL`） |
| **workflow_compliance** | 5% | 是否遵循预定工作流（backup → 操作 → 验证） |
| **plan_quality** | 5% | TodoWrite 中任务规划的质量和合理性 |
| **tool_selection** | 3% | 是否选择了正确的工具（如用 Python/openpyxl 而非 VBA 处理 cell 级操作） |

### 信息性维度（不计分）

| 维度 | 权重 | 评测内容 |
|------|------|---------|
| **efficiency_metrics** | 仅供参考 | 轮次数、token 消耗、执行时长，不计入总分 |

### 评分状态类型

- **PASS** — 完全通过
- **FAIL** — 未通过
- **PARTIAL** — 部分通过（有扣分项）
- **SKIP** — 不适用/跳过
- **INFO** — 仅展示信息，不评分

---

## 3. 透明化的过程信息

### 3.1 逐轮执行追踪（Turn-by-Turn Trace）

每个 Turn 展示：
- 调用的工具类型（TodoWrite / Bash / Write / backup / screenshot / task_complete）
- 每轮的精确时间戳
- 每轮的输入输出内容
- Turn 间的因果链

**价值**: 可以精确定位 Agent 在第几轮、用什么工具时出了问题。

### 3.2 System Prompt 与 User Message 结构分析

- System Prompt 字符数统计（如 6988 CHARS）
- User Message 字符数统计（如 13791 CHARS）
- 可展开查看完整的 Prompt 内容
- ExcelMaster Agent 的指令定义可见（含 backup/restore、VBA 执行等能力声明）

**价值**: 可以分析 Prompt 长度与任务成功率的关系。

### 3.3 Token 消耗明细

底部面板显示：
- Total / Input / Output token 分别统计
- 执行总时长（如 97.78s）
- 实际轮次数（如 21 turns）
- 模型版本（kimi-k2.5, v0.3.0）

**价值**: 成本分析与效率优化。

### 3.4 错误分类体系

12 种预定义错误类型，可按类型筛选：

| 错误类型 | 含义 |
|---------|------|
| `formula_syntax_error` | 公式语法错误 |
| `vba_logic_error` | VBA 逻辑错误 |
| `wrong_range` | 引用范围错误 |
| `data_loss` | 数据丢失 |
| `incomplete` | 任务未完成 |
| `wrong_sheet` | 操作了错误的 Sheet |
| `type_semantic_match` | 类型/语义匹配错误 |
| `mismatched_task` | 任务理解偏差 |
| `missing_backup` | 缺少备份操作 |
| `no_recovery` | 未从错误恢复 |
| `timeout` | 超时 |
| `formula_syntax_error` | 公式语法不正确 |

**价值**: 可以按错误类型聚合分析，找到 Agent 最薄弱的环节。

### 3.5 Excel 文件对比

SpreadsheetBench Viewer 中直接展示：
- 原始 Excel（Input）
- Agent 输出（Output）
- Cell-Level 高亮差异
- 支持多 Sheet 切换

**价值**: 直观看到 Agent 做对了什么、做错了什么。

### 3.6 GRADER 评分卡

以卡片矩阵形式展示 11 个维度：
- 每张卡片包含：维度名、权重、具体判定逻辑、PASS/FAIL/PARTIAL 状态
- 扣分原因有详细文字说明
- 支持展开查看原始判定依据

**价值**: 单条用例的全方位"体检报告"。

### 3.7 版本对比与趋势

- 左侧面板展示多个版本的运行记录（v0.1.1 → v0.3.0）
- 每个版本显示运行日期、通过率
- 可对比不同版本的 PASS 率变化（如从 53.6% 提升到某个更高值）

**价值**: 迭代优化时量化进步。

### 3.8 聚合统计仪表盘

右侧栏实时展示：
- TOTAL: 408（总用例数）
- PASS: 32 / FAIL: 14
- RATE: 8.0%
- AVG TIME: 2186.7s
- Trace Viewer 入口

---

## 4. 架构设计亮点

### 4.1 结果与过程双轨评估

不只看最终输出是否正确（outcome_verification 35%），还看过程中的每个环节：
- **怎么规划的**（plan_quality）
- **选了什么工具**（tool_selection）
- **代码写得好不好**（code_quality）
- **出错后怎么处理的**（self_repair, execution_errors）
- **有没有验证**（verification_quality）
- **有没有违规操作**（forbidden_patterns）
- **是否遵循 SOP**（workflow_compliance）

### 4.2 多粒度查看

- **宏观**: 聚合统计（总通过率、平均耗时）
- **中观**: 用例列表（按分类、状态筛选）
- **微观**: 单条用例逐轮追踪 + 评分卡

### 4.3 可对比性

- 版本间对比（同一用例在不同版本的表现）
- 用例间对比（不同类型任务的通过率差异）

---

## 5. 对我们评测系统优化的启发

### 5.1 可借鉴的维度设计

- **权重分配策略**: 结果正确性 35%（最重要但不是全部），过程质量占 65%
- **forbidden_patterns**: 不只看做对了什么，还看是否做了不该做的事
- **self_repair**: 评估 Agent 的容错恢复能力，这是实际生产中很关键的能力
- **efficiency_metrics 不计分**: 效率作为参考而非硬指标，避免鼓励 Agent 为了速度牺牲质量

### 5.2 可借鉴的透明化手段

- **逐轮 Trace**: 必备功能，是定位问题的核心
- **错误分类标签**: 不只记录"失败"，要细分失败原因
- **Prompt 可视化**: 展示 System Prompt 和 User Message，方便 Prompt 工程调优
- **版本对比**: 必须支持，否则无法量化迭代效果

### 5.3 我们可以增加的维度

- **多轮一致性**: Agent 在多轮对话中是否保持策略一致
- **成本效益比**: 每个用例的 token 消耗 vs 结果质量
- **边界处理**: Agent 对模糊/歧义任务的处理能力
- **安全性**: 是否泄露敏感信息或执行危险操作

---

## 6. 关键数据

| 指标 | 值 |
|------|-----|
| 总用例数 | 408 |
| 通过数 | 32 |
| 失败数 | 14-15 |
| 通过率 | 8.0% |
| 平均耗时 | 2186.7s (~36min) |
| Agent Token 平均消耗 | ~289K input / ~6.5K output |
| 模型 | kimi-k2.5 |
| Agent 版本 | v0.3.0 |
| 最大轮次限制 | 48 turns |
