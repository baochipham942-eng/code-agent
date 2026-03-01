# ADR-005: Eval Engineering Key Decisions

> 状态: accepted
> 日期: 2026-02-13

## 背景

在 Excel Agent Benchmark 优化过程中（v14 95% → v19 94.5% → v32 82%），我们积累了一系列关键的工程决策。这些决策覆盖了输出检测、结构验证、任务模式识别、token 管理、bash 预处理和工具描述优化等多个维度，共同构成了 eval 工程的核心策略体系。

这些决策经过多轮评测验证（R20-R23），在 10 个 case 上反复迭代，最终形成了当前的最佳实践。记录这些决策以便后续维护和回溯。

## 决策

### D1: P5 输出检测策略

采用三重检测机制确保 agent 产出正确的输出文件：

- **显式路径检测**：从 agent 消息中提取明确提到的文件路径
- **脚本未执行检测**：检测 agent 生成了脚本但未实际运行的情况，触发 force-execute nudge
- **xlsx-vs-csv 检测**：当任务要求 xlsx 但 agent 产出 csv 时，提示格式转换

已移除 Workspace Diff 方案（通过快照输出目录差异提取文件），因维护成本高于收益。

### D2: P7 输出结构验证

agent 结束前，使用 pandas 读取输出 xlsx 的结构（列名、行数、数据类型），注入给模型进行需求核对。同时运行自动质量检查（空值比例、列数匹配等）。

确保输出文件不仅存在，而且结构正确、内容完整。

### D3: P8 任务模式检测

根据任务描述自动识别任务模式，注入针对性的提示：

| 模式 | 触发条件 | 注入内容 |
|------|----------|----------|
| 异常检测 | 关键词匹配 | 异常检测方法论提示 |
| 透视分析 | 关键词匹配 | 透视表构建指导 |
| 数据清洗 | 关键词匹配 | 6 步系统性清洗检查清单 |
| 多轮任务 | 任务结构分析 | 中间结果保留策略 |

通过 skill 机制注入，不污染通用 prompt。

### D4: maxOutputFileNudges = 3

输出文件检测的最大 nudge 次数设为 3。低于此值时部分 case 会因 agent 未及时修正而丢分；高于此值则浪费 token 且可能导致 agent 进入无效循环。

### D5: Bash 预处理管道

bash 工具输出经过 4 层预处理：

1. **JSON-wrapper**：将 JSON 输出包裹在结构化格式中，防止模型误解
2. **Heredoc 截断**：超长 heredoc 输出自动截断，保留首尾
3. **工具混淆检测**：检测 bash 输出中可能被模型误认为工具调用的模式
4. **stderr 合并输出**：stderr 与 stdout 合并展示，确保错误信息对模型可见（v32 修复 C07 从 6→15）

### D6: maxTokens 按模型查表

不再使用统一的 maxTokens 值，改为按模型查表（`MODEL_MAX_OUTPUT_TOKENS`）：

| 级别 | 值 | 适用 |
|------|-----|------|
| DEFAULT | 16384 | 大部分模型 |
| EXTENDED | 32768 | 支持长输出的模型 |
| 模型专属 | 各异 | 按 provider 文档配置 |

v32 涉及 15 个文件的适配（constants.ts + 8 providers + 6 config）。

### D7: 工具描述优化（Claude Code 风格）

对 10 个核心工具的描述进行 Claude Code 风格重写：

- **明确边界**：每个工具说明能做什么、不能做什么
- **交叉引用**：工具间互相引用（如 edit 失败 2 次 → 用 write 重写）
- **后果说明**：错误使用的后果（如 "参数写进 file_path 会导致文件找不到"）

优化的 10 个工具：read, readXlsx, bash, write, edit, glob, grep, listDirectory, webFetch, webSearch

v32 验证：C06 从 0→18。

## 选项考虑

### 输出检测：Workspace Diff vs 显式路径

- **Workspace Diff**：快照输出目录，通过文件增量检测。优点是不依赖模型输出格式；缺点是实现复杂、IO 开销大、误报多
- **显式路径 + 脚本未执行 + 格式检测**（已采用）：更轻量、更精准、可维护性好

### maxTokens：统一值 vs 按模型查表

- **统一值**：简单，但浪费（小模型用不了那么多）或不足（大模型被限制）
- **按模型查表**（已采用）：精确匹配每个模型的能力，需要维护映射表但收益明显

## 后果

### 积极影响

- 评测分数从 v3 基线大幅提升（132→164 峰值）
- 工程决策可追溯，新问题可快速定位是哪层出了问题
- 工具描述优化后模型工具使用正确率显著提高
- bash stderr 可见性修复解决了一类"模型看不到错误"的系统性问题

### 消极影响

- 评测分数波动仍然较大（R22=164 vs R23=154），需多轮均值才能可靠评估
- 任务模式检测依赖关键词匹配，存在漏检和误检
- 15 个文件的 maxTokens 适配增加了维护负担

### 风险

- P8 任务模式检测的关键词集需持续维护，新任务类型可能不被覆盖
- maxOutputFileNudges=3 是经验值，不同复杂度的任务可能需要不同阈值
- 工具描述优化效果依赖具体模型，模型升级后可能需要重新调优

## 相关文档

- [CLAUDE.local.md](../../CLAUDE.local.md) — 评测结果对比和 v32 修复清单
- [docs/ARCHITECTURE.md](../ARCHITECTURE.md) — 工程能力提升章节
- [src/shared/constants.ts](../../src/shared/constants.ts) — MODEL_MAX_OUTPUT_TOKENS 定义
- [src/main/tools/shell/bash.ts](../../src/main/tools/shell/bash.ts) — bash 预处理管道
- [src/main/agent/antiPattern/detector.ts](../../src/main/agent/antiPattern/detector.ts) — 输出检测和 force-execute
