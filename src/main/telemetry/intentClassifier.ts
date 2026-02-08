// ============================================================================
// Intent Classifier - 规则意图分类 + 结果评判
// ============================================================================

import type {
  IntentClassification,
  OutcomeEvaluation,
  QualitySignals,
  UserIntentCategory,
} from '../../shared/types/telemetry';

// ----------------------------------------------------------------------------
// Intent Classification (Rule-based, Phase 1)
// ----------------------------------------------------------------------------

interface IntentRule {
  intent: UserIntentCategory;
  keywords: string[];
  toolHeuristics?: string[]; // tool names that strongly suggest this intent
  weight: number;
}

const INTENT_RULES: IntentRule[] = [
  {
    intent: 'code_generation',
    keywords: ['写', '创建', '实现', '生成', '新建', 'implement', 'create', 'write', 'generate', 'add'],
    toolHeuristics: ['write_file'],
    weight: 1.0,
  },
  {
    intent: 'bug_fix',
    keywords: ['修复', 'bug', '错误', '报错', 'fix', 'error', 'broken', 'issue', '问题', '崩溃'],
    toolHeuristics: ['edit_file'],
    weight: 1.0,
  },
  {
    intent: 'code_review',
    keywords: ['审查', '检查', 'review', 'check', '看看', '评审'],
    weight: 0.8,
  },
  {
    intent: 'explanation',
    keywords: ['解释', '什么是', '为什么', '怎么', 'explain', 'what', 'why', 'how', '原理', '含义'],
    weight: 0.9,
  },
  {
    intent: 'refactoring',
    keywords: ['重构', '优化', '简化', '整理', 'refactor', 'optimize', 'simplify', 'clean'],
    toolHeuristics: ['edit_file', 'read_file'],
    weight: 0.9,
  },
  {
    intent: 'search',
    keywords: ['查找', '搜索', '在哪', '哪里', 'find', 'search', 'where', 'locate', '定位'],
    toolHeuristics: ['grep', 'glob'],
    weight: 0.8,
  },
  {
    intent: 'file_operation',
    keywords: ['移动', '重命名', '删除', '复制', 'move', 'rename', 'delete', 'copy'],
    toolHeuristics: ['bash'],
    weight: 0.7,
  },
  {
    intent: 'testing',
    keywords: ['测试', '单元测试', '运行测试', 'test', 'spec', 'jest', 'vitest'],
    toolHeuristics: ['bash'],
    weight: 0.8,
  },
  {
    intent: 'documentation',
    keywords: ['文档', '注释', '说明', 'docs', 'document', 'readme', 'comment'],
    weight: 0.7,
  },
  {
    intent: 'configuration',
    keywords: ['配置', '设置', '安装', 'config', 'setup', 'install', 'env'],
    weight: 0.6,
  },
  {
    intent: 'research',
    keywords: ['调研', '研究', '对比', '方案', 'research', 'investigate', 'compare'],
    toolHeuristics: ['web_search', 'web_fetch'],
    weight: 0.8,
  },
  {
    intent: 'planning',
    keywords: ['规划', '设计', '架构', '方案', 'plan', 'design', 'architect'],
    weight: 0.7,
  },
  {
    intent: 'multi_step_task',
    keywords: ['步骤', '分步', '1.', '2.', '首先', '然后', 'step', 'first', 'then'],
    weight: 0.6,
  },
  {
    intent: 'conversation',
    keywords: ['你好', '谢谢', '感谢', 'hello', 'hi', 'thanks', 'thank'],
    weight: 0.5,
  },
];

export function classifyIntent(
  userPrompt: string,
  toolsUsed: string[] = []
): IntentClassification {
  const promptLower = userPrompt.toLowerCase();
  const scores = new Map<UserIntentCategory, { score: number; keywords: string[] }>();

  // Short conversation detection
  if (userPrompt.length < 20 && toolsUsed.length === 0) {
    const greetings = ['你好', '嗨', 'hi', 'hello', '谢谢', 'thanks'];
    if (greetings.some(g => promptLower.includes(g))) {
      return {
        primary: 'conversation',
        confidence: 0.9,
        method: 'rule',
        keywords: greetings.filter(g => promptLower.includes(g)),
      };
    }
  }

  // Score each intent
  for (const rule of INTENT_RULES) {
    let score = 0;
    const matchedKeywords: string[] = [];

    for (const kw of rule.keywords) {
      if (promptLower.includes(kw.toLowerCase())) {
        score += rule.weight;
        matchedKeywords.push(kw);
      }
    }

    // Tool heuristics bonus
    if (rule.toolHeuristics) {
      for (const tool of rule.toolHeuristics) {
        if (toolsUsed.includes(tool)) {
          score += 0.5;
          matchedKeywords.push(`[tool:${tool}]`);
        }
      }
    }

    if (score > 0) {
      scores.set(rule.intent, { score, keywords: matchedKeywords });
    }
  }

  // Multi-step detection from multiple tool types
  if (toolsUsed.length > 3) {
    const toolTypes = new Set(toolsUsed);
    if (toolTypes.size > 2) {
      const existing = scores.get('multi_step_task');
      scores.set('multi_step_task', {
        score: (existing?.score ?? 0) + 0.8,
        keywords: [...(existing?.keywords ?? []), '[multi-tool]'],
      });
    }
  }

  // Sort by score
  const sorted = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);

  if (sorted.length === 0) {
    return {
      primary: 'unknown',
      confidence: 0.3,
      method: 'rule',
      keywords: [],
    };
  }

  const [primary, primaryData] = sorted[0];
  const secondary = sorted.length > 1 ? sorted[1][0] : undefined;
  const maxPossible = Math.max(...INTENT_RULES.map(r => r.keywords.length * r.weight + (r.toolHeuristics?.length ?? 0) * 0.5));
  const confidence = Math.min(0.95, primaryData.score / Math.max(maxPossible * 0.3, 1));

  return {
    primary,
    secondary,
    confidence: Math.round(confidence * 100) / 100,
    method: 'rule',
    keywords: primaryData.keywords,
  };
}

// ----------------------------------------------------------------------------
// Outcome Evaluation (Rule-based, Phase 1)
// ----------------------------------------------------------------------------

export function evaluateOutcome(signals: QualitySignals): OutcomeEvaluation {
  const { toolSuccessRate, toolCallCount, errorCount, circuitBreakerTripped } = signals;

  // No tools used = pure conversation, unknown outcome
  if (toolCallCount === 0) {
    return {
      status: 'unknown',
      confidence: 0.5,
      method: 'rule',
      signals,
    };
  }

  // Circuit breaker = failure
  if (circuitBreakerTripped) {
    return {
      status: 'failure',
      confidence: 0.9,
      method: 'rule',
      signals,
    };
  }

  // All tools succeeded, no errors
  if (toolSuccessRate === 1 && errorCount === 0) {
    return {
      status: 'success',
      confidence: 0.85,
      method: 'rule',
      signals,
    };
  }

  // Most tools succeeded
  if (toolSuccessRate >= 0.5) {
    return {
      status: 'partial',
      confidence: 0.7,
      method: 'rule',
      signals,
    };
  }

  // Low success rate
  return {
    status: 'failure',
    confidence: 0.75,
    method: 'rule',
    signals,
  };
}
