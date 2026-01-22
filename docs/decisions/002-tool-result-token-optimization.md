# ADR-002: 工具结果 Token 优化方案

## 状态

**提议中** - 2025-01-22

## 背景

### 问题描述

用户在使用 `image_generate` 工具后，下一轮模型调用报错：

```
DeepSeek API error: 400 - {"error":{"message":"This model's maximum context length is 131072 tokens.
However, you requested 5472941 tokens (5468845 in the messages, 4096 in the completion).
```

### 根本原因分析

1. **工具结果序列化问题**：`image_generate` 返回的 `metadata.imageBase64` 包含完整图片数据（200KB-1MB）
2. **消息历史膨胀**：`agentLoop.ts:589` 将整个 `toolResults` 序列化为 JSON 存入 `message.content`
3. **发送给模型时未过滤**：`buildModelMessages()` 直接将 `message.content` 发送给 LLM

### 影响范围

- `image_generate`：返回 `imageBase64`（200KB-1MB → 150K-300K tokens）
- `read_pdf`（视觉模式）：可能返回图片数据
- `screenshot`（Gen6）：返回屏幕截图 base64
- 未来的多媒体工具

## 设计方案

### 方案概览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           数据流优化设计                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Tool Execute                                                           │
│       │                                                                 │
│       ▼                                                                 │
│  ToolExecutionResult                                                    │
│  {                                                                      │
│    success: true,                                                       │
│    output: "图片生成成功。",                                              │
│    metadata: {                                                          │
│      imagePath: "/path/to/image.png",                                   │
│      imageBase64: "data:image/png;base64,..." (500KB)  ← 大型数据       │
│    }                                                                    │
│  }                                                                      │
│       │                                                                 │
│       ▼                                                                 │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  新增: sanitizeToolResultForHistory()                            │   │
│  │  - 过滤大型二进制数据（imageBase64, screenshotData 等）            │   │
│  │  - 保留路径引用（imagePath, filePath 等）                         │   │
│  │  - 保留小型元数据（model, duration 等）                           │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│       │                                                                 │
│       ├──────────────────┬──────────────────────────────────────────┐   │
│       │                  │                                          │   │
│       ▼                  ▼                                          │   │
│  Message.content     前端事件                                        │   │
│  (sanitized JSON)    tool_call_end                                   │   │
│       │              (完整 metadata)                                 │   │
│       │                  │                                          │   │
│       ▼                  ▼                                          │   │
│  buildModelMessages()  UI 渲染                                       │   │
│  (发送给 LLM)          (显示图片)                                     │   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 核心设计

#### 1. 新增 `sanitizeToolResultForHistory()` 函数

**位置**: `src/main/agent/agentLoop.ts`

**职责**: 在将工具结果存入消息历史前，过滤掉大型二进制数据

```typescript
/**
 * 清理工具结果用于历史存储
 *
 * 设计原则：
 * 1. 大型二进制数据（base64 图片等）只保留引用，不存入历史
 * 2. 前端通过 tool_call_end 事件获取完整数据用于渲染
 * 3. 模型只需要知道"图片已生成"，不需要看到图片内容
 */
private sanitizeToolResultForHistory(result: ToolResult): ToolResult {
  // 深拷贝避免修改原始数据
  const sanitized = { ...result };

  if (result.metadata) {
    sanitized.metadata = { ...result.metadata };

    // 定义需要过滤的大型数据字段
    const LARGE_DATA_FIELDS = [
      'imageBase64',      // image_generate
      'screenshotData',   // screenshot (Gen6)
      'pdfImages',        // read_pdf (视觉模式)
      'audioData',        // 未来的音频工具
      'videoData',        // 未来的视频工具
    ];

    // 定义大小阈值（超过此大小的字段会被替换为占位符）
    const SIZE_THRESHOLD = 10000; // ~10KB

    for (const field of LARGE_DATA_FIELDS) {
      if (sanitized.metadata[field]) {
        const data = sanitized.metadata[field] as string;
        // 替换为占位符，保留大小信息便于调试
        sanitized.metadata[field] = `[BINARY_DATA_FILTERED: ${(data.length / 1024).toFixed(1)}KB]`;
      }
    }

    // 检查其他可能的大型字段（动态检测）
    for (const [key, value] of Object.entries(sanitized.metadata)) {
      if (typeof value === 'string' && value.length > SIZE_THRESHOLD) {
        // 检测是否为 base64 数据
        if (value.startsWith('data:') || /^[A-Za-z0-9+/=]{1000,}$/.test(value)) {
          sanitized.metadata[key] = `[LARGE_DATA_FILTERED: ${(value.length / 1024).toFixed(1)}KB]`;
        }
      }
    }
  }

  return sanitized;
}
```

#### 2. 修改工具结果存储逻辑

**位置**: `src/main/agent/agentLoop.ts:585-593`

**修改前**:
```typescript
const toolMessage: Message = {
  id: this.generateId(),
  role: 'tool',
  content: JSON.stringify(toolResults),  // ← 包含完整 base64
  timestamp: Date.now(),
  toolResults,
};
```

**修改后**:
```typescript
// 清理工具结果用于历史存储（过滤大型二进制数据）
const sanitizedResults = toolResults.map(r => this.sanitizeToolResultForHistory(r));

const toolMessage: Message = {
  id: this.generateId(),
  role: 'tool',
  content: JSON.stringify(sanitizedResults),  // ← 不含大型数据
  timestamp: Date.now(),
  toolResults: sanitizedResults,  // ← 历史中也用清理后的版本
};
```

#### 3. 确保前端仍能获取完整数据

**关键点**: 前端通过 `tool_call_end` 事件获取数据，该事件在清理之前发送

**验证**: 查看 `agentLoop.ts` 中事件发送顺序：

```typescript
// 1. 执行工具，获取完整结果
const toolResult = await this.executeSingleTool(toolCall, ...);

// 2. 发送完整结果给前端（用于 UI 渲染）
this.onEvent({
  type: 'tool_call_end',
  data: toolResult,  // ← 包含完整 metadata（含 imageBase64）
});

// 3. 之后才存入消息历史（这里做清理）
```

**结论**: 事件发送在存储之前，前端能获取完整数据。只需确保清理发生在 `messages.push()` 之前。

#### 4. 新增 `formatToolResultForModel()` 函数（可选增强）

**目的**: 进一步优化发送给模型的工具结果格式，只保留关键信息

```typescript
/**
 * 格式化工具结果用于模型消息
 * 比 sanitizeToolResultForHistory 更激进，只保留模型决策所需的信息
 */
private formatToolResultForModel(results: ToolResult[]): string {
  return results.map(r => {
    if (r.success) {
      // 成功时只返回简要信息
      const info = [`✓ ${r.toolCallId}: ${r.output || 'Success'}`];

      // 添加关键元数据（不含大型数据）
      if (r.metadata) {
        if (r.metadata.imagePath) {
          info.push(`  → Image saved: ${r.metadata.imagePath}`);
        }
        if (r.metadata.filePath) {
          info.push(`  → File: ${r.metadata.filePath}`);
        }
        if (r.metadata.generationTimeMs) {
          info.push(`  → Time: ${r.metadata.generationTimeMs}ms`);
        }
      }
      return info.join('\n');
    } else {
      // 失败时返回错误信息
      return `✗ ${r.toolCallId}: ${r.error || 'Failed'}`;
    }
  }).join('\n\n');
}
```

**使用位置**: `buildModelMessages()` 中处理 `tool` 消息时

```typescript
if (message.role === 'tool') {
  // 使用优化的格式而非原始 JSON
  const formatted = this.formatToolResultForModel(message.toolResults || []);
  modelMessages.push({
    role: 'user',
    content: `Tool results:\n${formatted}`,
  });
}
```

### 方案二：延迟清理（在 buildModelMessages 中过滤）

如果不想修改存储逻辑，可以在发送给模型时再过滤：

```typescript
private buildModelMessages(): ModelMessage[] {
  // ...
  for (const message of this.messages) {
    if (message.role === 'tool') {
      // 过滤大型数据后再发送
      const sanitizedContent = this.sanitizeToolResultsJson(message.content);
      modelMessages.push({
        role: 'user',
        content: `Tool results:\n${sanitizedContent}`,
      });
    }
    // ...
  }
}

private sanitizeToolResultsJson(content: string): string {
  try {
    const results = JSON.parse(content) as ToolResult[];
    const sanitized = results.map(r => this.sanitizeToolResultForHistory(r));
    return JSON.stringify(sanitized);
  } catch {
    return content; // 解析失败时返回原内容
  }
}
```

**优缺点对比**:

| 方案 | 优点 | 缺点 |
|------|------|------|
| 方案一（存储时清理） | 数据库也不存大数据，节省存储 | 需要修改两处代码 |
| 方案二（发送时过滤） | 改动最小，只改一处 | 数据库仍存大数据 |

**推荐**: 方案一，因为：
1. 数据库存储优化
2. 会话恢复时不会有问题
3. 逻辑更清晰（源头解决）

---

## 友好的错误处理设计

### 问题

当前上下文超限错误直接暴露给用户：
```
Error: DeepSeek API error: 400 - {"error":{"message":"This model's maximum context length is 131072 tokens...
```

### 设计

#### 1. 在 `modelRouter.ts` 中捕获并转换错误

```typescript
// src/main/model/modelRouter.ts

// 定义上下文超限错误类型
export class ContextLengthExceededError extends Error {
  constructor(
    public readonly requestedTokens: number,
    public readonly maxTokens: number,
    public readonly provider: string
  ) {
    super(`上下文长度超出限制`);
    this.name = 'ContextLengthExceededError';
  }
}

// 在 callDeepSeek 等方法中检测错误
private async callDeepSeek(...): Promise<ModelResponse> {
  try {
    // ... 调用 API ...
  } catch (error: any) {
    if (error.response) {
      const errorData = error.response.data;

      // 检测上下文超限错误
      if (errorData?.error?.message?.includes('maximum context length')) {
        const match = errorData.error.message.match(
          /maximum context length is (\d+).*requested (\d+)/
        );
        if (match) {
          throw new ContextLengthExceededError(
            parseInt(match[2]),
            parseInt(match[1]),
            'deepseek'
          );
        }
      }

      throw new Error(`DeepSeek API error: ${error.response.status} - ${JSON.stringify(errorData)}`);
    }
    throw error;
  }
}
```

#### 2. 在 `agentLoop.ts` 中处理并转换为友好提示

```typescript
// src/main/agent/agentLoop.ts

async run(): Promise<void> {
  try {
    // ... 主循环 ...
  } catch (error) {
    if (error instanceof ContextLengthExceededError) {
      // 发送友好的错误提示
      this.onEvent({
        type: 'error',
        data: {
          code: 'CONTEXT_LENGTH_EXCEEDED',
          message: '对话内容过长，已超出模型上下文限制。',
          suggestion: '建议新开一个会话继续对话。',
          details: {
            requested: error.requestedTokens,
            max: error.maxTokens,
          },
        },
      });

      // 可选：自动尝试压缩历史
      const compressed = await this.tryCompressHistory();
      if (compressed) {
        this.onEvent({
          type: 'notification',
          data: { message: '已自动压缩对话历史，请重试' },
        });
      }
      return;
    }

    // 其他错误正常抛出
    throw error;
  }
}
```

#### 3. 前端友好展示

```typescript
// src/renderer/hooks/useAgent.ts

case 'error':
  if (event.data.code === 'CONTEXT_LENGTH_EXCEEDED') {
    // 显示专门的上下文超限提示
    showContextLimitDialog({
      message: event.data.message,
      suggestion: event.data.suggestion,
      onNewSession: () => createNewSession(),
    });
  } else {
    // 其他错误
    setError(event.data.message);
  }
  break;
```

---

## 图片生成耗时优化设计

### 当前耗时分析

| 阶段 | 耗时 | 说明 |
|------|------|------|
| Prompt 扩展（可选） | 5-15s | 调用 LLM 优化 prompt |
| FLUX 模型生成 | 30-90s | 模型本身较慢（正常） |
| 网络传输 | 5-10s | 下载 base64 图片 |
| **总计** | **40-115s** | |

### 优化方案

#### 1. 进度反馈优化

当前只有开始和结束提示，中间用户看不到进度。

```typescript
// src/main/tools/network/imageGenerate.ts

async execute(...): Promise<ToolExecutionResult> {
  const startTime = Date.now();

  // 阶段 1: 模型选择
  context.emit?.('tool_progress', {
    tool: 'image_generate',
    stage: 'init',
    message: `使用模型: ${isAdmin ? 'FLUX Pro' : 'FLUX Schnell'}`,
    progress: 5,
  });

  // 阶段 2: Prompt 扩展（可选）
  if (expand_prompt) {
    context.emit?.('tool_progress', {
      tool: 'image_generate',
      stage: 'prompt_expand',
      message: '优化描述中...',
      progress: 15,
    });
    finalPrompt = await expandPromptWithLLM(prompt, style);
  }

  // 阶段 3: 图片生成
  context.emit?.('tool_progress', {
    tool: 'image_generate',
    stage: 'generating',
    message: '生成中（约 30-60 秒）...',
    progress: 30,
  });

  // 启动定时器模拟进度
  const progressInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const estimatedProgress = Math.min(30 + (elapsed / 60000) * 50, 80);
    context.emit?.('tool_progress', {
      tool: 'image_generate',
      stage: 'generating',
      message: `生成中... ${Math.round(elapsed / 1000)}s`,
      progress: estimatedProgress,
    });
  }, 5000);

  try {
    const imageData = await generateImage(model, finalPrompt, aspectRatio);
    clearInterval(progressInterval);

    // 阶段 4: 完成
    context.emit?.('tool_progress', {
      tool: 'image_generate',
      stage: 'complete',
      message: '生成完成',
      progress: 100,
    });

    return { success: true, ... };
  } catch (error) {
    clearInterval(progressInterval);
    throw error;
  }
}
```

#### 2. 前端进度条展示

```typescript
// src/renderer/components/features/chat/MessageBubble/ToolCallDisplay.tsx

const ImageGenerateProgress: React.FC<{ progress: ToolProgress }> = ({ progress }) => {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-gray-700 rounded overflow-hidden">
        <div
          className="h-full bg-purple-500 transition-all duration-500"
          style={{ width: `${progress.progress}%` }}
        />
      </div>
      <span className="text-xs text-gray-400">{progress.message}</span>
    </div>
  );
};
```

#### 3. 超时处理优化

```typescript
// 当前超时设置
const TIMEOUT_MS = {
  CLOUD_PROXY: 60000,   // 云端代理 60 秒（Vercel 限制）
  DIRECT_API: 90000,    // 直接 API 90 秒
  PROMPT_EXPAND: 30000, // Prompt 扩展 30 秒
};

// 优化：提供更好的超时提示
async function generateImage(...): Promise<string> {
  try {
    return await generateImageInternal(...);
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error(
        `图片生成超时。\n\n` +
        `FLUX 模型生成一张图片通常需要 30-60 秒。\n` +
        `如果持续超时，可能是：\n` +
        `1. 网络连接不稳定\n` +
        `2. API 服务繁忙\n\n` +
        `建议稍后重试，或使用更简单的描述。`
      );
    }
    throw error;
  }
}
```

---

## 实施计划

### Phase 1: 紧急修复（P0）

**目标**: 解决上下文超限导致的崩溃

1. 实现 `sanitizeToolResultForHistory()` 函数
2. 修改工具结果存储逻辑
3. 测试 `image_generate` 多次调用不再超限

**预计工时**: 2 小时

### Phase 2: 错误处理优化（P1）

**目标**: 友好的用户提示

1. 实现 `ContextLengthExceededError`
2. 修改 `modelRouter.ts` 捕获错误
3. 前端展示友好提示

**预计工时**: 3 小时

### Phase 3: 进度反馈优化（P2）

**目标**: 改善图片生成体验

1. 实现 `tool_progress` 事件
2. 前端进度条组件
3. 超时提示优化

**预计工时**: 4 小时

---

## 测试验证

### 功能测试

1. **Token 优化验证**
   - 生成图片后，检查 `message.content` 不含 base64
   - 连续生成 3 张图片，确认不超限
   - 验证前端仍能正确显示图片

2. **错误处理验证**
   - 模拟超限错误，确认显示友好提示
   - 确认提供"新开会话"选项

3. **进度反馈验证**
   - 确认进度条显示
   - 确认超时后显示友好提示

### 性能测试

1. 清理逻辑不影响工具执行性能（<10ms）
2. 消息构建不因清理而变慢

---

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 清理逻辑误删重要数据 | 模型决策受影响 | 只清理明确的二进制字段，保守策略 |
| 前端未收到完整数据 | 图片无法显示 | 确保事件发送在清理之前 |
| 会话恢复丢失图片 | 历史图片无法查看 | 保留 `imagePath`，图片文件本身不删 |

---

## 参考

- [ADR-001: Turn-Based Messaging](./001-turn-based-messaging.md)
- DeepSeek API 文档: 上下文限制 131,072 tokens
- OpenRouter FLUX 模型: 生成时间 30-90 秒
