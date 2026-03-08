// ============================================================================
// TaskAnalyzer - 任务分析器
// 深度分析用户请求，提取任务特征，为路由决策提供依据
// ============================================================================

import type {
  TaskAnalysis,
  TaskType,
  RequiredCapability,
  SensitivityLevel,
  ComplexityLevel,
  RealtimeRequirement,
} from './types';

// ============================================================================
// 关键词配置
// ============================================================================

const TASK_TYPE_KEYWORDS: Record<TaskType, RegExp[]> = {
  research: [
    /\b(search|find|lookup|research|investigate|explore|discover)\b/i,
    /\b(搜索|查找|研究|调研|探索|了解)\b/,
    /\b(what is|how to|why|when|where|who)\b/i,
    /\b(是什么|怎么|为什么|什么时候|哪里|谁)\b/,
  ],
  coding: [
    /\b(write|create|implement|build|develop|code|program)\b/i,
    /\b(fix|debug|refactor|optimize|improve|update|modify)\b/i,
    /\b(写|创建|实现|开发|编写|修复|重构|优化)\b/,
    /\b(function|class|method|variable|interface|type)\b/i,
    /\b(函数|类|方法|变量|接口|类型)\b/,
  ],
  automation: [
    /\b(automate|script|schedule|batch|run|execute)\b/i,
    /\b(自动化|脚本|定时|批量|运行|执行)\b/,
    /\b(workflow|pipeline|process|task)\b/i,
    /\b(工作流|流水线|流程|任务)\b/,
  ],
  data: [
    /\b(analyze|data|statistics|report|chart|graph|dashboard)\b/i,
    /\b(分析|数据|统计|报表|图表|仪表盘)\b/,
    /\b(csv|json|database|sql|query)\b/i,
    /\b(extract|transform|load|etl)\b/i,
  ],
  general: [],
};

const CAPABILITY_KEYWORDS: Record<RequiredCapability, RegExp[]> = {
  file_access: [
    /\b(file|read|write|edit|create|delete|save|load|open)\b/i,
    /\b(文件|读取|写入|编辑|创建|删除|保存|加载|打开)\b/,
    /\b(\.ts|\.js|\.py|\.json|\.md|\.txt|\.yaml|\.yml)\b/i,
    /\b(directory|folder|path)\b/i,
    /\b(目录|文件夹|路径)\b/,
  ],
  shell: [
    /\b(run|execute|command|terminal|shell|bash|npm|yarn|git|docker)\b/i,
    /\b(运行|执行|命令|终端)\b/,
    /\b(build|test|lint|compile|deploy)\b/i,
    /\b(构建|测试|编译|部署)\b/,
  ],
  network: [
    /\b(fetch|request|api|http|url|endpoint|web)\b/i,
    /\b(请求|接口|网络|网页)\b/,
    /\b(download|upload|sync)\b/i,
    /\b(下载|上传|同步)\b/,
  ],
  browser: [
    /\b(browser|chrome|firefox|selenium|puppeteer|playwright)\b/i,
    /\b(浏览器|截图|自动化)\b/,
    /\b(click|scroll|navigate|screenshot)\b/i,
    /\b(点击|滚动|导航|截图)\b/,
  ],
  memory: [
    /\b(remember|recall|memory|history|previous|context)\b/i,
    /\b(记住|回忆|记忆|历史|之前|上下文)\b/,
    /\b(similar|related|semantic|vector)\b/i,
  ],
  code_analysis: [
    /\b(analyze|review|explain|understand|trace)\b/i,
    /\b(分析|审查|解释|理解|追踪)\b/,
    /\b(architecture|design|pattern|structure)\b/i,
    /\b(架构|设计|模式|结构)\b/,
  ],
  planning: [
    /\b(plan|strategy|roadmap|outline|steps)\b/i,
    /\b(计划|策略|路线图|大纲|步骤)\b/,
    /\b(breakdown|decompose|organize)\b/i,
    /\b(分解|组织|安排)\b/,
  ],
};

const SENSITIVITY_KEYWORDS: Record<SensitivityLevel, RegExp[]> = {
  sensitive: [
    /\b(password|secret|token|credential|api[_-]?key|private[_-]?key)\b/i,
    /\b(密码|密钥|凭证|私钥)\b/,
    /\b(ssn|social security|credit card|bank account)\b/i,
    /\b(身份证|银行卡|信用卡)\b/,
    /\b(\.env|\.pem|\.key|credentials)\b/i,
  ],
  internal: [
    /\b(internal|private|confidential|proprietary)\b/i,
    /\b(内部|私有|机密|专有)\b/,
    /\b(company|organization|team|project)\b/i,
  ],
  public: [],
};

const COMPLEXITY_INDICATORS = {
  complex: {
    wordCountThreshold: 100,
    stepIndicators: [
      /\b(first|then|next|after|finally|step\s*\d+)\b/i,
      /\b(首先|然后|接着|最后|第\s*[一二三四五六七八九十\d]+\s*步)\b/,
    ],
    multiTaskIndicators: [
      /\b(and then|also|additionally|moreover)\b/i,
      /\b(并且|还要|另外|此外)\b/,
    ],
  },
  moderate: {
    wordCountThreshold: 30,
  },
};

const REALTIME_KEYWORDS: Record<RealtimeRequirement, RegExp[]> = {
  realtime: [
    /\b(now|immediately|instant|live|realtime|real-time)\b/i,
    /\b(现在|立即|即时|实时)\b/,
    /\b(watch|monitor|stream)\b/i,
    /\b(监控|观察|流式)\b/,
  ],
  async: [
    /\b(background|async|later|schedule|queue)\b/i,
    /\b(后台|异步|稍后|定时|队列)\b/,
  ],
  batch: [
    /\b(batch|bulk|all|every|multiple)\b/i,
    /\b(批量|全部|所有|多个)\b/,
  ],
};

// ============================================================================
// TaskAnalyzer 类
// ============================================================================

export class TaskAnalyzer {
  /**
   * 分析用户请求
   */
  analyze(prompt: string, context?: { fileTree?: string[]; currentFile?: string }): TaskAnalysis {
    const normalizedPrompt = this.normalizePrompt(prompt);
    const detectedKeywords: string[] = [];

    // 分析任务类型
    const taskType = this.detectTaskType(normalizedPrompt, detectedKeywords);

    // 分析所需能力
    const requiredCapabilities = this.detectCapabilities(normalizedPrompt, context, detectedKeywords);

    // 分析敏感度
    const sensitivityLevel = this.detectSensitivity(normalizedPrompt, detectedKeywords);

    // 分析复杂度
    const complexity = this.detectComplexity(normalizedPrompt);

    // 分析实时性要求
    const realtimeRequirement = this.detectRealtimeRequirement(normalizedPrompt, detectedKeywords);

    // 估算执行时间
    const estimatedDuration = this.estimateDuration(taskType, complexity, requiredCapabilities);

    // 计算置信度
    const confidence = this.calculateConfidence(detectedKeywords.length, normalizedPrompt.length);

    // 生成分析说明
    const reasoning = this.generateReasoning(
      taskType,
      requiredCapabilities,
      sensitivityLevel,
      complexity,
      realtimeRequirement
    );

    return {
      taskType,
      requiredCapabilities,
      sensitivityLevel,
      complexity,
      realtimeRequirement,
      estimatedDuration,
      confidence,
      detectedKeywords,
      reasoning,
    };
  }

  /**
   * 标准化 prompt
   */
  private normalizePrompt(prompt: string): string {
    return prompt.trim().toLowerCase();
  }

  /**
   * 检测任务类型
   */
  private detectTaskType(prompt: string, detectedKeywords: string[]): TaskType {
    const scores: Record<TaskType, number> = {
      research: 0,
      coding: 0,
      automation: 0,
      data: 0,
      general: 0,
    };

    for (const [type, patterns] of Object.entries(TASK_TYPE_KEYWORDS) as [TaskType, RegExp[]][]) {
      for (const pattern of patterns) {
        const matches = prompt.match(pattern);
        if (matches) {
          scores[type] += matches.length;
          detectedKeywords.push(...matches);
        }
      }
    }

    // 找出得分最高的类型
    let maxScore = 0;
    let detectedType: TaskType = 'general';

    for (const [type, score] of Object.entries(scores) as [TaskType, number][]) {
      if (score > maxScore) {
        maxScore = score;
        detectedType = type;
      }
    }

    return detectedType;
  }

  /**
   * 检测所需能力
   */
  private detectCapabilities(
    prompt: string,
    context: { fileTree?: string[]; currentFile?: string } | undefined,
    detectedKeywords: string[]
  ): RequiredCapability[] {
    const capabilities = new Set<RequiredCapability>();

    for (const [capability, patterns] of Object.entries(CAPABILITY_KEYWORDS) as [RequiredCapability, RegExp[]][]) {
      for (const pattern of patterns) {
        const matches = prompt.match(pattern);
        if (matches) {
          capabilities.add(capability);
          detectedKeywords.push(...matches);
        }
      }
    }

    // 基于上下文推断能力
    if (context?.currentFile) {
      capabilities.add('file_access');
    }

    if (context?.fileTree && context.fileTree.length > 0) {
      capabilities.add('file_access');
    }

    return Array.from(capabilities);
  }

  /**
   * 检测敏感度
   */
  private detectSensitivity(prompt: string, detectedKeywords: string[]): SensitivityLevel {
    // 先检查敏感级别
    for (const pattern of SENSITIVITY_KEYWORDS.sensitive) {
      const matches = prompt.match(pattern);
      if (matches) {
        detectedKeywords.push(...matches);
        return 'sensitive';
      }
    }

    // 再检查内部级别
    for (const pattern of SENSITIVITY_KEYWORDS.internal) {
      const matches = prompt.match(pattern);
      if (matches) {
        detectedKeywords.push(...matches);
        return 'internal';
      }
    }

    return 'public';
  }

  /**
   * 检测复杂度
   */
  private detectComplexity(prompt: string): ComplexityLevel {
    const wordCount = prompt.split(/\s+/).length;

    // 检查是否有步骤指示器
    const hasSteps = COMPLEXITY_INDICATORS.complex.stepIndicators.some((p) => p.test(prompt));

    // 检查是否有多任务指示器
    const hasMultiTask = COMPLEXITY_INDICATORS.complex.multiTaskIndicators.some((p) => p.test(prompt));

    if (wordCount > COMPLEXITY_INDICATORS.complex.wordCountThreshold || hasSteps || hasMultiTask) {
      return 'complex';
    }

    if (wordCount > COMPLEXITY_INDICATORS.moderate.wordCountThreshold) {
      return 'moderate';
    }

    return 'simple';
  }

  /**
   * 检测实时性要求
   */
  private detectRealtimeRequirement(prompt: string, detectedKeywords: string[]): RealtimeRequirement {
    // 检查实时
    for (const pattern of REALTIME_KEYWORDS.realtime) {
      const matches = prompt.match(pattern);
      if (matches) {
        detectedKeywords.push(...matches);
        return 'realtime';
      }
    }

    // 检查批量
    for (const pattern of REALTIME_KEYWORDS.batch) {
      const matches = prompt.match(pattern);
      if (matches) {
        detectedKeywords.push(...matches);
        return 'batch';
      }
    }

    // 检查异步
    for (const pattern of REALTIME_KEYWORDS.async) {
      const matches = prompt.match(pattern);
      if (matches) {
        detectedKeywords.push(...matches);
        return 'async';
      }
    }

    return 'async'; // 默认异步
  }

  /**
   * 估算执行时间
   */
  private estimateDuration(
    taskType: TaskType,
    complexity: ComplexityLevel,
    capabilities: RequiredCapability[]
  ): number {
    // 基础时间（毫秒）
    const baseDurations: Record<TaskType, number> = {
      research: 30000,
      coding: 45000,
      automation: 60000,
      data: 40000,
      general: 20000,
    };

    // 复杂度系数
    const complexityMultipliers: Record<ComplexityLevel, number> = {
      simple: 1,
      moderate: 2,
      complex: 4,
    };

    // 能力系数
    const capabilityMultipliers: Record<RequiredCapability, number> = {
      file_access: 1.2,
      shell: 1.5,
      network: 1.3,
      browser: 2.0,
      memory: 1.1,
      code_analysis: 1.4,
      planning: 1.3,
    };

    let duration = baseDurations[taskType];
    duration *= complexityMultipliers[complexity];

    for (const capability of capabilities) {
      duration *= capabilityMultipliers[capability];
    }

    return Math.round(duration);
  }

  /**
   * 计算置信度
   */
  private calculateConfidence(keywordCount: number, promptLength: number): number {
    // 基于关键词密度计算置信度
    if (promptLength === 0) return 0.5;

    const density = keywordCount / (promptLength / 100);
    const confidence = Math.min(0.95, 0.5 + density * 0.1);

    return Math.round(confidence * 100) / 100;
  }

  /**
   * 生成分析说明
   */
  private generateReasoning(
    taskType: TaskType,
    capabilities: RequiredCapability[],
    sensitivity: SensitivityLevel,
    complexity: ComplexityLevel,
    realtime: RealtimeRequirement
  ): string {
    const parts: string[] = [];

    parts.push(`任务类型: ${taskType}`);

    if (capabilities.length > 0) {
      parts.push(`需要能力: ${capabilities.join(', ')}`);
    }

    if (sensitivity !== 'public') {
      parts.push(`敏感级别: ${sensitivity}`);
    }

    parts.push(`复杂度: ${complexity}`);
    parts.push(`实时性: ${realtime}`);

    return parts.join('; ');
  }
}

// ============================================================================
// 单例实例
// ============================================================================

let analyzerInstance: TaskAnalyzer | null = null;

export function getTaskAnalyzer(): TaskAnalyzer {
  if (!analyzerInstance) {
    analyzerInstance = new TaskAnalyzer();
  }
  return analyzerInstance;
}
