# RFC-004: Claude Code 会话数据微调 Code Agent

> 状态：Draft | 日期：2026-02-26 | 优先级：P3（规划中，暂不实施）

## 背景

`claudeSessionParser.ts` 已实现 Claude Code JSONL 会话解析和训练数据导出（SFT/ChatML 格式）。本 RFC 规划如何利用这些数据改进 code-agent 的行为策略。

## 三个可行方向

### 方向 A：Prompt Distillation（推荐，零成本）

**核心思路**：不微调模型权重，用 Claude 的行为数据改进提示词工程。

**流程**：
1. `discoverClaudeSessions()` 扫描所有成功会话
2. `toSFTFormat()` 提取 instruction → output pairs
3. 分析 Claude Code 在不同任务类型下的工具使用模式：
   - 文件修改：read → edit vs read → write 的选择策略
   - 调试：错误定位步骤序列（grep → read → hypothesis → bash test）
   - 搜索：grep + glob + read 的组合模式
4. 将模式固化为 Skill 提示词或 `gen8.ts` 工具决策树

**产出**：更新后的工具决策树、新 Skill 定义
**成本**：零（纯分析）
**验证**：eval 分数对比

### 方向 B：工具路由模型微调

**核心思路**：训练一个轻量模型（GLM-4.7-Flash LoRA）专门做工具选择决策。

**数据准备**：
```python
# 从 Claude Code 会话提取 (context → tool_choice) pairs
# context = 最近 3 条消息 + 当前任务描述
# tool_choice = Claude 实际选择的工具 + 参数
```

**训练**：
- 基座模型：GLM-4.7-Flash（免费推理）
- 方法：LoRA (r=16, alpha=32)
- 框架：LLaMA Factory（项目已有实验室模块）
- 数据量：需要 ~500+ 高质量 tool_use 样本

**部署**：替代 `adaptiveRouter.ts` 的规则路由

**成本**：微调 GPU 时间（~2h A100）+ 评估
**风险**：数据量可能不足、Claude 和 Kimi 的行为模式差异

### 方向 C：行为克隆（SFT 全流程）

**核心思路**：微调 GLM-4.7-Flash 使其行为接近 Claude Code。

**流程**：
1. 收集 100+ 完整 Claude Code 会话
2. `toSFTFormat()` 导出训练数据
3. SFT 微调：instruction (系统提示 + 工具描述) + input (用户消息) → output (助手回复含 tool_use)
4. 部署为 code-agent 的 fast 层（explore/bash agent）

**数据格式**（已实现）：
```json
{
  "instruction": "你是一个编程助手，可以使用以下工具: bash, read_file, write_file...",
  "input": "帮我修复 src/app.ts 中的类型错误",
  "output": "我先读取文件了解错误...\n[tool_use: read_file({file_path: 'src/app.ts'})]",
  "tools_used": ["read_file", "edit_file"]
}
```

**成本**：高（GPU + 数据标注 + 评估循环）
**风险**：Claude 和 Kimi/GLM 架构差异大，行为克隆可能效果有限

## 推荐路径

```
Phase 1（现在）: 方向 A — Prompt Distillation
  ↓ 积累 Claude Code 会话数据
Phase 2（数据足够时）: 方向 B — 工具路由微调
  ↓ 验证微调效果
Phase 3（可选）: 方向 C — 行为克隆
```

## 前置条件

- [x] claudeSessionParser.ts 实现（JSONL 解析 + SFT/ChatML 导出）
- [ ] 积累 500+ 条 Claude Code 高质量会话
- [ ] 会话质量评分标准（过滤失败/低效会话）
- [ ] eval 基线数据（用于对比微调前后效果）

## 相关代码

| 文件 | 功能 |
|------|------|
| `src/main/session/claudeSessionParser.ts` | JSONL 解析 + 格式转换 |
| `src/main/agent/metricsCollector.ts` | 评测 metrics 追踪 |
| `src/renderer/components/features/lab/` | LLaMA Factory 微调实验室 |
