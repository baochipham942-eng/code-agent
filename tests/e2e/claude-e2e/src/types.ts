/** 复杂度等级
 * L1: 简单单文件修改 (1-20 行)
 * L2: 中等单文件修改 (20-50 行)
 * L3: 复杂单文件或简单多文件 (50-100 行, 2-4 文件)
 * L4: 复杂多文件集成 (50-100 行, 4-6 文件)
 * L5: 大型功能模块 (100-200 行, 8-10 文件) - 参考 SWE-bench Pro
 * L6: 架构级别变更 (200+ 行, 12+ 文件) - 参考 ACE-Bench
 */
export type Complexity = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';

/** 测试场景分类 */
export type Category =
  | 'generation'
  | 'understanding'
  | 'debugging'
  | 'refactoring'
  | 'documentation'
  | 'git'
  | 'config'
  | 'multi-file'
  | 'edge-cases';

/** 验证类型 */
export type ValidationType =
  | 'file-exists'
  | 'file-contains'
  | 'file-structure'
  | 'compile-pass'
  | 'test-pass'
  | 'output-contains'
  | 'output-matches'
  | 'no-error'
  | 'custom';

/** 验证规则 */
export interface Validation {
  type: ValidationType;
  target?: string;
  /** AND 逻辑：所有字符串都必须出现 */
  contains?: string[];
  /** OR 逻辑：只要包含其中任意一个即可通过 */
  containsAny?: string[];
  notContains?: string[];
  /** 使用正则表达式匹配 (用于 file-contains, output-contains) */
  regex?: boolean;
  /** 大小写不敏感匹配 (用于 file-contains, output-contains) */
  ignoreCase?: boolean;
  /** 目录结构验证 (用于 file-structure) - 检查路径列表是否存在 */
  structure?: string[];
  custom?: (ctx: TestContext) => Promise<ValidationResult>;
  message?: string;
}

/** 工具调用记录 */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, any>;
  output?: string;
  duration: number;
  timestamp: number;
  error?: string;
}

/** Agent 调度记录 */
export interface AgentDispatch {
  id: string;
  agentType: string;
  prompt: string;
  parentAgentId?: string;
  toolCalls: ToolCall[];
  result?: string;
  duration: number;
  timestamp: number;
}

/** 完整执行轨迹 */
export interface ExecutionTrace {
  toolCalls: ToolCall[];
  agentDispatches: AgentDispatch[];
  totalApiCalls: number;
  totalToolCalls: number;
  totalAgentDispatches: number;
  timeline: (ToolCall | AgentDispatch)[];
}

/** 过程验证类型 */
export type ProcessValidationType =
  | 'tool-used'
  | 'tool-not-used'
  | 'tool-sequence'
  | 'tool-count-max'
  | 'tool-count-min'
  | 'agent-dispatched'
  | 'agent-not-dispatched'
  | 'agent-type'
  | 'no-redundant-reads'
  | 'no-blind-edit'
  | 'error-recovery'
  | 'efficient-path'
  | 'custom-process';

/** 过程验证规则 */
export interface ProcessValidation {
  type: ProcessValidationType;
  tool?: string | string[];
  sequence?: string[];
  count?: number;
  toolFilter?: string;
  agentType?: string | string[];
  efficiency?: {
    maxToolCalls?: number;
    maxAgentDispatches?: number;
    maxDuration?: number;
    maxRedundantOps?: number;
  };
  custom?: (trace: ExecutionTrace, ctx: TestContext) => Promise<ProcessValidationResult>;
  message?: string;
}

/** 过程验证结果 */
export interface ProcessValidationResult {
  passed: boolean;
  validation: ProcessValidation;
  message?: string;
  details?: {
    actualToolCalls?: string[];
    actualSequence?: string[];
    redundantOps?: string[];
    inefficiencies?: string[];
  };
}

/** 测试用例定义 */
export interface TestCase {
  id: string;
  name: string;
  category: Category;
  complexity: Complexity;

  // 输入
  prompt: string;
  fixture?: string;
  setupCommands?: string[];

  // Claude CLI 配置
  cliOptions?: {
    model?: string;
    allowedTools?: string[];
    timeout?: number;
    /** 启用规划模式（复杂任务自动分解） */
    plan?: boolean;
  };

  // 结果验证
  validations: Validation[];

  // 过程验证
  processValidations?: ProcessValidation[];

  // 预期执行模式（快捷方式）
  expectedBehavior?: {
    directExecution?: boolean;
    expectedAgents?: string[];
    requiredTools?: string[];
    forbiddenTools?: string[];
    toolCallRange?: { min?: number; max?: number };
    toolPattern?: string;
  };

  // 元数据
  tags?: string[];
  skip?: boolean;
  timeout?: number;
  /** 失败后重试次数（用于处理模型行为的随机性） */
  retries?: number;
  /** 启用 nudge 机制：检测未创建的文件和未完成的修改，提示模型完成 */
  nudgeOnMissingFile?: boolean;
  /** 启用步骤分解执行：将多步骤任务拆成独立调用，逐步验证 */
  stepByStepExecution?: boolean;
  /** 分解后的步骤定义（可选，不提供则自动从 prompt 解析） */
  steps?: {
    instruction: string;
    validation?: Validation;
  }[];
}

/** 测试执行上下文 */
export interface TestContext {
  testCase: TestCase;
  workDir: string;
  startTime: number;
  output: string;
  exitCode: number;
  files: Map<string, string>;
}

/** 验证结果 */
export interface ValidationResult {
  passed: boolean;
  validation: Validation;
  message?: string;
  details?: any;
}

/** 测试结果 */
export interface TestResult {
  testCase: TestCase;
  status: 'passed' | 'failed' | 'skipped' | 'timeout' | 'error';
  validations: ValidationResult[];
  processValidations?: ProcessValidationResult[];
  trace?: ExecutionTrace;

  // 性能指标
  metrics: {
    duration: number;
    tokensIn?: number;
    tokensOut?: number;
    toolCalls?: number;
    apiCalls?: number;
  };

  // 调试信息
  output: string;
  error?: string;
  workDir?: string;
}

/** 测试套件报告 */
export interface TestReport {
  timestamp: string;
  duration: number;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    timeout: number;
    error: number;
  };
  byCategory: Record<Category, { passed: number; total: number }>;
  byComplexity: Record<Complexity, { passed: number; total: number }>;
  results: TestResult[];
}
