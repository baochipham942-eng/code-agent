// ============================================================================
// Built-in Agent Types - Type-safe definitions for Gen7 multi-agent system
// ============================================================================

/**
 * 6 个内置 Agent 角色
 * 这是 Gen7 多代理系统的核心角色集
 */
export type BuiltInAgentRole =
  | 'coder'
  | 'reviewer'
  | 'tester'
  | 'architect'
  | 'debugger'
  | 'documenter';

/**
 * 内置 Agent 配置接口
 */
export interface BuiltInAgentConfig {
  /** 角色 ID */
  role: BuiltInAgentRole;
  /** 显示名称 */
  name: string;
  /** 角色描述 */
  description: string;
  /** 系统提示词 */
  systemPrompt: string;
  /** 可用工具列表 */
  tools: string[];
  /** 最大迭代次数 */
  maxIterations: number;
  /** 是否可以创建子代理 */
  canSpawnSubagents: boolean;
  /** 分类标签 */
  tags: string[];
  /** 模型覆盖配置（可选，用于需要特定模型的 agent） */
  modelOverride?: {
    provider?: string;
    model?: string;
    temperature?: number;
  };
}

/**
 * 内置 Agent 配置常量
 * 这些角色可以通过 spawn_agent 工具的 role 参数直接引用
 */
export const BUILT_IN_AGENTS: Record<BuiltInAgentRole, BuiltInAgentConfig> = {
  coder: {
    role: 'coder',
    name: 'Coder',
    description: 'Writes clean, efficient code following best practices',
    systemPrompt: `You are a senior software engineer. Your responsibilities:

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
    maxIterations: 25,
    canSpawnSubagents: false,
    tags: ['code', 'development'],
  },

  reviewer: {
    role: 'reviewer',
    name: 'Code Reviewer',
    description: 'Reviews code for bugs, security issues, and best practices',
    systemPrompt: `You are an expert code reviewer. Your responsibilities:

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
    maxIterations: 15,
    canSpawnSubagents: false,
    tags: ['code', 'review', 'quality'],
  },

  tester: {
    role: 'tester',
    name: 'Test Engineer',
    description: 'Writes comprehensive unit and integration tests',
    systemPrompt: `You are a testing specialist. Your responsibilities:

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
    maxIterations: 25,
    canSpawnSubagents: false,
    tags: ['code', 'testing', 'quality'],
  },

  architect: {
    role: 'architect',
    name: 'Software Architect',
    description: 'Designs system architecture and makes technical decisions',
    systemPrompt: `You are a software architect. Your responsibilities:

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
    maxIterations: 15,
    canSpawnSubagents: false,
    tags: ['architecture', 'design', 'planning'],
  },

  debugger: {
    role: 'debugger',
    name: 'Debugger',
    description: 'Investigates and fixes bugs systematically',
    systemPrompt: `You are a debugging specialist. Your approach:

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
    maxIterations: 30,
    canSpawnSubagents: false,
    tags: ['debugging', 'analysis'],
  },

  documenter: {
    role: 'documenter',
    name: 'Technical Writer',
    description: 'Writes documentation and comments',
    systemPrompt: `You are a technical writer. Your responsibilities:

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
    maxIterations: 15,
    canSpawnSubagents: false,
    tags: ['documentation', 'writing'],
  },
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 获取内置 Agent 配置
 * @param role 角色名称
 * @returns 配置对象，如果角色不存在则返回 undefined
 */
export function getBuiltInAgent(role: string): BuiltInAgentConfig | undefined {
  if (isBuiltInAgentRole(role)) {
    return BUILT_IN_AGENTS[role];
  }
  return undefined;
}

/**
 * 检查是否为内置角色
 * @param role 角色名称
 * @returns 是否为内置角色
 */
export function isBuiltInAgentRole(role: string): role is BuiltInAgentRole {
  return role in BUILT_IN_AGENTS;
}

/**
 * 获取所有内置角色名称
 * @returns 角色名称数组
 */
export function listBuiltInAgentRoles(): BuiltInAgentRole[] {
  return Object.keys(BUILT_IN_AGENTS) as BuiltInAgentRole[];
}

/**
 * 获取所有内置 Agent 的简要信息
 * @returns 包含 role、name、description 的数组
 */
export function listBuiltInAgents(): Array<{
  role: BuiltInAgentRole;
  name: string;
  description: string;
}> {
  return Object.values(BUILT_IN_AGENTS).map((config) => ({
    role: config.role,
    name: config.name,
    description: config.description,
  }));
}

/**
 * 按标签获取内置 Agent
 * @param tag 标签名称
 * @returns 匹配的配置数组
 */
export function getBuiltInAgentsByTag(tag: string): BuiltInAgentConfig[] {
  return Object.values(BUILT_IN_AGENTS).filter((config) =>
    config.tags.includes(tag)
  );
}
