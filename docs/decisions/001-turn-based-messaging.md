# ADR-001: Turn-Based 消息流架构

> 状态: accepted
> 日期: 2026-01-17

## 背景

在 v0.4.11 版本中，发现消息流存在顺序混乱问题：
1. 工具调用后 AI 的总结文本会追加到包含工具调用的同一条消息
2. 导致用户看到的消息顺序与实际执行顺序不一致
3. 前端预创建 placeholder 消息的方式无法正确处理多轮迭代

## 决策

采用 **Turn-Based 消息模型**，借鉴 Vercel AI SDK 和 LangGraph 的行业最佳实践：

1. 每轮 Agent Loop 迭代对应一条前端 assistant 消息
2. 后端驱动消息创建（通过 `turn_start` 事件）
3. 使用 `turnId` 关联同一轮的所有事件

## 选项考虑

### 选项 1: 前端预创建 + 智能追加（原方案）
- 优点: 实现简单，前端控制
- 缺点: 无法正确处理多轮迭代，容易出现消息混乱

### 选项 2: 后端驱动 + turnId 关联（采纳）
- 优点:
  - 消息边界清晰
  - 支持精确的事件路由
  - 符合行业最佳实践
- 缺点:
  - 需要修改前后端协议
  - 增加了 turnId 的管理复杂度

### 选项 3: 每个工具调用独立消息
- 优点: 最细粒度的消息控制
- 缺点: 消息数量爆炸，UI 体验差

## 后果

### 积极影响
- 消息顺序问题彻底解决
- 前端不再需要复杂的消息合并逻辑
- 事件处理更加简洁和可靠

### 消极影响
- 需要更新 AgentLoop、useAgent、types 三个文件
- 旧版本客户端需要兼容处理

### 风险
- 如果 turnId 丢失，事件可能路由失败（已通过 fallback 机制缓解）

## 实现位置

| 文件 | 职责 |
|------|------|
| `AgentLoop.ts` | 生成 turnId，发送 turn_start/turn_end 事件 |
| `useAgent.ts` | 处理事件，使用 turnId 定位和更新消息 |
| `types.ts` | 定义 AgentEvent 类型（含 turnId） |

## 事件流程

```
turn_start → stream_chunk* → stream_tool_call_start? → tool_call_end → turn_end
    |                                                                       |
    v                                                                       v
创建新 assistant 消息                                                标记本轮完成
```

## 相关文档

- [Agent 核心架构](../architecture/agent-core.md)
- [前端架构](../architecture/frontend.md)
