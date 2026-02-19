// ============================================================================
// Core Agents - 4 个核心角色定义（混合架构 Layer 1）
// ============================================================================
//
// 设计原则：
// 1. 边界清晰：每个角色职责明确，无重叠
// 2. 覆盖 80%：4 个核心角色覆盖大部分编程场景
// 3. 配置简单：扁平化配置，无多层嵌套
//
// 参考：
// - Claude Code 的 6 个子代理
// - Kimi Agent Swarm 的动态生成理念
// - LangGraph 的条件路由机制
// ============================================================================

import type { ModelProvider } from '../../../shared/types/model';
import { DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_MODELS } from '../../../shared/constants';

// ============================================================================
// Types
// ============================================================================

/**
 * 核心角色 ID（4 个）
 */
export type CoreAgentId = 'coder' | 'reviewer' | 'explore' | 'plan';

/**
 * 模型层级（3 级）
 */
export type ModelTier = 'fast' | 'balanced' | 'powerful';

/**
 * 核心角色配置（扁平化）
 */
export interface CoreAgentConfig {
  id: CoreAgentId;
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  model: ModelTier;
  maxIterations: number;
  readonly: boolean;
}

// ============================================================================
// Model Configuration
// ============================================================================

/**
 * 模型层级映射
 *
 * 可通过环境变量覆盖：
 * - FAST_MODEL_PROVIDER / FAST_MODEL
 * - BALANCED_MODEL_PROVIDER / BALANCED_MODEL
 * - POWERFUL_MODEL_PROVIDER / POWERFUL_MODEL
 */
export const MODEL_CONFIG: Record<ModelTier, { provider: ModelProvider; model: string }> = {
  fast: {
    provider: (process.env.FAST_MODEL_PROVIDER as ModelProvider) || 'zhipu',
    model: process.env.FAST_MODEL || DEFAULT_MODELS.quick,
  },
  balanced: {
    provider: (process.env.BALANCED_MODEL_PROVIDER as ModelProvider) || 'zhipu',
    model: process.env.BALANCED_MODEL || 'glm-5',
  },
  powerful: {
    provider: (process.env.POWERFUL_MODEL_PROVIDER as ModelProvider) || (DEFAULT_PROVIDER as ModelProvider),
    model: process.env.POWERFUL_MODEL || DEFAULT_MODEL,
  },
};

export function getModelConfig(tier: ModelTier): { provider: ModelProvider; model: string } {
  return MODEL_CONFIG[tier];
}

// ============================================================================
// Agent ID Validation
// ============================================================================

/**
 * 核心角色列表
 */
export const CORE_AGENT_IDS: CoreAgentId[] = ['coder', 'reviewer', 'explore', 'plan'];

/**
 * 检查是否为核心角色
 */
export function isCoreAgent(id: string): id is CoreAgentId {
  return CORE_AGENT_IDS.includes(id as CoreAgentId);
}

/**
 * 验证 Agent ID，无效则抛出错误
 */
export function validateAgentId(id: string): CoreAgentId {
  if (!isCoreAgent(id)) {
    throw new Error(`Invalid agent ID: "${id}". Valid IDs: ${CORE_AGENT_IDS.join(', ')}`);
  }
  return id;
}

// ============================================================================
// Core Agent Definitions
// ============================================================================

export const CORE_AGENTS: Record<CoreAgentId, CoreAgentConfig> = {
  // =========================================================================
  // Coder - 代码编写 + 调试 + 文档
  // =========================================================================
  coder: {
    id: 'coder',
    name: 'Coder',
    description: 'Writes, debugs, and documents code. Handles all code modifications.',
    prompt: `You are a senior software engineer. Your responsibilities:

## Core Capabilities
1. **Write Code**: Clean, readable, maintainable code
2. **Debug Issues**: Investigate and fix bugs systematically
3. **Refactor**: Improve code structure without changing behavior
4. **Document**: Add comments and docs where needed

## Workflow
1. **Understand First**: Read existing code before making changes
2. **Minimal Changes**: Keep modifications focused and small
3. **Verify**: Run tests or typecheck after changes

## Rules
- ALWAYS read a file before editing it
- For multi-step tasks, start with todo_write
- Run verification after modifications (bash: npm run typecheck)
- Follow project conventions and patterns

## Anti-patterns to Avoid
- Don't edit without reading first
- Don't add unnecessary abstractions
- Don't create new files unless absolutely necessary

## Task Management
- Use task_list to check available tasks before starting work
- Use task_update to claim tasks (set owner to your name) and mark completed
- After completing a task, call task_list to find next available work
- Create sub-tasks with task_create if you discover additional work needed`,
    tools: [
      'bash', 'read_file', 'write_file', 'edit_file',
      'glob', 'grep', 'list_directory', 'todo_write',
      'task_list', 'task_get', 'task_update', 'task_create',
    ],
    model: 'powerful',
    maxIterations: 20,
    readonly: false,
  },

  // =========================================================================
  // Reviewer - 代码审查 + 测试
  // =========================================================================
  reviewer: {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews code quality, writes and runs tests.',
    prompt: `You are a code reviewer and testing specialist. Your responsibilities:

## Code Review
1. **Bug Detection**: Logic errors, null pointers, race conditions
2. **Security Review**: XSS, injection, auth issues, OWASP top 10
3. **Best Practices**: Coding standards, naming, DRY, SOLID
4. **Performance**: Inefficient algorithms, memory leaks, N+1 queries

## Testing
1. **Unit Tests**: Isolated tests for functions/methods (AAA pattern)
2. **Edge Cases**: Boundary conditions, error cases, null inputs
3. **Integration Tests**: Component interactions
4. **Coverage**: High coverage of critical paths

## Output Format
When reviewing:
- Brief summary (1-2 sentences)
- Issues by severity: CRITICAL > HIGH > MEDIUM > LOW
- For each issue: file:line, description, suggested fix
- Positive observations

When testing:
- Test file location and naming
- How to run the tests
- Coverage expectations

Be constructive and specific. Focus on actionable feedback.

## Task Management
- Use task_list to check available tasks before starting work
- Use task_update to claim tasks (set owner to your name) and mark completed
- After completing a task, call task_list to find next available work
- Create sub-tasks with task_create if you discover additional work needed`,
    tools: [
      'bash', 'read_file', 'write_file', 'edit_file',
      'glob', 'grep', 'list_directory',
      'task_list', 'task_get', 'task_update', 'task_create',
    ],
    model: 'balanced',
    maxIterations: 15,
    readonly: false,
  },

  // =========================================================================
  // Explore - 信息搜索（只读）
  // =========================================================================
  explore: {
    id: 'explore',
    name: 'Explorer',
    description: 'Searches code, web, and documents. Read-only operations.',
    prompt: `You are a research and exploration specialist. Your responsibilities:

## Core Capabilities
1. **Code Search**: Use glob/grep to find files and patterns
2. **Web Search**: Search internet for documentation and solutions
3. **Document Reading**: Read PDFs, Word, Excel, and text files
4. **Codebase Understanding**: Map project structure and dependencies

## Workflow
1. **Parallel Searches**: Issue multiple search requests simultaneously
2. **Structured Output**: Report findings in clear format
3. **Source Attribution**: Always cite where information came from

## Rules
- READ-ONLY: You search and read, NEVER modify files
- Be thorough but efficient
- Summarize findings clearly with file paths
- Suggest next steps if appropriate

## Task Management
- Use task_list to see available tasks and overall progress
- Use task_get to read task details before starting

## Output Format
For code exploration:
\`\`\`
Found X relevant files:
1. path/to/file.ts:123 - description
2. path/to/another.ts:45 - description

Key findings:
- Finding 1
- Finding 2

Suggested actions:
- Action 1
- Action 2
\`\`\``,
    tools: [
      'glob', 'grep', 'read_file', 'list_directory',
      'web_search', 'web_fetch',
      'read_pdf', 'read_docx', 'read_xlsx',
      'task_list', 'task_get',
    ],
    model: 'fast',
    maxIterations: 15,
    readonly: true,
  },

  // =========================================================================
  // Plan - 规划 + 架构设计
  // =========================================================================
  plan: {
    id: 'plan',
    name: 'Planner',
    description: 'Designs architecture and creates implementation plans.',
    prompt: `You are a software architect and planner. Your responsibilities:

## Core Capabilities
1. **System Design**: Scalable, maintainable architectures
2. **Task Planning**: Break down complex tasks into subtasks
3. **Technology Choice**: Recommend appropriate technologies
4. **Risk Assessment**: Identify potential issues early

## Workflow
1. **Understand Requirements**: Both functional and non-functional
2. **Research Codebase**: Use search tools to understand existing structure
3. **Design Solution**: Consider trade-offs explicitly
4. **Output Plan**: Structured, actionable plan

## Output Format
\`\`\`json
{
  "analysis": "Task analysis and understanding",
  "approach": "Chosen implementation path and reasoning",
  "subtasks": [
    {
      "id": "task-1",
      "title": "Subtask title",
      "description": "Detailed description",
      "files": ["files to modify"],
      "agent": "coder|reviewer|explore",
      "dependencies": [],
      "parallelizable": true
    }
  ],
  "risks": ["potential risks"],
  "estimatedEffort": "low|medium|high"
}
\`\`\`

## Rules
- READ-ONLY for exploration, can write plan documents
- Prefer simplicity over complexity
- Consider team capabilities and existing patterns
- Plan for evolution and change

## Task Management
- Use task_list to check available tasks before starting work
- Use task_update to claim tasks (set owner to your name) and mark completed
- After completing a task, call task_list to find next available work
- Create sub-tasks with task_create to break down complex plans`,
    tools: [
      'glob', 'grep', 'read_file', 'list_directory',
      'write_file', 'todo_write',
      'task_list', 'task_get', 'task_update', 'task_create',
    ],
    model: 'balanced',
    maxIterations: 12,
    readonly: true,  // 主要是只读，除了写计划文档
  },
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 获取核心角色配置
 */
export function getCoreAgent(id: CoreAgentId): CoreAgentConfig {
  return CORE_AGENTS[id];
}

/**
 * 获取角色配置
 */
export function getAgent(id: string): CoreAgentConfig | undefined {
  if (isCoreAgent(id)) {
    return CORE_AGENTS[id];
  }
  return undefined;
}

/**
 * 列出所有核心角色
 */
export function listCoreAgents(): CoreAgentConfig[] {
  return Object.values(CORE_AGENTS);
}

/**
 * 获取角色的模型配置
 */
export function getAgentModelConfig(id: CoreAgentId): { provider: ModelProvider; model: string } {
  const agent = CORE_AGENTS[id];
  return getModelConfig(agent.model);
}

/**
 * 检查角色是否只读
 */
export function isReadonlyAgent(id: CoreAgentId): boolean {
  return CORE_AGENTS[id].readonly;
}

/**
 * 根据任务类型推荐核心角色
 */
export function recommendCoreAgent(taskType: string): CoreAgentId {
  const mapping: Record<string, CoreAgentId> = {
    // 编码相关
    'code': 'coder',
    'write': 'coder',
    'implement': 'coder',
    'fix': 'coder',
    'debug': 'coder',
    'refactor': 'coder',
    'document': 'coder',

    // 审查相关
    'review': 'reviewer',
    'test': 'reviewer',
    'audit': 'reviewer',
    'check': 'reviewer',

    // 探索相关
    'search': 'explore',
    'find': 'explore',
    'explore': 'explore',
    'research': 'explore',
    'read': 'explore',
    'understand': 'explore',

    // 规划相关
    'plan': 'plan',
    'design': 'plan',
    'architect': 'plan',
    'analyze': 'plan',
  };

  return mapping[taskType.toLowerCase()] || 'coder';
}
