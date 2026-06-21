// ============================================================================
// Question Form Artifact
// ----------------------------------------------------------------------------
// AI 在 emit 视觉/文档/邮件/PPT 类 artifact 前先 emit 一个 question_form，
// 让用户补齐 surface/direction 等关键信息，回流成 DesignBrief 注入下一轮上下文。
// ============================================================================

import {
  DESIGN_BRIEF_DIRECTION_LABELS,
  DESIGN_BRIEF_SURFACE_LABELS,
  type DesignBrief,
  type DesignBriefDirection,
  type DesignBriefSurface,
} from '../shared/contract/designBrief';
import { directionTokens } from '../design/direction-tokens';

export interface QuestionForm {
  surface: DesignBriefSurface;
  /** 用户最终选定的方向。参考截图模式或仅给候选集时可缺省。 */
  direction?: DesignBriefDirection;
  /** AI 精选的候选方向（最多 3 张方向卡）；缺省时 UI 回退到全部 6 个方向。 */
  directions?: DesignBriefDirection[];
  /** 参考截图模式：用户要匹配一张参考截图（在输入框附图），此时无需选方向。 */
  referenceScreenshot?: boolean;
  intent?: string;
  audience?: string;
  constraints?: string[];
  references?: string[];
}

export interface QuestionFormParseError {
  ok: false;
  reason: string;
}

export type QuestionFormParseResult =
  | { ok: true; form: QuestionForm }
  | QuestionFormParseError;

const QUESTION_FORM_BLOCK = /```question-form\s*\n([\s\S]*?)```/;

function trimText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function trimList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => trimText(item))
    .filter((item): item is string => Boolean(item));
  return items.length > 0 ? Array.from(new Set(items)) : undefined;
}

function isSurface(value: unknown): value is DesignBriefSurface {
  return typeof value === 'string' && value in DESIGN_BRIEF_SURFACE_LABELS;
}

function isDirection(value: unknown): value is DesignBriefDirection {
  return typeof value === 'string' && value in DESIGN_BRIEF_DIRECTION_LABELS;
}

/**
 * 容错解析 question-form 文本块。支持两种入口：
 * 1) 完整代码块（```question-form\n{...}\n```），常见于 AI 直接 emit
 * 2) 仅 JSON 主体，常见于已被上游 extractor 剥离 fence 后调用
 */
export function parseQuestionForm(input: string): QuestionFormParseResult {
  if (!input || typeof input !== 'string') {
    return { ok: false, reason: 'empty input' };
  }

  const blockMatch = input.match(QUESTION_FORM_BLOCK);
  const body = (blockMatch ? blockMatch[1] : input).trim();
  if (!body) return { ok: false, reason: 'empty body' };

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    return { ok: false, reason: `json parse failed: ${(err as Error).message}` };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'expected json object' };
  }

  const obj = raw as Record<string, unknown>;
  if (!isSurface(obj.surface)) {
    return { ok: false, reason: 'missing or invalid surface' };
  }

  // 顶层 direction 显式存在但非法 → 拒绝（保留旧契约）；缺省则交给候选/参考截图分支。
  if (obj.direction !== undefined && !isDirection(obj.direction)) {
    return { ok: false, reason: 'invalid direction' };
  }

  const directions = Array.isArray(obj.directions)
    ? Array.from(new Set(obj.directions.filter(isDirection)))
    : undefined;
  const referenceScreenshot = obj.referenceScreenshot === true;

  // 必须能确定"按什么生成"：选定方向 / 候选方向集 / 参考截图模式 三者至少其一。
  if (!isDirection(obj.direction) && !(directions && directions.length > 0) && !referenceScreenshot) {
    return { ok: false, reason: 'missing direction (need direction, directions, or referenceScreenshot)' };
  }

  const form: QuestionForm = {
    surface: obj.surface,
  };
  if (isDirection(obj.direction)) form.direction = obj.direction;
  if (directions && directions.length > 0) form.directions = directions;
  if (referenceScreenshot) form.referenceScreenshot = true;
  const intent = trimText(obj.intent);
  const audience = trimText(obj.audience);
  const constraints = trimList(obj.constraints);
  const references = trimList(obj.references);
  if (intent) form.intent = intent;
  if (audience) form.audience = audience;
  if (constraints) form.constraints = constraints;
  if (references) form.references = references;
  return { ok: true, form };
}

/**
 * 把已校验的 QuestionForm 映射成 DesignBrief（source='manual'）。
 * 仅做形状映射，不做规范化（normalizeDesignBrief 会再过一遍）。
 */
export function renderQuestionFormToDesignBrief(form: QuestionForm): DesignBrief {
  const brief: DesignBrief = {
    surface: form.surface,
    source: 'manual',
  };
  if (form.direction) {
    brief.direction = form.direction;
    brief.directionTokens = directionTokens[form.direction];
  }
  if (form.referenceScreenshot) brief.referenceScreenshot = true;
  if (form.intent) brief.intent = form.intent;
  if (form.audience) brief.audience = form.audience;
  if (form.constraints?.length) brief.constraints = form.constraints;
  if (form.references?.length) brief.references = form.references;
  return brief;
}
