# RFC-001: 子代理架构简化

> 状态：草案
> 作者：Claude
> 创建日期：2026-02-03

## 概述

将 Code Agent 的 17 个预定义子代理简化为 8 个，删除 Layer 0-4 分层和 4 层配置体系，对齐 Claude Code 官方的设计哲学。

## 动机

### 当前问题

| 问题 | 详情 |
|------|------|
| **角色过多** | 17 个子代理，但 Claude Code 只有 6 个 |
| **定义重复** | `agentDefinition.ts` 和 `builtInAgents.ts` 有重复定义 |
| **配置过度** | 4 层配置（core/runtime/security/coordination）大部分用默认值 |
| **分层无意义** | Layer 0-4 在实际运行中未被使用 |
| **边界模糊** | coder/debugger/refactorer 能力高度重叠 |

### 三方对比

```
Claude Code:  6 种子代理，能力导向，平级结构
Prism Agent:  3-4 种，角色导向，2 层结构
Code Agent:   17 种，角色导向，5 层结构 ← 过度设计
```

## 方案设计

### 新的 8 个子代理

```
┌─────────────────────────────────────────────────────────────────┐
│  核心角色（高频使用）                                             │
├─────────────────────────────────────────────────────────────────┤
│  coder     ← coder + debugger + documenter                      │
│  reviewer  ← reviewer + tester                                   │
│  explore   ← code-explore + web-search + doc-reader              │
│  plan      ← plan + architect                                    │
├─────────────────────────────────────────────────────────────────┤
│  扩展角色（低频按需）                                             │
├─────────────────────────────────────────────────────────────────┤
│  refactorer (保留)                                               │
│  devops     (保留)                                               │
│  visual    ← visual-understanding + visual-processing            │
│  general   ← general-purpose + orchestrator + mcp-connector      │
└─────────────────────────────────────────────────────────────────┘
```

### 简化的配置接口

```typescript
// 旧配置（4 层，~30 个字段）
interface FullAgentConfig {
  id, name, description, prompt, tools, model,
  runtime: { maxIterations, timeout, maxBudget },
  security: { permissionPreset },
  coordination: { layer, canDelegate, allowedSubagents, canParallelWith, maxInstances, readonly },
  outputSchema, tags
}

// 新配置（1 层，8 个字段）
interface AgentConfig {
  id: AgentId;
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  model: 'fast' | 'balanced' | 'powerful';
  maxIterations?: number;
  readonly?: boolean;
}
```

### 模型层级映射

| 层级 | 模型 | 适用场景 |
|------|------|----------|
| `fast` | GLM-4-Flash | 探索、搜索（只读） |
| `balanced` | GLM-4.7 | 规划、审查、DevOps |
| `powerful` | Kimi K2.5 | 编码、重构、通用 |

### 别名映射（向后兼容）

```typescript
const AGENT_ALIASES = {
  // 旧 ID → 新 ID
  'code-explore': 'explore',
  'web-search': 'explore',
  'doc-reader': 'explore',
  'architect': 'plan',
  'debugger': 'coder',
  'documenter': 'coder',
  'tester': 'reviewer',
  'visual-understanding': 'visual',
  'visual-processing': 'visual',
  'general-purpose': 'general',
  'orchestrator': 'general',
  'mcp-connector': 'general',
  'bash-executor': 'general',
};
```

## 影响分析

### 需要修改的文件

| 文件 | 改动 |
|------|------|
| `src/main/agent/agentDefinition.ts` | 重写 |
| `src/shared/types/builtInAgents.ts` | 删除（合并到上面） |
| `src/shared/types/agentTypes.ts` | 简化类型定义 |
| `src/main/agent/subagentExecutor.ts` | 适配新配置 |
| `src/main/agent/subagentContextBuilder.ts` | 简化上下文级别 |
| `src/main/generation/prompts/tools/task.ts` | 更新工具描述 |
| 测试文件 | 更新 mock 和断言 |

### 不需要修改的文件

| 文件 | 原因 |
|------|------|
| `src/main/agent/agentLoop.ts` | 核心循环逻辑不变 |
| `src/main/scheduler/` | DAG 调度器不变 |
| `src/main/tools/gen7/` | spawn_agent 工具接口不变 |

### 向后兼容性

- **spawn_agent 调用**：通过 `AGENT_ALIASES` 自动映射旧 ID
- **配置迁移**：读取旧配置时自动转换为新格式
- **API 不变**：`getAgent(id)` 函数签名保持不变

## 实施计划

### Phase 1：准备（1 天）

- [ ] 创建 `agentDefinition.refactored.ts`（新定义）
- [ ] 添加兼容层（别名映射）
- [ ] 编写迁移脚本

### Phase 2：迁移（2 天）

- [ ] 替换 `agentDefinition.ts`
- [ ] 删除 `builtInAgents.ts`
- [ ] 更新所有引用点
- [ ] 运行 typecheck

### Phase 3：验证（1 天）

- [ ] 运行现有测试
- [ ] 手动测试各子代理
- [ ] 验证别名映射
- [ ] 性能对比

### Phase 4：清理（1 天）

- [ ] 删除废弃代码
- [ ] 更新文档
- [ ] 更新 CLAUDE.md

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 角色合并导致能力下降 | 中 | 中 | Prompt 合并保留关键指令 |
| 别名映射遗漏 | 低 | 低 | 完整的映射表 + 测试覆盖 |
| 配置读取错误 | 中 | 高 | 类型检查 + 运行时验证 |

## 度量指标

### 成功标准

| 指标 | 目标 |
|------|------|
| 子代理数量 | 17 → 8（减少 53%）|
| 配置字段数 | ~30 → 8（减少 73%）|
| 代码行数 | 减少 ~500 行 |
| 测试通过率 | 100% |

### 监控

- 子代理调用成功率
- 任务完成率（按类型）
- 平均迭代次数

## 附录

### A. 新子代理 Prompt 对比

| 子代理 | 字符数 | 关键能力 |
|--------|--------|----------|
| coder | ~800 | 写码 + 调试 + 文档 |
| reviewer | ~700 | 审查 + 测试 |
| explore | ~500 | 代码/网络/文档搜索 |
| plan | ~600 | 规划 + 架构 |
| refactorer | ~400 | 大规模重构 |
| devops | ~300 | CI/CD |
| visual | ~400 | 图片理解 + 处理 |
| general | ~400 | 通用兜底 |

### B. 工具分配矩阵

| 子代理 | bash | read | write | edit | glob | grep | web | mcp |
|--------|------|------|-------|------|------|------|-----|-----|
| coder | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| reviewer | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| explore | | ✓ | | | ✓ | ✓ | ✓ | |
| plan | | ✓ | ✓ | | ✓ | ✓ | | |
| refactorer | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| devops | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| visual | | ✓ | ✓ | | ✓ | | | |
| general | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

### C. 参考资料

- [Claude Code Task Tool 定义](系统提示)
- [Prism Agent v5_multi_agent.py](https://github.com/danny123gg/prism-agent)
- [ADR-004 统一配置目录](../ARCHITECTURE.md)
