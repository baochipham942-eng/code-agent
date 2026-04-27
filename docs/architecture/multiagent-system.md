# 多 Agent 编排系统架构设计

> 核心代码：
> - `src/main/agent/autoAgentCoordinator.ts` — 唯一的多 Agent 协调器
> - `src/main/agent/parallelAgentCoordinator.ts` — 并行 Agent 协调器（含 SharedContext）
> - `src/main/agent/taskDag.ts` — DAG 依赖调度
> - `src/main/agent/multiagentTools/` — spawnAgent / sendInput / waitAgent 等工具

## 0. 通信级别模型 (Communication Levels)

借鉴 Hermes Agent 的 L0-L3 分级，对现有多 Agent 通信模式进行显式建模。
选择依据：**按任务需求选最低够用的级别**，级别越低隔离越强、调试越容易。

### 级别定义

| Level | Name | 描述 | 适用场景 |
|-------|------|------|----------|
| **L0** | Isolated | 完全隔离，无数据共享，父 agent 手动中继 | 独立子任务（代码生成、文档生成） |
| **L1** | Result Passing | 上游输出自动注入下游 context | 流水线式任务（分析→编码→测试） |
| **L2** | Shared Context | 共享 KV 存储，coordinator 中转读写 | 并行任务需发现共享（并行搜索→合成） |
| **L3** | Live Dialogue | Agent 间 turn-based 对话 | 辩论/交叉审查（未实现，P2 交叉验证是简化版） |

### 代码映射

```
L0 — executeParallel() 中的并行 agent，各自独立执行
L1 — executeSequential() 的 previousOutput 链式传递
L2 — ParallelAgentCoordinator.SharedContext（findings/files/decisions KV）
L3 — 未实现（Codex MCP P2 crossVerify 是 L3 雏形）
```

### 策略与级别的对应

| ExecutionStrategy | 默认级别 | 说明 |
|-------------------|---------|------|
| `direct` | L0 | 单 agent，无需通信 |
| `sequential` | L1 | 上游结果自动注入下游 |
| `parallel` | L0 + L2(可选) | 主 agent 串行(L1) → 并行 agent 隔离(L0)，可开 SharedContext 升到 L2 |

### 设计原则

1. **不做 L3** — Agent 间直接对话引入非确定性交互，调试成本极高。需要交叉验证时走 MCP P2
2. **L2 仅 coordinator 中转** — 不暴露自由读写 KV，避免共享可变状态的一致性问题
3. **升级需显式** — 默认走 L0/L1，只有 `enableSharedContext: true` 时才升到 L2

## 0.0 2026-04-27 产品化加固状态

这轮把 Agent Team 的几个“不可靠但看起来能用”的点补成了明确 contract。当前还没有完成全量 swarm runtime 收敛，但 P1 blocker 已不再成立。

| 能力 | 当前状态 | 关键文件 / 测试 |
|------|----------|----------------|
| parallel executor inbox | `send_input` 先写 SpawnGuard agent queue；找不到时会退到 `ParallelAgentCoordinator` 的 task inbox，executor 迭代前可 drain | `src/main/agent/multiagentTools/sendInput.ts`、`tests/unit/agent/sendInput.test.ts` |
| dependsOn gate | 下游只在所有依赖成功后启动；上游失败时下游标 `blocked`，不再继续跑 | `parallelAgentCoordinator.ts`、`tests/unit/agent/parallelAgentCoordinator.test.ts` |
| aggregation shape | 成功、失败、blocked、cancelled agent 都进入结果结构；`successRate` 按总任务数计算 | `src/main/agent/resultAggregator.ts`、`tests/unit/agent/resultAggregator.test.ts` |
| run-level cancel | `abortAllRunning()` 会中止 running task，并把 pending task 标 cancelled；`swarm:cancel-run` 同时取消 plan/launch approval、SpawnGuard 和 parallel coordinator | `parallelAgentCoordinator.ts`、`src/main/ipc/swarm.ipc.ts` |
| send_input interrupt | schema 已移除未实现的 `interrupt` 参数，避免承诺抢占式中断 | `src/main/agent/multiagentTools/sendInput.ts` |

当前边界：

- UI 上仍可能看到 Agent Team、SpawnGuard、hybrid swarm、parallel coordinator 多条历史路径并存；工程债文档把这条列为长期收敛项。
- 本轮闭环主要是 unit 级和 IPC 级；真实多 agent 端到端 smoke 仍应单独补。
- 生产口径里，parallel executor 才是 dependsOn / inbox / aggregation 的主要事实源，legacy/hybrid 只按兼容路径理解。

## 0.1 节点级 Checkpoint（断点恢复）

多 agent DAG 执行中，网络中断或 token 耗尽会导致已完成节点工作白费。
Checkpoint 机制在每个节点成功后持久化结果，重新执行时自动跳过。

### 机制

| 项 | 说明 |
|----|------|
| **存储位置** | `~/.code-agent/coordination-checkpoints/<sessionId>.json` |
| **存储粒度** | Agent 节点级（非工具调用级） |
| **缓存条件** | 仅 `completed` 状态持久化，`failed` 不缓存以支持重试 |
| **恢复条件** | sessionId 相同 + agentIds 列表完全匹配 |
| **清理时机** | 全部 agent 成功后自动删除 checkpoint 文件 |

### 流程

```
execute() 入口
  ├── loadCheckpoint(sessionId, agentIds)
  │   ├── 文件不存在 → createCheckpoint()（新执行）
  │   ├── agentIds 不匹配 → deleteCheckpoint() + createCheckpoint()（执行计划变了）
  │   └── 匹配 → 恢复（跳过已完成节点）
  │
  ├── executeSequential / executeParallel
  │   ├── 每个 agent 执行前：检查 checkpoint.completedNodes[agentId]
  │   │   ├── 命中 → skip + 使用缓存 output 作为 L1 传递
  │   │   └── 未命中 → 正常执行
  │   └── 每个 agent 成功后：saveCheckpoint()
  │
  └── aggregateResults
      └── 全部成功 → deleteCheckpoint()
```

---

> ⚠️ **以下为早期设计稿**（v0.16.55 前），保留作为历史参考。

## 1. 问题诊断

### 1.1 当前系统的问题

1. **图片数据传递错误**
   - `SubagentExecutor` 没有正确处理 data URL 格式的 base64 图片
   - `img.data` 可能包含 `data:image/png;base64,xxx` 前缀，但代码直接使用导致数据错误

2. **上下文传递不完整**
   - 工作流只传递文本输出 (`stageOutputs: Map<string, string>`)
   - 前一阶段的结构化数据（如 OCR 坐标）无法被后续阶段正确解析

3. **Agent 定义系统不完善**
   - 缺少 Plan Agent（规划型）
   - 缺少 Coordinator Agent（协调型）
   - 视觉 Agent 定义不够精确

4. **工作流模板过于简单**
   - 没有条件分支
   - 没有错误恢复机制
   - 没有中间结果验证

## 2. 新架构设计

### 2.1 Agent 类型层次

```
┌─────────────────────────────────────────────────────────────────┐
│                       Agent 类型分层                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Layer 0: Meta Agents (元 Agent)                               │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐   │
│  │   Planner      │  │  Coordinator   │  │   Evaluator    │   │
│  │   规划任务分解  │  │   协调多Agent  │  │   评估结果质量  │   │
│  └────────────────┘  └────────────────┘  └────────────────┘   │
│                                                                 │
│  Layer 1: Specialist Agents (专家 Agent)                       │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐   │
│  │ Code Reviewer  │  │   Debugger     │  │   Architect    │   │
│  │   代码审查     │  │   调试定位     │  │   架构设计     │   │
│  └────────────────┘  └────────────────┘  └────────────────┘   │
│                                                                 │
│  Layer 2: Vision Agents (视觉 Agent)                           │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐   │
│  │    Analyzer    │  │   Processor    │  │   Annotator    │   │
│  │  视觉分析理解   │  │   图片处理     │  │   图片标注     │   │
│  └────────────────┘  └────────────────┘  └────────────────┘   │
│                                                                 │
│  Layer 3: Worker Agents (执行 Agent)                           │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐   │
│  │    Coder       │  │  Test Writer   │  │  Documenter    │   │
│  │    编写代码    │  │   编写测试     │  │   编写文档     │   │
│  └────────────────┘  └────────────────┘  └────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 新 Agent 定义

#### Plan Agent (规划型)
```typescript
{
  id: 'planner',
  name: 'Planner Agent',
  description: '分析复杂任务并制定执行计划，分解为可执行的子任务',
  systemPrompt: `你是任务规划专家。职责：
1. 分析用户任务的复杂度和依赖关系
2. 分解为可独立执行的子任务
3. 确定子任务的执行顺序和并行可能性
4. 为每个子任务匹配合适的专家 Agent

输出格式（JSON）：
{
  "analysis": "任务分析",
  "subtasks": [
    {
      "id": "task-1",
      "description": "子任务描述",
      "agent": "agent-id",
      "inputs": ["依赖的前置任务输出"],
      "priority": 1
    }
  ],
  "executionOrder": [["task-1"], ["task-2", "task-3"]], // 并行组
  "estimatedComplexity": "low|medium|high"
}`,
  tools: ['Read', 'Glob', 'Grep'],  // 只读工具，用于分析
  maxIterations: 5,
  canSpawnSubagents: true,  // 可以建议 spawn 其他 agent
}
```

#### Vision Analyzer Agent (视觉分析)
```typescript
{
  id: 'vision-analyzer',
  name: 'Vision Analyzer',
  description: '使用视觉模型分析图片内容，输出结构化的分析结果',
  systemPrompt: `你是视觉分析专家。职责：
1. 描述图片的整体内容
2. 识别并定位图片中的关键元素
3. 输出结构化的位置信息

**重要：输出格式必须是 JSON**

对于 OCR 任务，输出格式：
{
  "type": "ocr",
  "imageSize": { "width": 1920, "height": 1080 },
  "textRegions": [
    {
      "text": "识别到的文字",
      "boundingBox": {
        "x": 100,      // 左上角 x（像素）
        "y": 50,       // 左上角 y（像素）
        "width": 200,  // 宽度（像素）
        "height": 30   // 高度（像素）
      },
      "confidence": 0.95
    }
  ]
}

对于元素检测任务，输出格式：
{
  "type": "detection",
  "imageSize": { "width": 1920, "height": 1080 },
  "elements": [
    {
      "type": "button|text|image|icon",
      "description": "元素描述",
      "boundingBox": { "x": 100, "y": 50, "width": 80, "height": 30 }
    }
  ]
}`,
  tools: [],  // 纯视觉模型，无工具
  maxIterations: 1,  // 单轮分析
  modelOverride: {
    provider: 'zhipu',
    model: 'glm-4v-flash',
  },
}
```

#### Vision Annotator Agent (视觉标注)
```typescript
{
  id: 'vision-annotator',
  name: 'Vision Annotator',
  description: '根据分析结果在图片上绘制标注',
  systemPrompt: `你是图片标注专家。职责：
1. 解析前一阶段的视觉分析结果（JSON 格式）
2. 调用 image_annotate 工具绘制标注
3. 确保所有需要标注的区域都被正确标记

工作流程：
1. 解析输入的 JSON 分析结果
2. 提取所有 boundingBox 信息
3. 将 boundingBox 转换为 image_annotate 工具所需的格式
4. 调用工具绘制标注

image_annotate 调用示例：
{
  "image_path": "图片路径",
  "query": "在以下位置绘制矩形框",
  "regions": [
    { "type": "rectangle", "x": 100, "y": 50, "width": 200, "height": 30, "label": "文字1" }
  ]
}`,
  tools: ['image_annotate', 'Read', 'Write'],
  maxIterations: 10,
}
```

### 2.3 上下文传递机制

#### StageContext 类型定义
```typescript
interface StageContext {
  // 文本输出
  textOutput: string;

  // 结构化数据（JSON 解析后）
  structuredData?: Record<string, unknown>;

  // 生成的文件
  generatedFiles?: Array<{
    path: string;
    type: 'image' | 'text' | 'data';
  }>;

  // 附件（图片等）
  attachments?: Attachment[];

  // 元数据
  metadata?: {
    duration: number;
    toolsUsed: string[];
    agentId: string;
  };
}

interface WorkflowContext {
  // 原始任务
  task: string;

  // 原始附件（图片、文件）
  originalAttachments: Attachment[];

  // 各阶段输出
  stageOutputs: Map<string, StageContext>;

  // 工作目录
  workingDirectory: string;
}
```

### 2.4 图片数据处理规范

```typescript
/**
 * 规范化图片数据
 *
 * 输入可能是：
 * 1. 纯 base64 字符串
 * 2. data URL (data:image/png;base64,xxx)
 * 3. 文件路径
 *
 * 输出统一为：
 * { base64: string, mimeType: string }
 */
function normalizeImageData(
  data?: string,
  path?: string,
  mimeType?: string
): { base64: string; mimeType: string } | null {
  // 1. 如果有 data 字段
  if (data) {
    // 1.1 检查是否是 data URL
    if (data.startsWith('data:')) {
      const match = data.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        return { base64: match[2], mimeType: match[1] };
      }
    }
    // 1.2 假设是纯 base64
    return { base64: data, mimeType: mimeType || 'image/png' };
  }

  // 2. 如果有 path 字段
  if (path && fs.existsSync(path)) {
    const buffer = fs.readFileSync(path);
    const base64 = buffer.toString('base64');
    const detectedMime = mimeType || getMimeTypeFromPath(path);
    return { base64, mimeType: detectedMime };
  }

  return null;
}
```

### 2.5 工作流执行引擎

```typescript
class WorkflowEngine {
  async execute(
    workflow: WorkflowDefinition,
    task: string,
    context: WorkflowContext
  ): Promise<WorkflowResult> {
    const executionGroups = this.buildExecutionGroups(workflow.stages);

    for (const group of executionGroups) {
      // 并行执行同一组内的阶段
      const results = await Promise.all(
        group.map(stage => this.executeStage(stage, context))
      );

      // 验证结果
      for (const result of results) {
        if (!result.success) {
          // 错误恢复策略
          if (workflow.errorStrategy === 'retry') {
            // 重试
          } else if (workflow.errorStrategy === 'skip') {
            // 跳过
          } else {
            // 中止
            return { success: false, error: result.error };
          }
        }

        // 存储阶段输出
        context.stageOutputs.set(result.stageName, {
          textOutput: result.output,
          structuredData: this.parseStructuredOutput(result.output),
          generatedFiles: result.generatedFiles,
          attachments: result.attachments,
          metadata: {
            duration: result.duration,
            toolsUsed: result.toolsUsed,
            agentId: result.agentId,
          },
        });
      }
    }

    return { success: true, context };
  }

  private parseStructuredOutput(output: string): Record<string, unknown> | undefined {
    // 尝试提取 JSON
    const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch (e) {
        // 解析失败，返回 undefined
      }
    }

    // 尝试直接解析
    try {
      return JSON.parse(output);
    } catch (e) {
      return undefined;
    }
  }
}
```

## 3. 实现计划

### Phase 1: 修复图片传递 (Critical)
1. 修复 `SubagentExecutor` 中的图片 base64 处理
2. 添加 `normalizeImageData` 工具函数
3. 确保图片在所有环节正确传递

### Phase 2: 增强 Agent 定义
1. 添加 `planner` Agent
2. 重新设计视觉 Agent（analyzer + annotator）
3. 添加 `evaluator` Agent

### Phase 3: 重构工作流引擎
1. 实现 `StageContext` 结构化上下文
2. 添加结构化输出解析
3. 实现错误恢复策略

### Phase 4: 新工作流模板
1. `image-ocr-annotate`: OCR + 矩形标注
2. `image-element-detect`: 元素检测 + 标注
3. `code-review-and-fix`: 代码审查 + 自动修复

## 4. 文件变更清单

| 文件 | 变更类型 | 描述 |
|-----|---------|------|
| `src/main/agent/subagentExecutor.ts` | 修改 | 修复图片 base64 处理 |
| `src/main/agent/agentDefinition.ts` | 修改 | 添加新 Agent 定义 |
| `src/main/tools/multiagent/workflowOrchestrate.ts` | 重构 | 实现结构化上下文传递 |
| `src/main/utils/imageUtils.ts` | 新增 | 图片数据规范化工具 |
| `src/main/agent/workflowEngine.ts` | 新增 | 工作流执行引擎 |
