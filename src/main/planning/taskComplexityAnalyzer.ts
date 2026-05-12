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

const DESKTOP_MEETING_CONTEXT_RE =
  /腾讯会议|tencent\s*meeting|当前会议|会议内容|正在(?:开的|进行的)?会议|meeting\s+(?:content|notes?|transcript)|current\s+meeting/i;

const MEETING_NOTE_ACTION_RE =
  /记录|记下|整理|总结|纪要|转写|录入|note|notes|record|capture|transcribe|summari[sz]e/i;

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
    // 注意：避免过宽泛的匹配（如"安全"可能只是描述安全要求，不是审计任务）
    // 只匹配明确的审计动作词，不匹配一般性安全描述
    const auditKeywords = ['审计', '审查', '安全检查', '漏洞扫描', '安全分析', '代码质量检查', 'audit', 'code review', 'security audit'];
    const isAuditTask = auditKeywords.some(k => lowerMsg.includes(k));

    // 简单规则5: 是否有多维度描述（1. 2. 3. 或者 - - - 列表）
    const listPattern = /(?:^|\n)\s*(?:\d+[.、）)]|[-•*])\s+/g;
    const listMatches = userMessage.match(listPattern) || [];
    const hasList = listMatches.length >= 2;

    // 简单规则6: 长内容产出约束（中文写作/小说/报告类任务,输入很短但输出预期很长）
    // 上面的 charCount 看的是"输入长度",对"写3000字小说,分6段,慢慢写"这种短输入
    // 长输出的请求会判 simple/fastPath,导致 agent 一把梭直接交差。这里识别输出约束
    // 关键词,任意一个命中就升级为 complex,让 planning 走多步分解。
    const longOutputCountPattern = /(\d{2,})\s*(?:字|words?)/i;
    const partitionPattern = /分\s*[\d一二三四五六七八九十]+\s*(?:段|个段|部分|章节|章|节|步)/;
    const outputStyleKeywords = ['慢慢写', '详细展开', '循序渐进', '事无巨细', '逐步展开', '逐段', '一段一段'];
    const longOutputMatch = userMessage.match(longOutputCountPattern);
    const requestsLongOutput = longOutputMatch ? Number(longOutputMatch[1]) >= 500 : false;
    const requestsPartition = partitionPattern.test(userMessage);
    const requestsDetailedStyle = outputStyleKeywords.some(k => userMessage.includes(k));
    const hasOutputConstraint = requestsLongOutput || requestsPartition || requestsDetailedStyle;
    const isDesktopMeetingCaptureTask =
      DESKTOP_MEETING_CONTEXT_RE.test(userMessage) && MEETING_NOTE_ACTION_RE.test(userMessage);

    // 计算复杂度
    let complexity: TaskComplexity = 'simple';
    let confidence = 0.6;

    // 优先检测审计/审查类任务
    if (isAuditTask) {
      complexity = 'complex';
      reasons.push('审计/审查类任务');
      confidence = 0.85;
    } else if (fileCount >= 3 || stepCount >= 2 || charCount > 200 || hasList || hasOutputConstraint) {
      complexity = 'complex';
      if (isDesktopMeetingCaptureTask) reasons.push(`桌面会议记录任务需要读取当前会议上下文`);
      if (fileCount >= 3) reasons.push(`涉及 ${fileCount} 个文件`);
      if (stepCount >= 2) reasons.push(`包含多步骤描述`);
      if (charCount > 200) reasons.push(`详细描述 (${charCount} 字符)`);
      if (hasList) reasons.push(`包含多项清单 (${listMatches.length} 项)`);
      if (requestsLongOutput && longOutputMatch) reasons.push(`要求长内容产出 (${longOutputMatch[0]})`);
      if (requestsPartition) reasons.push(`要求分段/分部分产出`);
      if (requestsDetailedStyle) reasons.push(`要求详细/慢节奏写作`);
      confidence = 0.7;
    } else if (isDesktopMeetingCaptureTask || fileCount >= 2 || stepCount >= 1 || charCount > 50) {
      complexity = 'moderate';
      if (isDesktopMeetingCaptureTask) reasons.push(`桌面会议记录任务需要读取当前会议上下文`);
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
