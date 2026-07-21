import type {
  SurfaceConversationSnapshotV1,
  SurfaceExecutionEventV1,
  SurfaceSessionControlActionV1,
  SurfaceSessionProjectionV1,
  SurfaceSessionStateV1,
} from '../../../src/shared/contract/surfaceExecution';

export const CONVERSATION_EXECUTION_CANARY = 'surface-secret-canary-conversation-ux';
export const CONVERSATION_SURFACE_SESSION_ID = 'surface-conversation-workbuddy';
export const CONVERSATION_RUN_ID = 'run-conversation-workbuddy';
export const CONVERSATION_AGENT_ID = 'neo-conversation-workbuddy';

export type ConversationAcceptanceControlAction = Extract<
  SurfaceSessionControlActionV1,
  'pause' | 'resume' | 'takeover' | 'stop' | 'end_session'
>;

export interface ConversationExecutionFixtureOptions {
  conversationId: string;
  evidenceAssetRef: string;
  now: number;
}

function controlsForState(state: SurfaceSessionStateV1): SurfaceSessionControlActionV1[] {
  if (state === 'running') return ['pause', 'takeover', 'stop', 'end_session'];
  if (state === 'paused') return ['resume', 'takeover', 'stop', 'end_session'];
  if (state === 'waiting_human') return ['resume', 'stop', 'end_session'];
  if (state === 'stopping') return ['end_session'];
  return [];
}

function event(
  options: ConversationExecutionFixtureOptions,
  sequence: number,
  overrides: Omit<Partial<SurfaceExecutionEventV1>, 'sequence'>,
): SurfaceExecutionEventV1 {
  const startedAt = options.now - (7 - sequence) * 1_000;
  return {
    version: 1,
    eventId: `conversation-event-${sequence}`,
    sequence,
    sessionId: CONVERSATION_SURFACE_SESSION_ID,
    conversationId: options.conversationId,
    runId: CONVERSATION_RUN_ID,
    agentId: CONVERSATION_AGENT_ID,
    surface: 'browser',
    provider: 'managed-playwright',
    sessionState: 'running',
    phase: 'observe',
    status: 'succeeded',
    userSummary: 'Surface 执行状态已更新',
    evidenceRefs: [],
    artifactRefs: [],
    availableControls: controlsForState('running'),
    startedAt,
    completedAt: startedAt + 400,
    ...overrides,
  };
}

export function buildConversationExecutionSnapshot(
  options: ConversationExecutionFixtureOptions,
): SurfaceConversationSnapshotV1 {
  const target = {
    kind: 'browser' as const,
    browserInstanceId: 'browser-conversation-workbuddy',
    windowRef: 'window-conversation-workbuddy',
    tabRef: 'tab-conversation-workbuddy',
    origin: 'http://127.0.0.1/workbuddy/travel-site',
    documentRevision: 'document-conversation-workbuddy-v2',
    title: 'WorkBuddy 旅行站点 · 已复验',
  };
  const events: SurfaceExecutionEventV1[] = [
    event(options, 1, {
      phase: 'prepare',
      userSummary: '已建立本次会话独立的托管浏览器环境',
      target,
    }),
    event(options, 2, {
      phase: 'observe',
      userSummary: '已打开生成后的旅行网站首页',
      target,
      observation: {
        verdict: 'pass',
        findings: ['首页、路线、住宿和预算四个板块均已呈现'],
        confidence: 0.99,
      },
    }),
    event(options, 3, {
      phase: 'act',
      userSummary: '已调整第二张 Hero 图片的裁切与文案',
      target,
      operation: {
        action: '调整图片裁切与文案',
        risk: 'low',
        approvalScope: 'authorized-target',
        expectedOutcome: '图片主体完整且标题不遮挡',
      },
    }),
    event(options, 4, {
      phase: 'verify',
      userSummary: `已读取最新页面截图；${CONVERSATION_EXECUTION_CANARY}`,
      target,
      observation: {
        verdict: 'pass',
        findings: [
          '四个业务板块完整',
          'Hero 图片主体未被裁切',
          `敏感校验串 ${CONVERSATION_EXECUTION_CANARY} 不得进入会话展示`,
        ],
        confidence: 0.98,
      },
      evidenceRefs: ['evidence-conversation-screenshot'],
      artifactRefs: ['artifact://travel-site-final.html', 'artifact://travel-site-final.png'],
    }),
    event(options, 5, {
      phase: 'artifact',
      userSummary: 'HTML 与 PNG 交付物已保存到会话产物区',
      target,
      evidenceRefs: ['evidence-conversation-screenshot'],
      artifactRefs: ['artifact://travel-site-final.html', 'artifact://travel-site-final.png'],
    }),
    event(options, 6, {
      phase: 'recover',
      status: 'waiting',
      userSummary: '检测到页面 revision 更新，正在基于最新截图恢复',
      target,
      completedAt: undefined,
    }),
  ];
  const session: SurfaceSessionProjectionV1 = {
    version: 1,
    session: {
      version: 1,
      sessionId: CONVERSATION_SURFACE_SESSION_ID,
      runId: CONVERSATION_RUN_ID,
      taskId: 'task-conversation-workbuddy',
      turnId: 'turn-conversation-workbuddy',
      conversationId: options.conversationId,
      agentId: CONVERSATION_AGENT_ID,
      surface: 'browser',
      provider: 'managed-playwright',
      capabilities: {
        version: 1,
        surface: 'browser',
        provider: 'managed-playwright',
        protocolVersion: '2',
        operations: ['observe', 'navigate', 'click', 'type', 'screenshot'],
        observationKinds: ['screenshot', 'dom', 'a11y'],
        supports: {
          cancel: true,
          pause: true,
          takeover: true,
          cleanup: true,
          successorObservation: true,
        },
      },
      state: 'running',
      activeTarget: target,
      startedAt: options.now - 75_000,
      heartbeatAt: options.now,
      expiresAt: options.now + 15 * 60_000,
    },
    grant: {
      state: 'active',
      capabilities: ['observe', 'input', 'navigate', 'file'],
      actionClasses: ['read', 'write', 'navigation'],
      dataScopes: ['authorized-target', 'screenshot-proof'],
      expiresAt: options.now + 15 * 60_000,
    },
    events,
    evidence: [{
      version: 1,
      evidenceId: 'evidence-conversation-screenshot',
      kind: 'screenshot',
      source: 'browser',
      title: '旅行网站最终复验截图',
      summary: '真实 System Chrome 截图已读取；四个板块完整，图片裁切已修复。',
      capturedAt: options.now - 2_000,
      assetRef: options.evidenceAssetRef,
      observationStateId: 'document-conversation-workbuddy-v2',
      redactionStatus: 'clean',
      inspection: {
        captureState: 'captured',
        analysisState: 'analyzed',
        verificationState: 'verified',
        inspectedBy: {
          kind: 'service',
          id: 'conversation-acceptance-deterministic-inspector',
          method: 'dom',
        },
        inspectedAt: options.now - 1_500,
        supportsStepIds: ['observe-page', 'verify-layout', 'verify-image-crop'],
        checklist: [
          { id: 'layout', label: '四个业务板块完整', status: 'passed' },
          { id: 'hero', label: 'Hero 图片主体完整', status: 'passed' },
          { id: 'artifact', label: 'HTML 与 PNG 产物可用', status: 'passed' },
        ],
      },
    }],
    outputs: [
      {
        ref: 'artifact://travel-site-final.html',
        kind: 'file',
        label: 'travel-site-final.html',
        createdAt: options.now - 1_000,
      },
      {
        ref: 'artifact://travel-site-final.png',
        kind: 'artifact',
        label: 'travel-site-final.png',
        createdAt: options.now - 900,
      },
      {
        ref: 'trace://conversation-execution-proof',
        kind: 'trace',
        label: 'conversation-execution-proof.json',
        createdAt: options.now - 800,
      },
    ],
    availableControls: controlsForState('running'),
    source: 'live',
    writable: true,
    updatedAt: options.now,
  };

  return {
    version: 1,
    conversationId: options.conversationId,
    sessions: [session],
    updatedAt: options.now,
  };
}

function transitionEvent(
  snapshot: SurfaceConversationSnapshotV1,
  action: ConversationAcceptanceControlAction,
  now: number,
  state: SurfaceSessionStateV1,
): SurfaceExecutionEventV1 {
  const session = snapshot.sessions[0];
  const sequence = (session?.events.at(-1)?.sequence ?? 0) + 1;
  const phase = action === 'takeover'
    ? 'human'
    : action === 'stop' || action === 'end_session'
      ? 'cleanup'
      : action === 'resume'
        ? 'recover'
        : 'human';
  const status = action === 'takeover'
    ? 'waiting'
    : action === 'stop'
      ? 'running'
      : 'succeeded';
  const summary = {
    pause: '执行已暂停，当前 Session 与目标状态均已保留',
    resume: '已基于最新目标状态继续执行',
    takeover: 'Neo 已释放输入控制，等待你完成操作',
    stop: '停止请求已生效，不再发出新操作',
    end_session: 'Session 已结束，目标资源进入清理完成态',
  }[action] ?? 'Surface 控制已生效';

  return {
    version: 1,
    eventId: `conversation-control-${action}-${sequence}`,
    sequence,
    sessionId: CONVERSATION_SURFACE_SESSION_ID,
    conversationId: snapshot.conversationId,
    runId: CONVERSATION_RUN_ID,
    agentId: CONVERSATION_AGENT_ID,
    surface: 'browser',
    provider: 'managed-playwright',
    sessionState: state,
    phase,
    status,
    userSummary: summary,
    evidenceRefs: ['evidence-conversation-screenshot'],
    artifactRefs: [],
    availableControls: controlsForState(state),
    startedAt: now,
    ...(status === 'succeeded' ? { completedAt: now + 1 } : {}),
  };
}

export function transitionConversationExecutionSnapshot(
  snapshot: SurfaceConversationSnapshotV1,
  action: ConversationAcceptanceControlAction,
  now: number,
): SurfaceConversationSnapshotV1 {
  const state: SurfaceSessionStateV1 = action === 'pause'
    ? 'paused'
    : action === 'resume'
      ? 'running'
      : action === 'takeover'
        ? 'waiting_human'
        : action === 'stop'
          ? 'stopping'
          : 'completed';
  const current = snapshot.sessions[0];
  if (!current) throw new Error('Conversation acceptance snapshot has no Surface Session');
  const nextEvent = transitionEvent(snapshot, action, now, state);
  const next: SurfaceSessionProjectionV1 = {
    ...current,
    session: {
      ...current.session,
      state,
      heartbeatAt: now,
    },
    events: [...current.events, nextEvent],
    availableControls: controlsForState(state),
    writable: state !== 'completed',
    updatedAt: now,
  };
  return {
    ...snapshot,
    sessions: [next],
    updatedAt: now,
  };
}
