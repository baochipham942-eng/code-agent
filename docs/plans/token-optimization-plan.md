# Token 消耗优化计划

> 基于深度代码分析的改进方案，预期节省 25-40% token 消耗

## 问题总览

| 问题 | 当前成本 | 根因 | 优先级 |
|------|---------|------|--------|
| 系统提示词重复 | 5-8k tokens/代际 | 所有代际加载相同规则 | P1 |
| Hook 消息膨胀 | 25 处注入点 | 无去重/折叠机制 | P1 |
| 工具结果未压缩 | 1-3k/工具调用 | compressor.ts 未被使用 | P1 |
| RAG 上下文重查 | 1.5k × N轮 | 无缓存机制 | P2 |
| Token 估算粗糙 | ±20% 误差 | 使用字符数/4 而非精确估算 | P2 |

---

## 问题 1: 系统提示词重复加载

### 现状分析

**文件统计：**
```
constitution/  222 行 (~1,500 tokens)
rules/         400+ 行 (~2,500 tokens)
tools/         434 行 (~2,000 tokens)
base/gen1-8    458 行 (~2,000 tokens)
────────────────────────────────────
总计：         ~8,000 tokens/代际
```

**代码位置：** `src/main/generation/prompts/builder.ts:58-161`

**问题：** Gen1-Gen8 加载几乎相同的规则集，差异仅在：
- Gen1: 7 项规则
- Gen2: +PARALLEL_TOOLS_RULES
- Gen3+: +PLAN_MODE_RULES, +GIT_SAFETY_RULES, +INJECTION_DEFENSE_RULES
- Gen4+: +GITHUB_ROUTING_RULES

但实际上 Gen5-8 的规则配置**完全相同**。

### 改进方案

**方案 A: 规则分层加载（推荐）**

```typescript
// builder.ts 改进
const RULE_TIERS = {
  // 基础层：所有代际
  basic: [
    OUTPUT_FORMAT_RULES,
    PROFESSIONAL_OBJECTIVITY_RULES,
    CODE_REFERENCE_RULES,
    ERROR_HANDLING_RULES,
  ],
  // 协作层：Gen2+
  collaboration: [
    PARALLEL_TOOLS_RULES,
  ],
  // 高级层：Gen3+
  advanced: [
    PLAN_MODE_RULES,
    GIT_SAFETY_RULES,
    INJECTION_DEFENSE_RULES,
  ],
  // 网络层：Gen4+
  network: [
    GITHUB_ROUTING_RULES,
  ],
};

function getRulesForGeneration(genId: GenerationId): string[] {
  const genNum = parseInt(genId.replace('gen', ''), 10);

  let rules = [...RULE_TIERS.basic];
  if (genNum >= 2) rules.push(...RULE_TIERS.collaboration);
  if (genNum >= 3) rules.push(...RULE_TIERS.advanced);
  if (genNum >= 4) rules.push(...RULE_TIERS.network);

  return rules;
}
```

**方案 B: 简单任务快速模式**

```typescript
// 新增 prompts/base/simple.ts
export const SIMPLE_TASK_PROMPT = `
You are a coding assistant. Help with the user's request concisely.

Available tools: read_file, write_file, edit_file, bash, glob

Rules:
- Be direct and concise
- Use only necessary tools
- No verbose explanations
`.trim();  // ~200 tokens vs 8,000

// agentLoop.ts 使用
if (this.isSimpleTaskMode && genNum <= 2) {
  return SIMPLE_TASK_PROMPT;
}
```

### 预期收益

| 场景 | 当前 | 改进后 | 节省 |
|------|------|--------|------|
| Gen1 简单任务 | 8,000 | 200 | 97.5% |
| Gen1-2 普通任务 | 8,000 | 4,500 | 43.8% |
| Gen3-4 普通任务 | 8,000 | 6,500 | 18.8% |
| Gen5-8 复杂任务 | 8,000 | 8,000 | 0% |

**平均节省：20-30% 系统提示词成本**

---

## 问题 2: Hook 消息无控制注入

### 现状分析

**注入点统计：** `agentLoop.ts` 中有 **25 处** `injectSystemMessage` 调用

| 类别 | 调用位置 | 频率 | tokens/次 |
|------|---------|------|-----------|
| 复杂度提示 | 260, 307 | 1次/会话 | 200-400 |
| Session Hook | 322, 335 | 1-2次/会话 | 100-300 |
| Stop Hook | 425, 430, 445 | 最多3次/停止 | 200-500 |
| 工具格式错误 | 405 | 重试时 | 300-500 |
| 截断警告 | 513 | 大输出时 | 100-200 |
| PreTool Hook | 854, 867, 883 | 每工具1次 | 100-300 |
| 工具执行警告 | 920, 969, 986, 994 | 条件触发 | 100-300 |
| 自动续行 | 1003 | 迭代时 | 50-100 |
| PostTool Hook | 1033, 1062 | 每工具1次 | 100-300 |
| 失败 Hook | 1092, 1115, 1132 | 失败时 | 200-400 |

**典型 5 轮对话（每轮 2 工具）的 Hook 消息成本：**
```
Session Start:       300 tokens
复杂度分析:          300 tokens
PreTool × 10:      1,500 tokens
PostTool × 10:     1,500 tokens
自动续行 × 4:        200 tokens
─────────────────────────────
总计:              3,800 tokens
```

### 改进方案

**方案 A: Hook 消息缓冲与折叠**

```typescript
// agentLoop.ts 改进
class HookMessageBuffer {
  private buffer: Map<string, { content: string; count: number }> = new Map();

  add(category: string, content: string): void {
    const existing = this.buffer.get(category);
    if (existing) {
      // 相同类别的消息合并计数，不重复内容
      existing.count++;
    } else {
      this.buffer.set(category, { content, count: 1 });
    }
  }

  flush(): string | null {
    if (this.buffer.size === 0) return null;

    const merged = Array.from(this.buffer.entries())
      .map(([cat, { content, count }]) =>
        count > 1 ? `[${cat} ×${count}]\n${content}` : `[${cat}]\n${content}`
      )
      .join('\n---\n');

    this.buffer.clear();
    return merged;
  }
}

// 使用
private hookBuffer = new HookMessageBuffer();

// 替换直接注入
this.hookBuffer.add('pre-tool', hookResult.message);

// 在迭代结束时一次性注入
const mergedHooks = this.hookBuffer.flush();
if (mergedHooks) {
  this.injectSystemMessage(mergedHooks);
}
```

**方案 B: Hook 消息去重**

```typescript
// 基于内容哈希去重
private injectedHashes = new Set<string>();

private injectSystemMessageDeduped(content: string, category: string): boolean {
  const hash = this.hashContent(content.substring(0, 100));
  const key = `${category}:${hash}`;

  if (this.injectedHashes.has(key)) {
    logger.debug(`Skipping duplicate hook: ${category}`);
    return false;
  }

  this.injectedHashes.add(key);
  this.injectSystemMessage(content);
  return true;
}
```

**方案 C: Hook 消息压缩**

```typescript
// 对长 Hook 消息进行摘要
private injectSystemMessageCompressed(content: string, maxTokens = 200): void {
  const tokens = estimateTokens(content);

  if (tokens > maxTokens) {
    // 截取关键信息
    const compressed = content.substring(0, maxTokens * 3) + '\n[... truncated]';
    this.injectSystemMessage(compressed);
  } else {
    this.injectSystemMessage(content);
  }
}
```

### 预期收益

| 方案 | 实施难度 | 节省比例 | 推荐 |
|------|---------|---------|------|
| A: 缓冲折叠 | 中 | 50-60% | ✓ |
| B: 去重 | 低 | 20-30% | ✓ |
| C: 压缩 | 低 | 10-20% | ✓ |
| 组合 A+B+C | 中 | 60-70% | ✓✓ |

**预期节省：2,000-2,500 tokens/会话**

---

## 问题 3: 工具结果完全未压缩

### 现状分析

**关键发现：** `compressor.ts` 实现了完整的 457 行压缩器，但**零使用**！

```bash
# 搜索 ContextCompressor 使用情况
$ grep -r "ContextCompressor" src/
src/main/context/compressor.ts  # 仅定义，无导入
```

**工具结果进入历史的路径：**
```
agentLoop.ts:537  toolExecutor.execute()
         ↓
agentLoop.ts:553  JSON.stringify(sanitizedResults)  ← 无压缩！
         ↓
agentLoop.ts:1462 buildModelMessages()
         ↓
直接进入 LLM 上下文
```

**典型工具输出大小：**
| 工具 | 典型输出 | tokens |
|------|---------|--------|
| read_file (大文件) | 10-50KB | 3,000-15,000 |
| bash (npm install) | 5-20KB | 1,500-6,000 |
| grep (多匹配) | 2-10KB | 600-3,000 |
| glob (大目录) | 1-5KB | 300-1,500 |

### 改进方案

**方案：集成 ContextCompressor**

```typescript
// agentLoop.ts:553 处改进
import { ContextCompressor, DEFAULT_STRATEGIES } from '../context/compressor';

private compressToolResult(result: ToolResult): ToolResult {
  const content = typeof result.result === 'string'
    ? result.result
    : JSON.stringify(result.result);

  const tokens = estimateTokens(content);

  // 超过阈值时压缩
  if (tokens > 500) {
    const compressor = new ContextCompressor({
      tokenLimit: 500,
      strategies: [
        { type: 'code_extract', threshold: 0.8, targetRatio: 0.6, priority: 3 },
        { type: 'truncate', threshold: 0.9, targetRatio: 0.5, priority: 2 },
      ],
    });

    const compressed = compressor.compressText(content);

    if (compressed.wasCompressed) {
      logger.info(`Tool result compressed: ${compressed.savedTokens} tokens saved`);
      return {
        ...result,
        result: `[Compressed: ${tokens}→${compressed.compressedTokens} tokens]\n${compressed.content}`,
      };
    }
  }

  return result;
}

// 在 executeTools 中使用
const compressedResults = results.map(r => this.compressToolResult(r));
```

### 预期收益

| 工具类型 | 压缩前 | 压缩后 | 节省 |
|---------|--------|--------|------|
| read_file | 5,000 | 500 | 90% |
| bash 输出 | 2,000 | 500 | 75% |
| grep 结果 | 1,500 | 500 | 67% |
| 平均 | 2,500 | 500 | 80% |

**预期节省：1,500-2,000 tokens/工具调用**

---

## 问题 4: RAG 上下文重复查询

### 现状分析

**代码位置：** `contextBuilder.ts:74-149`

```typescript
export function buildEnhancedSystemPrompt(
  basePrompt: string,
  userQuery: string,
  generationId: string,
  isSimpleTaskMode: boolean
): string {
  // ...
  if (isFullRAG) {
    const ragContext = memoryService.getRAGContext(userQuery, {
      maxTokens: 1500,  // 每次都查询
    });
    // ...
  }
}
```

**调用频率：** `agentLoop.ts:1449-1451` 每轮迭代都调用

**问题：** 同一会话的 10 轮迭代，如果用户查询相同，会重复查询 10 次 RAG。

### 改进方案

**方案：会话级 RAG 缓存**

```typescript
// contextBuilder.ts 改进
interface RAGCache {
  query: string;
  context: string;
  timestamp: number;
  tokens: number;
}

class RAGContextCache {
  private cache: Map<string, RAGCache> = new Map();
  private readonly TTL = 5 * 60 * 1000; // 5 分钟

  get(query: string): RAGCache | null {
    const key = this.normalizeQuery(query);
    const cached = this.cache.get(key);

    if (cached && Date.now() - cached.timestamp < this.TTL) {
      return cached;
    }

    return null;
  }

  set(query: string, context: string, tokens: number): void {
    const key = this.normalizeQuery(query);
    this.cache.set(key, {
      query,
      context,
      timestamp: Date.now(),
      tokens,
    });
  }

  private normalizeQuery(query: string): string {
    // 取前 100 字符作为 key，忽略细微差异
    return query.substring(0, 100).toLowerCase().trim();
  }
}

// 使用
const ragCache = new RAGContextCache();

export function buildEnhancedSystemPrompt(...): string {
  // ...
  if (isFullRAG) {
    const cached = ragCache.get(userQuery);

    if (cached) {
      logger.debug(`RAG cache hit: ${cached.tokens} tokens`);
      return basePrompt + cached.context;
    }

    const ragContext = memoryService.getRAGContext(userQuery, {...});
    ragCache.set(userQuery, ragContext, estimateTokens(ragContext));
    // ...
  }
}
```

### 预期收益

| 场景 | 当前 | 改进后 | 节省 |
|------|------|--------|------|
| 10 轮相同查询 | 15,000 | 1,500 | 90% |
| 5 轮不同查询 | 7,500 | 7,500 | 0% |
| 混合场景 | 10,000 | 4,000 | 60% |

**预期节省：500-1,000 tokens/多轮会话**

---

## 问题 5: Token 估算精度不足

### 现状分析

**精确实现（未使用）：** `tokenEstimator.ts`
```typescript
export const TOKEN_RATIOS = {
  CJK: 2.0,      // 中文 2 字符/token
  ENGLISH: 3.5,  // 英文 3.5 字符/token
  CODE: 3.0,     // 代码 3 字符/token
  JSON: 2.5,     // JSON 2.5 字符/token
};
```

**粗糙实现（实际使用）：** `agentLoop.ts:1381-1392`
```typescript
const estimatedInputTokens = Math.ceil(inputChars / 4);  // 一刀切！
```

**误差分析：**
| 内容类型 | 实际比率 | 使用比率 | 误差 |
|---------|---------|---------|------|
| 中文 | 2.0 | 4.0 | +100% 高估 |
| 英文 | 3.5 | 4.0 | +14% 高估 |
| 代码 | 3.0 | 4.0 | +33% 高估 |
| JSON | 2.5 | 4.0 | +60% 高估 |

### 改进方案

**方案：替换为精确估算**

```typescript
// agentLoop.ts 改进
import { estimateTokens, estimateConversationTokens } from '../context/tokenEstimator';

// 替换第 1381-1392 行
private recordTokenUsage(modelMessages: ModelMessage[]): void {
  const inputTokens = estimateConversationTokens(
    modelMessages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content.map(p => p.text || '').join(''),
    }))
  );

  // 使用精确估算
  this.budgetService.recordUsage({
    inputTokens,
    outputTokens: this.lastOutputTokens,
    model: this.modelConfig.model,
    breakdown: {
      systemPrompt: estimateTokens(this.generation.systemPrompt),
      messages: inputTokens,
    },
  });
}
```

### 预期收益

- 中文重型任务：预算跟踪误差从 ±100% 降至 ±10%
- 代码重型任务：预算跟踪误差从 ±33% 降至 ±5%
- **总体：提升成本透明度 60-80%**

---

## 实施计划

### Phase 1: 快速胜利（1-2 天）

| 任务 | 文件 | 预期节省 | 风险 |
|------|------|---------|------|
| 集成 ContextCompressor | agentLoop.ts | 1,500-2,000/调用 | 低 |
| Hook 消息去重 | agentLoop.ts | 500-800/会话 | 低 |
| Token 估算替换 | agentLoop.ts | 提升精度 | 低 |

### Phase 2: 中等改进（2-3 天）

| 任务 | 文件 | 预期节省 | 风险 |
|------|------|---------|------|
| Hook 消息缓冲折叠 | agentLoop.ts | 1,500-2,000/会话 | 中 |
| RAG 上下文缓存 | contextBuilder.ts | 500-1,000/会话 | 低 |
| 规则分层加载 | builder.ts | 1,500-2,500/会话 | 中 |

### Phase 3: 架构优化（3-5 天）

| 任务 | 文件 | 预期节省 | 风险 |
|------|------|---------|------|
| 简单任务快速模式 | 多文件 | 7,000+/简单任务 | 中 |
| 消息历史压缩 | agentLoop.ts | 1,000+/长会话 | 高 |
| 子 Agent 成本隔离 | subagentPipeline.ts | 可追溯性 | 中 |

---

## 成本影响预测

**假设：100 用户 × 100 会话/月 × $0.15/会话**

| 阶段 | 节省比例 | 月度节省 |
|------|---------|---------|
| Phase 1 | 15-20% | $225-300 |
| Phase 2 | 额外 10-15% | $150-225 |
| Phase 3 | 额外 5-10% | $75-150 |
| **总计** | **30-45%** | **$450-675** |

---

## 验证方法

### 1. Token 消耗基线测试

```typescript
// 创建测试脚本
async function measureTokenBaseline() {
  const scenarios = [
    { name: '简单问答', query: '什么是 React?' },
    { name: '代码生成', query: '写一个排序函数' },
    { name: '多工具任务', query: '读取文件并修改' },
  ];

  for (const scenario of scenarios) {
    const before = await runScenario(scenario, { optimization: false });
    const after = await runScenario(scenario, { optimization: true });

    console.log(`${scenario.name}: ${before.tokens} → ${after.tokens} (${
      ((before.tokens - after.tokens) / before.tokens * 100).toFixed(1)
    }% 节省)`);
  }
}
```

### 2. 回归测试

- 确保优化后的输出质量不变
- 验证 Hook 折叠不丢失关键信息
- 验证工具结果压缩保留关键内容

### 3. 性能监控

```typescript
// 添加 token 消耗监控
this.metrics.record('token_usage', {
  systemPrompt: systemPromptTokens,
  hooks: hookTokens,
  toolResults: toolResultTokens,
  rag: ragTokens,
  total: totalTokens,
});
```

---

## 下一步

1. **立即开始 Phase 1** - 风险低，收益明确
2. **建立基线测试** - 量化改进效果
3. **逐步实施 Phase 2-3** - 根据 Phase 1 结果调整

是否要我开始实现 Phase 1 的改进？
