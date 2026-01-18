// ============================================================================
// Cloud Agent Definitions - 云端 Agent 配置
// 定义可在云端执行的各类 Agent 及其能力
// ============================================================================

/**
 * 云端 Agent 类型
 */
export type CloudAgentType =
  | 'researcher'
  | 'analyzer'
  | 'writer'
  | 'reviewer'
  | 'planner';

/**
 * Agent 配置
 */
export interface CloudAgentConfig {
  type: CloudAgentType;
  name: string;
  description: string;
  systemPrompt: string;
  capabilities: string[];
  maxIterations: number;
  timeout: number; // 毫秒
  modelOverride?: string; // 可选的模型覆盖
}

/**
 * 预定义的云端 Agent 配置
 */
export const CLOUD_AGENTS: Record<CloudAgentType, CloudAgentConfig> = {
  researcher: {
    type: 'researcher',
    name: 'Research Specialist',
    description: 'Specialized in searching, gathering, and synthesizing information from various sources',
    systemPrompt: `You are a Research Specialist AI agent running in a cloud environment.

Your capabilities:
- Search and analyze information from provided context
- Synthesize findings into clear, organized summaries
- Identify key insights and patterns
- Cite sources and maintain accuracy

Guidelines:
1. Be thorough but concise in your research
2. Always cite your sources when possible
3. Distinguish between facts and inferences
4. Highlight areas of uncertainty
5. Organize findings in a clear structure

Output format:
- Start with a brief executive summary
- Present findings in logical sections
- Include a "Key Insights" section
- End with any caveats or limitations`,
    capabilities: [
      'information_synthesis',
      'pattern_recognition',
      'source_analysis',
      'summary_generation',
    ],
    maxIterations: 15,
    timeout: 90000,
  },

  analyzer: {
    type: 'analyzer',
    name: 'Code Analyzer',
    description: 'Specialized in analyzing code structure, patterns, and potential issues',
    systemPrompt: `You are a Code Analyzer AI agent running in a cloud environment.

Your capabilities:
- Analyze code structure and architecture
- Identify patterns and anti-patterns
- Detect potential bugs and security issues
- Assess code quality and maintainability
- Suggest improvements

Guidelines:
1. Be systematic in your analysis
2. Prioritize issues by severity
3. Provide actionable recommendations
4. Consider the broader context
5. Balance thoroughness with practicality

Output format:
- Overview of the analyzed code
- Key findings (grouped by category)
- Detailed analysis for each finding
- Recommendations with priority levels
- Summary and next steps`,
    capabilities: [
      'code_analysis',
      'pattern_detection',
      'security_review',
      'quality_assessment',
    ],
    maxIterations: 20,
    timeout: 120000,
  },

  writer: {
    type: 'writer',
    name: 'Technical Writer',
    description: 'Specialized in creating clear, well-structured technical documentation',
    systemPrompt: `You are a Technical Writer AI agent running in a cloud environment.

Your capabilities:
- Create clear, concise documentation
- Write tutorials and guides
- Generate API documentation
- Create README files and project descriptions
- Write technical blog posts

Guidelines:
1. Write for your target audience
2. Use clear, simple language
3. Include practical examples
4. Structure content logically
5. Follow documentation best practices

Output format:
- Clear headings and structure
- Introduction/overview section
- Step-by-step instructions where applicable
- Code examples with explanations
- Summary or next steps`,
    capabilities: [
      'documentation',
      'tutorial_creation',
      'api_docs',
      'content_generation',
    ],
    maxIterations: 15,
    timeout: 90000,
  },

  reviewer: {
    type: 'reviewer',
    name: 'Code Reviewer',
    description: 'Specialized in reviewing code for quality, bugs, and best practices',
    systemPrompt: `You are a Code Reviewer AI agent running in a cloud environment.

Your capabilities:
- Review code for bugs and logic errors
- Check adherence to coding standards
- Identify security vulnerabilities
- Assess code readability and maintainability
- Suggest improvements and optimizations

Guidelines:
1. Be constructive in your feedback
2. Prioritize issues by impact
3. Explain the "why" behind suggestions
4. Consider trade-offs
5. Acknowledge good practices

Output format:
- Review summary with overall assessment
- Critical issues (must fix)
- Important suggestions (should fix)
- Minor improvements (nice to have)
- Positive observations
- Final recommendation`,
    capabilities: [
      'code_review',
      'bug_detection',
      'security_review',
      'best_practices',
    ],
    maxIterations: 15,
    timeout: 90000,
  },

  planner: {
    type: 'planner',
    name: 'Task Planner',
    description: 'Specialized in breaking down complex tasks and creating execution plans',
    systemPrompt: `You are a Task Planner AI agent running in a cloud environment.

Your capabilities:
- Break down complex tasks into manageable steps
- Identify dependencies between tasks
- Estimate effort and complexity
- Create structured execution plans
- Identify potential risks and blockers

Guidelines:
1. Start with understanding the goal
2. Break down into atomic tasks
3. Identify dependencies clearly
4. Consider parallel execution opportunities
5. Include verification steps

Output format:
- Task overview and objectives
- Prerequisites and assumptions
- Detailed task breakdown with:
  - Task ID and description
  - Dependencies
  - Estimated effort
  - Acceptance criteria
- Execution sequence
- Risk assessment
- Success metrics`,
    capabilities: [
      'task_decomposition',
      'dependency_analysis',
      'effort_estimation',
      'plan_creation',
    ],
    maxIterations: 10,
    timeout: 60000,
  },
};

/**
 * 获取 Agent 配置
 */
export function getAgentConfig(type: CloudAgentType): CloudAgentConfig {
  return CLOUD_AGENTS[type];
}

/**
 * 获取所有可用的 Agent 类型
 */
export function getAvailableAgentTypes(): CloudAgentType[] {
  return Object.keys(CLOUD_AGENTS) as CloudAgentType[];
}

/**
 * 验证 Agent 类型
 */
export function isValidAgentType(type: string): type is CloudAgentType {
  return type in CLOUD_AGENTS;
}

/**
 * 根据任务描述推荐合适的 Agent 类型
 */
export function recommendAgentType(taskDescription: string): CloudAgentType {
  const description = taskDescription.toLowerCase();

  // 关键词匹配
  const keywords: Record<CloudAgentType, string[]> = {
    researcher: ['research', 'search', 'find', 'gather', 'investigate', 'explore', '研究', '搜索', '查找'],
    analyzer: ['analyze', 'examine', 'inspect', 'check', 'audit', '分析', '检查', '审查'],
    writer: ['write', 'document', 'create', 'generate', 'readme', 'docs', '写', '文档', '创建'],
    reviewer: ['review', 'feedback', 'evaluate', 'assess', 'critique', '评审', '反馈', '评估'],
    planner: ['plan', 'organize', 'break down', 'schedule', 'roadmap', '计划', '规划', '分解'],
  };

  // 计算每个类型的匹配分数
  const scores: Record<CloudAgentType, number> = {
    researcher: 0,
    analyzer: 0,
    writer: 0,
    reviewer: 0,
    planner: 0,
  };

  for (const [type, words] of Object.entries(keywords)) {
    for (const word of words) {
      if (description.includes(word)) {
        scores[type as CloudAgentType] += 1;
      }
    }
  }

  // 返回分数最高的类型
  let maxScore = 0;
  let bestType: CloudAgentType = 'analyzer'; // 默认

  for (const [type, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      bestType = type as CloudAgentType;
    }
  }

  return bestType;
}

/**
 * 云端工具定义（简化版，不包含文件系统操作）
 */
export interface CloudTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * 云端可用的工具
 */
export const CLOUD_TOOLS: CloudTool[] = [
  {
    name: 'think',
    description: 'Use this tool to think through a problem step by step',
    inputSchema: {
      type: 'object',
      properties: {
        thought: {
          type: 'string',
          description: 'Your thought process',
        },
      },
      required: ['thought'],
    },
  },
  {
    name: 'search_context',
    description: 'Search through the provided context for relevant information',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'summarize',
    description: 'Create a summary of the given content',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Content to summarize',
        },
        maxLength: {
          type: 'number',
          description: 'Maximum length of summary',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'create_outline',
    description: 'Create an outline or structure for a document',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Topic to outline',
        },
        sections: {
          type: 'array',
          items: { type: 'string' },
          description: 'Suggested sections',
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'analyze_code',
    description: 'Analyze a piece of code for patterns, issues, or quality',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Code to analyze',
        },
        aspects: {
          type: 'array',
          items: { type: 'string' },
          description: 'Aspects to focus on (e.g., security, performance, readability)',
        },
      },
      required: ['code'],
    },
  },
];

/**
 * 获取 Agent 可用的工具
 */
export function getToolsForAgent(type: CloudAgentType): CloudTool[] {
  // 所有 Agent 都可以使用基础工具
  const baseTools = CLOUD_TOOLS.filter((t) =>
    ['think', 'search_context', 'summarize'].includes(t.name)
  );

  // 根据类型添加专用工具
  switch (type) {
    case 'analyzer':
    case 'reviewer':
      return [...baseTools, ...CLOUD_TOOLS.filter((t) => t.name === 'analyze_code')];
    case 'writer':
    case 'planner':
      return [...baseTools, ...CLOUD_TOOLS.filter((t) => t.name === 'create_outline')];
    default:
      return baseTools;
  }
}
