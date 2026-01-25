# 多 Agent 编排系统架构设计

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
  tools: ['read_file', 'glob', 'grep'],  // 只读工具，用于分析
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
  tools: ['image_annotate', 'read_file', 'write_file'],
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
