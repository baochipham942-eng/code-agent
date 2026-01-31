// ============================================================================
// TaskComplexityAnalyzer - 自动检测任务复杂度，确保复杂任务得到正确规划
// ============================================================================

export type TaskComplexity = 'simple' | 'moderate' | 'complex';

export interface ComplexityAnalysis {
  complexity: TaskComplexity;
  confidence: number; // 0-1
  reasons: string[];
  suggestedApproach: string;
  targetFiles: string[]; // Files mentioned in the prompt that need to be modified
}

// ----------------------------------------------------------------------------
// 复杂度指标关键词
// ----------------------------------------------------------------------------

// 简单任务关键词 - 单一、明确、创建类
const SIMPLE_KEYWORDS = [
  // 创建单个文件
  'create a', 'make a', 'write a', 'build a', 'generate a',
  '创建一个', '写一个', '做一个', '生成一个', '生成',
  // 简单游戏/页面
  'snake game', 'todo app', 'calculator', 'hello world',
  '贪吃蛇', '计算器', '待办事项',
  // 单文件操作
  'single file', 'one file', 'simple',
  '单个文件', '简单的',
  // 文档/数据文件生成
  'excel', 'spreadsheet', 'csv', 'json file', 'pdf', 'document',
  '表格', '文档', '数据文件',
  // 快速任务指示词
  'quickly', 'quick', 'fast', 'just',
  '快速', '快', '直接',
];

// 复杂任务关键词 - 系统性、重构、多文件
const COMPLEX_KEYWORDS = [
  // 系统性任务
  'refactor', 'migrate', 'upgrade', 'architecture',
  '重构', '迁移', '升级', '架构',
  // 多组件
  'system', 'framework', 'across', 'all files',
  '系统', '框架', '跨', '所有文件',
  // 分析任务
  'analyze', 'audit', 'review', 'investigate',
  '分析', '审计', '审查', '调查',
  // 集成任务
  'integrate', 'connect', 'sync', 'authentication',
  '集成', '连接', '同步', '认证',
  // 测试任务
  'test coverage', 'unit tests', 'e2e tests',
  '测试覆盖', '单元测试', '端到端测试',
];

// 中等复杂度关键词
const MODERATE_KEYWORDS = [
  'add feature', 'implement', 'fix bug', 'update',
  '添加功能', '实现', '修复', '更新',
  'component', 'module', 'api endpoint',
  '组件', '模块', 'API 端点',
  // 调试任务
  'debug', 'fix', 'race condition', 'async', 'error handling',
  '调试', '竞态', '异步', '错误处理',
  // 编辑任务
  'edit_file', 'modify', 'change',
  '修改', '改',
];

// ----------------------------------------------------------------------------
// 复杂度分析器
// ----------------------------------------------------------------------------

export class TaskComplexityAnalyzer {
  /**
   * 从用户消息中提取目标文件路径
   * 用于后续验证是否所有文件都被修改
   */
  extractTargetFiles(userMessage: string): string[] {
    const files: string[] = [];

    // 匹配常见文件路径模式: src/xxx/yyy.ts 格式
    const pathPattern = /(?:^|\s|["'`])((?:src|lib|app|pages|components|api|store|hooks|utils|services|prisma)\/[\w\-./]+\.(?:ts|tsx|js|jsx|json|prisma|md))/gi;
    let match;
    while ((match = pathPattern.exec(userMessage)) !== null) {
      const filePath = match[1].trim();
      if (!files.includes(filePath)) {
        files.push(filePath);
      }
    }

    // 匹配带引号的文件名
    const quotedPattern = /["'`]([\w\-./]+\.(?:ts|tsx|js|jsx|json|prisma|md))["'`]/gi;
    while ((match = quotedPattern.exec(userMessage)) !== null) {
      const filePath = match[1].trim();
      if (!files.includes(filePath)) {
        files.push(filePath);
      }
    }

    return files;
  }

  /**
   * 分析用户输入的任务复杂度
   */
  analyze(userMessage: string): ComplexityAnalysis {
    const lowerMessage = userMessage.toLowerCase();
    const reasons: string[] = [];
    let simpleScore = 0;
    let complexScore = 0;
    let moderateScore = 0;

    // 提取目标文件
    const targetFiles = this.extractTargetFiles(userMessage);

    // 多文件任务自动提升复杂度
    if (targetFiles.length >= 3) {
      complexScore += 3;
      reasons.push(`涉及 ${targetFiles.length} 个目标文件`);
    } else if (targetFiles.length >= 2) {
      moderateScore += 2;
      reasons.push(`涉及 ${targetFiles.length} 个目标文件`);
    }

    // 检查数字+文件的模式，如 "5个文件"、"修改以下5个文件"
    const numFilesPattern = /(\d+)\s*(?:个|files?|份)/i;
    const numMatch = lowerMessage.match(numFilesPattern);
    if (numMatch) {
      const numFiles = parseInt(numMatch[1], 10);
      if (numFiles >= 3) {
        complexScore += 3;
        reasons.push(`明确提到 ${numFiles} 个文件`);
      } else if (numFiles >= 2) {
        moderateScore += 2;
        reasons.push(`明确提到 ${numFiles} 个文件`);
      }
    }

    // 检查简单任务关键词
    for (const keyword of SIMPLE_KEYWORDS) {
      if (lowerMessage.includes(keyword.toLowerCase())) {
        simpleScore += 2;
        reasons.push(`包含简单任务关键词: "${keyword}"`);
      }
    }

    // 检查复杂任务关键词
    for (const keyword of COMPLEX_KEYWORDS) {
      if (lowerMessage.includes(keyword.toLowerCase())) {
        complexScore += 2;
        reasons.push(`包含复杂任务关键词: "${keyword}"`);
      }
    }

    // 检查中等复杂度关键词
    for (const keyword of MODERATE_KEYWORDS) {
      if (lowerMessage.includes(keyword.toLowerCase())) {
        moderateScore += 1;
        reasons.push(`包含中等复杂度关键词: "${keyword}"`);
      }
    }

    // 消息长度分析
    const wordCount = userMessage.split(/\s+/).length;
    if (wordCount < 10) {
      simpleScore += 1;
      reasons.push(`消息较短 (${wordCount} 词)`);
    } else if (wordCount > 50) {
      complexScore += 1;
      reasons.push(`消息较长 (${wordCount} 词)`);
    }

    // 是否包含多个步骤描述
    const stepIndicators = ['first', 'then', 'after', 'finally', '首先', '然后', '接着', '最后'];
    const stepCount = stepIndicators.filter((s) => lowerMessage.includes(s)).length;
    if (stepCount >= 2) {
      complexScore += stepCount;
      reasons.push(`包含多步骤描述 (${stepCount} 个步骤指示词)`);
    }

    // 是否提到多个文件/组件
    const fileIndicators = ['files', 'components', 'modules', 'pages', '文件', '组件', '模块', '页面'];
    const multipleFilesCount = fileIndicators.filter((f) => lowerMessage.includes(f)).length;
    if (multipleFilesCount > 0) {
      complexScore += multipleFilesCount;
      reasons.push(`可能涉及多个文件 (${multipleFilesCount} 个多文件指示词)`);
    }

    // 计算最终复杂度
    const totalScore = simpleScore + moderateScore + complexScore;
    let complexity: TaskComplexity;
    let confidence: number;
    let suggestedApproach: string;

    if (complexScore > simpleScore && complexScore > moderateScore) {
      complexity = 'complex';
      confidence = Math.min(0.9, complexScore / (totalScore || 1));
      suggestedApproach = this.getComplexApproach();
    } else if (simpleScore > complexScore && simpleScore >= moderateScore) {
      complexity = 'simple';
      confidence = Math.min(0.9, simpleScore / (totalScore || 1));
      suggestedApproach = this.getSimpleApproach();
    } else {
      complexity = 'moderate';
      confidence = Math.min(0.8, moderateScore / (totalScore || 1));
      suggestedApproach = this.getModerateApproach();
    }

    // 默认情况（无明显指标）
    if (reasons.length === 0) {
      reasons.push('未检测到明显的复杂度指标');
      complexity = 'simple'; // 默认当作简单任务
      confidence = 0.5;
      suggestedApproach = this.getSimpleApproach();
    }

    return { complexity, confidence, reasons, suggestedApproach, targetFiles };
  }

  /**
   * 生成复杂度提示，注入到 AI 上下文
   */
  generateComplexityHint(analysis: ComplexityAnalysis): string {
    const { complexity, confidence, suggestedApproach } = analysis;
    const confidencePercent = Math.round(confidence * 100);

    return (
      `<task-complexity-analysis>\n` +
      `Detected complexity: ${complexity.toUpperCase()} (${confidencePercent}% confidence)\n\n` +
      `${suggestedApproach}\n` +
      `</task-complexity-analysis>`
    );
  }

  // --------------------------------------------------------------------------
  // 建议方法
  // --------------------------------------------------------------------------

  private getSimpleApproach(): string {
    return (
      `RECOMMENDED APPROACH for SIMPLE task:\n` +
      `1. Do NOT create a plan - just execute directly\n` +
      `2. Use write_file immediately to create the requested content\n` +
      `3. Skip todo_write entirely\n` +
      `4. Maximum 2 read operations before writing\n` +
      `5. Complete in 1-3 tool calls total`
    );
  }

  private getModerateApproach(): string {
    return (
      `RECOMMENDED APPROACH for MODERATE task:\n` +
      `1. Create a brief plan with 3-5 items using todo_write\n` +
      `2. Start executing immediately after planning\n` +
      `3. Focus on the core requirement first\n` +
      `4. Maximum 5 read operations before writing\n` +
      `5. Complete in 5-10 tool calls total`
    );
  }

  private getComplexApproach(): string {
    return (
      `RECOMMENDED APPROACH for COMPLEX task:\n` +
      `1. Use todo_write to create a comprehensive plan (5-10 items)\n` +
      `2. Break down into phases: Analysis → Design → Implementation → Verification\n` +
      `3. Read necessary files to understand the system first\n` +
      `4. Execute one phase at a time, updating todo status as you go\n` +
      `5. Ask user for clarification if requirements are ambiguous\n` +
      `6. Expected: 10-30+ tool calls`
    );
  }
}

// 导出单例
export const taskComplexityAnalyzer = new TaskComplexityAnalyzer();
