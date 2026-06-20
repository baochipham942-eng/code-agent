// 设计工作区的纯类型 + 常量 + prompt 构造器（无 React 依赖，可单测）。
// 原型 prompt 的硬约束与设计上下文移植自竞品 Kun（sdd-prototype-prompt /
// sdd-design-context），详见 docs/competitive/kun-设计tab-借鉴清单.md。

/** 设计语境的表层定位：品牌主导（设计即产品）vs 产品主导（设计服务产品）。 */
export type DesignSurface = 'brand' | 'product';

/** 产物类型：交互原型(HTML) / 设计稿(图) / 信息图(图)。 */
export type DesignOutputType = 'prototype' | 'mockup' | 'infographic';

/** 设计上下文，注入 prompt 以约束品牌/语气并规避 AI 默认审美。 */
export type DesignContextInput = {
  surface?: DesignSurface;
  brandColor?: string;
  tone?: readonly string[];
};

/** 语气候选项（对齐 Kun SDD_DESIGN_TONE_OPTIONS）。 */
export const DESIGN_TONE_OPTIONS = [
  '编辑风',
  '专业',
  '活泼',
  '极简',
  '大胆',
  '温暖',
  '科技感',
  '严肃',
] as const;

const SURFACE_LABEL: Record<DesignSurface, string> = {
  brand: 'Brand-led（营销 / 落地页 / 作品集——设计本身就是产品）',
  product: 'Product-led（应用 UI / 仪表盘 / 工具——设计服务于产品）',
};

/**
 * 把设计上下文渲染成 prompt 行。无内容时返回空数组，调用方可无条件展开。
 * 显式禁止 AI 默认审美（紫蓝渐变 / 米色底 / 弹跳缓动…），与 P2 设计质量
 * 自检 hook 同源，前置约束 + 事后自检双保险。
 */
export function formatDesignContextLines(ctx: DesignContextInput | undefined): string[] {
  if (!ctx) return [];
  const parts: string[] = [];
  if (ctx.surface) parts.push(`- Surface: ${SURFACE_LABEL[ctx.surface]}`);
  if (ctx.brandColor) {
    parts.push(
      `- 品牌色锚点: ${ctx.brandColor} —— 围绕它组织配色；不要回退到紫→蓝的 AI 默认渐变。`,
    );
  }
  if (ctx.tone && ctx.tone.length > 0) parts.push(`- 语气: ${ctx.tone.join('、')}`);
  if (parts.length === 0) return [];
  return [
    '设计上下文（每个视觉决策都要遵守）：',
    ...parts,
    '- 规避通用 AI 痕迹：米/沙色默认底、紫→蓝渐变、弹跳/橡皮筋缓动、嵌套卡片、彩底灰字。' +
      '校验文字对比度，并提供 prefers-reduced-motion 兜底。',
  ];
}

export type BuildPrototypePromptInput = {
  /** 用户的需求描述。 */
  requirement: string;
  /** 工作区相对的预留写入路径，Agent 必须写到这里。 */
  reservedPath: string;
  designContext?: DesignContextInput;
};

/**
 * 交互 HTML 原型的回合 prompt：产出单文件可交互 HTML 并用 Write 一次性写到预留
 * 路径。硬约束移植自 Kun：单文件、纯 raw HTML、以 </html> 收尾。
 *
 * 注意：刻意要求「单次 Write 写完整文档」，不做增量 edit——多次写/改会反复触发
 * 工具入参 repair 闸导致 Write 被拦截、Agent 被迫退回 Bash（dogfood 实测，
 * 详见借鉴清单 Bug B）。一次写完最稳。
 */
export function buildPrototypePrompt(input: BuildPrototypePromptInput): string {
  const requirement = input.requirement.trim();
  const lines = [
    '请构建一个可交互的 HTML 原型。',
    `预留原型文件路径：${input.reservedPath}`,
    '',
    '硬性规则：',
    `- 用一次 Write 调用，在 \`${input.reservedPath}\` 写入一个完整、独立的单文件 HTML 文档；按需创建父目录。`,
    '- 一次写完整份文档，不要分多次 write/edit 增量拼接。',
    '- 本回合不要创建或修改任何其他文件。',
    '- 文件内容必须是 raw HTML——不要 markdown 围栏、不要在文件内写说明。',
    '- 以文档的 `</html>` 收尾，然后用一段话总结你实现了哪些交互。',
  ];
  const ctxLines = formatDesignContextLines(input.designContext);
  if (ctxLines.length > 0) lines.push('', ...ctxLines);
  if (requirement) lines.push('', '需求：', requirement);
  return lines.join('\n');
}

const IMAGE_OUTPUT_LABEL: Record<Exclude<DesignOutputType, 'prototype'>, string> = {
  mockup: 'UI 设计稿',
  infographic: '信息图',
};

export type BuildImagePromptInput = {
  requirement: string;
  outputType: Exclude<DesignOutputType, 'prototype'>;
  designContext?: DesignContextInput;
};

/**
 * 设计稿 / 信息图的回合 prompt：让 Agent 调用图像生成工具（image_generate，
 * 走 CogView/FLUX）产出静态视觉。
 */
export function buildImagePrompt(input: BuildImagePromptInput): string {
  const requirement = input.requirement.trim();
  const label = IMAGE_OUTPUT_LABEL[input.outputType];
  const lines = [
    `请使用图像生成工具（image_generate）生成一张${label}。`,
    `主题：${requirement || label}`,
  ];
  const ctxLines = formatDesignContextLines(input.designContext);
  if (ctxLines.length > 0) lines.push('', ...ctxLines);
  lines.push('', '生成后用一句话说明这张图的设计取向。');
  return lines.join('\n');
}
