// ============================================================================
// 从会话转成题目（回放页 → 草稿区）的共享契约
// ----------------------------------------------------------------------------
// 从 evaluation.ts 拆出来单独成文件（那份已顶到 max-lines 上限）；
// 消费方仍从 '@shared/contract/evaluation' 取，那边整体再导出。
// ============================================================================
import type { PostLaunchDimension, PostLaunchSignalKind } from './postLaunchScore';
/** 候选判定标准允许的类型白名单——只用现有断言类型，不发明新的。 */
export const HARVEST_EXPECTATION_TYPES = [
  'file_exists',
  'content_contains',
  'command_succeeds',
  'test_passes',
  'tool_called',
  'html_renders',
] as const;

export type HarvestExpectationType = (typeof HARVEST_EXPECTATION_TYPES)[number];

/** 每类判定标准可编辑的参数键；UI 按此渲染输入框，宿主按此校验（多余键一律拒收）。 */
export const HARVEST_EXPECTATION_PARAM_KEYS: Record<HarvestExpectationType, readonly string[]> = {
  file_exists: ['path'],
  content_contains: ['path', 'contains'],
  command_succeeds: ['command'],
  test_passes: ['command'],
  tool_called: ['tool'],
  html_renders: ['path'],
};

/** 字段映射清单的行 id（会话里的东西 → 题目字段）。 */
export type HarvestFieldKey =
  | 'prompt'            // 用户首轮原话 → prompt（锁定必选）
  | 'sourceSessionId'   // 会话 id → sourceSessionId（锁定必选，来源必须留）
  | 'qualityTags'       // 质量标记 → tags
  | 'toolTrace';        // 工具调用序列 → 描述里的背景（默认不勾）

export const HARVEST_LOCKED_FIELDS: readonly HarvestFieldKey[] = ['prompt', 'sourceSessionId'];
export const HARVEST_DEFAULT_FIELDS: readonly HarvestFieldKey[] = ['prompt', 'sourceSessionId', 'qualityTags'];

export interface HarvestCandidate {
  type: HarvestExpectationType;
  params: Record<string, string>;
  /** 一句「为什么推出来」，直接展示给人。 */
  reason: string;
}

/** 一份草稿的预填内容（人还没确认任何判定标准）。 */
export interface HarvestDraftSeed {
  sessionId: string;
  sessionTitle: string;
  /** 自动生成的 id（draft-<会话短 id>），人可改。 */
  id: string;
  prompt: string;
  description: string;
  tags: string[];
  candidates: HarvestCandidate[];
  /** 推不出候选时给人的提示（渲染侧查词典翻成人话）。 */
  notes: HarvestSeedNote[];
  /** 上线后回流候选的结构化溯源；正文仍由 HARVEST 按同意档决定是否带入。 */
  postLaunchReflow?: {
    turnId: string | null;
    sources: Array<'judge' | 'signal' | 'feedback'>;
    redDimensions: PostLaunchDimension[];
    signals: PostLaunchSignalKind[];
  };
}

export type HarvestSeedNote = 'noCandidates' | 'negativeFeedbackNeedsManual';

export interface HarvestPreviewRequest {
  sessionIds: string[];
  fields: HarvestFieldKey[];
  /** 由上线后卡片点选时开启，宿主重新读取候选并预填溯源。 */
  postLaunchReflow?: boolean;
}

export interface HarvestPreviewResult {
  seeds: HarvestDraftSeed[];
  failed: Array<{ sessionId: string; error: string }>;
}

/** 草稿题目类型；与宿主 TestCaseType 在 caseBank 里有编译期对表。 */
export const EVAL_DRAFT_CASE_TYPES = ['tool', 'task', 'conversation', 'error_handling', 'multi_step'] as const;
export type EvalDraftCaseType = (typeof EVAL_DRAFT_CASE_TYPES)[number];
