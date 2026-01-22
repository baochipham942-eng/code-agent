# Agent Skills 标准迁移实施计划

## 概述

本文档详细规划将 Code Agent 的 Skill 系统迁移到 Agent Skills 开放标准的实施步骤。

**预计工作量**: 4-5 个开发阶段
**相关 ADR**: [ADR-002](../decisions/002-agent-skills-standard.md)

---

## Phase 1: 数据层 - Skill 解析与发现

**目标**: 实现 SKILL.md 文件的解析和文件系统发现机制

### Task 1.1: 创建 Skill 类型定义

**文件**: `src/shared/types/agentSkill.ts` (新建)

```typescript
// Agent Skills 标准的 frontmatter 结构
export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  'allowed-tools'?: string;

  // Claude Code 扩展字段
  'disable-model-invocation'?: boolean;
  'user-invocable'?: boolean;
  model?: string;
  context?: 'fork' | 'inline';
  agent?: string;
  'argument-hint'?: string;
}

export interface ParsedSkill {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools: string[];
  promptContent: string;
  basePath: string;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  model?: string;
  executionContext: 'fork' | 'inline';
  agent?: string;
  argumentHint?: string;
  source: 'user' | 'project' | 'plugin' | 'builtin';
}

export interface SkillMessage {
  role: 'user';
  content: string;
  isMeta?: boolean;
  autocheckpoint?: boolean;
}

export interface SkillToolResult {
  success: boolean;
  error?: string;
  data?: { commandName: string };
  newMessages?: SkillMessage[];
  contextModifier?: (ctx: unknown) => unknown;
}
```

**验收标准**:
- [ ] 类型定义完整
- [ ] `npm run typecheck` 通过

---

### Task 1.2: 实现 SKILL.md 解析器

**文件**: `src/main/services/skills/skillParser.ts` (新建)

**功能**:
1. 解析 YAML frontmatter
2. 验证必填字段 (name, description)
3. 验证 name 格式 (小写字母、数字、连字符)
4. 提取 markdown body 作为 promptContent

**关键代码逻辑**:
```typescript
export async function parseSkillMd(skillDir: string): Promise<ParsedSkill> {
  // 1. 读取 SKILL.md
  // 2. 用正则提取 frontmatter: /^---\n([\s\S]*?)\n---\n([\s\S]*)$/
  // 3. yaml.parse() 解析 frontmatter
  // 4. 验证 name: /^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$/ 且不含 --
  // 5. 验证 description 非空且 <= 1024 字符
  // 6. 解析 allowed-tools: 空格分隔 → 数组
  // 7. 返回 ParsedSkill 对象
}
```

**依赖**: 需要安装 `yaml` 包 (或使用现有的 YAML 解析方案)

**验收标准**:
- [ ] 能正确解析标准 SKILL.md 文件
- [ ] 格式错误时抛出明确的错误信息
- [ ] 单元测试覆盖主要场景

---

### Task 1.3: 实现 Skill 发现服务

**文件**: `src/main/services/skills/skillDiscoveryService.ts` (新建)

**功能**:
1. 扫描用户级目录: `~/.claude/skills/`
2. 扫描项目级目录: `.claude/skills/`
3. 加载内置 Skills (从 cloudConfigService 转换)
4. 合并去重 (项目 > 用户 > 内置)

**关键代码逻辑**:
```typescript
class SkillDiscoveryService {
  private skills: Map<string, ParsedSkill> = new Map();

  async initialize(workingDirectory: string): Promise<void> {
    // 1. 扫描 ~/.claude/skills/
    // 2. 扫描 {cwd}/.claude/skills/
    // 3. 从 cloudConfigService 获取内置 skills，转换格式
    // 4. 合并到 this.skills，后加载的覆盖先加载的
  }

  private async scanDirectory(dir: string, source: string): Promise<ParsedSkill[]> {
    // 遍历目录，找到包含 SKILL.md 的子目录
    // 调用 parseSkillMd 解析
  }

  getSkill(name: string): ParsedSkill | undefined
  getAllSkills(): ParsedSkill[]
  getSkillsForContext(): ParsedSkill[]  // 排除 disableModelInvocation
  getUserInvocableSkills(): ParsedSkill[]  // 用于 /skill 命令
}
```

**验收标准**:
- [ ] 能发现 `~/.claude/skills/` 下的 Skills
- [ ] 能发现 `.claude/skills/` 下的 Skills
- [ ] 项目级 Skill 覆盖用户级同名 Skill
- [ ] 内置 Skills 正确转换并加载

---

### Task 1.4: 集成到应用启动流程

**文件**: `src/main/main.ts` (修改)

**修改点**:
```typescript
async function initializeServices() {
  // ... 现有初始化 ...

  // 新增: 初始化 Skill 发现服务
  const skillDiscovery = getSkillDiscoveryService();
  await skillDiscovery.initialize(process.cwd());
}
```

**验收标准**:
- [ ] 应用启动时自动扫描并加载 Skills
- [ ] 启动日志显示加载的 Skill 数量

---

### Task 1.5: 创建兼容性桥接层

**文件**: `src/main/services/skills/skillBridge.ts` (新建)

**功能**: 将旧的 `SkillDefinition` 转换为新的 `ParsedSkill`

```typescript
export function bridgeCloudSkill(old: SkillDefinition): ParsedSkill {
  return {
    name: old.name,
    description: old.description,
    promptContent: old.prompt,
    allowedTools: old.tools || [],
    basePath: '',
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
  };
}
```

**验收标准**:
- [ ] 现有云端 Skills 能正确转换
- [ ] 转换后的 Skill 功能等价

---

## Phase 2: 核心层 - Skill 元工具实现

**目标**: 实现符合 Agent Skills 标准的 Skill 元工具

### Task 2.1: 实现 Skill 元工具

**文件**: `src/main/tools/skill/skillMetaTool.ts` (新建)

**功能**:
1. 动态生成包含 `<available_skills>` 的工具描述
2. 执行时构建注入消息 (isMeta 双通道)
3. 返回 contextModifier 修改执行环境

**关键代码逻辑**:
```typescript
export const skillMetaTool: Tool = {
  name: 'Skill',

  // 动态生成描述
  async getDescription(): Promise<string> {
    const skills = getSkillDiscoveryService().getSkillsForContext();
    const xml = skills.map(s =>
      `<skill><name>${s.name}</name><description>${escape(s.description)}</description></skill>`
    ).join('\n');

    return `Execute a skill...

<available_skills>
${xml}
</available_skills>`;
  },

  async execute(params, context): Promise<SkillToolResult> {
    const skill = getSkillDiscoveryService().getSkill(params.command);
    if (!skill) return { success: false, error: 'Unknown skill' };

    // 构建注入消息
    const messages: SkillMessage[] = [
      { role: 'user', content: `<command-message>...</command-message>`, isMeta: false },
      { role: 'user', content: skill.promptContent, isMeta: true },
    ];

    // 构建上下文修改器
    const contextModifier = (ctx) => ({
      ...ctx,
      preApprovedTools: [...(ctx.preApprovedTools || []), ...skill.allowedTools],
      modelOverride: skill.model,
    });

    return { success: true, newMessages: messages, contextModifier };
  },
};
```

**验收标准**:
- [ ] 工具描述包含所有可用 Skills
- [ ] 执行返回正确的 newMessages
- [ ] contextModifier 正确设置预授权工具

---

### Task 2.2: 注册新工具到 ToolRegistry

**文件**: `src/main/tools/toolRegistry.ts` (修改)

**修改点**:
```typescript
// 在 Gen4 工具注册部分
// 替换: this.register(skillTool);
// 为:   this.register(skillMetaTool);

import { skillMetaTool } from './skill/skillMetaTool';

// Gen4 工具
this.register(skillMetaTool);  // 替换原来的 skillTool
```

**验收标准**:
- [ ] Gen4+ 使用新的 Skill 元工具
- [ ] 旧的 skillTool 不再被使用

---

### Task 2.3: 移除旧的 skill 工具

**文件**: `src/main/tools/network/skill.ts` (删除或弃用)

**操作**:
1. 删除文件，或
2. 重命名为 `skill.ts.deprecated` 保留参考

**验收标准**:
- [ ] 旧代码不再被引用
- [ ] `npm run typecheck` 通过

---

## Phase 3: AgentLoop 改造

**目标**: 支持 Skill 工具的消息注入和上下文修改

### Task 3.1: 扩展消息类型

**文件**: `src/shared/types/message.ts` (修改)

**新增字段**:
```typescript
export interface Message {
  // ... 现有字段 ...

  isMeta?: boolean;      // true = 不渲染到 UI，但发送到 API
  source?: 'user' | 'skill' | 'system';
}
```

**验收标准**:
- [ ] 类型定义更新
- [ ] 相关代码无类型错误

---

### Task 3.2: AgentLoop 处理 Skill 返回

**文件**: `src/main/agent/agentLoop.ts` (修改)

**新增功能**:

1. **预授权工具集合**:
```typescript
class AgentLoop {
  private preApprovedTools: Set<string> = new Set();
  private modelOverride?: string;
}
```

2. **处理 Skill 工具返回**:
```typescript
private async handleToolResult(tool: Tool, result: ToolResult, context: ToolContext) {
  if (tool.name === 'Skill' && 'newMessages' in result) {
    const skillResult = result as SkillToolResult;

    // 注入消息
    for (const msg of skillResult.newMessages || []) {
      this.messages.push({
        id: generateId(),
        role: msg.role,
        content: msg.content,
        isMeta: msg.isMeta,
        source: 'skill',
        timestamp: Date.now(),
      });

      // 非 meta 消息发送到前端
      if (!msg.isMeta) {
        this.emit('message', { role: msg.role, content: msg.content });
      }
    }

    // 应用上下文修改
    if (skillResult.contextModifier) {
      const modified = skillResult.contextModifier(context);
      if (modified.preApprovedTools) {
        modified.preApprovedTools.forEach(t => this.preApprovedTools.add(t));
      }
      if (modified.modelOverride) {
        this.modelOverride = modified.modelOverride;
      }
    }

    return;
  }

  // ... 普通工具处理 ...
}
```

3. **工具权限检查**:
```typescript
private async checkToolPermission(tool: Tool, params: unknown): Promise<boolean> {
  // 1. 精确匹配
  if (this.preApprovedTools.has(tool.name)) {
    return true;
  }

  // 2. 通配符匹配 (如 Bash(git:*))
  for (const pattern of this.preApprovedTools) {
    if (this.matchToolPattern(pattern, tool.name, params)) {
      return true;
    }
  }

  // 3. 常规权限请求
  return this.requestPermission(tool, params);
}

private matchToolPattern(pattern: string, toolName: string, params: unknown): boolean {
  const match = pattern.match(/^(\w+)\(([^:]+):\*\)$/);
  if (!match) return pattern === toolName;

  const [, patternTool, prefix] = match;
  if (patternTool.toLowerCase() !== toolName.toLowerCase()) return false;

  if (toolName.toLowerCase() === 'bash') {
    const command = (params as { command?: string })?.command || '';
    return command.startsWith(prefix);
  }

  return false;
}
```

4. **消息构建时包含所有消息**:
```typescript
private buildModelMessages(): ModelMessage[] {
  // 所有消息都发送给模型，包括 isMeta: true
  return this.messages.map(msg => ({
    role: msg.role,
    content: msg.content,
  }));
}
```

**验收标准**:
- [ ] Skill 激活后，后续工具调用能匹配预授权
- [ ] isMeta 消息被发送到模型
- [ ] 模型覆盖正确生效

---

### Task 3.3: 支持 context: fork 执行模式

**文件**: `src/main/agent/agentLoop.ts` (修改)

**新增功能**:
当 `skill.executionContext === 'fork'` 时，使用现有的 SubagentExecutor:

```typescript
if (skill.executionContext === 'fork') {
  // 复用现有的 subagent 执行逻辑
  const executor = getSubagentExecutor();
  const result = await executor.execute({
    name: skill.name,
    systemPrompt: skill.promptContent,
    availableTools: skill.allowedTools,
    maxIterations: 15,
  }, context);

  return {
    success: result.success,
    data: { output: result.output },
  };
}
```

**验收标准**:
- [ ] `context: fork` 的 Skill 在 subagent 中执行
- [ ] `context: inline` 的 Skill 在主对话中执行

---

## Phase 4: 前端适配

**目标**: 正确渲染 Skill 相关消息

### Task 4.1: 过滤 isMeta 消息

**文件**: `src/renderer/components/features/chat/MessageList.tsx` (修改)

```typescript
function MessageList({ messages }) {
  const visibleMessages = messages.filter(msg => !msg.isMeta);

  return (
    <div className="message-list">
      {visibleMessages.map(msg => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
    </div>
  );
}
```

**验收标准**:
- [ ] isMeta 消息不显示在聊天界面
- [ ] 普通消息正常显示

---

### Task 4.2: Skill 状态消息特殊渲染

**文件**: `src/renderer/components/features/chat/SkillStatusMessage.tsx` (新建)

```typescript
function SkillStatusMessage({ content }: { content: string }) {
  const messageMatch = content.match(/<command-message>(.+?)<\/command-message>/);
  const nameMatch = content.match(/<command-name>(.+?)<\/command-name>/);

  if (!messageMatch) return null;

  return (
    <div className="skill-status flex items-center gap-2 p-2 bg-gray-100 rounded">
      <Spinner size="sm" />
      <span>{messageMatch[1]}</span>
      {nameMatch && <span className="text-gray-500">/{nameMatch[1]}</span>}
    </div>
  );
}
```

**文件**: `src/renderer/components/features/chat/MessageBubble.tsx` (修改)

```typescript
function MessageBubble({ message }) {
  // 检测是否是 Skill 状态消息
  if (message.source === 'skill' && message.content.includes('<command-message>')) {
    return <SkillStatusMessage content={message.content} />;
  }

  // ... 普通消息渲染 ...
}
```

**验收标准**:
- [ ] Skill 加载状态显示为特殊样式
- [ ] 普通消息渲染不受影响

---

### Task 4.3: /skill 命令支持

**文件**: `src/renderer/hooks/useCommandPalette.ts` (修改，如果有)

**功能**: 用户可以通过 `/skill-name` 手动调用 Skill

**验收标准**:
- [ ] 用户输入 `/commit` 能触发 commit Skill
- [ ] 自动补全显示可用的 user-invocable Skills

---

## Phase 5: 测试与文档

### Task 5.1: 单元测试

**文件**: `src/main/services/skills/__tests__/` (新建目录)

测试用例:
- [ ] `skillParser.test.ts`: 解析各种格式的 SKILL.md
- [ ] `skillDiscoveryService.test.ts`: 发现和合并 Skills
- [ ] `skillBridge.test.ts`: 格式转换

---

### Task 5.2: 集成测试

**场景**:
- [ ] 加载本地 Skill 并执行
- [ ] Skill 的 allowed-tools 权限生效
- [ ] 云端 Skill 兼容性

---

### Task 5.3: 更新文档

**文件**: `docs/ARCHITECTURE.md`, `CLAUDE.md`

更新内容:
- [ ] Skill 系统架构说明
- [ ] 如何创建自定义 Skill
- [ ] Skill 目录结构规范

---

## 文件变更清单

| 阶段 | 文件 | 操作 | 优先级 |
|-----|------|------|-------|
| **Phase 1** | `src/shared/types/agentSkill.ts` | 新建 | P0 |
| | `src/main/services/skills/skillParser.ts` | 新建 | P0 |
| | `src/main/services/skills/skillDiscoveryService.ts` | 新建 | P0 |
| | `src/main/services/skills/skillBridge.ts` | 新建 | P0 |
| | `src/main/services/skills/index.ts` | 新建 | P0 |
| | `src/main/main.ts` | 修改 | P0 |
| **Phase 2** | `src/main/tools/skill/skillMetaTool.ts` | 新建 | P0 |
| | `src/main/tools/toolRegistry.ts` | 修改 | P0 |
| | `src/main/tools/network/skill.ts` | 删除 | P1 |
| **Phase 3** | `src/shared/types/message.ts` | 修改 | P0 |
| | `src/main/agent/agentLoop.ts` | 修改 | P0 |
| **Phase 4** | `src/renderer/components/features/chat/MessageList.tsx` | 修改 | P1 |
| | `src/renderer/components/features/chat/SkillStatusMessage.tsx` | 新建 | P1 |
| | `src/renderer/components/features/chat/MessageBubble.tsx` | 修改 | P1 |
| **Phase 5** | `src/main/services/skills/__tests__/` | 新建 | P2 |
| | `docs/` | 修改 | P2 |

---

## 迁移开关

为了安全迁移，建议添加特性开关:

**文件**: `src/shared/config.ts`

```typescript
export const FEATURE_FLAGS = {
  useAgentSkillsStandard: true,  // 控制是否使用新系统
};
```

在 AgentLoop 中:
```typescript
if (FEATURE_FLAGS.useAgentSkillsStandard) {
  // 新的上下文注入逻辑
} else {
  // 旧的 subagent 执行逻辑
}
```

---

## 验收里程碑

### Milestone 1: 基础可用 (Phase 1-2)
- [ ] 能解析 `~/.claude/skills/` 下的 SKILL.md
- [ ] Skill 元工具能正确返回消息
- [ ] 云端 Skill 兼容

### Milestone 2: 完整功能 (Phase 3)
- [ ] Skill prompt 注入主对话
- [ ] allowed-tools 权限生效
- [ ] context: fork 支持

### Milestone 3: 用户体验 (Phase 4)
- [ ] 前端正确渲染 Skill 状态
- [ ] /skill 命令支持

### Milestone 4: 生产就绪 (Phase 5)
- [ ] 测试覆盖
- [ ] 文档完善
- [ ] 移除旧代码

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|-----|------|---------|
| 消息历史膨胀 | 长对话 token 超限 | 监控消息数量，必要时裁剪 |
| 恶意 Skill | 安全风险 | 提示用户仅使用可信来源的 Skill |
| 权限绕过 | 未授权工具执行 | 严格的通配符匹配逻辑 |
| 向后兼容问题 | 旧功能失效 | 保留桥接层，渐进迁移 |

---

## 附录: 测试用的示例 Skill

**文件**: `~/.claude/skills/hello-world/SKILL.md`

```markdown
---
name: hello-world
description: A simple test skill that greets the user. Use when user says "hello" or wants a greeting.
allowed-tools: bash
---

# Hello World Skill

When activated, greet the user warmly and demonstrate that the skill system is working.

## Instructions

1. Use bash to echo a greeting:
   ```bash
   echo "Hello from the skill system! 🎉"
   ```

2. Tell the user that the Agent Skills standard is now working.
```

测试命令:
```
用户: 执行 hello-world skill
期望: 模型调用 Skill({ command: "hello-world" })，然后执行 bash echo 命令
```
