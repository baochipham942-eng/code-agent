// ============================================================================
// Review Queue Types - Phase 6.1 + 6.2 plus minimal 6.3 failure follow-up sink
// ============================================================================

export type UnifiedTraceSource = 'session_replay';

export interface UnifiedTraceIdentity {
  traceId: string;
  source: UnifiedTraceSource;
  sessionId: string;
  replayKey: string;
}

export type ReviewQueueReason =
  | 'manual_review'
  | 'failure_followup'
  | 'interesting_case'
  | 'regression_candidate';

export type ReviewQueueSource =
  | 'current_session_bar'
  | 'session_list'
  | 'replay_failure';

export type ReviewQueueFailureRootCategory =
  | 'tool_error'
  | 'bad_decision'
  | 'missing_context'
  | 'loop'
  | 'hallucination'
  | 'env_failure'
  | 'deviation'
  | 'unknown';

export type ReviewQueueFailureCapabilitySink =
  | 'skill'
  | 'dataset'
  | 'prompt_policy'
  | 'capability_health';

export interface ReviewQueueFailureAttributionInput {
  rootCause?: {
    stepIndex: number;
    category: string;
    summary: string;
    evidence: number[];
    confidence: number;
  };
}

export interface ReviewQueueFailureCapabilityMetadata {
  sink: ReviewQueueFailureCapabilitySink;
  category: ReviewQueueFailureRootCategory;
  summary?: string;
  stepIndex?: number;
  confidence?: number;
  evidence?: number[];
}

export type ReviewQueueFailureCapabilityAssetStatus =
  | 'draft'
  | 'ready'
  | 'applied'
  | 'dismissed';

export interface ReviewQueueFailureCapabilityAsset {
  id: string;
  reviewItemId: string;
  sessionId: string;
  traceId: string;
  status: ReviewQueueFailureCapabilityAssetStatus;
  sink: ReviewQueueFailureCapabilitySink;
  category: ReviewQueueFailureRootCategory;
  title: string;
  body: string;
  stepIndex?: number;
  confidence?: number;
  evidence?: number[];
  createdAt: number;
  updatedAt: number;
}

export interface UpdateReviewQueueFailureCapabilityAssetInput {
  reviewItemId: string;
  status: ReviewQueueFailureCapabilityAssetStatus;
  updatedAt?: number;
}

export interface BuildReviewQueueFailureCapabilityAssetDraftInput {
  reviewItemId: string;
  sessionId: string;
  traceId: string;
  metadata: ReviewQueueFailureCapabilityMetadata;
  createdAt: number;
  updatedAt?: number;
}

export interface ReviewQueueItem {
  id: string;
  trace: UnifiedTraceIdentity;
  sessionId: string;
  sessionTitle: string;
  reason: ReviewQueueReason;
  source: ReviewQueueSource;
  failureCapability?: ReviewQueueFailureCapabilityMetadata;
  failureAsset?: ReviewQueueFailureCapabilityAsset;
  createdAt: number;
  updatedAt: number;
}

export interface EnqueueReviewItemInput {
  sessionId: string;
  sessionTitle?: string;
  reason?: ReviewQueueReason;
  source?: ReviewQueueSource;
  failureCapability?: ReviewQueueFailureCapabilityMetadata;
}

export function buildSessionTraceIdentity(sessionId: string): UnifiedTraceIdentity {
  return {
    traceId: `session:${sessionId}`,
    source: 'session_replay',
    sessionId,
    replayKey: sessionId,
  };
}

export function buildReviewQueueItemId(trace: UnifiedTraceIdentity): string {
  return `review:${trace.traceId}`;
}

export function getReviewQueueReasonLabel(reason: ReviewQueueReason): string {
  switch (reason) {
    case 'failure_followup':
      return '失败回看';
    case 'interesting_case':
      return '值得沉淀';
    case 'regression_candidate':
      return '回归候选';
    case 'manual_review':
    default:
      return '手动加入';
  }
}

const FAILURE_ROOT_CATEGORY_TO_SINK: Record<ReviewQueueFailureRootCategory, ReviewQueueFailureCapabilitySink> = {
  tool_error: 'capability_health',
  env_failure: 'capability_health',
  bad_decision: 'skill',
  missing_context: 'dataset',
  hallucination: 'prompt_policy',
  loop: 'prompt_policy',
  deviation: 'dataset',
  unknown: 'dataset',
};

const FAILURE_ROOT_CATEGORY_LABELS: Record<ReviewQueueFailureRootCategory, string> = {
  tool_error: '工具失败',
  bad_decision: '决策缺口',
  missing_context: '缺少上下文',
  loop: '循环卡住',
  hallucination: '幻觉',
  env_failure: '环境失败',
  deviation: '偏差样本',
  unknown: '待归因',
};

const FAILURE_CAPABILITY_SINK_LABELS: Record<ReviewQueueFailureCapabilitySink, string> = {
  skill: 'Skill',
  dataset: 'Dataset',
  prompt_policy: 'Prompt Policy',
  capability_health: 'Capability Health',
};

const FAILURE_CAPABILITY_ASSET_STATUS_LABELS: Record<ReviewQueueFailureCapabilityAssetStatus, string> = {
  draft: '草稿',
  ready: '待应用',
  applied: '已应用',
  dismissed: '已忽略',
};

export function getReviewQueueFailureCapabilitySinkLabel(sink: ReviewQueueFailureCapabilitySink): string {
  return FAILURE_CAPABILITY_SINK_LABELS[sink];
}

export function getReviewQueueFailureRootCategoryLabel(category: ReviewQueueFailureRootCategory): string {
  return FAILURE_ROOT_CATEGORY_LABELS[category];
}

export function getReviewQueueFailureCapabilityLabel(
  metadata: ReviewQueueFailureCapabilityMetadata,
): string {
  return `${getReviewQueueFailureCapabilitySinkLabel(metadata.sink)} · ${getReviewQueueFailureRootCategoryLabel(metadata.category)}`;
}

export function getReviewQueueFailureAssetStatusLabel(
  status: ReviewQueueFailureCapabilityAssetStatus,
): string {
  return FAILURE_CAPABILITY_ASSET_STATUS_LABELS[status];
}

export function isReviewQueueFailureCapabilityAssetStatus(
  status: unknown,
): status is ReviewQueueFailureCapabilityAssetStatus {
  return status === 'draft'
    || status === 'ready'
    || status === 'applied'
    || status === 'dismissed';
}

export function buildReviewQueueFailureCapabilityMetadata(
  attribution?: ReviewQueueFailureAttributionInput | null,
): ReviewQueueFailureCapabilityMetadata | undefined {
  const rootCause = attribution?.rootCause;
  if (!rootCause) {
    return undefined;
  }

  const category = normalizeFailureRootCategory(rootCause.category);

  return {
    sink: FAILURE_ROOT_CATEGORY_TO_SINK[category],
    category,
    summary: rootCause.summary,
    stepIndex: rootCause.stepIndex,
    confidence: rootCause.confidence,
    evidence: rootCause.evidence,
  };
}

export function buildReviewQueueFailureCapabilityAssetDraft(
  input: BuildReviewQueueFailureCapabilityAssetDraftInput,
): ReviewQueueFailureCapabilityAsset {
  const { metadata } = input;
  const updatedAt = input.updatedAt ?? input.createdAt;
  const title = `${getReviewQueueFailureCapabilityLabel(metadata)} draft`;
  const bodyLines: string[] = [
    metadata.summary?.trim() || 'Failure follow-up needs capability work.',
    `Target: ${getReviewQueueFailureCapabilitySinkLabel(metadata.sink)}`,
    `Category: ${getReviewQueueFailureRootCategoryLabel(metadata.category)}`,
  ];

  if (typeof metadata.stepIndex === 'number') {
    bodyLines.push(`Root step: ${metadata.stepIndex}`);
  }
  if (typeof metadata.confidence === 'number') {
    bodyLines.push(`Confidence: ${Math.round(metadata.confidence * 100)}%`);
  }
  if (metadata.evidence?.length) {
    bodyLines.push(`Evidence steps: ${metadata.evidence.join(', ')}`);
  }

  return {
    id: `failure-asset:${input.reviewItemId}`,
    reviewItemId: input.reviewItemId,
    sessionId: input.sessionId,
    traceId: input.traceId,
    status: 'draft',
    sink: metadata.sink,
    category: metadata.category,
    title,
    body: bodyLines.join('\n'),
    stepIndex: metadata.stepIndex,
    confidence: metadata.confidence,
    evidence: metadata.evidence,
    createdAt: input.createdAt,
    updatedAt,
  };
}

export function normalizeFailureRootCategory(category: string | undefined): ReviewQueueFailureRootCategory {
  switch (category) {
    case 'tool_error':
    case 'bad_decision':
    case 'missing_context':
    case 'loop':
    case 'hallucination':
    case 'env_failure':
    case 'deviation':
    case 'unknown':
      return category;
    default:
      return 'unknown';
  }
}
