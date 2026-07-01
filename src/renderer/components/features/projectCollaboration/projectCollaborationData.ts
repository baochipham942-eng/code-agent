import type {
  NeoTagContextPack,
  NeoMemoryCandidate,
  NeoWorkCard,
  NeoWorkCardDelta,
  NeoWorkCardRevision,
  NeoWorkCardStatus,
} from '@shared/contract/tag';

export interface ProjectCollaborationWorkCardRecord {
  card: NeoWorkCard;
  revision: NeoWorkCardRevision;
  delta?: NeoWorkCardDelta;
  contextPack?: NeoTagContextPack;
  memoryCandidates?: NeoMemoryCandidate[];
}

export interface ProjectCollaborationDecisionItem {
  id: string;
  workCardId: string;
  workCardTitle: string;
  text: string;
  createdAt: number;
}

export interface ProjectCollaborationMemoryCandidate {
  id: string;
  workCardId: string;
  workCardTitle: string;
  text: string;
  source: NeoMemoryCandidate['source'];
  status: NeoMemoryCandidate['status'];
  createdAt: number;
}

export interface ProjectCollaborationContextAudit {
  id: string;
  workCardId: string;
  workCardTitle: string;
  strategy: NeoTagContextPack['strategy'];
  selectedEvidenceCount: number;
  excludedCount: number;
  estimatedTokens: number;
  maxTokens: number;
  sourceTypes: string[];
  createdAt: number;
}

export interface ProjectCollaborationGroups {
  overview: {
    total: number;
    review: number;
    running: number;
    resultReview: number;
    completed: number;
    attention: number;
    closed: number;
    queue: number;
    decisions: number;
    memoryCandidates: number;
    contextAudits: number;
  };
  review: ProjectCollaborationWorkCardRecord[];
  running: ProjectCollaborationWorkCardRecord[];
  resultReview: ProjectCollaborationWorkCardRecord[];
  completed: ProjectCollaborationWorkCardRecord[];
  attention: ProjectCollaborationWorkCardRecord[];
  closed: ProjectCollaborationWorkCardRecord[];
  queue: ProjectCollaborationWorkCardRecord[];
  decisions: ProjectCollaborationDecisionItem[];
  memoryCandidates: ProjectCollaborationMemoryCandidate[];
  contextAudits: ProjectCollaborationContextAudit[];
}

export interface ProjectCollaborationBadge {
  openCount: number;
  reviewCount: number;
  runningCount: number;
  resultReviewCount: number;
  queueCount: number;
}

const REVIEW_STATUSES = new Set<NeoWorkCardStatus>(['draft', 'needs_review']);
const RUNNING_STATUSES = new Set<NeoWorkCardStatus>(['working', 'waiting_for_user']);
const RESULT_REVIEW_STATUSES = new Set<NeoWorkCardStatus>(['in_result_review']);
const COMPLETED_STATUSES = new Set<NeoWorkCardStatus>(['completed']);
const ATTENTION_STATUSES = new Set<NeoWorkCardStatus>(['failed']);
const CLOSED_STATUSES = new Set<NeoWorkCardStatus>(['cancelled', 'archived']);
const QUEUE_STATUSES = new Set<NeoWorkCardStatus>(['approved', 'queued']);

const PROJECT_ID = 'project-neo-tag-p0';
const CONVERSATION_ID = 'conversation-neo-tag-p0';
const USER_ID = 'user-local';
const BASE_TIME = 1782796800000;

function readScope(notes: string[] = []) {
  return {
    mode: 'current_project' as const,
    projectId: PROJECT_ID,
    conversationIds: [CONVERSATION_ID],
    messageIds: [],
    artifactIds: [],
    fileGlobs: ['src/renderer/**', 'docs/plans/**'],
    memoryEntryIds: [],
    notes,
  };
}

function writeScope(allowedPaths: string[] = []) {
  return {
    mode: 'current_project' as const,
    projectId: PROJECT_ID,
    allowedPaths,
    canCreateFiles: allowedPaths.length > 0,
    canModifyFiles: allowedPaths.length > 0,
    canWriteProjectMemory: false,
    externalDestinations: [],
    notes: ['P0 只写当前项目内文件'],
  };
}

function card(input: {
  id: string;
  title: string;
  status: NeoWorkCardStatus;
  revisionId: string;
  offset: number;
}): NeoWorkCard {
  return {
    id: input.id,
    projectId: PROJECT_ID,
    sourceConversationId: CONVERSATION_ID,
    sourceTurnId: `turn-${input.id}`,
    requesterUserId: USER_ID,
    title: input.title,
    status: input.status,
    currentRevisionId: input.revisionId,
    approvedRevisionId: ['approved', 'queued', 'working', 'waiting_for_user', 'in_result_review', 'completed'].includes(input.status)
      ? input.revisionId
      : null,
    createdAt: BASE_TIME + input.offset,
    updatedAt: BASE_TIME + input.offset + 120000,
    archivedAt: null,
  };
}

function revision(input: {
  id: string;
  workCardId: string;
  revisionNumber: number;
  intent: NeoWorkCardRevision['intent'];
  taskSummary: string;
  outputs: NeoWorkCardRevision['expectedOutputs'];
  risks?: string[];
  assumptions?: string[];
}): NeoWorkCardRevision {
  return {
    id: input.id,
    workCardId: input.workCardId,
    revisionNumber: input.revisionNumber,
    intent: input.intent,
    taskSummary: input.taskSummary,
    readScope: readScope(),
    writeScope: writeScope(['src/renderer/components/features/projectCollaboration/**']),
    modelIntent: { mode: 'inherit_current' },
    memoryPlan: {
      mode: 'explicit_only',
      entries: [],
      notes: ['只有用户确认的项目决策进入长期记忆'],
    },
    expectedOutputs: input.outputs,
    risks: input.risks ?? [],
    assumptions: input.assumptions ?? [],
    createdByUserId: USER_ID,
    createdAt: BASE_TIME,
  };
}

function delta(input: {
  id: string;
  workCardId: string;
  runId: string;
  decisions?: string[];
  memoryCandidates?: string[];
  changedFiles?: string[];
  createdAt: number;
}): NeoWorkCardDelta {
  return {
    id: input.id,
    workCardId: input.workCardId,
    runId: input.runId,
    completed: [],
    changedFiles: input.changedFiles ?? [],
    decisions: input.decisions ?? [],
    openQuestions: [],
    risks: [],
    memoryCandidates: input.memoryCandidates ?? [],
    nextStep: undefined,
    createdAt: input.createdAt,
  };
}

function memoryCandidate(input: {
  id: string;
  workCardId: string;
  revisionId?: string | null;
  deltaId?: string | null;
  text: string;
  source: NeoMemoryCandidate['source'];
  status?: NeoMemoryCandidate['status'];
  createdAt: number;
}): NeoMemoryCandidate {
  return {
    id: input.id,
    workCardId: input.workCardId,
    projectId: PROJECT_ID,
    revisionId: input.revisionId ?? null,
    deltaId: input.deltaId ?? null,
    kind: 'workflow_convention',
    text: input.text,
    source: input.source,
    status: input.status ?? 'pending',
    createdAt: input.createdAt,
    decidedByUserId: null,
    decidedAt: null,
    rejectionReason: null,
    writtenAt: input.status === 'written' ? input.createdAt + 1000 : null,
    writtenMemoryKey: input.status === 'written' ? `neo.${input.workCardId}.${input.id}` : null,
  };
}

function contextPack(input: {
  id: string;
  workCardId: string;
  revisionId: string;
  strategy: NeoTagContextPack['strategy'];
  estimatedTokens: number;
  selectedFiles?: Array<{ path: string; reason: string }>;
  excluded?: Array<{ id: string; reason: string }>;
}): NeoTagContextPack {
  return {
    id: input.id,
    projectId: PROJECT_ID,
    workCardId: input.workCardId,
    workCardRevisionId: input.revisionId,
    seedConversationId: CONVERSATION_ID,
    seedTurnId: `turn-${input.workCardId}`,
    strategy: input.strategy,
    selectedMessages: [{ id: 'msg-neo-entry', reason: '@neo invocation', score: 1 }],
    selectedArtifacts: [],
    selectedMemoryEntryIds: [],
    selectedFiles: input.selectedFiles ?? [],
    excluded: input.excluded ?? [],
    expandableScopes: [{ scope: 'project-history', handle: 'ctx:project-history', reason: '按需展开项目历史' }],
    budget: { maxTokens: 12000, estimatedTokens: input.estimatedTokens },
    createdAt: BASE_TIME + 600000,
  };
}

function parseContextAuditDecision(
  text: string,
  record: ProjectCollaborationWorkCardRecord,
  index: number,
): ProjectCollaborationContextAudit | null {
  if (!text.startsWith('Context audit: ')) return null;
  const pairs = new Map<string, string>();
  for (const segment of text.slice('Context audit: '.length).split(/\s+/)) {
    const splitAt = segment.indexOf('=');
    if (splitAt <= 0) continue;
    pairs.set(segment.slice(0, splitAt), segment.slice(splitAt + 1));
  }
  const tokens = pairs.get('tokens') ?? '0/0';
  const [estimatedTokens, maxTokens] = tokens.split('/').map((value) => Number(value) || 0);
  const selectedEvidenceCount =
    (Number(pairs.get('messages')) || 0)
    + (Number(pairs.get('artifacts')) || 0)
    + (Number(pairs.get('files')) || 0)
    + (Number(pairs.get('memory')) || 0);
  const sourceTypes = (pairs.get('sources') ?? 'none')
    .split('+')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item !== 'none');
  return {
    id: pairs.get('pack') || `${record.delta?.id ?? record.card.id}:context:${index}`,
    workCardId: record.card.id,
    workCardTitle: record.card.title,
    strategy: (pairs.get('strategy') as NeoTagContextPack['strategy']) || 'plain',
    selectedEvidenceCount,
    excludedCount: Number(pairs.get('excluded')) || 0,
    estimatedTokens,
    maxTokens,
    sourceTypes,
    createdAt: record.delta?.createdAt ?? record.card.updatedAt,
  };
}

export const NEO_PROJECT_COLLABORATION_FIXTURE: ProjectCollaborationWorkCardRecord[] = [
  {
    card: card({
      id: 'wc-review',
      title: '@neo 审 Project Collaboration skeleton 范围',
      status: 'needs_review',
      revisionId: 'rev-review-1',
      offset: 1000,
    }),
    revision: revision({
      id: 'rev-review-1',
      workCardId: 'wc-review',
      revisionNumber: 1,
      intent: 'plan',
      taskSummary: '确认 P0 面板只做 skeleton、入口和测试，不接 runtime/context/memory。',
      outputs: [{ kind: 'plan', title: 'P0 范围确认' }],
      risks: ['后端 IPC 尚未 ready，面板先使用 fixture'],
    }),
  },
  {
    card: card({
      id: 'wc-queued',
      title: '@neo 接真实 work card list/detail IPC',
      status: 'queued',
      revisionId: 'rev-queued-1',
      offset: 2000,
    }),
    revision: revision({
      id: 'rev-queued-1',
      workCardId: 'wc-queued',
      revisionNumber: 1,
      intent: 'implement',
      taskSummary: '等 tag IPC ready 后，用 list/detail 替换 renderer fixture 数据源。',
      outputs: [{ kind: 'patch', title: 'Renderer data client' }],
      assumptions: ['tag.ipc.ts 会暴露 project scoped list/detail'],
    }),
  },
  {
    card: card({
      id: 'wc-running',
      title: '@neo 生成项目合作面板 UI skeleton',
      status: 'working',
      revisionId: 'rev-running-1',
      offset: 3000,
    }),
    revision: revision({
      id: 'rev-running-1',
      workCardId: 'wc-running',
      revisionNumber: 1,
      intent: 'implement',
      taskSummary: '在 Workbench 中展示项目级 work card 分组、决策、记忆候选和上下文审计。',
      outputs: [{ kind: 'artifact', title: 'ProjectCollaborationPanel' }],
    }),
    delta: delta({
      id: 'delta-running-1',
      workCardId: 'wc-running',
      runId: 'run-running-1',
      decisions: ['Tag 管理入口独立于 TaskPanel'],
      memoryCandidates: ['项目合作面板使用 work card 作为共享合约主对象'],
      changedFiles: ['src/renderer/components/features/projectCollaboration/ProjectCollaborationPanel.tsx'],
      createdAt: BASE_TIME + 300000,
    }),
    memoryCandidates: [
      memoryCandidate({
        id: 'mem-running-1',
        workCardId: 'wc-running',
        deltaId: 'delta-running-1',
        text: '项目合作面板使用 work card 作为共享合约主对象',
        source: 'result_review',
        createdAt: BASE_TIME + 300000,
      }),
    ],
    contextPack: contextPack({
      id: 'ctx-running-1',
      workCardId: 'wc-running',
      revisionId: 'rev-running-1',
      strategy: 'work_card_thread',
      estimatedTokens: 3400,
      selectedFiles: [
        { path: 'docs/plans/neo-claude-tag-borrowing-plan.md', reason: 'P0 产品边界' },
        { path: 'src/renderer/components/WorkbenchTabs.tsx', reason: '右侧 workbench tab 入口' },
      ],
      excluded: [{ id: 'settings-page', reason: 'P0 不碰 settings' }],
    }),
  },
  {
    card: card({
      id: 'wc-result-review',
      title: '@neo 复核 Sidebar Neo badge 入口',
      status: 'in_result_review',
      revisionId: 'rev-result-review-1',
      offset: 4000,
    }),
    revision: revision({
      id: 'rev-result-review-1',
      workCardId: 'wc-result-review',
      revisionNumber: 1,
      intent: 'review',
      taskSummary: '确认 sidebar 中项目组能看到 Neo badge，并能打开项目合作面板。',
      outputs: [{ kind: 'decision_log', title: 'Sidebar badge review' }],
    }),
    delta: delta({
      id: 'delta-result-review-1',
      workCardId: 'wc-result-review',
      runId: 'run-result-review-1',
      decisions: ['Neo badge 放在项目组 header，保持项目级入口可见'],
      createdAt: BASE_TIME + 420000,
    }),
  },
  {
    card: card({
      id: 'wc-completed',
      title: '@neo 记录 P0 不实现 runtime/context/memory',
      status: 'completed',
      revisionId: 'rev-completed-1',
      offset: 5000,
    }),
    revision: revision({
      id: 'rev-completed-1',
      workCardId: 'wc-completed',
      revisionNumber: 1,
      intent: 'remember',
      taskSummary: '把 P0 边界留在项目面板可见状态里，避免 skeleton 被误解成完整 tag runtime。',
      outputs: [{ kind: 'memory_update', title: 'P0 边界候选' }],
    }),
    delta: delta({
      id: 'delta-completed-1',
      workCardId: 'wc-completed',
      runId: 'run-completed-1',
      memoryCandidates: ['P0 只做项目合作面板 skeleton 和入口，runtime/context/memory 延后'],
      createdAt: BASE_TIME + 540000,
    }),
    memoryCandidates: [
      memoryCandidate({
        id: 'mem-completed-1',
        workCardId: 'wc-completed',
        deltaId: 'delta-completed-1',
        text: 'P0 只做项目合作面板 skeleton 和入口，runtime/context/memory 延后',
        source: 'explicit_memory_plan',
        status: 'written',
        createdAt: BASE_TIME + 540000,
      }),
    ],
  },
];

export function buildProjectCollaborationGroups(
  records: ProjectCollaborationWorkCardRecord[] = NEO_PROJECT_COLLABORATION_FIXTURE,
): ProjectCollaborationGroups {
  const review = records.filter((record) => REVIEW_STATUSES.has(record.card.status));
  const running = records.filter((record) => RUNNING_STATUSES.has(record.card.status));
  const resultReview = records.filter((record) => RESULT_REVIEW_STATUSES.has(record.card.status));
  const completed = records.filter((record) => COMPLETED_STATUSES.has(record.card.status));
  const attention = records.filter((record) => ATTENTION_STATUSES.has(record.card.status));
  const closed = records.filter((record) => CLOSED_STATUSES.has(record.card.status));
  const queue = records.filter((record) => QUEUE_STATUSES.has(record.card.status));
  const decisions = records.flatMap((record) =>
    (record.delta?.decisions ?? []).map((text, index) => ({
      id: `${record.delta?.id ?? record.card.id}:decision:${index}`,
      workCardId: record.card.id,
      workCardTitle: record.card.title,
      text,
      createdAt: record.delta?.createdAt ?? record.card.updatedAt,
    })),
  );
  const memoryCandidates = records.flatMap((record) => {
    if (record.memoryCandidates?.length) {
      return record.memoryCandidates.map((candidate) => ({
        id: candidate.id,
        workCardId: record.card.id,
        workCardTitle: record.card.title,
        text: candidate.text,
        source: candidate.source,
        status: candidate.status,
        createdAt: candidate.createdAt,
      }));
    }
    return (record.delta?.memoryCandidates ?? []).map((text, index) => ({
      id: `${record.delta?.id ?? record.card.id}:memory:${index}`,
      workCardId: record.card.id,
      workCardTitle: record.card.title,
      text,
      source: 'result_review' as const,
      status: 'pending' as const,
      createdAt: record.delta?.createdAt ?? record.card.updatedAt,
    }));
  });
  const contextAudits = records.flatMap((record) => {
    const pack = record.contextPack;
    const fromPack = pack ? [{
      id: pack.id,
      workCardId: record.card.id,
      workCardTitle: record.card.title,
      strategy: pack.strategy,
      selectedEvidenceCount:
        pack.selectedMessages.length
        + pack.selectedArtifacts.length
        + pack.selectedFiles.length
        + pack.selectedMemoryEntryIds.length,
      excludedCount: pack.excluded.length,
      estimatedTokens: pack.budget.estimatedTokens,
      maxTokens: pack.budget.maxTokens,
      sourceTypes: [
        pack.selectedMessages.length > 0 ? 'messages' : null,
        pack.selectedArtifacts.length > 0 ? 'artifacts' : null,
        pack.selectedFiles.length > 0 ? 'files' : null,
        pack.selectedMemoryEntryIds.length > 0 ? 'memory' : null,
      ].filter((item): item is string => Boolean(item)),
      createdAt: pack.createdAt,
    }] : [];
    const fromDelta = (record.delta?.decisions ?? [])
      .map((text, index) => parseContextAuditDecision(text, record, index))
      .filter((item): item is ProjectCollaborationContextAudit => Boolean(item));
    return [...fromPack, ...fromDelta];
  });

  return {
    overview: {
      total: records.length,
      review: review.length,
      running: running.length,
      resultReview: resultReview.length,
      completed: completed.length,
      attention: attention.length,
      closed: closed.length,
      queue: queue.length,
      decisions: decisions.length,
      memoryCandidates: memoryCandidates.length,
      contextAudits: contextAudits.length,
    },
    review,
    running,
    resultReview,
    completed,
    attention,
    closed,
    queue,
    decisions,
    memoryCandidates,
    contextAudits,
  };
}

export function getProjectCollaborationBadge(
  records: ProjectCollaborationWorkCardRecord[] = NEO_PROJECT_COLLABORATION_FIXTURE,
): ProjectCollaborationBadge {
  const groups = buildProjectCollaborationGroups(records);
  return {
    openCount: groups.overview.review + groups.overview.running + groups.overview.resultReview + groups.overview.queue,
    reviewCount: groups.overview.review,
    runningCount: groups.overview.running,
    resultReviewCount: groups.overview.resultReview,
    queueCount: groups.overview.queue,
  };
}
