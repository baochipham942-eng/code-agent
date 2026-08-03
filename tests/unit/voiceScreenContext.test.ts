// 看屏进 Live（Appshots Phase 3）的接线门。
//
// 钉的是「执行侧真收到了那张图」，不是「工具返回了一句好听的话」：
//   · 注册面：工具在目录里、schema 朴素（零参数），零写权限的底线没破；
//   · fail-closed 三态：无权限 / 采集抛错 / 正常，前两态必须**明说没拍到**并指路开权限，
//     且明令不许描述画面——这条链最坏的失败不是拍不到，是拍不到却回一句像成功的话；
//   · 附着真到位：spawn_task 那一轮的 `startTask(attachments)` 里真有 appshot 图片附件，
//     turnSystemContext 里真有 `<appshot>` 块。只断言工具返回文本等于什么都没测。
//
// 采集服务整块被替掉：CI 没有屏幕录制权限，真跑一次 screencapture 就是一个必挂的用例。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentRunOptions } from '../../src/host/research/types';
import type { MessageAttachment } from '../../src/shared/contract/message';
import type { VoiceScreenCaptureResult } from '../../src/host/services/voice/voiceScreenContext';

type FakeEvent = { type: string; sessionId: string; data?: unknown };

const runtime = vi.hoisted(() => ({
  listeners: new Set<(event: FakeEvent) => void>(),
  status: 'idle' as string,
  startTask: vi.fn(async (
    _sessionId: string,
    _message: string,
    _attachments: unknown,
    _options: AgentRunOptions,
  ) => undefined),
  interruptAndContinue: vi.fn(async (
    _sessionId: string,
    _message: string,
    _attachments: unknown,
    _options: AgentRunOptions,
  ) => ({ outcome: 'steered' as const })),
  cancelTask: vi.fn(async (_sessionId: string) => undefined),
  emit(type: string, sessionId = 'session-1', data?: unknown) {
    for (const listener of [...this.listeners]) listener({ type, sessionId, data });
  },
}));

/** 采集服务的替身。每个用例自己决定这一次「屏幕」返回什么。 */
const capture = vi.hoisted(() => ({
  result: null as VoiceScreenCaptureResult | null,
  calls: 0,
}));

const spans = vi.hoisted(() => [] as Array<{ name: string; attributes: Record<string, unknown> }>);

vi.mock('../../src/host/services/voice/voiceScreenContext', () => ({
  isVoiceScreenContextSupported: () => true,
  captureVoiceScreenContext: async () => {
    capture.calls += 1;
    if (!capture.result) throw new Error('test did not stage a capture result');
    return capture.result;
  },
}));
vi.mock('../../src/host/task', () => ({
  getTaskManager: () => ({
    on: (_event: string, listener: (event: FakeEvent) => void) => { runtime.listeners.add(listener); },
    off: (_event: string, listener: (event: FakeEvent) => void) => { runtime.listeners.delete(listener); },
    observeAgentEvents: () => () => {},
    getSessionState: () => ({ status: runtime.status }),
    startTask: runtime.startTask,
    interruptAndContinue: runtime.interruptAndContinue,
    cancelTask: runtime.cancelTask,
  }),
}));
vi.mock('../../src/host/telemetry/telemetryService', () => ({
  getTelemetryService: () => ({
    startSpan: (name: string, _kind: string, attributes: Record<string, unknown>) => {
      spans.push({ name, attributes });
      return { spanId: `span-${spans.length}` };
    },
    endSpan: () => undefined,
  }),
}));
vi.mock('../../src/host/services/roleAssets/roleAssetService', () => ({
  buildRoleContextBlock: async () => null,
}));
vi.mock('../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ voice: { live: {} } }) }),
}));
vi.mock('../../src/host/services/planning/taskStore', () => ({
  getIncompleteTasks: () => [],
}));
vi.mock('../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: async () => ({ messages: [] }),
    addMessageToSession: async () => undefined,
  }),
}));
vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../src/host/session/completionSummaryService', () => ({
  readLatestCompletionSummaryRecord: async () => ({
    changedFiles: ['/repo/src/a.ts'],
    artifactRefs: [],
    commitIds: [],
    verificationEvidence: [],
    endedAt: Number.MAX_SAFE_INTEGER,
  }),
}));
vi.mock('../../src/host/agent/agentRegistry', () => ({ resolveAgent: () => undefined }));
vi.mock('../../src/host/connectors', () => ({
  getConnectorRegistry: () => ({ get: () => undefined }),
}));

const { executeVoiceTool, VOICE_TOOL_DEFINITIONS } = await import('../../src/host/services/voice/voiceTools');
const { beginVoiceDispatch, endVoiceDispatch } = await import('../../src/host/services/voice/voiceAgentCoordinator');
const { VOICE_SCREEN_CONTEXT_TTL_MS } = await import('../../src/shared/constants/voice');

const PNG_DATA_URL = 'data:image/png;base64,aGVsbG8=';

function stagedCapture(overrides: Record<string, unknown> = {}): VoiceScreenCaptureResult {
  return {
    ok: true,
    capture: {
      requestId: 'voice-screen-1',
      appName: 'Figma',
      windowTitle: '首页改版',
      screenshotPath: '/tmp/voice-screen-1.png',
      screenshotDataUrl: PNG_DATA_URL,
      axText: null,
      textSource: 'none',
      windowFrame: { x: 0, y: 0, width: 0, height: 0 },
      capturedAtMs: Date.now(),
      ...overrides,
    },
  };
}

function bind(): void {
  beginVoiceDispatch({
    neoSessionId: 'session-1',
    voiceSessionId: 'voice-1',
    onWorkItem: () => {},
    onWorkFailed: () => {},
    onEndCall: () => {},
    onWorkNarration: () => {},
  });
}

/** 最后一次派活带的附件。没派过就抛，免得把「没调用」读成「没有附件」。 */
function lastStartTaskAttachments(): MessageAttachment[] | undefined {
  const call = runtime.startTask.mock.calls.at(-1);
  if (!call) throw new Error('startTask was never called');
  return call[2] as MessageAttachment[] | undefined;
}

function lastStartTaskSystemContext(): string[] {
  const call = runtime.startTask.mock.calls.at(-1);
  if (!call) throw new Error('startTask was never called');
  return call[3]?.turnSystemContext ?? [];
}

describe('看屏进 Live（Appshots Phase 3）', () => {
  beforeEach(() => {
    runtime.startTask.mockClear();
    runtime.interruptAndContinue.mockClear();
    runtime.cancelTask.mockClear();
    runtime.status = 'idle';
    capture.result = null;
    capture.calls = 0;
    spans.length = 0;
    bind();
  });

  afterEach(() => {
    runtime.emit('task_cancelled');
    endVoiceDispatch();
  });

  it('注册面：工具在目录里，schema 朴素到没有参数（通话 brain 零写权限）', () => {
    const tool = VOICE_TOOL_DEFINITIONS.find((item) => item.name === 'capture_screen_context');
    expect(tool).toBeDefined();
    expect(tool?.parameters).toEqual({ type: 'object', properties: {}, required: [] });
    // DashScope 对 tools 的支持按模型分化，复杂 schema 是静默降级的高发区（见 voiceTools 文件头）。
    expect(JSON.stringify(tool?.parameters)).not.toContain('enum');
    // 描述里必须写死「你看不到」——不写它，模型拍完就会顺嘴描述画面。
    expect(tool?.description).toContain('不会给你');
  });

  it('intent 解析：工具名进来，走 dispatchVoiceIntent 那一个出口出去', async () => {
    capture.result = stagedCapture();
    const spoken = await executeVoiceTool('capture_screen_context', '{}');
    expect(capture.calls).toBe(1);
    expect(spoken).toContain('已经拍下用户此刻的屏幕');
    // 元数据取到了就报给通话 brain，方便它跟用户对齐「我拍的是这个」。
    expect(spoken).toContain('Figma');
  });

  it('fail-closed ①无权限：明说没拍到 + 指路开权限 + 禁止描述画面', async () => {
    capture.result = { ok: false, reason: 'no_permission' };
    const spoken = await executeVoiceTool('capture_screen_context', '{}');

    expect(spoken).toContain('没能拍到屏幕');
    expect(spoken).toContain('屏幕录制');
    expect(spoken).toContain('不许描述屏幕上有什么');
    // 没拍到就不许留下任何可附着的东西：随后的派活必须是干净的。
    await executeVoiceTool('spawn_task', JSON.stringify({ title: '改标题', prompt: '把标题改成 A' }));
    expect(lastStartTaskAttachments()).toBeUndefined();
  });

  it('fail-closed ②采集抛错：同样明说没拍到，不含任何「拍到了」的说法', async () => {
    capture.result = { ok: false, reason: 'capture_failed', detail: 'screenshot file is empty' };
    const spoken = await executeVoiceTool('capture_screen_context', '{}');

    expect(spoken).toContain('没能拍到屏幕');
    expect(spoken).toContain('屏幕录制');
    expect(spoken).not.toContain('已经拍下');
    // 内部错误细节是给日志的，不该出现在念给用户的台词里。
    expect(spoken).not.toContain('screenshot file is empty');
  });

  it('fail-closed ③这台机器不支持：不虚构能力，如实说看不了', async () => {
    capture.result = { ok: false, reason: 'unsupported_platform' };
    const spoken = await executeVoiceTool('capture_screen_context', '{}');

    expect(spoken).toContain('这台电脑不支持看屏');
    expect(spoken).not.toContain('已经拍下');
  });

  it('三态各留一条遥测（维度是 voiceSessionId，因为此刻还没有 workItemId）', async () => {
    capture.result = stagedCapture();
    await executeVoiceTool('capture_screen_context', '{}');
    capture.result = { ok: false, reason: 'no_permission' };
    await executeVoiceTool('capture_screen_context', '{}');
    capture.result = { ok: false, reason: 'capture_failed' };
    await executeVoiceTool('capture_screen_context', '{}');

    const captures = spans.filter((span) => span.attributes['voice_work.phase'] === 'screen_capture');
    expect(captures.map((span) => span.attributes['voice_work.capture_outcome'])).toEqual([
      'captured',
      'no_permission',
      'capture_failed',
    ]);
    expect(captures.every((span) => span.attributes['voice_work.voice_session_id'] === 'voice-1')).toBe(true);
  });

  it('附着真到位：派活那一轮的附件里有 appshot 图，system 上下文里有 <appshot> 块', async () => {
    capture.result = stagedCapture();
    await executeVoiceTool('capture_screen_context', '{}');
    await executeVoiceTool('spawn_task', JSON.stringify({ title: '照着屏幕改', prompt: '把屏幕上这个按钮改成蓝色' }));

    const attachments = lastStartTaskAttachments();
    expect(attachments).toHaveLength(1);
    // `appshot-` 前缀是 converter 认「这是截图上下文」的唯一凭据，不能改名。
    expect(attachments?.[0]?.id).toBe('appshot-voice-screen-1');
    expect(attachments?.[0]?.type).toBe('image');
    expect(attachments?.[0]?.data).toBe(PNG_DATA_URL);

    const screenBlock = lastStartTaskSystemContext().find((block) => block.includes('<appshot'));
    expect(screenBlock).toBeDefined();
    // 来路要说对：这是通话里采的整屏，不是热键截的窗口。写错就是对执行侧撒谎。
    expect(screenBlock).toContain('实时通话');
    expect(screenBlock).toContain('整屏');
    expect(screenBlock).not.toContain('快捷键');
  });

  it('改方向那一轮同样带得上（steer 也是执行侧的一轮）', async () => {
    runtime.status = 'idle';
    await executeVoiceTool('spawn_task', JSON.stringify({ title: '先跑一件', prompt: '随便做点什么' }));
    runtime.status = 'running';
    capture.result = stagedCapture();
    await executeVoiceTool('capture_screen_context', '{}');
    await executeVoiceTool('steer_task', JSON.stringify({ instruction: '按屏幕上这个来改' }));

    const call = runtime.interruptAndContinue.mock.calls.at(-1);
    expect(call).toBeDefined();
    const attachments = call?.[2] as MessageAttachment[] | undefined;
    expect(attachments).toHaveLength(1);
    expect(attachments?.[0]?.id).toBe('appshot-voice-screen-1');
  });

  it('一次性：拍一次只跟着一轮走，后面的活不再拖着同一张旧图', async () => {
    capture.result = stagedCapture();
    await executeVoiceTool('capture_screen_context', '{}');
    await executeVoiceTool('spawn_task', JSON.stringify({ title: '第一件', prompt: '照屏幕改' }));
    expect(lastStartTaskAttachments()).toHaveLength(1);

    runtime.emit('task_completed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.status = 'idle';

    await executeVoiceTool('spawn_task', JSON.stringify({ title: '第二件', prompt: '跟屏幕没关系的活' }));
    expect(lastStartTaskAttachments()).toBeUndefined();
    expect(lastStartTaskSystemContext().some((block) => block.includes('<appshot'))).toBe(false);
  });

  it('过了保质期就不附：宁可执行侧说没看到图，也不喂它一张过期的屏幕', async () => {
    capture.result = stagedCapture({ capturedAtMs: Date.now() - VOICE_SCREEN_CONTEXT_TTL_MS - 1 });
    await executeVoiceTool('capture_screen_context', '{}');
    await executeVoiceTool('spawn_task', JSON.stringify({ title: '很久以后的活', prompt: '做点别的' }));

    expect(lastStartTaskAttachments()).toBeUndefined();
  });

  it('挂断清掉待附着的屏幕：电话结束了，它就不再是任何人的当下', async () => {
    capture.result = stagedCapture();
    await executeVoiceTool('capture_screen_context', '{}');
    endVoiceDispatch();
    bind();

    await executeVoiceTool('spawn_task', JSON.stringify({ title: '下一通电话里的活', prompt: '做点什么' }));
    expect(lastStartTaskAttachments()).toBeUndefined();
  });
});
