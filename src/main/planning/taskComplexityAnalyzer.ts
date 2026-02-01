// ============================================================================
// TaskComplexityAnalyzer - 简化版：基于启发式规则判断任务复杂度
// ============================================================================
// 设计原则：不做硬编码的任务分类，让模型自己决策
// 只提供基础的复杂度提示，帮助模型理解任务规模

export type TaskComplexity = 'simple' | 'moderate' | 'complex';

export interface ComplexityAnalysis {
  complexity: TaskComplexity;
  confidence: number; // 0-1
  reasons: string[];
  suggestedApproach: string;
  targetFiles: string[]; // Files mentioned in the prompt that need to be modified
}

// ----------------------------------------------------------------------------
// 复杂度分析器（简化版）
// ----------------------------------------------------------------------------

export class TaskComplexityAnalyzer {
  /**
   * 从用户消息中提取目标文件路径
   * 用于后续验证是否所有文件都被修改
   */
  extractTargetFiles(userMessage: string): string[] {
    const files: string[] = [];

    // 匹配常见文件路径模式
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
   * 分析用户输入的任务复杂度（简化版）
   * 只使用简单的启发式规则，不做硬编码的任务分类
   */
  analyze(userMessage: string): ComplexityAnalysis {
    const reasons: string[] = [];
    const targetFiles = this.extractTargetFiles(userMessage);
    const lowerMsg = userMessage.toLowerCase();

    // 简单规则1: 文件数量
    const fileCount = targetFiles.length;

    // 简单规则2: 消息长度（字符数，对中英文都适用）
    const charCount = userMessage.length;

    // 简单规则3: 是否有多步骤指示词
    const stepIndicators = ['first', 'then', 'after', 'finally', 'next', '首先', '然后', '接着', '最后', '之后'];
    const stepCount = stepIndicators.filter(s => lowerMsg.includes(s)).length;

    // 简单规则4: 是否是审计/审查/分析类任务（这类任务通常需要委派子代理）
    const auditKeywords = ['审计', '审查', 'audit', 'review', '安全', 'security', '全面分析', '代码质量', 'code review'];
    const isAuditTask = auditKeywords.some(k => lowerMsg.includes(k));

    // 简单规则5: 是否有多维度描述（1. 2. 3. 或者 - - - 列表）
    const listPattern = /(?:^|\n)\s*(?:\d+[.、）)]|[-•*])\s+/g;
    const listMatches = userMessage.match(listPattern) || [];
    const hasList = listMatches.length >= 2;

    // 计算复杂度
    let complexity: TaskComplexity = 'simple';
    let confidence = 0.6;

    // 优先检测审计/审查类任务
    if (isAuditTask) {
      complexity = 'complex';
      reasons.push('审计/审查类任务');
      confidence = 0.85;
    } else if (fileCount >= 3 || stepCount >= 2 || charCount > 200 || hasList) {
      complexity = 'complex';
      if (fileCount >= 3) reasons.push(`涉及 ${fileCount} 个文件`);
      if (stepCount >= 2) reasons.push(`包含多步骤描述`);
      if (charCount > 200) reasons.push(`详细描述 (${charCount} 字符)`);
      if (hasList) reasons.push(`包含多项清单 (${listMatches.length} 项)`);
      confidence = 0.7;
    } else if (fileCount >= 2 || stepCount >= 1 || charCount > 50) {
      complexity = 'moderate';
      if (fileCount >= 2) reasons.push(`涉及 ${fileCount} 个文件`);
      if (charCount > 50) reasons.push(`中等描述 (${charCount} 字符)`);
      confidence = 0.6;
    } else {
      reasons.push('简短任务描述');
      confidence = 0.5;
    }

    return {
      complexity,
      confidence,
      reasons,
      suggestedApproach: this.getApproach(complexity),
      targetFiles,
    };
  }

  /**
   * 生成复杂度提示（简化版）
   * 不强制指定工具，让模型自己决策
   */
  generateComplexityHint(analysis: ComplexityAnalysis): string {
    const { complexity, reasons, targetFiles } = analysis;

    let hint = `<task-analysis>\n`;
    hint += `复杂度: ${complexity.toUpperCase()}\n`;

    if (reasons.length > 0) {
      hint += `原因: ${reasons.join(', ')}\n`;
    }

    if (targetFiles.length > 0) {
      hint += `目标文件: ${targetFiles.join(', ')}\n`;
    }

    // 只给建议，不强制
    if (complexity === 'complex') {
      hint += `\n建议: 考虑使用 task 工具委派子代理来处理复杂任务\n`;
    }

    hint += `</task-analysis>`;
    return hint;
  }

  private getApproach(complexity: TaskComplexity): string {
    switch (complexity) {
      case 'simple':
        return '直接执行';
      case 'moderate':
        return '分步执行，必要时使用子代理';
      case 'complex':
        return '建议委派子代理处理';
    }
  }
}

// 导出单例
export const taskComplexityAnalyzer = new TaskComplexityAnalyzer();
