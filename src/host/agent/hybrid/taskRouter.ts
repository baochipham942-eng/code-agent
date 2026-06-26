// ============================================================================
// Task Analyzer - 任务分析器（混合架构遗留）
// ============================================================================
//
// 历史背景：
// 本文件曾承载完整的 TaskRouter 类（核心/动态/Swarm 三档路由），但 Wave 2
// 清理（cleanup/wave2-hybrid）确认 TaskRouter / getTaskRouter / routeTask /
// RoutingDecision 体系全部 0 外部消费者，连带 dynamicFactory.ts 和
// crossVerify.ts 一同删除。当前仅保留外部仍在用的 `analyzeTask` 函数及其
// 内部依赖，被 `agentLoop.ts` 与 `agentOrchestrator.ts` 用作任务类型嗅探
// （主要看 analysis.taskType 是否命中 'research'）。
// ============================================================================

// ============================================================================
// Internal Types
// ============================================================================

/**
 * 任务复杂度
 */
type TaskComplexity = 'simple' | 'moderate' | 'complex';

/**
 * 任务分析结果
 */
export interface TaskAnalysis {
  /** 任务复杂度 */
  complexity: TaskComplexity;
  /** 推荐的任务类型 */
  taskType: string;
  /** 涉及的文件操作 */
  involvesFiles: boolean;
  /** 涉及网络操作 */
  involvesNetwork: boolean;
  /** 涉及命令执行 */
  involvesExecution: boolean;
  /** 预估步骤数 */
  estimatedSteps: number;
  /** 可并行子任务数 */
  parallelism: number;
  /** 需要的专业能力 */
  specializations: string[];
  /** 分析置信度 */
  confidence: number;
}

// ============================================================================
// Task Analysis
// ============================================================================

/**
 * 复杂度指标
 */
const COMPLEXITY_INDICATORS = {
  simple: [
    /\b(find|search|list|show|get|what is|读取|查找|列出|显示)\b/i,
  ],
  complex: [
    /\b(refactor|redesign|architect|comprehensive|detailed|complete|全面|重构|设计|详细|完整)\b/i,
    /\b(analyze.*and.*implement|分析.*并.*实现)\b/i,
    /\b(multiple files|多个文件)\b/i,
  ],
};

/**
 * 专业化指标
 */
const SPECIALIZATION_INDICATORS: Record<string, RegExp[]> = {
  'database': [/\b(database|sql|schema|migration|postgresql|mysql|sqlite)\b/i],
  'frontend': [/\b(react|vue|css|ui|component|frontend|前端)\b/i],
  'backend': [/\b(api|server|backend|service|后端|接口)\b/i],
  'devops': [/\b(deploy|ci|cd|docker|kubernetes|部署|容器)\b/i],
  'security': [/\b(security|auth|permission|vulnerability|安全|权限)\b/i],
  'performance': [/\b(performance|optimize|speed|latency|性能|优化)\b/i],
};

/**
 * 分析任务
 */
export function analyzeTask(task: string): TaskAnalysis {
  // 检测复杂度
  let complexity: TaskComplexity = 'moderate';

  for (const pattern of COMPLEXITY_INDICATORS.simple) {
    if (pattern.test(task) && task.length < 100) {
      complexity = 'simple';
      break;
    }
  }

  for (const pattern of COMPLEXITY_INDICATORS.complex) {
    if (pattern.test(task)) {
      complexity = 'complex';
      break;
    }
  }

  // 长任务描述通常更复杂
  if (task.length > 500) {
    complexity = 'complex';
  }

  // 多个编号列表
  const numberedItems = (task.match(/\d+\./g) || []).length;
  if (numberedItems >= 3) {
    complexity = 'complex';
  }

  // 检测涉及的操作
  const involvesFiles = /\b(file|read|write|edit|create|modify|文件|读取|写入|修改)\b/i.test(task);
  const involvesNetwork = /\b(http|api|fetch|url|web|network|网络|接口)\b/i.test(task);
  const involvesExecution = /\b(run|execute|test|build|命令|执行|测试|构建)\b/i.test(task);

  // 检测专业化需求
  const specializations: string[] = [];
  for (const [spec, patterns] of Object.entries(SPECIALIZATION_INDICATORS)) {
    for (const pattern of patterns) {
      if (pattern.test(task)) {
        specializations.push(spec);
        break;
      }
    }
  }

  // 估算步骤数
  let estimatedSteps = 5;
  if (complexity === 'simple') estimatedSteps = 3;
  if (complexity === 'complex') estimatedSteps = 15;
  if (numberedItems > 0) estimatedSteps = Math.max(estimatedSteps, numberedItems * 3);

  // 估算并行度
  let parallelism = 1;
  if (specializations.length > 1) parallelism = specializations.length;
  if (/\b(parallel|concurrent|同时|并行)\b/i.test(task)) parallelism = Math.max(parallelism, 3);
  if (/(\d+)\s*(个|份|批)/.test(task)) {
    const match = task.match(/(\d+)\s*(个|份|批)/);
    if (match && parseInt(match[1]) > 5) {
      parallelism = Math.min(Math.ceil(parseInt(match[1]) / 10), 10);
    }
  }

  // 推断任务类型（默认 'unknown' 表示无正则命中，允许 LLM 分类 fallback）
  let taskType = 'unknown';
  if (/\b(review|审查|检查)\b/i.test(task)) taskType = 'review';
  if (/深度搜索|深入研究|深入调研|全面分析|深度调研|深入搜索|深度分析|研究报告|详细调研|对比.*选型|选型.*对比|趋势.*分析|deep\s*research|comprehensive\s*research|in-depth\s*(analysis|research|study)|thorough\s*research/i.test(task)) taskType = 'research';
  else if (/\b(search|find|explore|查找|搜索|探索)\b/i.test(task)) taskType = 'search';
  if (/\b(plan|design|规划|设计)\b/i.test(task)) taskType = 'plan';
  if (/\b(test|测试)\b/i.test(task)) taskType = 'test';
  if (/\b(excel|xlsx|csv|数据|分析|清洗|透视|聚合|统计|dataframe|pandas)\b/i.test(task)) taskType = 'data';
  if (/\b(ppt|pptx|幻灯片|演示|slide|presentation)\b/i.test(task)) taskType = 'ppt';
  if (/\b(文章|报告|文档|撰写|write.*article|write.*report|write.*document)\b/i.test(task)) taskType = 'document';
  if (/\b(生成.*图|画.*图|image|draw|generate.*image|生图|插图)\b/i.test(task)) taskType = 'image';
  if (/\b(生成.*视频|做.*视频|制作.*视频|视频生成|video|generate.*video|短视频|动画)\b/i.test(task)) taskType = 'video';
  // 编程任务显式匹配（原默认值 'code' 已改为 'unknown'，需显式捕获）
  if (taskType === 'unknown' && (
    /实现|写.*代码|写.*函数|写.*方法|修复|重构|编码|开发.*功能|创建.*组件/i.test(task) ||
    /\b(refactor|implement|fix.*bug|write.*code|write.*function|add.*feature|debug|create.*component)\b/i.test(task)
  )) taskType = 'code';

  // 计算置信度
  let confidence = 0.5;
  if (complexity !== 'moderate') confidence += 0.1;
  if (specializations.length > 0) confidence += 0.1;
  if (task.length > 50) confidence += 0.1;

  return {
    complexity,
    taskType,
    involvesFiles,
    involvesNetwork,
    involvesExecution,
    estimatedSteps,
    parallelism,
    specializations,
    confidence: Math.min(confidence, 1),
  };
}
