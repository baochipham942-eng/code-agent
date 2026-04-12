// ============================================================================
// Cowork Types - 多 Agent 协作类型定义
// Phase 1: Cowork 角色体系重构
// ============================================================================

/**
 * Agent 角色在 Cowork 中的职责定义
 */
export interface CoworkAgentRole {
  /** Agent 类型 ID */
  agentType: string;
  /** 职责列表 */
  responsibilities: string[];
  /** 约束（不能做什么） */
  constraints?: string[];
  /** 输出物（交付什么） */
  deliverables: string[];
  /** 是否必须（默认 true） */
  required?: boolean;
}

/**
 * 共享资源定义
 */
export interface CoworkSharedResources {
  /** 共享类型文件路径 */
  types?: string[];
  /** API 规范文件 */
  apiSpec?: string;
  /** 数据库 Schema */
  dbSchema?: string;
  /** 共享上下文 */
  sharedContext?: string;
}

/**
 * 执行规则
 */
export interface CoworkExecutionRules {
  /** 可并行执行的 Agent 组 */
  parallelGroups?: string[][];
  /** 依赖关系：key 依赖 values 完成后才能执行 */
  dependencies?: Record<string, string[]>;
  /** 失败策略 */
  failureStrategy?: 'fail-fast' | 'continue' | 'retry-then-continue';
  /** 最大并行数 */
  maxParallelism?: number;
}

/**
 * Cowork 合约定义
 *
 * 定义多 Agent 协作的规则和约定
 */
export interface CoworkContract {
  /** 合约 ID */
  id: string;
  /** 合约名称 */
  name: string;
  /** 合约描述 */
  description: string;

  /** 共享资源约定 */
  sharedResources?: CoworkSharedResources;

  /** Agent 角色分工 */
  agentRoles: CoworkAgentRole[];

  /** 执行规则 */
  executionRules: CoworkExecutionRules;

  /** 版本 */
  version?: string;
  /** 标签 */
  tags?: string[];
}

/**
 * Cowork 任务输入
 */
export interface CoworkTaskInput {
  /** 合约 ID 或自定义合约 */
  contract: string | CoworkContract;
  /** 任务描述 */
  taskDescription: string;
  /** 上下文信息 */
  context?: {
    /** 相关文件路径 */
    files?: string[];
    /** 额外上下文 */
    additionalContext?: string;
  };
  /** 覆盖配置 */
  overrides?: {
    /** 排除某些角色 */
    excludeRoles?: string[];
    /** 添加额外角色 */
    additionalRoles?: CoworkAgentRole[];
  };
}

/**
 * 单个 Agent 的执行结果
 */
export interface CoworkAgentResult {
  /** Agent 类型 */
  agentType: string;
  /** 是否成功 */
  success: boolean;
  /** 输出内容 */
  output: string;
  /** 错误信息 */
  error?: string;
  /** 执行时长（毫秒） */
  duration: number;
  /** 使用的工具 */
  toolsUsed: string[];
  /** 交付物 */
  deliverables?: Record<string, unknown>;
}

/**
 * Cowork 执行结果
 */
export interface CoworkResult {
  /** 合约 ID */
  contractId: string;
  /** 整体是否成功 */
  success: boolean;
  /** 各 Agent 的结果 */
  agentResults: CoworkAgentResult[];
  /** 聚合输出 */
  aggregatedOutput: string;
  /** 总时长（毫秒） */
  totalDuration: number;
  /** 最大并行度 */
  maxParallelism: number;
  /** 错误列表 */
  errors: Array<{ agentType: string; error: string }>;
}

/**
 * Cowork 模板 ID
 */
export type CoworkTemplateId =
  | 'code-review'
  | 'feature-development'
  | 'debugging'
  | 'refactoring'
  | 'documentation';

/**
 * 预定义 Cowork 模板
 */
export const COWORK_TEMPLATES: Record<CoworkTemplateId, CoworkContract> = {
  'code-review': {
    id: 'code-review',
    name: 'Code Review Cowork',
    description: '代码审查协作：reviewer + tester 并行审查',
    agentRoles: [
      {
        agentType: 'reviewer',
        responsibilities: ['代码质量检查', '命名规范', '代码风格', '潜在 bug'],
        deliverables: ['审查报告', '改进建议'],
      },
      {
        agentType: 'tester',
        responsibilities: ['测试覆盖检查', '边界情况分析', '测试建议'],
        deliverables: ['测试建议', '缺失测试用例'],
        required: false,
      },
    ],
    executionRules: {
      parallelGroups: [['reviewer', 'tester']],
      dependencies: {},
      failureStrategy: 'continue',
    },
    tags: ['review', 'quality'],
  },

  'feature-development': {
    id: 'feature-development',
    name: 'Feature Development Cowork',
    description: '功能开发协作：plan → coder → tester → reviewer',
    agentRoles: [
      {
        agentType: 'plan',
        responsibilities: ['需求分析', '实现方案设计', '任务分解'],
        deliverables: ['实现计划', '任务列表'],
      },
      {
        agentType: 'coder',
        responsibilities: ['代码实现', '单元测试'],
        deliverables: ['功能代码', '基础测试'],
      },
      {
        agentType: 'tester',
        responsibilities: ['测试用例编写', '集成测试'],
        deliverables: ['测试文件', '测试报告'],
      },
      {
        agentType: 'reviewer',
        responsibilities: ['代码审查', '最终确认'],
        deliverables: ['审查意见'],
      },
    ],
    executionRules: {
      parallelGroups: [],
      dependencies: {
        'coder': ['plan'],
        'tester': ['coder'],
        'reviewer': ['tester'],
      },
      failureStrategy: 'fail-fast',
    },
    tags: ['development', 'feature'],
  },

  'debugging': {
    id: 'debugging',
    name: 'Debugging Cowork',
    description: '调试协作：explorer → debugger → tester',
    agentRoles: [
      {
        agentType: 'code-explore',
        responsibilities: ['问题定位', '相关代码搜索', '错误日志分析'],
        deliverables: ['问题位置', '相关文件列表'],
      },
      {
        agentType: 'debugger',
        responsibilities: ['根因分析', '修复实现'],
        deliverables: ['修复代码', '修复说明'],
      },
      {
        agentType: 'tester',
        responsibilities: ['验证修复', '回归测试'],
        deliverables: ['测试结果'],
      },
    ],
    executionRules: {
      parallelGroups: [],
      dependencies: {
        'debugger': ['code-explore'],
        'tester': ['debugger'],
      },
      failureStrategy: 'fail-fast',
    },
    tags: ['debugging', 'bugfix'],
  },

  'refactoring': {
    id: 'refactoring',
    name: 'Refactoring Cowork',
    description: '重构协作：explorer → architect → coder → reviewer',
    agentRoles: [
      {
        agentType: 'code-explore',
        responsibilities: ['现有代码分析', '依赖关系梳理'],
        deliverables: ['代码结构分析', '依赖图'],
      },
      {
        agentType: 'architect',
        responsibilities: ['重构方案设计', '风险评估'],
        deliverables: ['重构计划', '风险列表'],
      },
      {
        agentType: 'coder',
        responsibilities: ['重构实现', '保持兼容性'],
        deliverables: ['重构代码'],
      },
      {
        agentType: 'reviewer',
        responsibilities: ['重构质量审查', '行为一致性验证'],
        deliverables: ['审查报告'],
      },
    ],
    executionRules: {
      parallelGroups: [],
      dependencies: {
        'architect': ['code-explore'],
        'coder': ['architect'],
        'reviewer': ['coder'],
      },
      failureStrategy: 'fail-fast',
    },
    tags: ['refactoring', 'improvement'],
  },

  'documentation': {
    id: 'documentation',
    name: 'Documentation Cowork',
    description: '文档协作：explorer + documenter 并行',
    agentRoles: [
      {
        agentType: 'code-explore',
        responsibilities: ['代码结构分析', '接口提取'],
        deliverables: ['代码摘要', '接口列表'],
      },
      {
        agentType: 'documenter',
        responsibilities: ['文档编写', '示例代码'],
        deliverables: ['文档文件'],
      },
    ],
    executionRules: {
      parallelGroups: [['code-explore']],
      dependencies: {
        'documenter': ['code-explore'],
      },
      failureStrategy: 'continue',
    },
    tags: ['documentation'],
  },
};

/**
 * 获取预定义 Cowork 模板
 */
export function getCoworkTemplate(templateId: CoworkTemplateId): CoworkContract | undefined {
  return COWORK_TEMPLATES[templateId];
}

/**
 * 列出所有 Cowork 模板
 */
export function listCoworkTemplates(): Array<{ id: string; name: string; description: string }> {
  return Object.values(COWORK_TEMPLATES).map(t => ({
    id: t.id,
    name: t.name,
    description: t.description,
  }));
}
