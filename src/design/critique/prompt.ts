import { DESIGN_BRIEF_DIRECTION_LABELS, DESIGN_BRIEF_SURFACE_LABELS } from '../../shared/contract/designBrief';
import {
  CRITIQUE_DIMENSIONS,
  CRITIQUE_DIMENSION_BRIEFS,
  CRITIQUE_DIMENSION_LABELS,
  CRITIQUE_SCORE_MAX,
  CRITIQUE_SCORE_MIN,
} from './types';
import type { CritiqueInput } from './types';

const SYSTEM_PREAMBLE = [
  'You are a senior product designer reviewing whether a generated artifact lives up to a design brief.',
  '你的任务：按 5 个维度给打分（整数 1-5）并给中文 reason，最后给一句中文 summary。',
  '严格输出 JSON，禁止 markdown 代码块，禁止任何额外文本。',
  // 强约束：避免 judge 在评 markdown / HTML artifact 时，把 artifact 里的特殊字符（表格 | 、引号、换行）',
  // 复述进 reason 字段引发 JSON malformed。即使 artifact 含 markdown 表格 / HTML / emoji，',
  // reason 也只能是单行中文短描述。',
  'reason 字段约束：单行中文（≤80 字符），不要含换行、双引号、反斜杠、markdown 表格 (|) 或代码块；',
  '即使 artifact 内容含特殊字符，也只用纯文字描述判断，不要复述 artifact 原文。',
  'summary 字段约束：单行中文一句话整体判断，同样不含换行 / 双引号 / 表格符号。',
].join('\n');

const SCORING_GUIDE = [
  `打分量纲（${CRITIQUE_SCORE_MIN}-${CRITIQUE_SCORE_MAX} 整数）：`,
  '1 = 严重背离，几乎没兑现；',
  '2 = 大体不符，少数细节对；',
  '3 = 及格，方向对但执行平庸；',
  '4 = 兑现良好，少量瑕疵；',
  '5 = 准确兑现，无明显瑕疵。',
].join('\n');

function describeDimensions(): string {
  return CRITIQUE_DIMENSIONS.map(
    (d) => `- ${d}（${CRITIQUE_DIMENSION_LABELS[d]}）：${CRITIQUE_DIMENSION_BRIEFS[d]}`,
  ).join('\n');
}

function describeBrief(input: CritiqueInput): string {
  const { brief } = input;
  const lines: string[] = [];
  if (brief.intent) lines.push(`intent: ${brief.intent}`);
  if (brief.surface) lines.push(`surface: ${brief.surface}（${DESIGN_BRIEF_SURFACE_LABELS[brief.surface]}）`);
  if (brief.audience) lines.push(`audience: ${brief.audience}`);
  if (brief.direction) lines.push(`direction: ${brief.direction}（${DESIGN_BRIEF_DIRECTION_LABELS[brief.direction]}）`);
  if (brief.directionTokens) {
    const t = brief.directionTokens;
    lines.push('directionTokens:');
    lines.push(
      `  palette: primary=${t.palette.primary} surface=${t.palette.surface} accent=${t.palette.accent} muted=${t.palette.muted} contrast=${t.palette.contrast}`,
    );
    lines.push(`  fonts.serif: ${t.fonts.serif}`);
    lines.push(`  fonts.sans: ${t.fonts.sans}`);
    lines.push(`  posture: ${t.posture}`);
  }
  if (brief.constraints && brief.constraints.length > 0) {
    lines.push('constraints:');
    for (const c of brief.constraints) lines.push(`  - ${c}`);
  }
  if (brief.brandContract) {
    const bc = brief.brandContract;
    if (bc.keep.length > 0 || bc.doNotCopy.length > 0) {
      lines.push('brandContract（品牌契约约束，并入 constraint 维度评分）:');
      for (const k of bc.keep) lines.push(`  - keep（必守）: ${k}`);
      for (const d of bc.doNotCopy) lines.push(`  - 禁止(do-not-copy): ${d}`);
    }
  }
  if (brief.references && brief.references.length > 0) {
    lines.push('references:');
    for (const r of brief.references) lines.push(`  - ${r}`);
  }
  return lines.length > 0 ? lines.join('\n') : '(空 brief)';
}

function describeArtifact(input: CritiqueInput): string {
  const { artifact } = input;
  const header = `kind: ${artifact.kind}` + (artifact.note ? `\nnote: ${artifact.note}` : '');
  return `${header}\ncontent:\n\`\`\`\n${artifact.content}\n\`\`\``;
}

const OUTPUT_SCHEMA = `{
  "scores": [
    { "dimension": "palette", "score": 1-5, "reason": "中文一句" },
    { "dimension": "typography", "score": 1-5, "reason": "中文一句" },
    { "dimension": "posture", "score": 1-5, "reason": "中文一句" },
    { "dimension": "surface", "score": 1-5, "reason": "中文一句" },
    { "dimension": "constraint", "score": 1-5, "reason": "中文一句（无约束时给 5 + 'N/A'）" }
  ],
  "summary": "中文一句，整体兑现度判断"
}`;

export function buildCritiquePrompt(input: CritiqueInput): string {
  return [
    SYSTEM_PREAMBLE,
    '',
    '## 维度定义',
    describeDimensions(),
    '',
    `## 打分指南`,
    SCORING_GUIDE,
    '',
    '## Design Brief',
    describeBrief(input),
    '',
    '## Artifact',
    describeArtifact(input),
    '',
    '## 输出 JSON Schema',
    OUTPUT_SCHEMA,
  ].join('\n');
}
