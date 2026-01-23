# ADR-002: 迁移到 Agent Skills 开放标准

## 状态
**草案** | 2026-01-22

## 背景

当前 Code Agent 的 Skill 系统采用自定义的 JSON 配置格式 (`SkillDefinition`)，通过云端拉取配置，使用 Subagent 隔离执行。这种设计存在以下问题：

1. **生态不兼容**: 无法使用为 Claude Code、Cursor、Windsurf 等工具编写的 Skills
2. **执行模式受限**: Subagent 隔离执行无法修改主对话上下文，限制了 Skill 的能力
3. **用户无法扩展**: 用户无法在本地添加自己的 Skills

Anthropic 主导的 [Agent Skills](https://agentskills.io/) 开放标准已被多个头部产品采用（Claude Code、Cursor、OpenAI Codex、VS Code、Gemini CLI 等），提供了更灵活的 Skill 定义和执行机制。

## 决策

将 Code Agent 的 Skill 系统迁移到 Agent Skills 开放标准，具体包括：

1. 支持 `SKILL.md` 文件格式（YAML frontmatter + Markdown）
2. 实现文件系统发现机制（`~/.claude/skills/`, `.claude/skills/`）
3. 采用"主对话上下文注入"执行模式替代 Subagent 隔离执行
4. 实现 `isMeta` 双通道消息机制
5. 保留向后兼容的云端配置支持

## 架构设计

### 整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                           启动阶段                                   │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────┐  │
│  │ 用户 Skills │    │ 项目 Skills │    │ 内置 Skills (云端/本地) │  │
│  │ ~/.claude/  │    │ .claude/    │    │ builtinConfig.ts       │  │
│  │ skills/     │    │ skills/     │    │                        │  │
│  └──────┬──────┘    └──────┬──────┘    └───────────┬─────────────┘  │
│         │                  │                       │                │
│         └──────────────────┼───────────────────────┘                │
│                            ▼                                        │
│              ┌─────────────────────────────┐                        │
│              │   SkillDiscoveryService     │                        │
│              │   - 扫描目录                │                        │
│              │   - 解析 SKILL.md           │                        │
│              │   - 合并去重                │                        │
│              └─────────────┬───────────────┘                        │
│                            │                                        │
│                            ▼                                        │
│              ┌─────────────────────────────┐                        │
│              │   Map<name, ParsedSkill>    │ (内存缓存)             │
│              └─────────────────────────────┘                        │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                           运行阶段                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                      System Prompt                           │   │
│  │  ┌───────────────────────────────────────────────────────┐  │   │
│  │  │ <available_skills>                                    │  │   │
│  │  │   <skill>                                             │  │   │
│  │  │     <name>commit</name>                               │  │   │
│  │  │     <description>Create git commits...</description>  │  │   │
│  │  │   </skill>                                            │  │   │
│  │  │   ...                                                 │  │   │
│  │  │ </available_skills>                                   │  │   │
│  │  └───────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                       Tools Array                            │   │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────────────────┐  │   │
│  │  │  Read  │ │ Write  │ │  Bash  │ │       Skill          │  │   │
│  │  │        │ │        │ │        │ │   (Meta-tool)        │  │   │
│  │  │        │ │        │ │        │ │   input: {command}   │  │   │
│  │  └────────┘ └────────┘ └────────┘ └──────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                      Skill 激活阶段                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  模型调用: Skill({ command: "commit" })                             │
│                         │                                           │
│                         ▼                                           │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │              SkillMetaTool.execute()                         │   │
│  │                                                              │   │
│  │  1. 查找 skill: skillDiscoveryService.getSkill("commit")    │   │
│  │  2. 构建注入消息:                                            │   │
│  │     - Message 1: 状态消息 (isMeta: false, 用户可见)          │   │
│  │     - Message 2: Skill Prompt (isMeta: true, 用户不可见)     │   │
│  │     - Message 3: 权限配置 (isMeta: true)                     │   │
│  │  3. 构建 contextModifier:                                    │   │
│  │     - preApprovedTools: ['bash', 'read_file']                │   │
│  │     - modelOverride: (optional)                              │   │
│  │                                                              │   │
│  └──────────────────────────┬──────────────────────────────────┘   │
│                             │                                       │
│                             ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    AgentLoop                                 │   │
│  │                                                              │   │
│  │  1. 注入 newMessages 到 this.messages                        │   │
│  │  2. 应用 contextModifier:                                    │   │
│  │     - 更新 this.preApprovedTools                             │   │
│  │     - 更新 this.modelOverride                                │   │
│  │  3. 继续循环，模型看到注入的 Skill Prompt                    │   │
│  │  4. 模型按照 Skill 指令执行后续操作                          │   │
│  │                                                              │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 数据结构设计

#### ParsedSkill (新的核心类型)

```typescript
interface ParsedSkill {
  // === Agent Skills 标准字段 ===
  name: string;                    // 必填，1-64 字符，小写+连字符
  description: string;             // 必填，1-1024 字符
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;

  // === 内容 ===
  promptContent: string;           // SKILL.md 的 markdown body
  basePath: string;                // skill 目录的绝对路径

  // === 执行控制 (Claude Code 扩展) ===
  allowedTools: string[];          // 预授权工具列表
  disableModelInvocation: boolean; // 禁止模型自动调用
  userInvocable: boolean;          // 用户可通过 /name 调用
  model?: string;                  // 模型覆盖
  executionContext: 'inline' | 'fork';  // 执行模式
  agent?: string;                  // fork 模式时使用的 agent 类型

  // === 来源追踪 ===
  source: 'user' | 'project' | 'plugin' | 'builtin';
}
```

#### SkillMessage (注入消息类型)

```typescript
interface SkillMessage {
  role: 'user';
  content: string;
  isMeta?: boolean;      // true = 不渲染到 UI，但发送给模型
  autocheckpoint?: boolean;
}
```

#### SkillToolResult (Skill 工具返回类型)

```typescript
interface SkillToolResult extends ToolResult {
  newMessages?: SkillMessage[];
  contextModifier?: (ctx: ToolContext) => ToolContext;
}
```

### 消息流设计

#### 正常工具 vs Skill 工具的消息流对比

```
=== 正常工具 (如 Read) ===

User: "读取 config.json"
  │
  ▼
Assistant: [tool_use: Read({ path: "config.json" })]
  │
  ▼
Tool Result: "{ ... file content ... }"
  │
  ▼
Assistant: "config.json 的内容是..."

消息序列: [user, assistant(tool_use), user(tool_result), assistant(text)]


=== Skill 工具 ===

User: "帮我提交代码"
  │
  ▼
Assistant: [tool_use: Skill({ command: "commit" })]
  │
  ▼
Skill Tool 返回:
  - Message 1 (isMeta: false): "<command-message>Loading commit skill</command-message>"
  - Message 2 (isMeta: true):  "[完整的 commit skill prompt]"
  - contextModifier: { preApprovedTools: ['bash', 'read_file'] }
  │
  ▼
AgentLoop 注入消息，应用 contextModifier
  │
  ▼
Assistant: (看到 skill prompt) "我来帮你创建提交..."
  │
  ▼
Assistant: [tool_use: Bash({ command: "git status" })]  // 预授权，无需确认
  │
  ▼
... 继续执行 skill 指令 ...

消息序列: [user, assistant(tool_use), user(skill_status), user(skill_prompt, isMeta), assistant(text), ...]
```

### 工具权限模型

```
┌─────────────────────────────────────────────────────────────────┐
│                      工具权限检查流程                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  AgentLoop.checkToolPermission(tool, params)                    │
│                         │                                       │
│                         ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 1. 检查精确匹配                                          │   │
│  │    preApprovedTools.has(tool.name)?                      │   │
│  │    如: "read_file" in ["read_file", "bash"]              │   │
│  │    → YES: 直接允许                                       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                         │ NO                                    │
│                         ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 2. 检查通配符匹配                                        │   │
│  │    如: "Bash(git:*)" 匹配 Bash({ command: "git status" }) │   │
│  │    → YES: 直接允许                                       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                         │ NO                                    │
│                         ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 3. 常规权限检查                                          │   │
│  │    - tool.requiresPermission?                            │   │
│  │    - 弹出用户确认对话框                                   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

通配符格式说明:
- "Bash(git:*)"     → 允许所有 git 开头的 bash 命令
- "Bash(npm:*)"     → 允许所有 npm 开头的 bash 命令
- "Read"            → 允许所有 Read 调用
- "Write"           → 允许所有 Write 调用
```

## 与 Claude Code 的差异

| 特性 | Claude Code | Code Agent (本方案) |
|-----|------------|-------------------|
| `context: fork` | 创建独立 subagent | 复用现有 SubagentExecutor |
| `!`command`` 语法 | 预执行 shell 命令 | Phase 2 实现 |
| 动态 prompt 生成 | `$ARGUMENTS`, `${CLAUDE_SESSION_ID}` | 支持 |
| Plugin skills | 支持 plugin.json 配置 | Phase 3 实现 |

## 后果

### 正面

1. **生态兼容**: 用户可以直接使用 Claude Code 的 Skills
2. **用户可扩展**: 用户可以在 `~/.claude/skills/` 添加自己的 Skills
3. **更强的 Skill 能力**: 上下文注入模式允许 Skill 修改后续对话行为
4. **标准化**: 遵循行业标准，降低学习成本

### 负面

1. **重构工作量大**: 需要修改 AgentLoop、ToolExecutor、前端渲染等多个模块
2. **向后兼容成本**: 需要桥接层支持旧的云端配置格式
3. **安全风险增加**: 本地 Skill 可能包含恶意 prompt

### 风险缓解

1. **渐进迁移**: 通过特性开关控制，允许新旧系统并行运行
2. **Skill 验证**: 实现 SKILL.md 格式校验，拒绝不合规的 Skill
3. **权限审计**: 记录所有 Skill 激活和工具调用日志

## 参考资料

- [Agent Skills 官方网站](https://agentskills.io/)
- [Agent Skills 规范](https://agentskills.io/specification)
- [Claude Code Skills 文档](https://code.claude.com/docs/en/skills)
- [skills-ref 参考实现](https://github.com/agentskills/agentskills/tree/main/skills-ref)
