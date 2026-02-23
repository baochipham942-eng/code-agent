# RFC-003: 扩展体系重构需求文档

> 版本: 1.0
> 日期: 2026-02-12
> 状态: Draft
> 基于: [Claude Code Guide (中文)](https://github.com/KimYx0207/Claude-Code-Guide-Zh) 对标分析

---

## 一、背景与动机

### 1.1 对标分析

基于 Claude Code Guide（10 篇教程，104,000 字）的完整分析，对照 code-agent v0.16.37 的实际实现，发现以下架构差距：

| 模块 | Claude Code 成熟度 | Code Agent 成熟度 | 差距等级 |
|------|-------------------|-------------------|----------|
| Skills 系统 | ★★★★★ | ★★☆☆☆ | **严重** |
| Commands 系统 | ★★★★☆ | ★☆☆☆☆ | **严重** |
| Agent Loop 解耦 | ★★★★★ | ★★☆☆☆ | **严重** |
| Plugin 完整性 | ★★★☆☆ | ★★★☆☆ | 中等 |
| Hooks 精简 | ★★★★★ | ★★★★☆ | 轻微 |
| 配置管理 | ★★★★★ | ★★★☆☆ | 中等 |
| 上下文管理门面 | ★★★★☆ | ★★★☆☆ | 中等 |
| Agent SDK | ★★★★☆ | ★☆☆☆☆ | **严重** |
| 安全模型 | ★★★☆☆ | ★★★★★ | **领先** |
| 数据锚定 | ☆☆☆☆☆ | ★★★★★ | **领先** |
| P-system 输出验证 | ☆☆☆☆☆ | ★★★★★ | **领先** |
| 多 Agent 架构 | ★★★☆☆ | ★★★★☆ | **领先** |

### 1.2 核心原则

1. **不重写，只解耦** — P-system、数据锚定等竞争优势保持逻辑不变，仅重组代码结构
2. **声明式优先** — Skills、Commands、安全规则等扩展点全部支持声明式配置
3. **渐进式交付** — 每个改进项独立可发布，不阻塞主线开发
4. **向后兼容** — 所有改动保持对现有 `.claude/` 和 `.code-agent/` 配置的兼容

---

## 二、改进项清单

### 总览

| ID | 改进项 | 优先级 | 工作量 | 依赖 |
|----|--------|--------|--------|------|
| E1 | AgentLoop 解耦 | **P0** | 2-3 天 | 无 |
| E2 | Skills 声明式架构 | **P0** | 3-5 天 | 无 |
| E3 | Commands 声明式系统 | **P1** | 2-3 天 | 无 |
| E4 | Hooks 精简 | **P1** | 0.5 天 | 无 |
| E5 | ContextManager 门面 | **P2** | 1-2 天 | E1 |
| E6 | Plugin Capability 扩展 | **P2** | 1 天 | E2, E3 |
| E7 | 配置目录迁移工具 | **P2** | 1 天 | 无 |
| E8 | Agent SDK | **P3** | 3-5 天 | E1 |
| E9 | 安全规则配置化 | **P3** | 1-2 天 | 无 |

---

## 三、E1: AgentLoop 解耦

### 3.1 现状

- **文件**: `src/main/agent/agentLoop.ts`
- **规模**: 3,904 行，~45 个私有状态字段
- **问题**: 10+ 个独立关注点全部内联在同一个类中

**状态字段归类**:

| 关注点 | 字段数 | 示例 |
|--------|--------|------|
| P-system (P1-P7) | 14 | readOnlyNudgeCount, expectedOutputFiles, _outputDirSnapshot, _userExpectsOutput |
| 截断恢复 | 4 | _truncationRetried, _consecutiveTruncations |
| 工具调用格式修复 | 2 | toolCallRetryCount |
| 结构化输出 | 3 | structuredOutput, structuredOutputRetryCount |
| Telemetry/Langfuse | 5 | traceId, currentTurnId |
| 计划/模式 | 5 | planModeActive, stepByStepMode, currentAgentMode |
| 思考 | 2 | effortLevel, thinkingStepCount |
| Token 优化 | 3 | hookMessageBuffer, autoCompressor |

**`run()` 方法结构**:
- L473-L668: 196 行"准备工作"（复杂度分析、模式检测、钩子初始化、会话恢复等）
- L669-L1200: 530 行主循环，其中 stop-guard 链 (L890-L1126) 占 236 行
- Stop-guard 瀑布: Stop hook → Planning Stop → P1 只读 → P2 Todo → P3 文件 → F4 目标 → P5 输出 → P7 结构

### 3.2 目标

将 agentLoop.ts 从 3,904 行精简到 ~1,500 行，将独立关注点抽取为可独立测试的模块。

### 3.3 设计

#### 3.3.1 新模块结构

```
src/main/agent/
├── agentLoop.ts              # 精简到 ~1500 行，只保留核心循环
├── stopGuard/
│   ├── StopGuardChain.ts     # Stop-guard 统一入口（~250 行）
│   ├── ReadOnlyGuard.ts      # P1: 只读模式检测
│   ├── TodoGuard.ts          # P2: Todo/Task 未完成检测
│   ├── FileGuard.ts          # P3: 目标文件未修改检测
│   ├── GoalGuard.ts          # F4: 目标完成度验证
│   └── index.ts
├── outputVerifier/
│   ├── OutputVerifier.ts     # 统一入口（~300 行）
│   ├── PathExtractor.ts      # P5: 显式路径提取
│   ├── WorkspaceDiff.ts      # P5-WsDiff: 目录快照对比
│   ├── ScriptDetector.ts     # P5: 未执行脚本检测
│   ├── XlsxValidator.ts      # P7: xlsx 结构验证（pandas）
│   └── index.ts
├── recovery/
│   ├── TruncationRecovery.ts # 截断自动恢复（~100 行）
│   ├── ContextOverflow.ts    # 上下文溢出恢复
│   └── NetworkRetry.ts       # 网络错误重试
├── runPreamble.ts            # run() 准备逻辑抽取（~200 行）
├── toolExecution/            # 已有：parallelStrategy, circuitBreaker, dagScheduler
├── antiPattern/              # 已有：detector, cleanXml
├── messageHandling/          # 已有：converter, contextBuilder
└── loopTypes.ts              # 已有：类型定义
```

#### 3.3.2 StopGuardChain 设计

```typescript
// src/main/agent/stopGuard/StopGuardChain.ts

export interface StopGuardContext {
  response: ModelResponse;
  toolsUsedInTurn: string[];
  isSimpleTaskMode: boolean;
  iterations: number;
  workingDirectory: string;
  sessionId: string;
  messages: Message[];
}

export interface StopGuardResult {
  shouldContinue: boolean;
  nudgeMessage?: string;
  notification?: string;
  guardName?: string;  // 哪个 guard 触发的，用于日志
}

export class StopGuardChain {
  private guards: StopGuard[] = [];

  constructor(config: StopGuardConfig) {
    // 按优先级注册 guards
    this.guards = [
      new ReadOnlyGuard(config),     // P1
      new TodoGuard(config),          // P2
      new FileGuard(config),          // P3
      new GoalGuard(config),          // F4
      new OutputFileGuard(config),    // P5 (显式路径)
      new WorkspaceDiffGuard(config), // P5-WsDiff
      new ScriptGuard(config),        // P5 (未执行脚本)
      new XlsxValidationGuard(config),// P7
    ];
  }

  async evaluate(ctx: StopGuardContext): Promise<StopGuardResult> {
    for (const guard of this.guards) {
      if (!guard.isApplicable(ctx)) continue;
      const result = await guard.check(ctx);
      if (result.shouldContinue) {
        logger.debug(`[StopGuard] ${guard.name} triggered`);
        return result;
      }
    }
    return { shouldContinue: false };
  }

  /** 重置所有 guard 的计数器（每次 run() 开始时调用） */
  reset(): void {
    this.guards.forEach(g => g.reset());
  }
}

/** 单个 Guard 的接口 */
export interface StopGuard {
  readonly name: string;
  isApplicable(ctx: StopGuardContext): boolean;
  check(ctx: StopGuardContext): Promise<StopGuardResult>;
  reset(): void;
}
```

#### 3.3.3 agentLoop 主循环简化

**改动前** (L832-L1126, 294 行):
```typescript
// 2b. Handle actual text response
if (response.type === 'text' && response.content) {
  // Stop hook (14 行)
  // Planning stop hook (26 行)
  // P1 读取模式检测 (16 行)
  // P2 Todo 检测 (40 行)
  // P3 文件检测 (36 行)
  // F4 目标验证 (26 行)
  // P5 Check 1 显式路径 (22 行)
  // P5 Check 2 Workspace diff (18 行)
  // P5 Check 3 未执行脚本 (20 行)
  // P7 xlsx 验证 (30 行)
  // 截断恢复 (40 行)
  // 连续截断断路器 (18 行)
  // ...正常消息处理
}
```

**改动后** (~30 行):
```typescript
if (response.type === 'text' && response.content) {
  // User-configurable Stop hook
  const hookResult = await this.triggerStopHooks(response, isSimpleTask);
  if (hookResult.shouldContinue) { continue; }

  // P-system stop guard chain
  const guardResult = await this.stopGuardChain.evaluate({
    response, toolsUsedInTurn: this.toolsUsedInTurn,
    isSimpleTaskMode: this.isSimpleTaskMode,
    iterations, workingDirectory: this.workingDirectory,
    sessionId: this.sessionId, messages: this.messages,
  });
  if (guardResult.shouldContinue) {
    this.injectSystemMessage(guardResult.nudgeMessage!);
    if (guardResult.notification) {
      this.onEvent({ type: 'notification', data: { message: guardResult.notification } });
    }
    continue;
  }

  // 截断恢复
  const truncResult = this.truncationRecovery.handle(response, this.modelConfig);
  if (truncResult.shouldRetry) {
    response = await this.inference();
    if (response.type === 'tool_use') continue;
  }

  // ...正常消息处理
}
```

### 3.4 验收标准

- [ ] agentLoop.ts 行数 ≤ 1,800 行
- [ ] 所有 guard 可独立单元测试
- [ ] Excel benchmark 分数无回退（v28 188/200 ± 5 分内波动）
- [ ] `npm run typecheck` 通过
- [ ] StopGuardChain 的 guard 执行顺序可配置（future: 用户自定义 guard）

### 3.5 风险

- **低风险**: 纯重构，所有逻辑原封不动移动到新文件
- **验证方式**: Excel benchmark 5 轮平均分对比（预期 170±5）

---

## 四、E2: Skills 声明式架构

### 4.1 现状

- 内置 skills（如 `data-cleaning`）硬编码在 `builtinSkills.ts`
- `src/main/skills/marketplace/` 仅提供远程 skill 安装，不涉及本地 skill 执行
- 用户无法通过文件系统添加自定义 skill
- 无 SKILL.md 解析、无 forked context、无热重载、无沙箱

### 4.2 目标

实现 Claude Code 风格的 Skills 系统：
1. 用户在 `.code-agent/skills/` 下创建 `SKILL.md` 即可定义 skill
2. 3 层渐进式加载（元数据 → 指令 → 资源）
3. Skill 执行在独立上下文中，不污染主对话
4. 内置 skills 迁移为标准 SKILL.md 格式

### 4.3 设计

#### 4.3.1 SKILL.md 格式

```markdown
---
name: data-cleaning
description: "6 步系统性数据清洗检查清单"
version: "1.0"
trigger_keywords:
  - 数据清洗
  - 去重
  - 缺失值
  - 异常值
allowed_tools:
  - read_file
  - read_xlsx
  - bash
  - write_file
  - edit_file
model: default          # 可选: 指定模型
forked_context: true    # 可选: 是否使用独立上下文（默认 true）
---

# 数据清洗检查清单

执行以下 6 步系统性检查：

## 1. 结构检查
- 检查列名是否清晰（无 Unnamed:0）
- 检查数据类型是否正确

## 2. 重复值检查
- 使用 subset 参数指定主键列进行去重
...
```

#### 4.3.2 目录结构

```
.code-agent/skills/
├── data-cleaning/
│   ├── SKILL.md                # 元数据 + 指令
│   ├── scripts/
│   │   └── detect_outliers.py  # 可选：辅助脚本
│   └── templates/
│       └── report.md           # 可选：输出模板
├── code-review/
│   └── SKILL.md
└── ...

# 同时扫描 legacy 路径
.claude/skills/
└── ...
```

#### 4.3.3 核心接口

```typescript
// src/main/skills/types.ts

/** SKILL.md YAML frontmatter */
export interface SkillMetadata {
  name: string;
  description: string;
  version?: string;
  trigger_keywords?: string[];
  allowed_tools?: string[];
  model?: string;
  forked_context?: boolean;  // 默认 true
}

/** 完整 Skill 定义 */
export interface Skill {
  metadata: SkillMetadata;
  instructions: string;       // markdown body
  rootPath: string;           // skill 目录绝对路径
  source: 'builtin' | 'user-global' | 'user-project';
}
```

```typescript
// src/main/skills/skillLoader.ts

export class SkillLoader {
  /**
   * 扫描所有 skill 目录，返回元数据列表（轻量，始终驻留内存）
   * 扫描路径:
   *   1. 内置: src/main/skills/builtins/
   *   2. 用户全局: ~/.code-agent/skills/ + ~/.claude/skills/
   *   3. 项目级: .code-agent/skills/ + .claude/skills/
   */
  async discoverSkills(workingDirectory: string): Promise<SkillMetadata[]>;

  /** 按需加载指令层（读取 SKILL.md 的 markdown body） */
  async loadInstructions(skillName: string): Promise<string>;

  /** 按需加载资源文件 */
  async loadResource(skillName: string, relativePath: string): Promise<Buffer>;

  /** 根据用户输入匹配 skill（关键词匹配） */
  matchSkill(userMessage: string): SkillMetadata | null;
}
```

```typescript
// src/main/skills/skillExecutor.ts

export class SkillExecutor {
  /**
   * 在 forked context 中执行 skill
   *
   * 1. 创建独立消息历史
   * 2. 注入 skill instructions 为 system prompt
   * 3. 限制可用工具集（allowed_tools）
   * 4. 运行 agentLoop（受限模式）
   * 5. 返回摘要结果
   */
  async execute(
    skill: Skill,
    userPrompt: string,
    parentContext: SkillParentContext
  ): Promise<SkillExecutionResult>;
}

export interface SkillParentContext {
  workingDirectory: string;
  sessionId: string;
  modelConfig: ModelConfig;
  /** 父对话的最近 N 条消息（提供上下文，但不修改） */
  recentMessages?: Message[];
}

export interface SkillExecutionResult {
  success: boolean;
  /** 摘要文本，合并回主对话 */
  summary: string;
  /** skill 执行产生的文件变更 */
  fileChanges?: string[];
  /** 执行耗时 */
  durationMs: number;
}
```

#### 4.3.4 内置 Skill 迁移

将 `builtinSkills.ts` 中的 `data-cleaning` 迁移为标准 SKILL.md：

```
src/main/skills/builtins/
├── data-cleaning/
│   └── SKILL.md
├── code-review/
│   └── SKILL.md
└── ...
```

在 `SkillLoader.discoverSkills()` 中，builtins 目录作为第一优先级扫描。

#### 4.3.5 agentLoop 集成

```typescript
// agentLoop.ts run() 方法中
const matchedSkill = this.skillLoader.matchSkill(userMessage);
if (matchedSkill && matchedSkill.forked_context) {
  // Forked context 执行
  const result = await this.skillExecutor.execute(skill, userMessage, parentCtx);
  this.injectSystemMessage(`<skill-result name="${skill.metadata.name}">\n${result.summary}\n</skill-result>`);
} else if (matchedSkill) {
  // 非 forked: 仅注入 instructions 到当前上下文
  const instructions = await this.skillLoader.loadInstructions(matchedSkill.name);
  this.injectSystemMessage(`<skill-instructions>\n${instructions}\n</skill-instructions>`);
}
```

### 4.4 验收标准

- [ ] `SKILL.md` 格式解析器通过单元测试（frontmatter + markdown body）
- [ ] 用户在 `.code-agent/skills/test-skill/SKILL.md` 创建文件后，下次对话自动发现
- [ ] `data-cleaning` 内置 skill 迁移后功能不变
- [ ] Forked context 执行不影响主对话消息历史
- [ ] 热重载：修改 SKILL.md 后下次触发即加载新版本

### 4.5 风险

- **中风险**: Forked context 需要创建独立的 AgentLoop 实例，可能引入并发问题
- **缓解**: 初版可不实现 forked context，仅做 instructions 注入（与当前 builtinSkills 等效）

---

## 五、E3: Commands 声明式系统

### 5.1 现状

- CLI commands 是 TypeScript 文件（chat.ts, run.ts, serve.ts, export.ts）
- Electron GUI 无 slash command 概念
- 用户无法自定义命令

### 5.2 目标

用户通过在 `.code-agent/commands/` 目录下创建 markdown 文件来定义自定义命令，输入 `/命令名` 即可触发。

### 5.3 设计

#### 5.3.1 命令文件格式

```markdown
<!-- .code-agent/commands/review.md -->
---
description: "审查代码变更"
argument-hint: "<file-or-branch>"
allowed-tools:
  - read_file
  - grep
  - glob
  - bash
model: default
---

审查以下代码变更，重点关注：
1. 逻辑错误
2. 安全漏洞
3. 性能问题
4. 代码风格

$ARGUMENTS
```

#### 5.3.2 命名空间

```
.code-agent/commands/
├── review.md             → /review
├── test.md               → /test
├── deploy/
│   ├── staging.md        → /deploy:staging
│   └── production.md     → /deploy:production
└── gen/
    └── component.md      → /gen:component
```

#### 5.3.3 优先级解析

```
项目级: .code-agent/commands/ > .claude/commands/
用户级: ~/.code-agent/commands/ > ~/.claude/commands/
优先级: 项目级 > 用户级
```

#### 5.3.4 核心接口

```typescript
// src/main/commands/types.ts

export interface CommandMetadata {
  name: string;           // 从文件路径推导
  description: string;
  argumentHint?: string;
  allowedTools?: string[];
  model?: string;
  /** 纯文本替换模式（不调用模型） */
  disableModelInvocation?: boolean;
}

export interface CommandDefinition extends CommandMetadata {
  template: string;       // markdown body
  source: 'project' | 'user-global';
  filePath: string;
}
```

```typescript
// src/main/commands/commandLoader.ts

export class CommandLoader {
  /** 扫描所有命令目录 */
  async discoverCommands(workingDirectory: string): Promise<CommandMetadata[]>;

  /** 加载命令模板 */
  async loadCommand(name: string): Promise<CommandDefinition>;

  /** 展开命令模板（替换 $ARGUMENTS） */
  expandTemplate(command: CommandDefinition, args: string): string;
}
```

#### 5.3.5 集成点

**CLI 模式**:
```bash
# 用户输入
code-agent run "/review main..HEAD"
# CommandLoader 识别 /review，加载模板，替换 $ARGUMENTS 为 "main..HEAD"
```

**Electron GUI**:
```
1. 用户在输入框输入 "/"
2. 弹出命令列表（CommandPalette 集成）
3. 选择命令后展开模板
4. 模板作为 userMessage 发送给 AgentLoop
```

**IPC 集成**:
```typescript
// src/main/ipc/command.ipc.ts
registerCommandHandlers(ipcMain, {
  'command:list': () => commandLoader.discoverCommands(workDir),
  'command:execute': (name, args) => commandLoader.loadCommand(name),
});
```

### 5.4 验收标准

- [ ] 用户创建 `.code-agent/commands/hello.md`，输入 `/hello` 触发模板注入
- [ ] `$ARGUMENTS` 占位符正确替换
- [ ] 命名空间（子目录 → 冒号分隔）正确工作
- [ ] 优先级：项目级覆盖用户级
- [ ] Electron GUI 输入 `/` 时弹出命令列表

### 5.5 风险

- **低风险**: 与现有 CLI commands 无冲突（不同层级）

---

## 六、E4: Hooks 精简

### 6.1 现状

13 种事件类型：
```typescript
'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'UserPromptSubmit' |
'Stop' | 'SubagentStop' | 'SubagentStart' | 'PermissionRequest' |
'PreCompact' | 'Setup' | 'SessionStart' | 'SessionEnd' | 'Notification'
```

### 6.2 目标

精简到 11 种，降低用户认知负担。

### 6.3 设计

#### 6.3.1 合并 PostToolUseFailure → PostToolUse

**改动前**:
```typescript
export type HookEvent = ... | 'PostToolUseFailure' | ...;

// hookManager.ts
async triggerPostToolUseFailure(toolName, toolInput, errorMessage, sessionId)
```

**改动后**:
```typescript
// PostToolUse 的 context 增加错误字段
export interface ToolHookContext {
  // ...existing fields
  isError?: boolean;           // 新增
  errorMessage?: string;       // 新增（原 PostToolUseFailure 的字段）
}

// hookManager.ts — 合并为一个方法
async triggerPostToolUse(
  toolName: string,
  toolInput: string,
  toolOutput: string,
  sessionId: string,
  options?: { isError?: boolean; errorMessage?: string }  // 新增
): Promise<HookTriggerResult>
```

**向后兼容**: 如果用户已配置 `PostToolUseFailure` hook，ConfigParser 自动映射到 `PostToolUse` 并设置 `isError` 过滤条件。

#### 6.3.2 合并 Setup → SessionStart

**改动前**: `Setup` 在"初始 setup"时触发，`SessionStart` 在"每次会话开始"时触发。

**改动后**: `SessionStart` 增加 `isFirstSession: boolean` 字段。原 `Setup` 配置自动映射。

#### 6.3.3 最终事件列表 (11 种)

```typescript
export type HookEvent =
  | 'PreToolUse'          // 工具执行前（gate: allow/block）
  | 'PostToolUse'         // 工具执行后（含失败，通过 isError 区分）
  | 'UserPromptSubmit'    // 用户提交 prompt
  | 'Stop'                // Agent 即将停止
  | 'SubagentStart'       // 子代理启动
  | 'SubagentStop'        // 子代理结束
  | 'PermissionRequest'   // 权限请求
  | 'PreCompact'          // 上下文压缩前
  | 'SessionStart'        // 会话开始（含首次 setup）
  | 'SessionEnd'          // 会话结束
  | 'Notification';       // 通知
```

### 6.4 验收标准

- [ ] `PostToolUseFailure` 配置自动映射到 `PostToolUse` + `isError` 过滤
- [ ] `Setup` 配置自动映射到 `SessionStart` + `isFirstSession` 过滤
- [ ] 所有现有 hook 功能不受影响
- [ ] 文档更新

### 6.5 风险

- **极低**: 纯代码层面合并，功能完全保留

---

## 七、E5: ContextManager 门面

### 7.1 现状

agentLoop.ts 直接操作 5+ 个上下文子模块：
```typescript
this.autoCompressor       // 自动压缩
dataFingerprintStore      // 数据锚定
fileReadTracker           // 文件读取追踪
this.messageHistoryCompressor  // 消息历史压缩
this.hookMessageBuffer    // Hook 消息缓冲
```

### 7.2 目标

提供统一的 `ContextManager` 门面类，agentLoop 只需调用一个入口。

### 7.3 设计

```typescript
// src/main/context/contextManager.ts

export class ContextManager {
  constructor(
    private autoCompressor: AutoContextCompressor,
    private fingerprints: DataFingerprintStore,
    private fileTracker: FileReadTracker,
    private documentContext: DocumentContextService,
    private hookMessageBuffer: HookMessageBuffer,
  ) {}

  /** 检查是否需要压缩，并执行 */
  async checkAndCompress(
    messages: Message[],
    contextWindow: number
  ): Promise<{ compressed: boolean; savedTokens: number }>;

  /** 构建 compaction recovery 上下文（数据锚定 + 最近文件 + TODO） */
  buildRecoveryContext(sessionId: string): string;

  /** 获取当前 token 使用率 */
  getUsageRate(messages: Message[], contextWindow: number): number;

  /** 是否应该 wrap up（基于 compaction 次数 × 预算） */
  shouldWrapUp(): boolean;

  /** Flush hook message buffer */
  flushHookMessages(): string | null;
}
```

### 7.4 验收标准

- [ ] agentLoop.ts 中的上下文相关代码减少 50%+
- [ ] ContextManager 可独立单元测试
- [ ] 功能无回退

---

## 八、E6: Plugin Capability 扩展

### 8.1 现状

```typescript
export type PluginCapability = 'tools' | 'skills' | 'theme' | 'language';
```

### 8.2 目标

Plugin 可以捆绑 Commands、Hooks、MCP 配置。

### 8.3 设计

```typescript
// 扩展 PluginCapability
export type PluginCapability =
  | 'tools' | 'skills' | 'theme' | 'language'
  | 'commands' | 'hooks' | 'mcp';  // 新增

// 扩展 PluginManifest
export interface PluginManifest extends PluginMetadata {
  main: string;
  capabilities?: PluginCapability[];
  // 新增：声明式扩展资源
  commandsDir?: string;                      // 相对路径 → commands/
  hooksConfig?: string;                      // 相对路径 → hooks.json
  mcpServers?: Record<string, MCPServerConfig>;  // 内嵌 MCP 配置
  skillsDir?: string;                        // 相对路径 → skills/
}
```

**PluginLoader 扩展**:
```typescript
async activatePlugin(plugin: LoadedPlugin): Promise<void> {
  // 现有逻辑: activate entry, register tools
  // 新增:
  if (plugin.manifest.commandsDir) {
    await this.commandLoader.registerFromDir(pluginRoot + commandsDir);
  }
  if (plugin.manifest.hooksConfig) {
    await this.hookManager.mergeFromFile(pluginRoot + hooksConfig);
  }
  if (plugin.manifest.mcpServers) {
    for (const [name, config] of Object.entries(plugin.manifest.mcpServers)) {
      await this.mcpClient.addServer(name, config);
    }
  }
}
```

### 8.4 验收标准

- [ ] Plugin manifest 支持 commandsDir / hooksConfig / mcpServers 字段
- [ ] 安装 plugin 后，命令/hooks/MCP 自动注册
- [ ] 卸载 plugin 后，自动清理

### 8.5 依赖

- E2 (Skills) 和 E3 (Commands) 完成后才能实现 Plugin 捆绑

---

## 九、E7: 配置目录迁移工具

### 9.1 目标

提供 CLI 命令，帮助用户将 `.claude/` 配置迁移到 `.code-agent/`。

### 9.2 设计

```bash
# 用法
code-agent migrate-config [--dry-run] [--direction=claude-to-codeagent|codeagent-to-claude]

# 默认: .claude/ → .code-agent/
# --dry-run: 仅显示将执行的操作，不实际移动
```

**迁移映射**:

| 源 | 目标 |
|----|------|
| `.claude/settings.json` (hooks 部分) | `.code-agent/hooks/hooks.json` |
| `.claude/settings.json` (其他部分) | `.code-agent/settings.json` |
| `.claude/settings.local.json` | `.code-agent/settings.local.json` |
| `.claude/skills/` | `.code-agent/skills/` |
| `.claude/commands/` | `.code-agent/commands/` |

### 9.3 验收标准

- [ ] `--dry-run` 模式正确显示迁移计划
- [ ] 迁移后原文件保留（不删除，仅复制）
- [ ] 双目录共存时 `resolvePathsWithWarning` 正确提示

---

## 十、E8: Agent SDK

### 10.1 现状

- `AgentOrchestrator` 硬依赖 `import { app } from 'electron'`（L26）
- CLI 模式通过 `bootstrap.ts` 绕过，但无干净的 SDK 接口
- 外部应用无法 `import { createAgent } from 'code-agent'`

### 10.2 目标

暴露纯 Node.js 可用的 Agent SDK，外部应用可编程式使用 code-agent 核心引擎。

### 10.3 设计

#### 10.3.1 解耦 Electron 依赖

```typescript
// 改动前 (agentOrchestrator.ts L26)
import { app } from 'electron';

// 改动后
export interface AppPathProvider {
  getUserDataPath(): string;
  getAppVersion(): string;
}

// Electron 实现
class ElectronAppPathProvider implements AppPathProvider {
  getUserDataPath() { return app.getPath('userData'); }
  getAppVersion() { return app.getVersion(); }
}

// Node.js/CLI 实现
class NodeAppPathProvider implements AppPathProvider {
  getUserDataPath() { return path.join(os.homedir(), '.code-agent'); }
  getAppVersion() { return require('../package.json').version; }
}
```

#### 10.3.2 SDK 入口

```typescript
// src/sdk/index.ts

export interface CodeAgentOptions {
  model?: string;
  provider?: string;
  apiKey?: string;
  workingDirectory?: string;
  generation?: string;
  tools?: string[];         // 允许的工具列表
  maxIterations?: number;
  onEvent?: (event: AgentEvent) => void;
}

export async function createCodeAgent(options: CodeAgentOptions): Promise<CodeAgent> {
  // 初始化: ModelRouter, ToolRegistry, ToolExecutor
  // 不依赖 Electron
  return new CodeAgent(/* ... */);
}

export class CodeAgent {
  async run(prompt: string): Promise<AgentRunResult>;
  async chat(messages: Message[]): Promise<AgentRunResult>;
  cancel(): void;
  getMessages(): Message[];
}

export interface AgentRunResult {
  success: boolean;
  messages: Message[];
  totalTokens: { input: number; output: number };
  toolCallCount: number;
  durationMs: number;
}
```

#### 10.3.3 使用示例

```typescript
import { createCodeAgent } from '@code-agent/sdk';

const agent = await createCodeAgent({
  provider: 'moonshot',
  model: 'kimi-k2.5',
  apiKey: process.env.KIMI_K25_API_KEY,
  workingDirectory: '/path/to/project',
  onEvent: (event) => console.log(event.type),
});

const result = await agent.run('读取 data.xlsx 并生成分析报告');
console.log(result.messages);
```

### 10.4 验收标准

- [ ] `createCodeAgent()` 在纯 Node.js 环境中可用（不依赖 Electron）
- [ ] CLI 模式使用 SDK 接口重构
- [ ] SDK 导出的类型定义完整
- [ ] 提供使用示例

### 10.5 依赖

- E1 (AgentLoop 解耦) 完成后更容易实现

### 10.6 风险

- **中风险**: AgentOrchestrator 对 Electron 的依赖散布在多处，需要逐一排查
- **缓解**: 先发布 alpha 版，仅暴露核心推理 + 工具执行，不含 UI 相关功能

---

## 十一、E9: 安全规则配置化

### 11.1 现状

`PolicyEngine` 的内置规则硬编码在 TypeScript 中：
```typescript
const BUILT_IN_RULES: PolicyRule[] = [
  { id: 'block-root-write', matcher: { pathPattern: /^\/(?:usr|bin|...)/ }, ... },
  { id: 'block-ssh-keys', matcher: { pathPattern: /\.ssh\/id_[^/]+$/ }, ... },
  // ...
];
```

`InputSanitizer` 的 20+ 注入检测模式同样硬编码。

### 11.2 目标

允许用户通过配置文件添加自定义安全规则，同时保持内置规则不可覆盖。

### 11.3 设计

```json
// .code-agent/security/rules.json
{
  "policyRules": [
    {
      "id": "block-production-db",
      "name": "Block production database access",
      "priority": 900,
      "matcher": {
        "level": "execute",
        "commandPattern": "mysql.*production|psql.*production"
      },
      "action": "deny",
      "reason": "Production database access is blocked"
    }
  ],
  "sanitizerPatterns": [
    {
      "category": "data_exfiltration",
      "pattern": "curl.*internal\\.company\\.com",
      "severity": "high"
    }
  ]
}
```

**加载优先级**: 内置规则（不可覆盖）→ 全局用户规则 → 项目级规则

### 11.4 验收标准

- [ ] 用户自定义规则正确加载和执行
- [ ] 内置规则（如 block-root-write）不可被用户配置覆盖
- [ ] 规则配置文件格式校验

---

## 十二、实施路线图

```
Week 1: E1 (AgentLoop 解耦) + E4 (Hooks 精简)
  ├── Day 1-2: StopGuardChain + OutputVerifier 抽取
  ├── Day 3: TruncationRecovery + RunPreamble 抽取
  ├── Day 4: Hooks 合并 (PostToolUseFailure, Setup)
  └── Day 5: Excel benchmark 回归测试

Week 2: E2 (Skills) + E3 (Commands)
  ├── Day 1-2: SKILL.md 解析器 + SkillLoader
  ├── Day 3: SkillExecutor (先不做 forked context，仅 instructions 注入)
  ├── Day 4: CommandLoader + 命令发现
  └── Day 5: Electron GUI 集成（/ 前缀触发）

Week 3: E5 (ContextManager) + E6 (Plugin) + E7 (Config)
  ├── Day 1-2: ContextManager 门面抽取
  ├── Day 3: Plugin capability 扩展
  ├── Day 4: 配置迁移 CLI 工具
  └── Day 5: 集成测试

Week 4+: E8 (SDK) + E9 (安全) + Forked Context
  ├── Day 1-3: Electron 依赖解耦 + SDK 入口
  ├── Day 4: 安全规则配置化
  └── Day 5+: Skills forked context 实现
```

---

## 十三、不变量（不在本 RFC 范围内修改的部分）

以下模块经对标分析确认为竞争优势，**不做重新设计**：

| 模块 | 原因 |
|------|------|
| P-system 输出验证 (P1-P7) | Excel benchmark 94%，逻辑只需移位不需重写 |
| 数据锚定 (DataFingerprint + ToolFact) | Claude Code 无此能力，独创竞争力 |
| 5 层安全模型 | 远超 Claude Code 参考设计 |
| 错误恢复引擎 (6 种模式) | 比参考更完善 |
| 多 Agent 3 层混合架构 | 比参考更丰富 (P2P + Delegate + Swarm) |
| MCP 4 种传输 | 功能完备，实现规模适中 (1,406 行) |
| 动态 maxTokens 截断恢复 | 实测有效 |
| h2A 实时转向机制 | Claude Code 风格，实现良好 |

---

## 十四、度量与验证

### 14.1 代码质量指标

| 指标 | 当前 | 目标 |
|------|------|------|
| agentLoop.ts 行数 | 3,904 | ≤ 1,800 |
| agentLoop.ts 私有字段数 | ~45 | ≤ 20 |
| 新增可独立测试模块 | 0 | ≥ 5 (StopGuard, OutputVerifier, SkillLoader, CommandLoader, ContextManager) |
| 用户可扩展点 | 1 (Hooks) | 4 (Hooks + Skills + Commands + Security Rules) |

### 14.2 功能回归

| 测试 | 方法 | 通过标准 |
|------|------|----------|
| Excel benchmark | 5 轮评测 | 平均分 ≥ 168/200 (当前 171.6) |
| 类型检查 | `npm run typecheck` | 0 errors |
| 现有单元测试 | `npm test` | 全部通过 |
| Hook 兼容性 | 加载旧版 `PostToolUseFailure` 配置 | 自动映射成功 |

---

*本文档基于 [Claude Code Guide (中文)](https://github.com/KimYx0207/Claude-Code-Guide-Zh) 的 10 篇教程对标分析生成。*
