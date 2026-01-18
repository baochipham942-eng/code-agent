# ADR-002: 8 代工具演进策略

> 状态: accepted
> 日期: 2026-01-18

## 背景

AI Agent 的能力边界由其可用的工具集定义。在设计 Code Agent 时，需要决定如何组织和演进工具能力，以支持从简单的文件操作到复杂的多代理协同。

## 决策

采用 **8 代工具演进模型**，每一代引入一组相关能力，形成渐进式能力增强：

| 代际 | 核心能力 | 工具集 |
|------|----------|--------|
| Gen1 | 基础文件操作 | bash, read_file, write_file, edit_file |
| Gen2 | 代码搜索 | glob, grep, list_directory, mcp |
| Gen3 | 任务规划 | task, todo_write, ask_user_question |
| Gen4 | 网络能力 | skill, web_fetch, web_search |
| Gen5 | 记忆系统 | memory_store, memory_search, code_index |
| Gen6 | 视觉交互 | screenshot, computer_use |
| Gen7 | 多代理 | spawn_agent, agent_message, workflow_orchestrate |
| Gen8 | 自我进化 | strategy_optimize, tool_create, self_evaluate |

## 选项考虑

### 选项 1: 扁平工具列表
- 优点: 实现简单，无需管理代际
- 缺点: 难以控制能力边界，无法渐进式启用

### 选项 2: 能力分组（读/写/执行/网络）
- 优点: 权限控制清晰
- 缺点: 不能体现能力演进关系

### 选项 3: 8 代演进模型（采纳）
- 优点:
  - 清晰的能力边界和演进路径
  - 可按需启用/禁用特定代际
  - 便于研究不同能力组合的效果
  - 与 Claude Code 8 个版本对应，便于对比研究
- 缺点:
  - 增加了代际管理复杂度
  - 工具归类可能有争议

## 后果

### 积极影响
- 用户可选择启用的能力等级（如只启用 Gen1-4）
- 便于 A/B 测试不同能力组合的效果
- 代码组织清晰（src/main/tools/gen1-gen8）
- 为未来能力扩展预留空间

### 消极影响
- 需要维护 GenerationManager 管理代际状态
- 工具间的跨代际依赖需要额外处理

### 风险
- 代际划分可能随着功能演进需要调整

## 实现位置

| 文件 | 职责 |
|------|------|
| `src/main/tools/gen1-gen8/` | 各代际工具实现 |
| `src/main/generation/GenerationManager.ts` | 代际状态管理 |
| `src/main/tools/ToolRegistry.ts` | 按代际注册和过滤工具 |

## 相关文档

- [工具系统架构](../architecture/tool-system.md)
- [系统概览](../architecture/overview.md)
