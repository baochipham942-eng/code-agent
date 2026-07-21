import type {
  SurfaceEvidenceKindV1,
  SurfaceExecutionControlV1,
  SurfaceSessionStateV1,
} from '@shared/contract/surfaceExecution';

type SurfacePhaseV1 = 'prepare' | 'observe' | 'act' | 'verify' | 'human' | 'recover' | 'artifact' | 'cleanup';
type SurfaceEventStatusV1 = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'ambiguous' | 'cancelled';

export interface SurfaceExecutionTranslationsV1 {
  panel: {
    label: string;
    sessionCount: string;
    native: string;
    compatibility: string;
  };
  surface: Record<'browser' | 'computer', string>;
  provider: Record<'managed' | 'relay' | 'computer' | 'other', string>;
  state: Record<SurfaceSessionStateV1, string>;
  target: {
    browser: string;
    computer: string;
    unavailable: string;
  };
  controller: {
    label: string;
    agent: string;
    human: string;
    archive: string;
  };
  isolation: {
    label: string;
    managed: string;
    relay: string;
    computer: string;
    other: string;
  };
  timing: {
    elapsed: string;
    heartbeat: string;
    justNow: string;
    minutes: string;
    hours: string;
  };
  permission: {
    title: string;
    grantActive: string;
    grantConsumed: string;
    grantRevoked: string;
    grantExpired: string;
    grantNone: string;
    capabilities: string;
    actionScope: string;
    dataScope: string;
    expires: string;
    readonly: string;
    capability: Record<'observe' | 'input' | 'navigate' | 'file' | 'secret' | 'destructive', string>;
  };
  timeline: {
    title: string;
    empty: string;
    findings: string;
    phase: Record<SurfacePhaseV1, string>;
    status: Record<SurfaceEventStatusV1, string>;
    verdict: Record<'pass' | 'partial' | 'fail' | 'inconclusive' | 'not_requested', string>;
  };
  evidence: {
    title: string;
    empty: string;
    kind: Record<SurfaceEvidenceKindV1, string>;
    source: Record<'browser' | 'computer' | 'compat', string>;
    assetReady: string;
    previewLoading: string;
    previewUnavailable: string;
    previewExpand: string;
    previewCollapse: string;
    captureSource: string;
    captureViewport: string;
    capturedAt: string;
    capture: string;
    analysis: string;
    verification: string;
    captureState: Record<'captured' | 'unavailable' | 'blocked', string>;
    analysisState: Record<'not_requested' | 'analyzing' | 'analyzed' | 'failed', string>;
    analysisIncomplete: string;
    verificationState: Record<'not_requested' | 'verified' | 'rejected' | 'inconclusive', string>;
    checklist: string;
    checklistState: Record<'passed' | 'failed' | 'inconclusive' | 'not_checked', string>;
    redaction: Record<'clean' | 'redacted' | 'blocked', string>;
  };
  resources: {
    outputs: string;
    evidence: string;
    sources: string;
    emptyOutputs: string;
    emptySources: string;
    readonlySource: string;
    openOutput: string;
    closeOutput: string;
    loadingOutput: string;
    unavailableOutput: string;
    readonlyOutput: string;
    truncatedOutput: string;
    outputKind: Record<'artifact' | 'file' | 'download' | 'trace', string>;
  };
  takeover: {
    title: string;
    description: string;
  };
  recovery: {
    title: string;
    description: string;
  };
  controls: {
    label: string;
    readonly: string;
    unavailable: string;
    pending: string;
    failed: string;
    action: Record<Exclude<SurfaceExecutionControlV1, 'skip'>, string>;
    hint: Record<Exclude<SurfaceExecutionControlV1, 'skip'>, string>;
  };
  fallback: {
    stage: string;
    evidence: string;
    output: string;
    source: string;
  };
}

export const surfaceExecutionZh: SurfaceExecutionTranslationsV1 = {
  panel: {
    label: 'Surface 执行',
    sessionCount: '{count} 个执行会话',
    native: '实时执行账本',
    compatibility: '历史兼容记录',
  },
  surface: { browser: '浏览器', computer: '电脑' },
  provider: { managed: '托管浏览器', relay: '授权标签页', computer: '本机电脑', other: '交互环境' },
  state: {
    preparing: '准备中',
    waiting_permission: '等待授权',
    running: '执行中',
    waiting_human: '等待你操作',
    paused: '已暂停',
    stopping: '正在停止',
    completed: '已完成',
    failed: '执行失败',
  },
  target: { browser: '当前页面', computer: '当前窗口', unavailable: '目标尚未就绪' },
  controller: { label: '当前控制者', agent: 'Neo', human: '你', archive: '只读记录' },
  isolation: {
    label: '隔离边界',
    managed: '本次会话独立环境',
    relay: '仅限已授权标签页',
    computer: '仅限当前应用窗口',
    other: '仅限本次执行目标',
  },
  timing: {
    elapsed: '已运行 {time}',
    heartbeat: '最近更新 {time}',
    justNow: '刚刚',
    minutes: '{count} 分钟前',
    hours: '{count} 小时前',
  },
  permission: {
    title: '权限范围',
    grantActive: '授权有效',
    grantConsumed: '授权已使用',
    grantRevoked: '授权已撤销',
    grantExpired: '授权已过期',
    grantNone: '未授予操作权限',
    capabilities: '能力',
    actionScope: '{count} 类允许动作',
    dataScope: '{count} 个数据范围',
    expires: '到期 {time}',
    readonly: '历史记录不会恢复旧授权；续跑会创建新的受控执行',
    capability: {
      observe: '观察',
      input: '输入',
      navigate: '导航',
      file: '文件',
      secret: '敏感信息',
      destructive: '高风险操作',
    },
  },
  timeline: {
    title: '执行时间线',
    empty: '还没有可展示的执行节点',
    findings: '判断',
    phase: {
      prepare: '准备',
      observe: '观察',
      act: '操作',
      verify: '验证',
      human: '接管',
      recover: '恢复',
      artifact: '产物',
      cleanup: '清理',
    },
    status: {
      queued: '排队中',
      running: '进行中',
      waiting: '等待中',
      succeeded: '已完成',
      failed: '失败',
      ambiguous: '结果待确认',
      cancelled: '已取消',
    },
    verdict: {
      pass: '通过',
      partial: '部分符合',
      fail: '未通过',
      inconclusive: '无法确认',
      not_requested: '尚未验证',
    },
  },
  evidence: {
    title: '证据',
    empty: '还没有持久证据',
    kind: {
      screenshot: '截图',
      dom: '页面结构',
      a11y: '可访问性结构',
      ax: '应用结构',
      window: '窗口状态',
      network: '网络记录',
      console: '控制台记录',
    },
    source: { browser: '浏览器', computer: '电脑', compat: '历史记录' },
    assetReady: '原始证据已保存',
    previewLoading: '正在读取证据画面…',
    previewUnavailable: '证据画面不可用，记录仍已保留',
    previewExpand: '放大查看证据',
    previewCollapse: '收起证据',
    captureSource: '采集对象',
    captureViewport: '画面尺寸',
    capturedAt: '采集于 {time}',
    capture: '采集',
    analysis: '读取',
    verification: '验证',
    captureState: { captured: '已采集', unavailable: '不可用', blocked: '已阻断' },
    analysisState: {
      not_requested: '未读取',
      analyzing: '读取中',
      analyzed: '已读取',
      failed: '读取失败',
    },
    analysisIncomplete: '读取记录不完整',
    verificationState: {
      not_requested: '未验证',
      verified: '已通过',
      rejected: '未通过',
      inconclusive: '无法确认',
    },
    checklist: '检查项',
    checklistState: {
      passed: '通过',
      failed: '失败',
      inconclusive: '待确认',
      not_checked: '未检查',
    },
    redaction: { clean: '无敏感内容', redacted: '已脱敏', blocked: '敏感内容已阻断' },
  },
  resources: {
    outputs: '产物',
    evidence: '证据',
    sources: '来源',
    emptyOutputs: '暂无产物',
    emptySources: '暂无可展示来源',
    readonlySource: '只读来源',
    openOutput: '打开产物',
    closeOutput: '收起产物',
    loadingOutput: '正在读取…',
    unavailableOutput: '产物不可用',
    readonlyOutput: '只读记录',
    truncatedOutput: '内容较长，这里仅展示安全预览。',
    outputKind: { artifact: '产物', file: '文件', download: '下载', trace: '执行记录' },
  },
  takeover: { title: '需要你接管', description: 'Neo 已释放输入控制。完成操作后可继续执行。' },
  recovery: { title: '执行正在恢复', description: '目标状态发生变化，Neo 会基于新证据继续。' },
  controls: {
    label: '执行控制',
    readonly: '历史记录只读',
    unavailable: '当前没有可用控制',
    pending: '正在处理…',
    failed: '控制请求未生效，请根据最新状态重试。',
    action: {
      pause: '暂停',
      resume: '继续',
      continue: '从检查点续跑',
      takeover: '我来操作',
      stop: '停止',
      end_session: '结束 Session',
    },
    hint: {
      pause: '暂停后保留当前 Session，可继续执行',
      resume: '基于最新目标状态继续执行',
      continue: '创建新的受控执行，并以这条只读记录为父 Session',
      takeover: '释放 Neo 的输入控制，由你完成操作',
      stop: '停止当前执行，不再发出新操作',
      end_session: '结束 Session 并清理目标资源',
    },
  },
  fallback: { stage: '执行状态已更新', evidence: '执行证据', output: '未命名产物', source: '执行来源' },
};

const surfaceExecutionEn: SurfaceExecutionTranslationsV1 = {
  panel: {
    label: 'Surface execution',
    sessionCount: '{count} execution sessions',
    native: 'Live execution ledger',
    compatibility: 'Historical compatibility record',
  },
  surface: { browser: 'Browser', computer: 'Computer' },
  provider: { managed: 'Managed browser', relay: 'Authorized tab', computer: 'Local computer', other: 'Interactive surface' },
  state: {
    preparing: 'Preparing',
    waiting_permission: 'Waiting for permission',
    running: 'Running',
    waiting_human: 'Waiting for you',
    paused: 'Paused',
    stopping: 'Stopping',
    completed: 'Completed',
    failed: 'Failed',
  },
  target: { browser: 'Current page', computer: 'Current window', unavailable: 'Target is not ready' },
  controller: { label: 'Controller', agent: 'Neo', human: 'You', archive: 'Read-only record' },
  isolation: {
    label: 'Isolation',
    managed: 'Dedicated to this conversation',
    relay: 'Authorized tab only',
    computer: 'Current app window only',
    other: 'Current execution target only',
  },
  timing: {
    elapsed: 'Running for {time}',
    heartbeat: 'Updated {time}',
    justNow: 'just now',
    minutes: '{count} minutes ago',
    hours: '{count} hours ago',
  },
  permission: {
    title: 'Permission scope',
    grantActive: 'Permission active',
    grantConsumed: 'Permission consumed',
    grantRevoked: 'Permission revoked',
    grantExpired: 'Permission expired',
    grantNone: 'No operation permission',
    capabilities: 'Capabilities',
    actionScope: '{count} allowed action classes',
    dataScope: '{count} data scopes',
    expires: 'Expires {time}',
    readonly: 'History never restores old authority; continuation creates a new controlled run',
    capability: {
      observe: 'Observe',
      input: 'Input',
      navigate: 'Navigate',
      file: 'Files',
      secret: 'Secrets',
      destructive: 'High-risk actions',
    },
  },
  timeline: {
    title: 'Execution timeline',
    empty: 'No execution milestones yet',
    findings: 'Assessment',
    phase: {
      prepare: 'Prepare',
      observe: 'Observe',
      act: 'Act',
      verify: 'Verify',
      human: 'Takeover',
      recover: 'Recover',
      artifact: 'Output',
      cleanup: 'Cleanup',
    },
    status: {
      queued: 'Queued',
      running: 'Running',
      waiting: 'Waiting',
      succeeded: 'Completed',
      failed: 'Failed',
      ambiguous: 'Needs confirmation',
      cancelled: 'Cancelled',
    },
    verdict: {
      pass: 'Passed',
      partial: 'Partially passed',
      fail: 'Failed',
      inconclusive: 'Inconclusive',
      not_requested: 'Not verified',
    },
  },
  evidence: {
    title: 'Evidence',
    empty: 'No durable evidence yet',
    kind: {
      screenshot: 'Screenshot',
      dom: 'Page structure',
      a11y: 'Accessibility tree',
      ax: 'App structure',
      window: 'Window state',
      network: 'Network record',
      console: 'Console record',
    },
    source: { browser: 'Browser', computer: 'Computer', compat: 'Historical record' },
    assetReady: 'Original evidence saved',
    previewLoading: 'Loading evidence frame…',
    previewUnavailable: 'Evidence frame unavailable; the record remains preserved',
    previewExpand: 'Expand evidence',
    previewCollapse: 'Collapse evidence',
    captureSource: 'Captured target',
    captureViewport: 'Frame size',
    capturedAt: 'Captured {time}',
    capture: 'Capture',
    analysis: 'Read',
    verification: 'Verification',
    captureState: { captured: 'Captured', unavailable: 'Unavailable', blocked: 'Blocked' },
    analysisState: {
      not_requested: 'Not read',
      analyzing: 'Reading',
      analyzed: 'Read',
      failed: 'Read failed',
    },
    analysisIncomplete: 'Inspection record incomplete',
    verificationState: {
      not_requested: 'Not verified',
      verified: 'Passed',
      rejected: 'Rejected',
      inconclusive: 'Inconclusive',
    },
    checklist: 'Checklist',
    checklistState: {
      passed: 'Passed',
      failed: 'Failed',
      inconclusive: 'Inconclusive',
      not_checked: 'Not checked',
    },
    redaction: { clean: 'No sensitive content', redacted: 'Redacted', blocked: 'Sensitive content blocked' },
  },
  resources: {
    outputs: 'Outputs',
    evidence: 'Evidence',
    sources: 'Sources',
    emptyOutputs: 'No outputs yet',
    emptySources: 'No displayable sources',
    readonlySource: 'Read-only source',
    openOutput: 'Open output',
    closeOutput: 'Close output',
    loadingOutput: 'Loading…',
    unavailableOutput: 'Output unavailable',
    readonlyOutput: 'Read-only record',
    truncatedOutput: 'This safe preview shows only part of the output.',
    outputKind: { artifact: 'Artifact', file: 'File', download: 'Download', trace: 'Execution record' },
  },
  takeover: { title: 'Your action is needed', description: 'Neo released input control. Resume when you are done.' },
  recovery: { title: 'Execution is recovering', description: 'The target changed. Neo will continue from fresh evidence.' },
  controls: {
    label: 'Execution controls',
    readonly: 'Historical record is read-only',
    unavailable: 'No controls are available right now',
    pending: 'Applying…',
    failed: 'The control did not take effect. Retry from the latest state.',
    action: {
      pause: 'Pause',
      resume: 'Resume',
      continue: 'Continue from checkpoint',
      takeover: 'Take over',
      stop: 'Stop',
      end_session: 'End session',
    },
    hint: {
      pause: 'Pause and retain the session for later resume',
      resume: 'Continue from the latest observed target state',
      continue: 'Create a new controlled run linked to this read-only checkpoint',
      takeover: 'Release Neo input control so you can act',
      stop: 'Stop execution and prevent new operations',
      end_session: 'End the session and clean up target resources',
    },
  },
  fallback: { stage: 'Execution state updated', evidence: 'Execution evidence', output: 'Untitled output', source: 'Execution source' },
};

export function getSurfaceExecutionTranslations(
  language: 'zh' | 'en',
): SurfaceExecutionTranslationsV1 {
  return language === 'en' ? surfaceExecutionEn : surfaceExecutionZh;
}

export function formatSurfaceExecutionCopy(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  ));
}
