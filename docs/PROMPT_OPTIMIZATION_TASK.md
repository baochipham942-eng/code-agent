# Prompt 优化探索任务

> 目标：让 GLM-4.7 能够自主进行多 Agent 并行编排，无需外部指挥家

## 背景

### 实验结论
- **GLM-4.7 有能力**：在简洁 prompt 下，能正确派发 3 个并行子代理
- **当前问题**：code-agent 的 prompt 把模型"教坏了"，默认不用 task 工具
- **根因**：缺少"并行派发"的明确指导，决策流程偏向"直接执行"

### 参考标杆
- Claude Code：明确写了 "parallel exploration and multi-agent planning"
- OpenAI Codex：Project Manager 协调专业代理
- Cursor：单代理架构，不用多代理（不适合参考）

---

## 优化项清单

### P0 - 核心问题（必须修复）

#### 1. toolUsagePolicy.ts - 添加并行派发策略

**文件**: `src/main/generation/prompts/rules/toolUsagePolicy.ts`

**当前问题**:
- 完全没有提到 "并行" 或 "parallel"
- "何时直接执行" 占大篇幅，引导模型不用 task
- 决策流程默认导向"直接执行"

**修复方案**:
```typescript
### 并行派发策略（重要）

当任务包含 **多个独立维度** 时，应 **同时派发多个子代理** 并行处理：

| 任务特征 | 正确做法 |
|---------|---------|
| 安全审计 + 性能分析 + 代码质量 | 并行派发 3 个 task |
| 分析 auth + payment + notification 模块 | 并行派发 3 个 task |
| 前端 + 后端 + 数据库层审查 | 并行派发 3 个 task |

**示例**:
```
// 并行派发（在单个响应中同时调用）
task(code-review, "安全审计：扫描 API 端点的认证问题")
task(explore, "性能分析：找出 N+1 查询和慢查询")
task(code-review, "代码质量：检查 any 类型使用")
```

**判断标准**:
- 各维度之间无依赖关系 → 并行
- 需要前一步结果才能进行 → 串行
```

#### 2. parallelTools.ts - 扩展到 task 工具

**文件**: `src/main/generation/prompts/rules/parallelTools.ts`

**当前问题**:
- 只讲了基础工具（git, glob, read_file）的并行
- 没有提到 task 工具的并行派发

**修复方案**:
```typescript
### 子代理并行派发

除了基础工具，task 工具也支持并行：

**可并行的 task 调用**:
- 审计不同维度（安全/性能/质量）
- 分析不同模块（auth/payment/user）
- 不同类型检查（类型安全/错误处理/日志规范）

**示例**:
```
// 单个响应中同时派发
task(code-review, "安全审计")
task(explore, "性能分析")
task(code-review, "代码质量检查")
```
```

---

### P1 - 重要优化

#### 3. task.ts - 精简工具描述

**文件**: `src/main/generation/prompts/tools/task.ts`

**当前问题**:
- 900 tokens，信息过载
- "何时不使用" 部分可能误导模型
- 并行使用只有一句话，不够突出

**修复方案**:
- 精简到 500 tokens 以内
- 删除或弱化"何时不使用"
- 强化"并行使用多个子代理"部分
- 添加多 task 并行的示例

#### 4. gen7.ts - 强化并行描述

**文件**: `src/main/generation/prompts/base/gen7.ts`

**当前状态**:
- 第 99 行有"协调多个 Agent 并行工作"
- 但示例都是单个 task 调用

**修复方案**:
- 添加多 task 并行调用的示例
- 在"工具使用策略"表格中添加"多维度任务"行

---

### P2 - 可选优化

#### 5. 对比 Claude Code 的 Task 描述

**任务**: 从 https://github.com/Piebald-AI/claude-code-system-prompts 获取 Claude Code 的 Task 工具完整描述，对比差异

**关注点**:
- 并行相关的措辞
- 示例的写法
- "何时使用"的表述

#### 6. 检查是否有其他"引导不用 task"的地方

**文件**: 全局搜索 prompts 目录

**搜索关键词**:
- "直接使用"
- "不需要委派"
- "简单的"
- "直接执行"

---

## 验证方案

### 测试脚本
使用 `scripts/experiment-multi-agent.ts`，测试任务：

```
对这个项目进行完整的代码审计，包括：
1. 安全审计：扫描所有 API 端点
2. 性能分析：分析数据库查询
3. 代码质量：检查 TypeScript any 类型
```

### 成功标准
- GLM-4.7 主动派发 **3 个** task 工具调用
- 不需要任务描述中明确说"使用 task 工具"

---

## 相关文件清单

| 文件 | 优先级 | 状态 |
|------|--------|------|
| `src/main/generation/prompts/rules/toolUsagePolicy.ts` | P0 | 待修改 |
| `src/main/generation/prompts/rules/parallelTools.ts` | P0 | 待修改 |
| `src/main/generation/prompts/tools/task.ts` | P1 | 待精简 |
| `src/main/generation/prompts/base/gen7.ts` | P1 | 待补充示例 |
| `scripts/experiment-multi-agent.ts` | - | 验证工具 |

---

## 参考资料

- [Claude Code System Prompts](https://github.com/Piebald-AI/claude-code-system-prompts)
- [Claude Code Swarm Orchestration](https://gist.github.com/kieranklaassen/4f2aba89594a4aea4ad64d753984b2ea)
- [OpenAI Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md)

---

## 注意事项

1. **不要过度工程** - 只修复必要的点
2. **保持简洁** - prompt 不是越长越好
3. **用实验验证** - 每次修改后跑测试脚本
4. **关键词很重要** - "并行"、"同时"、"parallel" 要明确出现
