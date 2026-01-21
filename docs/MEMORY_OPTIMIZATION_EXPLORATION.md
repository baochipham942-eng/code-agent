# Code Agent 记忆系统优化探索提示词

> 结合 Smart Forking + MIRIX 6层架构 + Cowork/Code Agent 产品需求

---

## 核心洞察：Smart Forking 的本质

Smart Forking 不是复杂的记忆系统，而是一个**极简但高效**的设计：

```
核心思想：
1. 每个会话结束 → 自动向量化存储
2. 新会话开始 → 检索相关历史会话
3. 用户选择 → Fork 继承上下文

关键价值：
- 不重复解释项目背景
- 复用历史解决方案
- 积累的 context 不浪费
```

**这告诉我们**：不需要实现所有 6 层记忆，只需要实现**对用户有感知价值**的能力。

---

## Cowork & Code Agent 产品需求分析

### 产品定位差异

| 维度 | Cowork (Claude Desktop) | Code Agent (你的项目) |
|------|------------------------|----------------------|
| 用户群体 | 通用用户 | 开发者 |
| 会话特点 | 短会话、多主题 | 长会话、单项目 |
| 记忆需求 | 跨会话偏好 | 项目上下文 + 代码历史 |
| 核心痛点 | "重复解释我是谁" | "重复解释项目背景" |

### 用户真正的痛点场景

```
场景 1：项目切换
"我昨天在 A 项目加了认证，今天想在 B 项目也加，但要重新解释一遍"
→ 需要：跨项目知识迁移

场景 2：功能迭代
"上周讨论过这个 API 设计，现在想继续，但 agent 忘了"
→ 需要：会话 Fork / 上下文继承

场景 3：重复问题
"每次都要解释我喜欢 TypeScript + Tailwind 这套技术栈"
→ 需要：用户偏好持久化

场景 4：代码审查
"这个函数我之前改过一版，agent 推荐的方案和之前冲突了"
→ 需要：记忆验证 / 冲突检测
```

---

## 能力优先级评估（产品视角）

### 🔴 P0: 必须有（用户可感知价值）

| 能力 | 用户价值 | Smart Forking 映射 | 你的现状 |
|------|---------|-------------------|---------|
| **会话摘要** | 快速定位历史会话 | ✅ 核心 | ❌ 缺失 |
| **会话检索** | "找到上次讨论 XX 的对话" | ✅ 核心 | ⚠️ 有 RAG 但无 UI 入口 |
| **上下文继承** | Fork 后不用重复解释 | ✅ 核心 | ❌ 缺失 |
| **用户偏好** | 记住技术栈/代码风格 | Core Memory | ⚠️ 简单实现 |

### 🟡 P1: 应该有（提升体验）

| 能力 | 用户价值 | 复杂度 | 你的现状 |
|------|---------|--------|---------|
| **时间衰减** | 新信息优先于旧信息 | 低 | ❌ 缺失 |
| **记忆验证** | 避免过时建议 | 中 | ❌ 缺失 |
| **项目知识** | 记住项目特定约定 | 低 | ✅ 已有 |

### 🟢 P2: 可以有（锦上添花）

| 能力 | 用户价值 | 复杂度 | 你的现状 |
|------|---------|--------|---------|
| **知识蒸馏** | 自动总结模式 | 高 | ❌ 缺失 |
| **记忆路由** | 更精准的分类 | 高 | ❌ 缺失 |
| **Reranking** | 更精准的检索 | 中 | ❌ 缺失 |

### ⚪ P3: 暂不需要（过度设计）

| 能力 | 为什么不需要 |
|------|-------------|
| **Knowledge Vault** | Code Agent 不处理银行卡/密码等敏感信息 |
| **复杂知识图谱** | 扁平 KV 对大多数场景够用 |
| **Multi-agent 记忆共享** | 单用户产品，无需跨 agent 同步 |

---

## 精简版实施方案

### 只做 P0：Smart Forking 最小实现

```
目标：用最少的代码实现 80% 的价值

需要新增：
1. SessionSummarizer - 会话结束时生成摘要
2. ForkDetector - 检索相关历史会话
3. ContextInjector - 将历史上下文注入新会话

不需要改：
- 现有 VectorStore（已经能存储会话）
- 现有 MemoryService（已经有 RAG）
```

---

## 探索性 Prompt（精简版）

### Prompt 1：会话摘要生成

```markdown
# 任务：设计 SessionSummarizer

## 背景
我的 Code Agent 项目需要在会话结束时自动生成摘要，用于后续检索。

## 现有能力
- `src/main/memory/memoryService.ts` - 已有 `saveConversation()` 存储原始消息
- `src/main/memory/vectorStore.ts` - 已有向量存储和检索
- `src/main/services/sessionManager.ts` - 管理会话生命周期

## 需求
设计一个 `SessionSummarizer` 类：

1. **触发时机**
   - 会话结束时（用户关闭/切换项目）
   - 消息数超过阈值（如 20 条）

2. **摘要内容**
   ```typescript
   interface SessionSummary {
     sessionId: string;
     title: string;           // 一句话标题，如"实现 JWT 认证"
     topics: string[];        // 讨论主题，如 ["authentication", "JWT", "middleware"]
     keyDecisions: string[];  // 关键决策，如 ["使用 jose 库", "token 存 httpOnly cookie"]
     codeChanges: string[];   // 修改的文件，如 ["src/auth.ts", "src/middleware.ts"]
     openQuestions: string[]; // 未解决问题，如 ["refresh token 策略待定"]
     createdAt: number;
     messageCount: number;
   }
   ```

3. **生成方式**
   - 方案 A：用 LLM 总结（质量高，成本高）
   - 方案 B：规则提取（质量中，成本零）
   - 建议：默认用规则提取，可选 LLM 增强

4. **存储位置**
   - 摘要文本 → 向量库（用于语义检索）
   - 结构化数据 → SQLite metadata

## 约束
- 兼容现有 VectorDocument 结构
- 摘要生成不应阻塞用户操作（异步）
- 考虑离线场景（LLM 不可用时的降级）

## 验收标准
- 生成 `src/main/memory/sessionSummarizer.ts`
- 集成到 SessionManager 的会话结束流程
- 单元测试覆盖主要场景
```

---

### Prompt 2：会话 Fork 检测

```markdown
# 任务：设计 ForkDetector 工具

## 背景
参考 Smart Forking 思路，当用户开始新任务时，自动检索相关历史会话。

## 需求
实现一个 `fork_session` 工具：

1. **工具定义**
   ```typescript
   {
     name: "fork_session",
     description: "检索与当前任务相关的历史会话，可选择继承其上下文",
     parameters: {
       query: {
         type: "string",
         description: "描述你想做什么，如'实现用户认证'"
       },
       projectPath: {
         type: "string",
         description: "可选，限定在特定项目内搜索"
       }
     }
   }
   ```

2. **返回结构**
   ```typescript
   interface ForkDetectionResult {
     relevantSessions: Array<{
       sessionId: string;
       title: string;
       summary: string;
       relevanceScore: number;  // 0-1
       createdAt: number;
       projectPath?: string;
       messageCount: number;
     }>;
     suggestedAction: 'fork' | 'new' | 'ask';
     reason: string;
   }
   ```

3. **检索策略**
   - 向量相似度（语义匹配）
   - 项目路径过滤（同项目优先）
   - 时间衰减（近期会话加权）
   - 复合得分：`score = 0.6*semantic + 0.2*recency + 0.2*sameProject`

4. **用户交互**
   - 如果找到高度相关会话（score > 0.8），询问是否 fork
   - 如果找到中度相关会话（0.5-0.8），展示列表让用户选择
   - 如果无相关会话（< 0.5），直接开始新会话

## 集成点
- 可在 `MemoryTriggerService.onSessionStart()` 中自动调用
- 也可作为用户主动触发的工具

## 验收标准
- 生成 `src/main/tools/gen5/forkSession.ts`
- 添加到工具注册表
- 在 system prompt 中引导 agent 适时使用
```

---

### Prompt 3：上下文注入

```markdown
# 任务：设计 ContextInjector

## 背景
用户选择 fork 某个历史会话后，需要将其关键上下文注入当前会话。

## 需求
实现 `ContextInjector` 模块：

1. **注入内容**
   ```typescript
   interface InjectedContext {
     // 来源信息
     fromSession: {
       id: string;
       title: string;
       createdAt: number;
     };

     // 注入的上下文
     summary: string;           // 会话摘要
     keyMessages: Message[];    // 关键消息（最多 5 条）
     decisions: string[];       // 已做的决策
     codeContext: string[];     // 相关代码片段

     // 警告信息
     warnings: string[];        // 如"此会话来自 30 天前，代码可能已变更"
   }
   ```

2. **注入方式**
   - 方案 A：追加到 system prompt（推荐）
   - 方案 B：作为首条 assistant 消息
   - 方案 C：用户可见的"历史上下文"卡片

3. **关键消息选择策略**
   - 包含代码块的消息
   - 包含决策性陈述的消息（"我们决定..."、"最终方案是..."）
   - 用户明确强调的消息（"重要："、"注意："）
   - 最后 2 条消息（保持连续性）

4. **防漂移机制**
   - 明确标记为"历史参考"
   - 添加时间戳警告
   - 对涉及文件路径的内容，验证文件是否存在

## 验收标准
- 生成 `src/main/memory/contextInjector.ts`
- 集成到 `buildEnhancedSystemPrompt()` 流程
- 注入的内容有明确的视觉区分
```

---

### Prompt 4：时间衰减 + 记忆验证（P1）

```markdown
# 任务：添加时间衰减和记忆验证

## 背景
当前 VectorStore 的 search 没有考虑时间因素，可能返回过时信息。

## 需求 1：时间衰减

修改 `vectorStore.ts` 的检索逻辑：

```typescript
// 当前
score = cosineSimilarity(query, doc)

// 改为
const age = Date.now() - doc.metadata.createdAt;
const recencyScore = Math.exp(-age / (30 * 24 * 60 * 60 * 1000)); // 30 天半衰期
const finalScore = 0.7 * semanticScore + 0.3 * recencyScore;
```

可配置参数：
- `decayHalfLife`: 半衰期（默认 30 天）
- `recencyWeight`: recency 权重（默认 0.3）

## 需求 2：记忆验证

在返回 RAG 结果前，验证记忆有效性：

```typescript
interface ValidationResult {
  isValid: boolean;
  warnings: string[];
  suggestedAction: 'use' | 'warn' | 'discard';
}

async function validateMemory(doc: VectorDocument): Promise<ValidationResult> {
  const warnings = [];

  // 1. 时效性检查
  const ageInDays = (Date.now() - doc.metadata.createdAt) / (24*60*60*1000);
  if (ageInDays > 30) {
    warnings.push(`此信息来自 ${Math.floor(ageInDays)} 天前，可能已过时`);
  }

  // 2. 文件存在性检查（如果是代码记忆）
  if (doc.metadata.filePath) {
    const exists = await fileExists(doc.metadata.filePath);
    if (!exists) {
      warnings.push(`相关文件 ${doc.metadata.filePath} 已不存在`);
      return { isValid: false, warnings, suggestedAction: 'discard' };
    }
  }

  // 3. 代码 hash 验证（可选，更严格）
  if (doc.metadata.codeHash) {
    const currentHash = await getFileHash(doc.metadata.filePath);
    if (currentHash !== doc.metadata.codeHash) {
      warnings.push(`文件内容已变更，历史上下文可能不适用`);
    }
  }

  return {
    isValid: true,
    warnings,
    suggestedAction: warnings.length > 0 ? 'warn' : 'use'
  };
}
```

## 验收标准
- 修改 `searchWithEmbedding()` 添加时间衰减
- 新增 `validateMemory()` 函数
- 在 `getRAGContext()` 返回时附带 warnings
```

---

### Prompt 5：用户偏好增强（P0 补充）

```markdown
# 任务：增强 Core Memory (用户偏好)

## 背景
当前 `userPreferences` 是简单 KV，需要结构化以支持更丰富的场景。

## 需求

设计增强版 CoreMemory：

```typescript
interface CoreMemory {
  // 用户画像
  human: {
    name?: string;
    role?: string;                    // "前端开发者"、"全栈工程师"
    experienceLevel?: 'junior' | 'mid' | 'senior';
    primaryLanguages: string[];       // ["TypeScript", "Python"]
    preferredFrameworks: string[];    // ["React", "Next.js"]
  };

  // 编码偏好
  codingStyle: {
    indentation: 'tabs' | '2spaces' | '4spaces';
    quotes: 'single' | 'double';
    semicolons: boolean;
    trailingComma: 'none' | 'es5' | 'all';
    namingConvention: 'camelCase' | 'snake_case' | 'PascalCase';
  };

  // 工作流偏好
  workflow: {
    preferredTestFramework?: string;  // "jest", "vitest"
    commitMessageStyle?: string;      // "conventional", "simple"
    preferDetailedExplanations: boolean;
    preferCodeCommentsLanguage: 'zh' | 'en';
  };

  // Agent 人设（可选）
  persona?: {
    name?: string;
    style?: 'concise' | 'detailed' | 'friendly';
    expertise?: string[];
  };
}
```

## 学习机制

自动从会话中学习偏好：

```typescript
async function learnPreferencesFromSession(messages: Message[]): Promise<Partial<CoreMemory>> {
  const learned: Partial<CoreMemory> = {};

  // 1. 从代码片段学习编码风格
  const codeBlocks = extractCodeBlocks(messages);
  if (codeBlocks.length > 0) {
    learned.codingStyle = inferCodingStyle(codeBlocks);
  }

  // 2. 从用户陈述中提取显式偏好
  const userMessages = messages.filter(m => m.role === 'user');
  const explicitPrefs = extractExplicitPreferences(userMessages);
  // 如："我喜欢用 Tailwind"、"请用中文注释"

  // 3. 从工具使用中推断偏好
  const toolUsage = analyzeToolUsage(messages);
  if (toolUsage['bash'] > toolUsage['other']) {
    learned.workflow = { prefersCLI: true };
  }

  return learned;
}
```

## 持久化
- 存储位置：`~/Library/Application Support/code-agent/core-memory.json`
- 跨项目共享（不绑定 projectPath）
- 支持用户手动编辑

## 验收标准
- 新增 `src/main/memory/coreMemory.ts`
- 集成到 `learnFromSession()` 流程
- 在 system prompt 中注入用户偏好
```

---

## 实施路线图（修订版）

### Week 1-2: Smart Forking MVP

```
Day 1-3: SessionSummarizer
- [ ] 设计 SessionSummary 结构
- [ ] 实现规则提取（从消息中提取 topics/decisions）
- [ ] 存储到向量库

Day 4-5: ForkDetector
- [ ] 实现 fork_session 工具
- [ ] 添加到工具注册表
- [ ] 测试检索效果

Day 6-7: ContextInjector
- [ ] 实现上下文注入
- [ ] 添加防漂移警告
- [ ] 集成到 system prompt
```

### Week 3: 体验优化

```
- [ ] 添加时间衰减
- [ ] 添加记忆验证
- [ ] 增强 Core Memory
- [ ] UI：历史会话列表
```

### Week 4+: 可选增强

```
- [ ] LLM 生成摘要（提升质量）
- [ ] Reranking（提升检索精度）
- [ ] 知识蒸馏（自动发现模式）
```

---

## 最终结论

### Cowork/Code Agent 真正需要的能力

| 能力 | 必要性 | 理由 |
|------|--------|------|
| **会话摘要 + 检索 + Fork** | 🔴 必须 | Smart Forking 核心，解决"重复解释"痛点 |
| **用户偏好持久化** | 🔴 必须 | 记住编码风格、技术栈偏好 |
| **时间衰减** | 🟡 应该 | 简单有效，防止旧信息污染 |
| **记忆验证** | 🟡 应该 | 防止推荐过时方案 |
| **知识蒸馏** | 🟢 可选 | 锦上添花，复杂度高 |
| **6层记忆架构** | ⚪ 不需要 | 过度设计，大部分用不上 |

### 一句话总结

> **做 Smart Forking 的核心（摘要+检索+Fork）+ 时间衰减 + 记忆验证，就够了。**
>
> 不要追求 MIRIX 的 6 层架构，那是为多 agent 协作设计的，单用户产品用不上。

---

## 参考资源

- [Smart Forking 原帖 (X/@PerceptualPeak)](https://x.com/PerceptualPeak/status/2012741829683224584)
- [MIRIX: Multi-Agent Memory System](https://arxiv.org/abs/2507.07957)
- [IBM: What Is AI Agent Memory?](https://www.ibm.com/think/topics/ai-agent-memory)
- [Memory in AI Agents (Hugging Face)](https://huggingface.co/blog/Kseniase/memory)
- [AI Memory Layer Guide (Mem0)](https://mem0.ai/blog/ai-memory-layer-guide)
