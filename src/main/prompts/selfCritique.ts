/**
 * Self-critique prompt section — 借鉴 nexu-io/open-design 的 self-critique pre-emit 模式：
 * agent 在 emit <artifact> 前 silently 按 5 维（palette/typography/posture/surface/constraint）
 * 自评 1-5；任一维 <3 算 regression，重写一次再评，最多 2 passes，通过后才 emit。
 *
 * 不向用户输出评分（silent scoring）。这是 generation 阶段的内部反思，不是 review 工具。
 */
import {
  CRITIQUE_DIMENSIONS,
  CRITIQUE_DIMENSION_BRIEFS,
  CRITIQUE_DIMENSION_LABELS,
  CRITIQUE_SCORE_MAX,
  CRITIQUE_SCORE_MIN,
} from '../../design/critique/types';
import type { DesignBrief } from '../../shared/contract/designBrief';

const SELF_CRITIQUE_GATE_THRESHOLD = 3;
const SELF_CRITIQUE_MAX_PASSES = 2;

function describeDimensions(): string {
  return CRITIQUE_DIMENSIONS.map(
    (d) => `  - ${d}（${CRITIQUE_DIMENSION_LABELS[d]}）：${CRITIQUE_DIMENSION_BRIEFS[d]}`,
  ).join('\n');
}

function describeBriefAnchors(brief: DesignBrief): string {
  const lines: string[] = [];
  if (brief.directionTokens) {
    const t = brief.directionTokens;
    lines.push(`  - posture 锚点："${t.posture}"`);
    lines.push(
      `  - palette 锚点：primary=${t.palette.primary}, surface=${t.palette.surface}, accent=${t.palette.accent}`,
    );
    lines.push(`  - 字体气质：serif=${t.fonts.serif.split(',')[0]?.trim()} / sans=${t.fonts.sans.split(',')[0]?.trim()}`);
  } else if (brief.direction) {
    lines.push(`  - direction：${brief.direction}（无 directionTokens，按 direction 名定性判断）`);
  }
  if (brief.surface) {
    lines.push(`  - surface：${brief.surface}（结构与节奏要符合）`);
  }
  if (brief.constraints && brief.constraints.length > 0) {
    lines.push(`  - constraints 硬约束：${brief.constraints.length} 条，逐条核对`);
  }
  return lines.join('\n');
}

/**
 * 构造 self-critique system prompt section，调用方负责拼到 brief 注入位置之后。
 * 没有 brief 时返回 null（无 brief 不评）。
 */
export function buildSelfCritiquePromptSection(brief?: DesignBrief | null): string | null {
  if (!brief) {
    return null;
  }
  const anchors = describeBriefAnchors(brief);
  const lines = [
    '<design_self_critique>',
    '在你 emit `<artifact>` 标签或视觉/文档/代码类产物前，必须 silently 按 5 维度对自己的产物自评（整数 1-5）：',
    '',
    describeDimensions(),
    '',
    `打分量纲：${CRITIQUE_SCORE_MIN}=严重背离 / 2=大体不符 / 3=及格但平庸 / 4=兑现良好 / ${CRITIQUE_SCORE_MAX}=准确兑现。`,
    '',
    'Brief 锚点（评分时对照）：',
    anchors || '  - （brief 未提供具体锚点，按 design 通用判断）',
    '',
    `Gate：任一维度 < ${SELF_CRITIQUE_GATE_THRESHOLD} 算 regression — 重写一次再评。最多 ${SELF_CRITIQUE_MAX_PASSES} passes 后即使仍未达标也 emit，但要在心里标注未达标维度。`,
    '',
    '严格 silent：不要把评分输出给用户，不要在产物前后说"我自评是..."、"reasoning..."；评分是你的内部反思，通过后直接 emit artifact。',
    '</design_self_critique>',
  ];
  return lines.join('\n');
}

export const SELF_CRITIQUE_CONFIG = {
  gateThreshold: SELF_CRITIQUE_GATE_THRESHOLD,
  maxPasses: SELF_CRITIQUE_MAX_PASSES,
} as const;
