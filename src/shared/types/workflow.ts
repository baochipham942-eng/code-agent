// ============================================================================
// Workflow Types - Type-safe definitions for Gen7 multi-agent workflows
// ============================================================================

import type { BuiltInAgentRole } from './builtInAgents';

// ============================================================================
// Core Types
// ============================================================================

/**
 * 工作流阶段定义
 */
export interface WorkflowStage {
  /** 阶段名称（用于依赖引用和日志） */
  name: string;
  /** 执行该阶段的 Agent 角色（built-in 或 predefined） */
  role: string;
  /** 该阶段的任务提示词 */
  prompt: string;
  /** 依赖的前置阶段名称列表 */
  dependsOn?: string[];
}

/**
 * 工作流模板定义
 */
export interface WorkflowTemplate {
  /** 模板显示名称 */
  name: string;
  /** 模板描述 */
  description: string;
  /** 阶段列表 */
  stages: WorkflowStage[];
  /** 标签（用于分类和搜索） */
  tags?: string[];
}

/**
 * 内置工作流模板 ID
 */
export type BuiltInWorkflowId =
  | 'code-review-pipeline'
  | 'bug-fix-flow'
  | 'documentation-flow'
  | 'parallel-review'
  | 'image-annotation'
  | 'image-ocr-annotate';

// ============================================================================
// Stage Execution Types
// ============================================================================

/**
 * 阶段上下文 - 用于在阶段之间传递结构化数据
 */
export interface StageContext {
  /** 文本输出 */
  textOutput: string;
  /** 结构化数据（从输出中解析的 JSON） */
  structuredData?: Record<string, unknown>;
  /** 生成的文件 */
  generatedFiles?: GeneratedFile[];
  /** 工具调用记录 */
  toolsUsed: string[];
  /** 执行时间（毫秒） */
  duration: number;
}

/**
 * 生成的文件信息
 */
export interface GeneratedFile {
  /** 文件路径 */
  path: string;
  /** 文件类型 */
  type: 'image' | 'text' | 'data';
}

/**
 * 阶段执行结果
 */
export interface StageResult {
  /** 阶段名称 */
  stage: string;
  /** 执行的 Agent 角色 */
  role: string;
  /** 是否成功 */
  success: boolean;
  /** 输出内容 */
  output: string;
  /** 错误信息 */
  error?: string;
  /** 执行时间（毫秒） */
  duration: number;
  /** 结构化上下文 */
  context?: StageContext;
}

// ============================================================================
// Workflow Execution Types
// ============================================================================

/**
 * 工作流执行状态
 */
export type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * 工作流执行记录
 */
export interface WorkflowExecution {
  /** 执行 ID */
  id: string;
  /** 工作流模板 ID */
  workflowId: string;
  /** 工作流名称 */
  workflowName: string;
  /** 任务描述 */
  task: string;
  /** 执行状态 */
  status: WorkflowStatus;
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime?: number;
  /** 各阶段结果 */
  stageResults: StageResult[];
  /** 总耗时（毫秒） */
  totalDuration?: number;
  /** 错误信息 */
  error?: string;
}

/**
 * 工作流执行选项
 */
export interface WorkflowExecutionOptions {
  /** 是否并行执行独立阶段（默认 true） */
  parallel?: boolean;
  /** 单阶段最大迭代次数 */
  maxIterationsPerStage?: number;
  /** 工作流总预算（USD） */
  maxBudget?: number;
}

// ============================================================================
// Built-in Workflow Templates
// ============================================================================

/**
 * 内置工作流模板常量
 * 可通过 workflow_orchestrate 工具的 workflow 参数直接引用
 */
export const BUILT_IN_WORKFLOWS: Record<BuiltInWorkflowId, WorkflowTemplate> = {
  'code-review-pipeline': {
    name: 'Code Review Pipeline',
    description: 'Coder -> Reviewer -> Tester flow for feature development',
    tags: ['code', 'review', 'testing'],
    stages: [
      {
        name: 'Development',
        role: 'coder',
        prompt: 'Implement the feature as specified.',
      },
      {
        name: 'Review',
        role: 'reviewer',
        prompt: 'Review the code written in the previous stage. List issues found.',
        dependsOn: ['Development'],
      },
      {
        name: 'Testing',
        role: 'tester',
        prompt: 'Write tests for the implemented feature.',
        dependsOn: ['Development'],
      },
    ],
  },

  'bug-fix-flow': {
    name: 'Bug Fix Flow',
    description: 'Debugger -> Coder -> Tester flow for bug fixes',
    tags: ['debugging', 'code', 'testing'],
    stages: [
      {
        name: 'Investigation',
        role: 'debugger',
        prompt: 'Investigate the bug and identify the root cause.',
      },
      {
        name: 'Fix',
        role: 'coder',
        prompt: 'Implement the fix based on the investigation results.',
        dependsOn: ['Investigation'],
      },
      {
        name: 'Verification',
        role: 'tester',
        prompt: 'Write tests to verify the fix and prevent regression.',
        dependsOn: ['Fix'],
      },
    ],
  },

  'documentation-flow': {
    name: 'Documentation Flow',
    description: 'Architect -> Documenter flow for documentation',
    tags: ['documentation', 'architecture'],
    stages: [
      {
        name: 'Architecture Analysis',
        role: 'architect',
        prompt: 'Analyze the system architecture and key components.',
      },
      {
        name: 'Documentation',
        role: 'documenter',
        prompt: 'Write comprehensive documentation based on the architecture analysis.',
        dependsOn: ['Architecture Analysis'],
      },
    ],
  },

  'parallel-review': {
    name: 'Parallel Review',
    description: 'Run reviewer and tester in parallel',
    tags: ['code', 'review', 'testing', 'parallel'],
    stages: [
      {
        name: 'Code Review',
        role: 'reviewer',
        prompt: 'Review the code for quality and issues.',
      },
      {
        name: 'Test Writing',
        role: 'tester',
        prompt: 'Write comprehensive tests.',
      },
    ],
  },

  'image-annotation': {
    name: '图片标注流程',
    description: '视觉理解 -> 视觉处理：先识别图片内容和位置，再进行标注',
    tags: ['vision', 'annotation', 'multimodal'],
    stages: [
      {
        name: '视觉理解',
        role: 'visual-understanding',
        prompt: `分析图片内容，识别所有需要标注的元素。

输出格式要求：
1. 列出所有识别到的元素
2. 为每个元素提供位置信息（如：左上角、中央、右下角，或百分比坐标）
3. 描述元素的大致尺寸（相对于图片的占比）

注意：位置信息要尽可能精确，以便后续标注处理。`,
      },
      {
        name: '视觉处理',
        role: 'visual-processing',
        prompt: `根据视觉理解阶段的分析结果，在图片上绘制标注。

使用 image_annotate 工具进行标注绘制：
- 根据识别到的位置信息计算坐标
- 选择合适的标注类型（矩形框、圆圈、箭头等）
- 添加必要的标签文字

确保所有识别到的元素都被正确标注。`,
        dependsOn: ['视觉理解'],
      },
    ],
  },

  'image-ocr-annotate': {
    name: 'OCR 文字标注流程',
    description: '专门用于识别图片中的文字并用矩形框标注',
    tags: ['vision', 'ocr', 'annotation', 'multimodal'],
    stages: [
      {
        name: 'OCR 识别',
        role: 'visual-understanding',
        prompt: `识别图片中的所有文字区域。

输出格式要求：
1. 列出每个文字区域的内容
2. 提供每个文字区域的位置（x%, y% 相对于图片左上角）
3. 提供每个文字区域的大小（宽度%、高度%）
4. 按从上到下、从左到右的阅读顺序排列

示例输出格式：
- 文字1: "标题文字", 位置: (10%, 5%), 尺寸: (80%, 8%)
- 文字2: "正文内容", 位置: (10%, 20%), 尺寸: (60%, 5%)`,
      },
      {
        name: '矩形标注',
        role: 'visual-processing',
        prompt: `根据 OCR 识别结果，用矩形框标注所有文字区域。

使用 image_annotate 工具：
- 将百分比坐标转换为像素坐标（假设图片尺寸，或使用相对坐标）
- 为每个文字区域绘制矩形框
- 矩形框颜色使用红色(#FF0000)
- 可选：添加标签显示文字内容

确保标注清晰可见，不遮挡原文字。`,
        dependsOn: ['OCR 识别'],
      },
    ],
  },
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 获取内置工作流模板
 * @param id 工作流 ID
 * @returns 模板对象，如果不存在则返回 undefined
 */
export function getBuiltInWorkflow(id: string): WorkflowTemplate | undefined {
  if (isBuiltInWorkflowId(id)) {
    return BUILT_IN_WORKFLOWS[id];
  }
  return undefined;
}

/**
 * 检查是否为内置工作流 ID
 * @param id 工作流 ID
 * @returns 是否为内置工作流
 */
export function isBuiltInWorkflowId(id: string): id is BuiltInWorkflowId {
  return id in BUILT_IN_WORKFLOWS;
}

/**
 * 获取所有内置工作流 ID
 * @returns 工作流 ID 数组
 */
export function listBuiltInWorkflowIds(): BuiltInWorkflowId[] {
  return Object.keys(BUILT_IN_WORKFLOWS) as BuiltInWorkflowId[];
}

/**
 * 获取所有内置工作流的简要信息
 * @returns 包含 id、name、description 的数组
 */
export function listBuiltInWorkflows(): Array<{
  id: BuiltInWorkflowId;
  name: string;
  description: string;
  tags?: string[];
}> {
  return Object.entries(BUILT_IN_WORKFLOWS).map(([id, template]) => ({
    id: id as BuiltInWorkflowId,
    name: template.name,
    description: template.description,
    tags: template.tags,
  }));
}

/**
 * 按标签获取内置工作流
 * @param tag 标签名称
 * @returns 匹配的模板数组
 */
export function getBuiltInWorkflowsByTag(tag: string): Array<{
  id: BuiltInWorkflowId;
  template: WorkflowTemplate;
}> {
  return Object.entries(BUILT_IN_WORKFLOWS)
    .filter(([, template]) => template.tags?.includes(tag))
    .map(([id, template]) => ({
      id: id as BuiltInWorkflowId,
      template,
    }));
}

/**
 * 验证工作流阶段依赖是否有效（无循环依赖）
 * @param stages 阶段列表
 * @returns 是否有效
 */
export function validateWorkflowDependencies(stages: WorkflowStage[]): {
  valid: boolean;
  error?: string;
} {
  const stageNames = new Set(stages.map((s) => s.name));
  const completed = new Set<string>();
  const remaining = [...stages];

  // 检查所有依赖是否引用有效的阶段名
  for (const stage of stages) {
    if (stage.dependsOn) {
      for (const dep of stage.dependsOn) {
        if (!stageNames.has(dep)) {
          return {
            valid: false,
            error: `Stage "${stage.name}" depends on unknown stage "${dep}"`,
          };
        }
      }
    }
  }

  // 拓扑排序检测循环依赖
  while (remaining.length > 0) {
    const ready = remaining.filter((stage) => {
      if (!stage.dependsOn || stage.dependsOn.length === 0) {
        return true;
      }
      return stage.dependsOn.every((dep) => completed.has(dep));
    });

    if (ready.length === 0) {
      const stuck = remaining.map((s) => s.name).join(', ');
      return {
        valid: false,
        error: `Circular dependency detected in stages: ${stuck}`,
      };
    }

    for (const stage of ready) {
      completed.add(stage.name);
      const idx = remaining.indexOf(stage);
      if (idx !== -1) {
        remaining.splice(idx, 1);
      }
    }
  }

  return { valid: true };
}
