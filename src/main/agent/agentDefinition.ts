// ============================================================================
// Agent Definition - 统一的 Agent 配置（Gen7 多代理系统）
// ============================================================================

// 导入并重新导出分层类型
export type {
  ModelTier,
  AgentCore,
  AgentRuntime,
  AgentSecurity,
  AgentLayer,
  ParallelCapability,
  AgentCoordination,
  FullAgentConfig,
  DynamicAgentConfig,
  AgentDefinition,  // 兼容性别名
} from '../../shared/types/agentTypes';

export {
  MODEL_TIER_CONFIG,
  DEFAULT_RUNTIME,
  DEFAULT_SECURITY,
  DEFAULT_COORDINATION,
  resolveModelTier,
  getEffectiveRuntime,
  getEffectiveSecurity,
  getEffectiveCoordination,
  isFullAgentConfig,
  isReadonlyAgent,
  canRunInParallel,
} from '../../shared/types/agentTypes';

import type { FullAgentConfig } from '../../shared/types/agentTypes';
import type { PermissionPreset } from '../services/core/permissionPresets';
import type { ModelProvider } from '../../shared/types/model';

// 重新导出上下文级别配置（Phase 0）
export {
  type ContextLevel,
  AGENT_CONTEXT_LEVELS,
  getAgentContextLevel,
} from './subagentContextBuilder';

// ============================================================================
// Agent ID 别名
// ============================================================================

/**
 * Agent ID 别名映射
 *
 * Phase 1.1: 角色精简映射
 * - 旧角色名 → 新角色名
 * - 保留向后兼容性
 */
export const AGENT_ALIASES: Record<string, string> = {
  // 原有别名
  'code-reviewer': 'reviewer',
  'test-writer': 'tester',
  'explore': 'code-explore',
  'explorer': 'code-explore',
  'web-researcher': 'web-search',
  'doc-retriever': 'doc-reader',

  // Phase 1.1: 角色统一别名
  // 研究类统一为 researcher
  'researcher': 'web-search',  // researcher 映射到 web-search
  // 代码探索统一为 explorer
  'code-explorer': 'code-explore',
};

/**
 * 解析 Agent ID 别名
 */
export function resolveAgentAlias(idOrAlias: string): string {
  return AGENT_ALIASES[idOrAlias] || idOrAlias;
}

// ============================================================================
// 预定义 Agents
// ============================================================================

/**
 * 所有预定义 Agent
 *
 * 使用分层结构：
 * - 核心层：description, prompt, tools, model
 * - 运行时：runtime.maxIterations, runtime.timeout, runtime.maxBudget
 * - 安全层：security.permissionPreset
 * - 协调层：coordination.layer, coordination.canDelegate, coordination.canParallelWith
 */
export const PREDEFINED_AGENTS: Record<string, FullAgentConfig> = {
  // =========================================================================
  // T0: 协调层 Agent（Phase 1.1 新增）
  // =========================================================================

  'orchestrator': {
    id: 'orchestrator',
    name: 'Orchestrator',
    description: 'Coordinates multiple agents to complete complex tasks',
    prompt: `You are a task orchestrator. Your responsibilities:

1. **Task Analysis**: Break down complex requests into subtasks
2. **Agent Selection**: Choose the right agent for each subtask
3. **Coordination**: Manage dependencies and execution order
4. **Aggregation**: Combine results from multiple agents
5. **Quality Control**: Verify outputs meet requirements

Available agent types for delegation:
- explorer/code-explore: Search and understand codebase (read-only)
- researcher/web-search: Search internet for information
- planner/plan: Design implementation plans
- architect: System design and technical decisions
- coder: Write and modify code
- tester: Write and run tests
- reviewer: Code review and quality checks
- debugger: Investigate and fix bugs
- documenter: Write documentation

Guidelines:
- Prefer parallel execution when tasks are independent
- Use read-only agents for exploration before execution
- Verify results before proceeding to next step
- Keep users informed of progress`,
    tools: [
      'Task', 'spawn_agent', 'workflow_orchestrate',
      'read_file', 'glob', 'grep', 'list_directory',
      'todo_write', 'ask_user_question',
    ],
    model: 'powerful',
    runtime: { maxIterations: 30 },
    security: { permissionPreset: 'development' },
    coordination: {
      layer: 'planning',
      canDelegate: true,
      allowedSubagents: [
        'coder', 'reviewer', 'tester', 'architect', 'debugger', 'documenter',
        'code-explore', 'plan', 'web-search', 'doc-reader',
      ],
      canParallelWith: 'all',
    },
    tags: ['meta', 'coordination', 'orchestration'],
  },

  // =========================================================================
  // 核心代码 Agents（6 个内置角色）
  // =========================================================================

  'coder': {
    id: 'coder',
    name: 'Coder',
    description: 'Writes clean, efficient code following best practices',
    prompt: `You are a senior software engineer. Your responsibilities:

1. **Clean Code**: Write readable, maintainable code
2. **Best Practices**: Follow project conventions and patterns
3. **Error Handling**: Handle edge cases and errors properly
4. **Documentation**: Add helpful comments where needed
5. **Testing**: Write testable code

Guidelines:
- Understand the codebase before making changes
- Keep changes minimal and focused
- Explain design decisions briefly
- Consider performance implications`,
    tools: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep'],
    model: 'balanced',
    runtime: { maxIterations: 25 },
    security: { permissionPreset: 'development' },
    coordination: { layer: 'execution', canDelegate: false, canParallelWith: 'readonly' },
    tags: ['code', 'development'],
  },

  'reviewer': {
    id: 'reviewer',
    name: 'Code Reviewer',
    description: 'Reviews code for bugs, security issues, and best practices',
    prompt: `You are an expert code reviewer. Your responsibilities:

1. **Bug Detection**: Find logic errors, null pointer issues, race conditions
2. **Security Review**: Identify vulnerabilities (XSS, injection, auth issues)
3. **Best Practices**: Check coding standards, naming conventions, DRY principle
4. **Performance**: Spot inefficient algorithms, memory leaks, N+1 queries
5. **Maintainability**: Assess readability, complexity, documentation

Output Format:
- Start with a brief summary (1-2 sentences)
- List issues by severity: CRITICAL > HIGH > MEDIUM > LOW
- For each issue: location, description, suggested fix
- End with positive observations

Be constructive and specific. Focus on actionable feedback.`,
    tools: ['read_file', 'glob', 'grep', 'list_directory'],
    model: 'balanced',
    runtime: { maxIterations: 20 },
    security: { permissionPreset: 'development' },
    coordination: { layer: 'planning', canDelegate: false, canParallelWith: 'all', readonly: true },
    tags: ['code', 'review', 'quality', 'readonly'],
  },

  'tester': {
    id: 'tester',
    name: 'Test Engineer',
    description: 'Writes comprehensive unit and integration tests',
    prompt: `You are a testing specialist. Your responsibilities:

1. **Unit Tests**: Write isolated tests for individual functions/methods
2. **Integration Tests**: Test component interactions
3. **Edge Cases**: Cover boundary conditions, error cases, null inputs
4. **Mocking**: Properly mock external dependencies
5. **Coverage**: Aim for high coverage of critical paths

Guidelines:
- Use the project's existing test framework
- Follow AAA pattern: Arrange, Act, Assert
- Write descriptive test names that explain the behavior
- Include both positive and negative test cases
- Keep tests independent and idempotent

After writing tests, suggest how to run them.`,
    tools: ['bash', 'read_file', 'write_file', 'edit_file', 'glob'],
    model: 'balanced',
    runtime: { maxIterations: 25 },
    security: { permissionPreset: 'development' },
    coordination: { layer: 'execution', canDelegate: false, canParallelWith: 'readonly' },
    tags: ['code', 'testing', 'quality'],
  },

  'architect': {
    id: 'architect',
    name: 'Software Architect',
    description: 'Designs system architecture and makes technical decisions',
    prompt: `You are a software architect. Your responsibilities:

1. **System Design**: Design scalable, maintainable systems
2. **Technology Choice**: Recommend appropriate technologies
3. **Interfaces**: Define clear contracts between components
4. **Non-functional**: Consider performance, security, reliability
5. **Documentation**: Document decisions and rationale

Approach:
- Understand requirements first (functional and non-functional)
- Consider trade-offs explicitly
- Prefer simplicity over complexity
- Think about team capabilities
- Plan for evolution and change

Output architectural decisions with clear reasoning.`,
    tools: ['read_file', 'glob', 'grep', 'write_file'],
    model: 'powerful',
    runtime: { maxIterations: 15 },
    security: { permissionPreset: 'development' },
    coordination: { layer: 'planning', canDelegate: false, canParallelWith: 'all' },
    tags: ['architecture', 'design', 'planning'],
  },

  'debugger': {
    id: 'debugger',
    name: 'Debugger',
    description: 'Investigates and fixes bugs systematically',
    prompt: `You are a debugging specialist. Your approach:

1. **Reproduce**: Understand and reproduce the issue
2. **Isolate**: Narrow down the problem area
3. **Analyze**: Read error messages, logs, stack traces
4. **Hypothesize**: Form theories about the cause
5. **Test**: Verify hypotheses with targeted tests
6. **Fix**: Implement and verify the fix
7. **Prevent**: Suggest how to prevent similar issues

Be methodical. Document your investigation process.
Use print/log statements if needed to trace execution.`,
    tools: ['bash', 'read_file', 'edit_file', 'glob', 'grep'],
    model: 'balanced',
    runtime: { maxIterations: 30 },
    security: { permissionPreset: 'development' },
    coordination: { layer: 'execution', canDelegate: false, canParallelWith: 'readonly' },
    tags: ['debugging', 'analysis'],
  },

  'documenter': {
    id: 'documenter',
    name: 'Technical Writer',
    description: 'Writes documentation and comments',
    prompt: `You are a technical writer. Your responsibilities:

1. **README**: Write clear project documentation
2. **API Docs**: Document APIs and interfaces
3. **Comments**: Add helpful inline comments
4. **Examples**: Create usage examples
5. **Guides**: Write how-to guides

Guidelines:
- Write for your audience (developers, users, etc.)
- Be clear and concise
- Use examples liberally
- Keep documentation up to date
- Structure content logically`,
    tools: ['read_file', 'write_file', 'edit_file', 'glob'],
    model: 'balanced',
    runtime: { maxIterations: 15 },
    security: { permissionPreset: 'development' },
    coordination: { layer: 'execution', canDelegate: false, canParallelWith: 'readonly' },
    tags: ['documentation', 'writing'],
  },

  // =========================================================================
  // 扩展代码 Agents
  // =========================================================================

  'refactorer': {
    id: 'refactorer',
    name: 'Code Refactorer',
    description: 'Refactors code to improve structure without changing behavior',
    prompt: `You are a refactoring expert. Your responsibilities:

1. **Extract Methods**: Break down large functions
2. **Rename**: Improve naming for clarity
3. **Simplify**: Reduce complexity, remove dead code
4. **Patterns**: Apply appropriate design patterns
5. **Structure**: Improve file/module organization

Rules:
- NEVER change external behavior
- Make small, incremental changes
- Explain each refactoring step
- Verify with existing tests if available
- Keep backward compatibility

Start by understanding the current structure, then propose changes.`,
    tools: ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash'],
    model: 'balanced',
    runtime: { maxIterations: 20 },
    security: { permissionPreset: 'development' },
    coordination: { layer: 'execution', canDelegate: false, canParallelWith: 'readonly' },
    tags: ['code', 'refactoring', 'maintenance'],
  },

  'devops': {
    id: 'devops',
    name: 'DevOps Engineer',
    description: 'Handles CI/CD, deployment, and infrastructure tasks',
    prompt: `You are a DevOps engineer. Your responsibilities:

1. **CI/CD**: Set up and maintain pipelines
2. **Deployment**: Configure deployment processes
3. **Infrastructure**: Manage infrastructure as code
4. **Monitoring**: Set up logging and monitoring
5. **Security**: Implement security best practices

Guidelines:
- Automate repetitive tasks
- Document all configurations
- Use version control for infrastructure
- Consider security implications
- Plan for failure and recovery`,
    tools: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep'],
    model: 'balanced',
    runtime: { maxIterations: 20 },
    security: { permissionPreset: 'development' },
    coordination: { layer: 'execution', canDelegate: false, canParallelWith: 'readonly' },
    tags: ['devops', 'infrastructure'],
  },

  // =========================================================================
  // 视觉 Agents
  // =========================================================================

  'visual-understanding': {
    id: 'visual-understanding',
    name: '视觉理解 Agent',
    description: '使用视觉模型理解图片内容，包括 OCR、物体检测、场景描述等',
    prompt: `你是一个视觉理解专家。你的职责是**理解和分析**图片内容，不做任何图片编辑操作。

核心能力：
1. **OCR 文字识别**：识别图片中的文字内容
2. **物体检测**：识别图片中的物体、人物、动物等
3. **场景理解**：描述图片的整体场景
4. **元素定位**：描述图片中元素的位置
5. **关系分析**：分析图片中元素之间的空间关系

注意事项：
- 只做理解和分析，不做图片编辑
- 如果用户需要编辑图片，告知需要使用 visual-processing Agent
- 尽可能详细地描述你看到的内容`,
    tools: ['image_analyze', 'read_file'],
    model: 'balanced',
    runtime: { maxIterations: 10 },
    security: { permissionPreset: 'development' },
    coordination: { layer: 'exploration', canDelegate: false, canParallelWith: 'all', readonly: true },
    tags: ['vision', 'analysis', 'ocr', 'readonly'],
  },

  'visual-processing': {
    id: 'visual-processing',
    name: '视觉处理 Agent',
    description: '对图片进行编辑处理，包括标注绘制、裁剪缩放、添加水印等',
    prompt: `你是一个图片处理专家。你的职责是**编辑和处理**图片。

核心能力：
1. **标注绘制**：在图片上绘制矩形框、圆圈、箭头、文字标签
2. **图片裁剪**：按指定区域或比例裁剪图片
3. **尺寸调整**：缩放、旋转图片
4. **水印添加**：在图片上添加文字或图片水印
5. **格式转换**：在 PNG、JPEG、WebP 等格式间转换

注意事项：
- 你不直接分析图片内容，需要依赖 visual-understanding Agent 提供的信息
- 确保输出的图片路径正确且可访问`,
    tools: ['image_annotate', 'image_process', 'read_file', 'write_file', 'glob'],
    model: 'balanced',
    runtime: { maxIterations: 15 },
    security: { permissionPreset: 'development' },
    coordination: { layer: 'execution', canDelegate: false, canParallelWith: 'readonly' },
    tags: ['vision', 'processing', 'annotation', 'editing'],
  },

  // =========================================================================
  // 元 Agents（探索、规划、执行）
  // =========================================================================

  'code-explore': {
    id: 'code-explore',
    name: 'Code Explore Agent',
    description: '搜索和理解本地代码库，只读操作',
    prompt: `你是一个代码库探索专家。你的核心职责是**快速、高效地搜索和理解代码库**。

## 核心能力

1. **文件搜索** - 使用 glob 按模式匹配文件
2. **内容搜索** - 使用 grep 搜索代码内容
3. **代码阅读** - 使用 read_file 查看文件内容

## 工作原则

- **只读操作**：你只搜索和阅读，不修改任何文件
- **高效并行**：可以同时发起多个搜索请求
- **结构化输出**：以清晰的格式汇报发现`,
    tools: ['glob', 'grep', 'read_file', 'list_directory'],
    model: 'fast',
    runtime: { maxIterations: 25 },
    security: { permissionPreset: 'development' },
    coordination: { layer: 'exploration', canDelegate: false, canParallelWith: 'all', maxInstances: 10, readonly: true },
    tags: ['meta', 'exploration', 'search', 'readonly'],
  },

  'plan': {
    id: 'plan',
    name: 'Plan Agent',
    description: '设计实现方案，分析任务并制定详细计划',
    prompt: `你是一个任务规划专家。你的核心职责是**分析任务、理解代码库、设计实现方案**。

## 工作原则

- **只规划不执行**：你输出计划，但不直接执行代码修改
- **深入调研**：在规划前充分理解代码库
- **考虑影响范围**：评估改动对其他模块的影响

## 输出格式

你的计划应该是结构化的 JSON 格式：

\`\`\`json
{
  "analysis": "任务分析和理解",
  "approach": "选择的实现路径和原因",
  "subtasks": [
    {
      "id": "task-1",
      "title": "子任务标题",
      "description": "详细描述",
      "files": ["需要修改的文件列表"],
      "dependencies": []
    }
  ],
  "risks": ["潜在风险列表"]
}
\`\`\``,
    tools: ['glob', 'grep', 'read_file', 'list_directory'],
    model: 'balanced',
    runtime: { maxIterations: 20 },
    security: { permissionPreset: 'development' },
    coordination: { layer: 'planning', canDelegate: false, canParallelWith: 'all', readonly: true },
    outputSchema: {
      type: 'object',
      properties: {
        analysis: { type: 'string' },
        approach: { type: 'string' },
        subtasks: { type: 'array' },
        risks: { type: 'array' },
      },
    },
    tags: ['meta', 'planning', 'design', 'readonly'],
  },

  'bash-executor': {
    id: 'bash-executor',
    name: 'Bash Executor Agent',
    description: '命令执行专家，专注于 shell 命令操作',
    prompt: `你是一个命令行专家。你的核心职责是**执行 shell 命令并处理结果**。

## 核心能力

1. **命令执行** - 运行构建、测试、部署命令
2. **环境管理** - 检查环境状态、安装依赖

## 安全注意事项

- 不执行删除根目录或重要系统文件的命令
- 对于破坏性操作，先确认
- 避免暴露敏感信息`,
    tools: ['bash'],
    model: 'fast',
    runtime: { maxIterations: 15 },
    security: { permissionPreset: 'development' },
    coordination: { layer: 'execution', canDelegate: false, canParallelWith: 'none', maxInstances: 1 },
    tags: ['meta', 'execution', 'shell'],
  },

  'general-purpose': {
    id: 'general-purpose',
    name: 'General Purpose Agent',
    description: '通用执行 Agent，拥有完整工具能力',
    prompt: `你是一个全能型助手。你拥有完整的工具访问权限，可以执行各种复杂任务。

## 核心能力

1. **代码操作** - 读取、编写、编辑代码文件
2. **命令执行** - 运行 shell 命令
3. **文档处理** - 编写和更新文档

## 工具使用策略

- **搜索阶段**：先用 glob、grep 了解代码库
- **阅读阶段**：用 read_file 理解关键代码
- **修改阶段**：用 edit_file 进行精确修改
- **验证阶段**：用 bash 运行测试验证`,
    tools: [
      'bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep',
      'list_directory', 'todo_write', 'ask_user_question',
      'web_search', 'web_fetch', 'skill', 'mcp', 'mcp_list_tools',
    ],
    model: 'powerful',
    runtime: { maxIterations: 30 },
    security: { permissionPreset: 'development' },
    coordination: { layer: 'execution', canDelegate: true, canParallelWith: 'readonly' },
    tags: ['meta', 'general', 'full-capability'],
  },

  // =========================================================================
  // 外部资源 Agents
  // =========================================================================

  'web-search': {
    id: 'web-search',
    name: 'Web Search Agent',
    description: '搜索互联网获取信息',
    prompt: `你是一个网络搜索专家。你的核心职责是**搜索和获取互联网上的信息**。

## 核心能力

1. **网页搜索** - 使用 web_search 进行关键词搜索
2. **网页抓取** - 使用 web_fetch 获取网页内容

## 工作原则

- **来源可信**：优先选择官方文档和权威来源
- **信息新鲜**：关注内容的时效性
- **结构化输出**：以清晰格式整理搜索结果`,
    tools: ['web_search', 'web_fetch'],
    model: 'fast',
    runtime: { maxIterations: 15 },
    security: { permissionPreset: 'development' },
    coordination: { layer: 'exploration', canDelegate: false, canParallelWith: 'all', readonly: true },
    tags: ['external', 'web', 'search', 'network'],
  },

  'mcp-connector': {
    id: 'mcp-connector',
    name: 'MCP Connector Agent',
    description: '连接和使用 MCP 服务器',
    prompt: `你是一个 MCP 服务连接专家。你的核心职责是**管理和使用 MCP 服务**。

## 核心能力

1. **服务发现** - 使用 mcp_list_tools 列出可用工具
2. **工具调用** - 使用 mcp 调用外部服务工具
3. **资源读取** - 使用 mcp_read_resource 读取外部资源

## 常用 MCP 服务

- **context7**: 获取最新库/框架文档
- **exa**: AI 驱动的语义搜索
- **firecrawl**: 网页抓取和数据提取`,
    tools: ['mcp', 'mcp_list_tools', 'mcp_list_resources', 'mcp_read_resource', 'mcp_get_status'],
    model: 'balanced',
    runtime: { maxIterations: 20 },
    security: { permissionPreset: 'development' },
    coordination: { layer: 'exploration', canDelegate: false, canParallelWith: 'all' },
    tags: ['external', 'mcp', 'integration'],
  },

  'doc-reader': {
    id: 'doc-reader',
    name: 'Document Reader Agent',
    description: '读取本地文档文件（PDF、Word、Excel）',
    prompt: `你是一个文档读取专家。你的核心职责是**读取和解析本地文档文件**。

## 核心能力

1. **PDF 文档** - 使用 read_pdf 读取 PDF 文件
2. **Word 文档** - 使用 read_docx 读取 .docx 文件
3. **Excel 表格** - 使用 read_xlsx 读取 .xlsx 文件
4. **通用文件** - 使用 read_file 读取文本文件

## 工作原则

- **本地文件**：只处理本地文件系统中的文档
- **完整提取**：尽可能提取完整的文档结构`,
    tools: ['read_pdf', 'read_docx', 'read_xlsx', 'read_file', 'glob'],
    model: 'fast',
    runtime: { maxIterations: 15 },
    security: { permissionPreset: 'development' },
    coordination: { layer: 'exploration', canDelegate: false, canParallelWith: 'all', readonly: true },
    tags: ['external', 'local', 'documentation', 'pdf', 'readonly'],
  },
};

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 获取预定义 Agent（支持别名）
 */
export function getPredefinedAgent(idOrAlias: string): FullAgentConfig | undefined {
  const canonicalId = resolveAgentAlias(idOrAlias);
  return PREDEFINED_AGENTS[canonicalId];
}

/**
 * 列出所有预定义 Agent ID
 */
export function listPredefinedAgentIds(): string[] {
  return Object.keys(PREDEFINED_AGENTS);
}

/**
 * 列出所有预定义 Agent（简要信息）
 */
export function listPredefinedAgents(): Array<{ id: string; name: string; description: string }> {
  return Object.values(PREDEFINED_AGENTS).map((agent) => ({
    id: agent.id,
    name: agent.name,
    description: agent.description,
  }));
}

/**
 * 检查是否为预定义 Agent
 */
export function isPredefinedAgent(idOrAlias: string): boolean {
  const canonicalId = resolveAgentAlias(idOrAlias);
  return canonicalId in PREDEFINED_AGENTS;
}

/**
 * 按标签获取 Agents
 */
export function getAgentsByTag(tag: string): FullAgentConfig[] {
  return Object.values(PREDEFINED_AGENTS).filter((agent) => agent.tags?.includes(tag));
}

/**
 * 按层级获取 Agents
 */
export function getAgentsByLayer(layer: 'exploration' | 'planning' | 'execution'): FullAgentConfig[] {
  return Object.values(PREDEFINED_AGENTS).filter(
    (agent) => agent.coordination?.layer === layer
  );
}

/**
 * 获取所有别名
 */
export function getAgentAliases(): Record<string, string> {
  return { ...AGENT_ALIASES };
}

// ============================================================================
// 兼容性辅助函数
// ============================================================================

/**
 * 获取 Agent 的系统提示词
 */
export function getAgentPrompt(agent: FullAgentConfig): string {
  return agent.prompt;
}

/**
 * 需要 tool_search 的 Agent 列表
 * 这些 Agent 可能需要发现和使用延迟加载的工具
 */
const AGENTS_NEED_TOOL_SEARCH = [
  'coder',
  'general-purpose',
  'debugger',
  'architect',
  'documenter',
  'refactorer',
  'devops',
];

/**
 * 获取 Agent 的工具列表
 * 对于需要扩展能力的 Agent，自动添加 tool_search
 */
export function getAgentTools(agent: FullAgentConfig, includeToolSearch = true): string[] {
  const tools = agent.tools || [];

  // 如果启用了 tool_search 且该 Agent 需要扩展能力
  if (includeToolSearch && AGENTS_NEED_TOOL_SEARCH.includes(agent.id)) {
    if (!tools.includes('tool_search')) {
      return [...tools, 'tool_search'];
    }
  }

  return tools;
}

/**
 * 获取 Agent 的最大迭代次数
 */
export function getAgentMaxIterations(agent: FullAgentConfig): number {
  return agent.runtime?.maxIterations ?? 20;
}

/**
 * 获取 Agent 的权限预设
 */
export function getAgentPermissionPreset(agent: FullAgentConfig): PermissionPreset {
  return agent.security?.permissionPreset ?? 'development';
}

/**
 * 获取 Agent 的最大预算
 */
export function getAgentMaxBudget(agent: FullAgentConfig): number | undefined {
  return agent.runtime?.maxBudget;
}

// ============================================================================
// P2: 迭代次数分级控制
// 借鉴 Anthropic: "embedded scaling rules in prompts"
// ============================================================================

/**
 * 任务复杂度类型
 */
export type TaskComplexity = 'simple' | 'moderate' | 'complex';

/**
 * 迭代次数上限配置（按 Agent 类型）
 */
const ITERATION_LIMITS: Record<string, number> = {
  // 信息搜集类（快速返回）
  'code-explore': 8,     // 原 25 → 8
  'explore': 8,
  'doc-reader': 6,
  'web-search': 8,

  // 分析审查类（适中）
  'reviewer': 12,        // 原 20 → 12
  'visual-understanding': 8,

  // 执行类（可能需要更多）
  'coder': 15,           // 原 25 → 15
  'debugger': 15,        // 原 30 → 15
  'tester': 15,
  'refactorer': 12,
  'devops': 12,
  'documenter': 10,

  // 规划类（限制思考时间）
  'plan': 10,            // 原 20 → 10
  'architect': 10,       // 原 15 → 10

  // 通用类
  'general-purpose': 20, // 原 30 → 20
  'bash-executor': 10,
  'mcp-connector': 12,
  'visual-processing': 10,
};

/**
 * 估算任务复杂度
 *
 * 基于 prompt 内容关键词判断任务复杂度
 */
export function estimateTaskComplexity(prompt: string): TaskComplexity {
  const lowerPrompt = prompt.toLowerCase();

  // 简单任务指标
  const simpleIndicators = [
    '查找', '读取', '列出', '获取',
    'find', 'list', 'read', 'get', 'show', 'what is',
  ];

  // 复杂任务指标
  const complexIndicators = [
    '分析', '审计', '重构', '设计', '全面', '详细', '完整',
    'analyze', 'audit', 'refactor', 'design', 'comprehensive',
    'detailed', 'complete', 'thorough', 'in-depth',
  ];

  // 检查复杂指标
  const hasComplexIndicator = complexIndicators.some(i => lowerPrompt.includes(i));
  const hasMultipleTasks = (prompt.match(/\d+\./g) || []).length >= 3;
  const isLongPrompt = prompt.length > 500;

  if (hasComplexIndicator || hasMultipleTasks || isLongPrompt) {
    return 'complex';
  }

  // 检查简单指标
  const hasSimpleIndicator = simpleIndicators.some(i => lowerPrompt.includes(i));
  const isShortPrompt = prompt.length < 100;

  if (hasSimpleIndicator && isShortPrompt) {
    return 'simple';
  }

  return 'moderate';
}

/**
 * 动态迭代次数计算
 *
 * 根据 Agent 类型和任务复杂度动态计算最大迭代次数
 *
 * @param agentType - Agent 类型 ID
 * @param prompt - 任务提示词
 * @returns 计算后的最大迭代次数（范围：3-30）
 */
export function calculateMaxIterations(
  agentType: string,
  prompt: string
): number {
  // 获取 Agent 配置的基础迭代次数
  const agent = getPredefinedAgent(agentType);
  const configuredIterations = agent?.runtime?.maxIterations ?? 20;

  // 使用优化后的迭代上限（如果存在）
  const baseIterations = ITERATION_LIMITS[agentType] ?? configuredIterations;

  // 估算任务复杂度
  const complexity = estimateTaskComplexity(prompt);

  // 复杂度调整因子
  const complexityFactor = {
    simple: 0.6,     // 简单任务减少 40%
    moderate: 1.0,   // 中等任务不变
    complex: 1.3,    // 复杂任务增加 30%
  }[complexity];

  // Prompt 长度调整（长 prompt 可能需要更多迭代，但限制增幅）
  const lengthFactor = Math.min(1.2, 1 + (prompt.length - 200) / 2000);

  // 计算最终值
  const calculated = Math.round(baseIterations * complexityFactor * lengthFactor);

  // 设置上下限：3-30
  return Math.max(3, Math.min(calculated, 30));
}

/**
 * 获取 Agent 的动态最大迭代次数
 *
 * 优先使用动态计算值，如果没有 prompt 则回退到配置值
 */
export function getAgentDynamicMaxIterations(
  agent: FullAgentConfig,
  prompt?: string
): number {
  if (prompt) {
    return calculateMaxIterations(agent.id, prompt);
  }
  return getAgentMaxIterations(agent);
}

// ============================================================================
// P4: 子代理模型路由
// 基于 GLM 包年套餐优化：GLM-4-Flash（简单任务）+ GLM-4.7（其他）+ DeepSeek（降级）
// ============================================================================

/**
 * 子代理模型配置
 *
 * 策略：
 * - 简单任务（探索、文档读取）使用 GLM-4-Flash（免费且快）
 * - 其他任务使用 GLM-4.7（包年套餐，边际成本为零）
 * - 降级时使用 DeepSeek V3
 */
/**
 * 子代理模型配置
 *
 * 策略（GLM + Kimi 分工）：
 * - 简单任务（探索、搜索）：GLM-4-Flash（免费且快）
 * - 规划/审查任务：GLM-4.7（擅长中文理解和规划）
 * - 编码/重构任务：Kimi K2.5（代码能力强，包月套餐）
 * - 其他任务：GLM-4.7（包年套餐）
 *
 * 可通过环境变量覆盖：
 * - SUBAGENT_CODER_PROVIDER / SUBAGENT_CODER_MODEL
 */
const SUBAGENT_MODEL_CONFIG: Record<string, { provider: ModelProvider; model: string }> = {
  // === 简单任务：GLM-4-Flash（免费且快）===
  'code-explore': { provider: 'zhipu', model: 'glm-4-flash' },
  'doc-reader': { provider: 'zhipu', model: 'glm-4-flash' },
  'bash-executor': { provider: 'zhipu', model: 'glm-4-flash' },
  'web-search': { provider: 'zhipu', model: 'glm-4-flash' },

  // === 规划/审查任务：GLM-4.7（擅长中文理解）===
  'plan': { provider: 'zhipu', model: 'glm-4.7' },
  'reviewer': { provider: 'zhipu', model: 'glm-4.7' },
  'documenter': { provider: 'zhipu', model: 'glm-4.7' },
  'architect': { provider: 'zhipu', model: 'glm-4.7' },

  // === 编码/重构任务：Kimi K2.5（代码能力强）===
  'coder': {
    provider: (process.env.SUBAGENT_CODER_PROVIDER as ModelProvider) || 'moonshot',
    model: process.env.SUBAGENT_CODER_MODEL || 'kimi-k2.5',
  },
  'refactorer': {
    provider: (process.env.SUBAGENT_REFACTORER_PROVIDER as ModelProvider) || 'moonshot',
    model: process.env.SUBAGENT_REFACTORER_MODEL || 'kimi-k2.5',
  },
  'debugger': {
    provider: (process.env.SUBAGENT_DEBUGGER_PROVIDER as ModelProvider) || 'moonshot',
    model: process.env.SUBAGENT_DEBUGGER_MODEL || 'kimi-k2.5',
  },
  'tester': {
    provider: (process.env.SUBAGENT_TESTER_PROVIDER as ModelProvider) || 'moonshot',
    model: process.env.SUBAGENT_TESTER_MODEL || 'kimi-k2.5',
  },

  // === 其他任务：GLM-4.7（包年套餐）===
  'devops': { provider: 'zhipu', model: 'glm-4.7' },
  'general-purpose': { provider: 'zhipu', model: 'glm-4.7' },
  'mcp-connector': { provider: 'zhipu', model: 'glm-4.7' },
  'visual-understanding': { provider: 'zhipu', model: 'glm-4.7' },
  'visual-processing': { provider: 'zhipu', model: 'glm-4.7' },
};

/**
 * 降级模型配置（GLM 不可用时）
 */
const FALLBACK_MODEL: { provider: ModelProvider; model: string } = {
  provider: 'deepseek',
  model: 'deepseek-chat',
};

/**
 * 获取子代理应使用的模型配置
 *
 * @param agentType - Agent 类型 ID
 * @returns { provider, model } 配置
 */
export function getSubagentModelConfig(agentType: string): { provider: ModelProvider; model: string } {
  return SUBAGENT_MODEL_CONFIG[agentType] || FALLBACK_MODEL;
}

/**
 * 获取子代理的完整模型配置（用于直接传递给 ModelRouter）
 *
 * @param agentType - Agent 类型 ID
 * @param baseConfig - 基础模型配置（继承 API key 等）
 * @returns 完整的 ModelConfig
 */
export function getSubagentFullModelConfig(
  agentType: string,
  baseConfig: { apiKey?: string; baseUrl?: string }
): { provider: ModelProvider; model: string; apiKey?: string; baseUrl?: string } {
  const modelConfig = getSubagentModelConfig(agentType);
  return {
    ...modelConfig,
    apiKey: baseConfig.apiKey,
    baseUrl: baseConfig.baseUrl,
  };
}
