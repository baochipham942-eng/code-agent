# Code Agent 高质量迭代计划

> 日期: 2026-01-24
> 基于: 当前实现状态分析

---

## 一、现状诊断

### 1.1 代际完成度评估

| 代际 | 完成度 | 状态 | 问题 |
|------|--------|------|------|
| Gen1-4 | 95% | ✅ 生产就绪 | 文档滞后 |
| Gen5 | 120% | ✅ 超额完成 | 工具散落在 network/，未归类 |
| Gen6 | 60% | ⚠️ 骨架完成 | Computer Use 缺少 Puppeteer/Playwright 集成 |
| Gen7 | 50% | ⚠️ 基础完成 | 缺少动态协调、Agent 间通信不够灵活 |
| Gen8 | 30% | ⚠️ 框架完成 | 「进化」是被动的，缺少自驱动机制 |

### 1.2 核心差距

**量已达标，质需提升：**

1. **Gen6 Computer Use** - 有鼠标键盘控制，但缺少：
   - 浏览器自动化（Puppeteer/Playwright）
   - 屏幕元素识别（OCR + 视觉模型）
   - 应用状态感知

2. **Gen7 Multi-Agent** - 有 spawn_agent，但缺少：
   - Agent 间实时消息传递
   - 共享工作空间
   - 动态角色分配
   - 冲突解决机制

3. **Gen8 Self-Evolution** - 有模式记录，但缺少：
   - 自动触发的元学习循环
   - Prompt 自优化
   - 失败驱动的策略调整
   - 能力缺口自动识别

---

## 二、迭代路线图

### Phase 1: 文档补全 + 代码整理（1-2 天）

**目标**: 让现有实现可被理解和使用

#### 1.1 更新 CLAUDE.md

```markdown
# 需要补充的内容：

## Gen3 新增
- confirm_action, read_clipboard
- plan_read, plan_update, enter_plan_mode, exit_plan_mode
- findings_write

## Gen5 文档生成套件
- docx_generate, excel_generate, pdf_generate
- chart_generate, mermaid_export, qrcode_generate
- image_process, image_analyze
- read_docx, read_xlsx
- academic_search, youtube_transcript, twitter_fetch
- screenshot_page, jira
- auto_learn, fork_session

## Gen6 视觉能力
- screenshot, computer_use
- browser_navigate, browser_action

## Gen7 多代理
- spawn_agent（预定义角色 + 并行执行）
- agent_message
- workflow_orchestrate（预定义流程模板）

## Gen8 自我进化
- strategy_optimize（策略管理）
- tool_create（动态工具创建）
- self_evaluate（性能评估）
- learn_pattern（模式学习）
```

#### 1.2 工具目录重构

```
src/main/tools/
├── gen1/          # bash, read_file, write_file, edit_file
├── gen2/          # glob, grep, list_directory
├── gen3/          # task, todo_write, ask_user_question, plan_*, confirm_action
├── gen4/          # skill, web_fetch, web_search, read_pdf, mcp_*
├── gen5/          # memory_*, ppt_generate, image_*, docx_*, excel_*, ...
├── gen6/          # screenshot, computer_use, browser_*
├── gen7/          # spawn_agent, agent_message, workflow_orchestrate
├── gen8/          # strategy_optimize, tool_create, self_evaluate, learn_pattern
└── utils/         # 公共工具函数
```

**当前问题**: 工具散落在 file/, network/, planning/, vision/, multiagent/, evolution/ 等目录

**方案**: 保持当前目录结构（按功能域），但在 generationMap.ts 中清晰映射

---

### Phase 2: Gen6 深化 - 真正的 Computer Use（3-5 天）

**目标**: 从「能点击」到「能操作应用」

#### 2.1 浏览器自动化集成

```typescript
// src/main/tools/vision/browserAutomation.ts

interface BrowserAutomationTool {
  // 基于 Puppeteer/Playwright
  actions: {
    navigate: (url: string) => Promise<void>;
    click: (selector: string) => Promise<void>;
    type: (selector: string, text: string) => Promise<void>;
    screenshot: () => Promise<Buffer>;
    evaluate: (script: string) => Promise<any>;
    waitFor: (selector: string, timeout?: number) => Promise<void>;
  };

  // 智能元素定位（结合视觉模型）
  findElement: (description: string) => Promise<ElementHandle>;
}
```

#### 2.2 屏幕理解增强

```typescript
// src/main/tools/vision/screenUnderstanding.ts

interface ScreenUnderstanding {
  // 截图 + 视觉模型分析
  describeScreen: () => Promise<ScreenDescription>;

  // 找到特定元素的位置
  locateElement: (description: string) => Promise<BoundingBox>;

  // 识别当前应用状态
  detectAppState: () => Promise<AppState>;

  // OCR 文字识别
  extractText: (region?: BoundingBox) => Promise<string>;
}
```

#### 2.3 交付标准

- [ ] 能自动填写网页表单
- [ ] 能在 Finder 中创建文件夹
- [ ] 能操作 VS Code（打开文件、执行命令）
- [ ] 错误恢复（点击失败时重试、元素未找到时等待）

---

### Phase 3: Gen7 深化 - 真正的多代理协作（5-7 天）

**目标**: 从「串行调用」到「并行协作」

#### 3.1 Agent 间通信机制

```typescript
// src/main/agent/agentBus.ts

interface AgentBus {
  // 发布-订阅模式
  publish: (topic: string, message: AgentMessage) => void;
  subscribe: (topic: string, handler: MessageHandler) => Unsubscribe;

  // 请求-响应模式
  request: (targetAgent: string, request: AgentRequest) => Promise<AgentResponse>;

  // 共享状态
  sharedState: SharedStateStore;
}

interface SharedStateStore {
  get: <T>(key: string) => T | undefined;
  set: <T>(key: string, value: T) => void;
  watch: <T>(key: string, handler: (value: T) => void) => Unsubscribe;
}
```

#### 3.2 动态 Agent 协调器

```typescript
// src/main/agent/dynamicCoordinator.ts

interface DynamicCoordinator {
  // 根据任务动态分配角色
  assignRoles: (task: Task) => Promise<RoleAssignment[]>;

  // 监控 Agent 进度
  monitorProgress: () => AgentProgress[];

  // 处理冲突（多个 Agent 要修改同一文件）
  resolveConflict: (conflict: Conflict) => Promise<Resolution>;

  // 动态调整策略
  rebalance: () => Promise<void>;
}
```

#### 3.3 预定义协作模式

```typescript
// 扩展 workflowOrchestrate.ts

const COLLABORATION_PATTERNS = {
  // 主从模式：一个主 Agent 协调多个工作 Agent
  'master-worker': { ... },

  // 管道模式：任务在 Agent 间顺序流转
  'pipeline': { ... },

  // 共识模式：多个 Agent 投票决策
  'consensus': { ... },

  // 竞争模式：多个 Agent 并行尝试，取最佳结果
  'race': { ... },
};
```

#### 3.4 交付标准

- [ ] 3 个 Agent 能同时工作在不同文件上
- [ ] Agent A 完成后能自动通知 Agent B
- [ ] 文件冲突时能自动协调或请求人工介入
- [ ] 能可视化展示多 Agent 工作状态

---

### Phase 4: Gen8 深化 - 真正的自我进化（7-10 天）

**目标**: 从「被动记录」到「自驱动优化」

#### 4.1 元学习循环

```typescript
// src/main/evolution/metaLearning.ts

interface MetaLearningLoop {
  // 任务完成后自动触发
  onTaskComplete: (task: Task, result: TaskResult) => Promise<void>;

  // 分析成功/失败模式
  analyzePatterns: () => Promise<PatternAnalysis>;

  // 生成改进建议
  generateImprovements: () => Promise<Improvement[]>;

  // 应用改进（需用户确认）
  applyImprovement: (improvement: Improvement) => Promise<void>;
}

// 自动触发条件
const TRIGGERS = {
  // 连续 3 次相似任务失败
  repeatedFailure: { threshold: 3, windowHours: 24 },

  // 任务耗时超过预期 2 倍
  slowExecution: { multiplier: 2 },

  // 工具调用次数异常高
  toolOveruse: { percentile: 95 },
};
```

#### 4.2 Prompt 自优化

```typescript
// src/main/evolution/promptOptimizer.ts

interface PromptOptimizer {
  // 收集 prompt 效果反馈
  recordFeedback: (prompt: string, result: 'success' | 'failure', context: any) => void;

  // 分析哪些 prompt 片段效果好/差
  analyzeEffectiveness: () => Promise<PromptAnalysis>;

  // 生成优化后的 prompt（需用户确认）
  suggestOptimization: () => Promise<OptimizedPrompt>;

  // A/B 测试不同 prompt 版本
  runExperiment: (variants: PromptVariant[]) => Promise<ExperimentResult>;
}
```

#### 4.3 能力缺口识别

```typescript
// src/main/evolution/capabilityGapDetector.ts

interface CapabilityGapDetector {
  // 监控任务失败原因
  analyzeFailures: () => Promise<FailureAnalysis>;

  // 识别缺失的工具能力
  detectMissingCapabilities: () => Promise<Capability[]>;

  // 建议创建新工具
  suggestNewTool: (capability: Capability) => Promise<ToolSuggestion>;

  // 建议集成外部服务
  suggestIntegration: (capability: Capability) => Promise<IntegrationSuggestion>;
}
```

#### 4.4 交付标准

- [ ] 连续失败后自动分析原因并建议改进
- [ ] 能识别「这类任务我总是做不好」并提供解决方案
- [ ] 能建议「如果有 X 工具，我可以更好地完成 Y」
- [ ] 用户可以选择接受/拒绝进化建议
- [ ] 进化历史可追溯

---

### Phase 5: 体验打磨 + 性能优化（持续）

#### 5.1 可视化增强

- 多 Agent 工作状态实时展示
- 进化建议的友好展示界面
- 工具使用统计和分析面板

#### 5.2 性能优化

- 工具执行结果缓存
- 并行 Agent 资源调度
- 大文件处理优化

#### 5.3 稳定性

- 错误恢复机制
- 会话持久化
- 断点续传

---

## 三、优先级排序

### P0 - 必须完成（本周）

1. **CLAUDE.md 文档更新** - 让用户知道有哪些能力
2. **Gen6 browser_action 增强** - 接入 Puppeteer

### P1 - 重要（下周）

3. **Gen7 Agent 通信机制** - 实现 AgentBus
4. **Gen8 元学习触发器** - 失败后自动分析

### P2 - 有价值（后续）

5. **Prompt 自优化实验**
6. **能力缺口检测**
7. **可视化面板**

---

## 四、技术债务清理

### 4.1 需要处理的

| 问题 | 位置 | 优先级 |
|------|------|--------|
| 工具目录结构混乱 | src/main/tools/ | P1 |
| generationMap 与实际实现不同步 | generationMap.ts | P0 |
| 部分工具缺少完整的 inputSchema | 各工具文件 | P2 |
| 错误处理不一致 | 全局 | P2 |

### 4.2 建议保留的

- 当前按功能域组织的目录结构（file/, network/ 等）
- 工具装饰器模式
- 持久化服务架构

---

## 五、成功指标

### 短期（1 个月）

- [ ] CLAUDE.md 与实现 100% 同步
- [ ] Gen6 能完成基本的浏览器自动化任务
- [ ] Gen7 能运行 3 个并行 Agent

### 中期（3 个月）

- [ ] Gen8 能主动识别 5 种以上的改进机会
- [ ] 用户反馈「进化建议有用」比例 > 60%

### 长期（6 个月）

- [ ] 形成可复用的「AI Agent 进化框架」
- [ ] 发表技术博客/论文总结经验

---

## 六、风险与对策

| 风险 | 可能性 | 影响 | 对策 |
|------|--------|------|------|
| Gen8 进化失控 | 中 | 高 | 所有进化操作需用户确认 |
| 多 Agent 死锁 | 中 | 中 | 超时机制 + 协调器监控 |
| Puppeteer 兼容性问题 | 低 | 中 | 提供 Playwright 作为备选 |
| 性能下降 | 中 | 低 | 分阶段加载工具，按需初始化 |

---

## 七、并行执行方案

### 7.1 任务依赖分析

```
                    ┌─────────────────────────────────────────────────┐
                    │              可并行的工作流                      │
                    └─────────────────────────────────────────────────┘

┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│   Track A    │    │   Track B    │    │   Track C    │    │   Track D    │
│   文档补全    │    │  Gen6 深化   │    │  Gen7 深化   │    │  Gen8 深化   │
│  (无依赖)    │    │  (无依赖)    │    │ (依赖 Gen6)  │    │ (依赖 Gen7)  │
└──────┬───────┘    └──────┬───────┘    └──────┬───────┘    └──────┬───────┘
       │                   │                   │                   │
       ▼                   ▼                   │                   │
 ┌───────────┐      ┌───────────┐             │                   │
 │ CLAUDE.md │      │ Puppeteer │             │                   │
 │ 更新      │      │ 集成      │             │                   │
 └───────────┘      └─────┬─────┘             │                   │
       │                  │                   │                   │
       │                  ▼                   ▼                   │
       │           ┌───────────┐       ┌───────────┐             │
       │           │ 屏幕理解  │       │ AgentBus  │             │
       │           │ 增强      │       │ 实现      │             │
       │           └─────┬─────┘       └─────┬─────┘             │
       │                 │                   │                   │
       │                 │                   ▼                   ▼
       │                 │            ┌───────────┐       ┌───────────┐
       │                 │            │ 动态协调器│       │ 元学习    │
       │                 │            │ 实现      │       │ 循环      │
       │                 │            └───────────┘       └───────────┘
       │                 │                   │                   │
       ▼                 ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         集成测试 & 发布                              │
└─────────────────────────────────────────────────────────────────────┘
```

### 7.2 四轨并行方案

使用 **4 个 Claude Code worktree** 同时推进：

| Track | Worktree | 负责内容 | 预估周期 | 依赖 |
|-------|----------|----------|----------|------|
| **A** | `track-docs` | 文档补全 + CLAUDE.md | 1-2 天 | 无 |
| **B** | `track-gen6` | Gen6 Browser Automation | 3-5 天 | 无 |
| **C** | `track-gen7` | Gen7 Multi-Agent | 5-7 天 | Gen6 完成 50% 后启动 |
| **D** | `track-gen8` | Gen8 Self-Evolution | 7-10 天 | Gen7 完成 50% 后启动 |

### 7.3 各 Track 详细任务

#### Track A: 文档补全 (track-docs)

```bash
# 创建 worktree
git worktree add ~/.claude-worktrees/code-agent/track-docs -b track-docs

# 任务清单
□ 更新 CLAUDE.md Gen3-8 工具文档
□ 更新 generationMap.ts 注释
□ 补充各工具的使用示例
□ 更新 PRD.md 代际描述
```

**交付物**: PR `docs: sync CLAUDE.md with Gen3-8 implementation`

---

#### Track B: Gen6 深化 (track-gen6)

```bash
git worktree add ~/.claude-worktrees/code-agent/track-gen6 -b track-gen6

# 任务清单
□ 评估 Puppeteer vs Playwright
□ 实现 browserAutomation.ts
□ 实现 screenUnderstanding.ts
□ 集成视觉模型（元素定位）
□ 添加错误恢复机制
□ 编写测试用例
```

**交付物**: PR `feat(gen6): browser automation with Puppeteer`

---

#### Track C: Gen7 深化 (track-gen7)

```bash
git worktree add ~/.claude-worktrees/code-agent/track-gen7 -b track-gen7

# 任务清单
□ 设计 AgentBus 接口
□ 实现发布-订阅机制
□ 实现共享状态存储
□ 实现动态协调器
□ 添加冲突解决逻辑
□ 实现 4 种协作模式
□ 编写多 Agent 测试
```

**交付物**: PR `feat(gen7): agent communication bus`

---

#### Track D: Gen8 深化 (track-gen8)

```bash
git worktree add ~/.claude-worktrees/code-agent/track-gen8 -b track-gen8

# 任务清单
□ 实现元学习循环
□ 实现自动触发器
□ 实现 Prompt 优化器
□ 实现能力缺口检测
□ 添加进化历史追溯
□ 用户确认 UI
```

**交付物**: PR `feat(gen8): self-driven evolution loop`

---

### 7.4 同步点与合并策略

```
Week 1                  Week 2                  Week 3
  │                       │                       │
  ▼                       ▼                       ▼
┌─────┐                ┌─────┐                ┌─────┐
│Sync1│                │Sync2│                │Sync3│
└──┬──┘                └──┬──┘                └──┬──┘
   │                      │                      │
   ├─ Track A 完成 ────────┤                      │
   │  → 合并到 main        │                      │
   │                      │                      │
   ├─ Track B 50% ─────────┼─ Track B 完成 ───────┤
   │  → Track C 启动       │  → 合并到 main        │
   │                      │                      │
   │                      ├─ Track C 50% ─────────┼─ Track C 完成
   │                      │  → Track D 启动       │  → 合并到 main
   │                      │                      │
   │                      │                      ├─ Track D 完成
   │                      │                      │  → 合并到 main
   │                      │                      │
   ▼                      ▼                      ▼
```

**同步规则**:

1. **每日 standup**: 各 Track 进度同步，识别阻塞
2. **Sync1 (Day 3)**: Track A 合并，Track B 进度检查
3. **Sync2 (Day 7)**: Track B 合并，Track C 进度检查
4. **Sync3 (Day 14)**: Track C/D 合并，集成测试

### 7.5 冲突预防

| 高风险文件 | 处理策略 |
|-----------|----------|
| `generationMap.ts` | Track A 先改，其他 Track rebase |
| `toolRegistry.ts` | 各 Track 只添加，不修改已有代码 |
| `CLAUDE.md` | Track A 独占，其他 Track 不碰 |
| `package.json` | 各 Track 只添加依赖，合并时 npm dedupe |

### 7.6 快速启动命令

```bash
# 一键创建所有 worktree
cd ~/Downloads/ai/code-agent

git worktree add ~/.claude-worktrees/code-agent/track-docs -b track-docs
git worktree add ~/.claude-worktrees/code-agent/track-gen6 -b track-gen6
git worktree add ~/.claude-worktrees/code-agent/track-gen7 -b track-gen7
git worktree add ~/.claude-worktrees/code-agent/track-gen8 -b track-gen8

# 验证
git worktree list
```

### 7.7 每个 Track 的 Claude Code 会话启动

```bash
# Terminal 1 - Track A
cd ~/.claude-worktrees/code-agent/track-docs
claude --dangerously-skip-permissions

# Terminal 2 - Track B
cd ~/.claude-worktrees/code-agent/track-gen6
claude --dangerously-skip-permissions

# Terminal 3 - Track C (Day 3 后启动)
cd ~/.claude-worktrees/code-agent/track-gen7
claude --dangerously-skip-permissions

# Terminal 4 - Track D (Day 7 后启动)
cd ~/.claude-worktrees/code-agent/track-gen8
claude --dangerously-skip-permissions
```

### 7.8 任务卡片模板

每个 Track 启动时，给 Claude 的 prompt：

**Track A (文档)**:
```
你在 track-docs 分支。任务：
1. 更新 CLAUDE.md，补充 Gen3-8 所有已实现但未文档化的工具
2. 确保每个工具有使用示例
3. 完成后创建 PR

参考：docs/plans/2026-01-24-high-quality-iteration-plan.md
```

**Track B (Gen6)**:
```
你在 track-gen6 分支。任务：
1. 用 Playwright 实现浏览器自动化
2. 增强 computer_use 工具，支持智能元素定位
3. 完成后创建 PR

参考：docs/plans/2026-01-24-high-quality-iteration-plan.md Phase 2
```

**Track C (Gen7)**:
```
你在 track-gen7 分支。任务：
1. 实现 AgentBus（发布订阅 + 共享状态）
2. 实现动态协调器
3. 完成后创建 PR

参考：docs/plans/2026-01-24-high-quality-iteration-plan.md Phase 3
```

**Track D (Gen8)**:
```
你在 track-gen8 分支。任务：
1. 实现元学习循环（自动触发 + 模式分析）
2. 实现能力缺口检测
3. 完成后创建 PR

参考：docs/plans/2026-01-24-high-quality-iteration-plan.md Phase 4
```

---

## 八、下一步行动

### 立即执行

```bash
# 1. 创建 worktree
git worktree add ~/.claude-worktrees/code-agent/track-docs -b track-docs
git worktree add ~/.claude-worktrees/code-agent/track-gen6 -b track-gen6

# 2. 启动两个 Claude Code 会话（最大权限）
# Terminal 1
cd ~/.claude-worktrees/code-agent/track-docs && claude --dangerously-skip-permissions

# Terminal 2
cd ~/.claude-worktrees/code-agent/track-gen6 && claude --dangerously-skip-permissions
```

### Day 3 启动

```bash
git worktree add ~/.claude-worktrees/code-agent/track-gen7 -b track-gen7
cd ~/.claude-worktrees/code-agent/track-gen7 && claude --dangerously-skip-permissions
```

### Day 7 启动

```bash
git worktree add ~/.claude-worktrees/code-agent/track-gen8 -b track-gen8
cd ~/.claude-worktrees/code-agent/track-gen8 && claude --dangerously-skip-permissions
```

---

*计划制定者: Claude (assisted by user)*
*最后更新: 2026-01-24*
