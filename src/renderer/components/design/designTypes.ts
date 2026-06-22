// 设计工作区的纯类型 + 常量 + prompt 构造器（无 React 依赖，可单测）。
// 原型 prompt 的硬约束与设计上下文移植自竞品 Kun（sdd-prototype-prompt /
// sdd-design-context），详见 docs/competitive/kun-设计tab-借鉴清单.md。
import { DESIGN_DEVICE_PRESETS, type DesignDeviceId } from '@shared/constants';

/** 把设备预设映射成预览 iframe 的 CSS 宽度（桌面满宽，平板/手机定宽）。 */
export function designDeviceWidth(id: DesignDeviceId): string {
  const width = DESIGN_DEVICE_PRESETS.find((d) => d.id === id)?.width;
  return width != null ? `${width}px` : '100%';
}

/** 版本快照文件名（按创建时间戳编码，便于排序与解析）。 */
export function versionFileName(ts: number): string {
  return `v-${ts}.html`;
}

/** 从版本快照文件名解析出时间戳；非法名返回 null。 */
export function parseVersionTs(fileName: string): number | null {
  const m = /^v-(\d+)\.html$/i.exec(fileName);
  return m ? Number(m[1]) : null;
}

/** 导出到下载目录时的文件名（带时间戳避免覆盖）。 */
export function prototypeExportName(ts: number): string {
  return `neo-prototype-${ts}.html`;
}

/** 原型 PDF 导出文件名（带时间戳避免覆盖）。 */
export function prototypePdfExportName(ts: number): string {
  return `neo-prototype-${ts}.pdf`;
}

/** 设计稿/信息图 PDF 导出文件名（带时间戳避免覆盖）。 */
export function imagePdfExportName(ts: number): string {
  return `neo-design-${ts}.pdf`;
}

/** 画布产物打包 PPTX 导出文件名（带时间戳避免覆盖）。 */
export function canvasPptxExportName(ts: number): string {
  return `neo-design-${ts}.pptx`;
}

/** 设计语境的表层定位：品牌主导（设计即产品）vs 产品主导（设计服务产品）。 */
export type DesignSurface = 'brand' | 'product';

/** 产物类型：交互原型(HTML) / 设计稿(图) / 信息图(图)。 */
export type DesignOutputType = 'prototype' | 'mockup' | 'infographic';

/** 出图尺寸比例（映射到通义万相 size，见 imageGenerationService）。 */
export type DesignAspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
export const DESIGN_ASPECT_RATIOS: readonly DesignAspectRatio[] = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
];

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
 * 交互 HTML 原型的回合 prompt：产出单文件可交互 HTML 并用文件工具写到预留路径。
 * 硬约束移植自 Kun：单文件、纯 raw HTML、增量写入、以 </html> 收尾。
 *
 * 注意：刻意要求「先写骨架再用 Edit 增量扩展」。dogfood 实测，让 MiMo 把整页 HTML
 * 塞进一次 Write 的工具入参里流式吐，会在 ~1KB 处中断（incomplete tool call）导致
 * 文件写不完；分小块增量写每块都能稳定流完。设计草稿目录已豁免游戏校验，增量写不再
 * 触发 artifact repair（详见借鉴清单 Bug B）。
 */
export function buildPrototypePrompt(input: BuildPrototypePromptInput): string {
  const requirement = input.requirement.trim();
  const lines = [
    '请构建一个可交互的 HTML 原型。',
    `预留原型文件路径：${input.reservedPath}`,
    '',
    '硬性规则：',
    `- 在 \`${input.reservedPath}\` 产出一个完整、独立的单文件 HTML 文档；按需创建父目录。`,
    '- 分步增量构建：先用 Write 写一个最小可用骨架（doctype、head、空 body），' +
      '再用若干次 Edit 逐段把 hero、内容、样式、脚本补全。每次写入控制在约 1500 字符' +
      '以内的小块——不要试图在一次 Write 里塞进整页 HTML，过大的工具入参会在流式中途中断。',
    '- 本回合只操作这一个文件，不要创建或修改其他文件。',
    '- 文件内容必须是 raw HTML——不要 markdown 围栏、不要在文件内写说明。',
    '- 任何 HTML 标签都写成真实标签，禁止用转义实体（如 &lt;nav&gt;）或把标签当可见文本，' +
      '否则会在页面上显示成原始代码。导航 / 页头这类结构要在同一次 Edit 内把开闭标签成对写完，' +
      '不要跨多次 Edit 把一个元素切成半截，避免预览在中途渲染出未闭合的原始标记残影。',
    '- 需要配图 / 头像 / 封面 / 缩略图时，用真实占位图，不要灰色空框：' +
      '`<img src="https://picsum.photos/seed/{desc}/{w}/{h}">`——{desc} 换成描述内容的英文 slug（如 ' +
      '`office-team`）、{w}/{h} 换成像素宽高（如 `800/600`），并写贴切的 alt。禁止用灰色空 div、' +
      '`background:#ccc` / `bg-gray-200` 这类纯色块或 via.placeholder.com / dummyimage.com 等灰图床充当图片。',
    '- 以文档的 `</html>` 收尾，然后用一段话总结你实现了哪些交互。',
  ];
  const ctxLines = formatDesignContextLines(input.designContext);
  if (ctxLines.length > 0) lines.push('', ...ctxLines);
  if (requirement) lines.push('', '需求：', requirement);
  return lines.join('\n');
}

/** 圈选到的原型元素定位信息（来自预览 iframe 注入脚本的 postMessage）。 */
export type PrototypeSelection = {
  /** 元素标签名（小写），如 button / h1。 */
  tag?: string;
  /** 元素可见文案（截断）。 */
  text?: string;
  /** 元素的 CSS 选择器路径，供 Agent 在源 HTML 中定位。 */
  selector?: string;
};

export type BuildContinueEditPromptInput = {
  /** 现有原型文件路径，Agent 在其上做局部 Edit。 */
  reservedPath: string;
  /** 用户的修改指令。 */
  instruction: string;
  /** 可选：圈选的目标元素，注入后让 Agent 定向修改。 */
  selection?: PrototypeSelection;
};

/**
 * 「在同一原型上续编」的回合 prompt：约束 Agent 用 Edit 对现有文件做最小局部修改，
 * 不重写整页、不新建文件、仍以 `</html>` 收尾。带圈选元素时附上目标定位，让模型
 * 定向改而非全局猜。与 buildPrototypePrompt（首次生成，Write 骨架 + 增量）互补。
 */
export function buildContinueEditPrompt(input: BuildContinueEditPromptInput): string {
  const instruction = input.instruction.trim();
  const lines = [
    '在现有 HTML 原型上做局部修改，不要重写整页。',
    `原型文件：${input.reservedPath}`,
    '',
    '硬性规则：',
    `- 用 Edit 工具对 \`${input.reservedPath}\` 做最小必要的局部修改，保持页面其余部分不变。`,
    '- 本回合只操作这一个文件，不要新建或修改其他文件。',
    '- 文件内容保持 raw HTML，仍以 `</html>` 收尾。',
  ];
  const sel = input.selection;
  if (sel && (sel.selector || sel.tag || sel.text)) {
    lines.push('', '目标元素（用户在预览里圈选的，优先改它）：');
    if (sel.selector) lines.push(`- CSS 选择器：${sel.selector}`);
    if (sel.tag) lines.push(`- 标签：<${sel.tag}>`);
    if (sel.text) lines.push(`- 文案：「${sel.text}」`);
  }
  if (instruction) lines.push('', '修改要求：', instruction);
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
 * 设计稿 / 信息图的图像生成 prompt：直连图像模型（通义万相）用的干净图像描述，
 * 不是给 Agent 的工具调用指令。把需求 + 品牌色/语气/表层定位拼成逗号分隔的视觉描述。
 */
export function buildImagePrompt(input: BuildImagePromptInput): string {
  const requirement = input.requirement.trim();
  const label = IMAGE_OUTPUT_LABEL[input.outputType];
  const parts: string[] = [requirement || label];
  const ctx = input.designContext;
  if (ctx?.brandColor) parts.push(`主色调 ${ctx.brandColor}`);
  if (ctx?.tone && ctx.tone.length > 0) parts.push(`风格：${ctx.tone.join('、')}`);
  if (ctx?.surface === 'brand') parts.push('品牌主导视觉');
  parts.push(input.outputType === 'infographic' ? '信息图排版，层次清晰' : 'UI 设计稿');
  return parts.join('，');
}
