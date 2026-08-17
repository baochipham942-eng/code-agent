// ============================================================================
// 语音通话审计时间线（N-L7-AUDIT）——判据 2 的钉子：
// 「查过了确实没有」(none) 和「没法查」(unavailable) 必须长得不一样。
// 证据档位：hermetic-protocol（DB 与路径 mock，日志文件真读真写）。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dbMock = {
  listVoiceCallSummaries: vi.fn(),
  getVoiceMessagesInWindow: vi.fn(),
  getPermissionDecisionsBySession: vi.fn(),
};

vi.mock('../../src/host/services/core/databaseService', () => ({
  getDatabase: () => dbMock,
}));

let tmpDir = '';
vi.mock('../../src/host/platform/appPaths', () => ({
  getUserDataPath: () => tmpDir,
}));

import { getVoiceCallTimeline, formatVoiceCallTimelineMarkdown } from '../../src/host/services/voice/voiceCallAudit';

const CALL_ID = 'voice-1755300000000-1';
const NEO_SESSION = 'neo-session-1';
// 时间取「今天 UTC」内一段，保证日志文件日期可控
const DAY_MS = 24 * 60 * 60 * 1000;
const START = Math.floor(Date.now() / DAY_MS) * DAY_MS + 10 * 60 * 60 * 1000;
const END = START + 60_000;

function summaryMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-summary-1',
    sessionId: NEO_SESSION,
    role: 'system',
    content: '语音通话结束',
    timestamp: END,
    metadata: {
      source: 'voice',
      voiceCallSummary: {
        durationSec: 60,
        provider: 'dashscope-qwen-omni',
        conversationModel: 'qwen3.5-omni-flash-realtime',
        workItemCount: 1,
        startedAt: START,
        endedAt: END,
        transcriptCount: 2,
        voiceCallId: CALL_ID,
        tokens: {
          totalTokens: 1000, inputTokens: 700, outputTokens: 300,
          inputAudioTokens: 500, inputTextTokens: 200, outputAudioTokens: 250, outputTextTokens: 50,
        },
        ...overrides,
      },
    },
  };
}

function writeLogFile(lines: object[]): void {
  const dir = path.join(tmpDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const date = new Date(START).toISOString().slice(0, 10);
  fs.writeFileSync(
    path.join(dir, `code-agent-${date}.log`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-audit-'));
  dbMock.listVoiceCallSummaries.mockReturnValue([summaryMessage()]);
  dbMock.getVoiceMessagesInWindow.mockReturnValue([]);
  dbMock.getPermissionDecisionsBySession.mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getVoiceCallTimeline', () => {
  it('按 voiceCallId 精确聚合：字幕命中、别通电话的消息剔除、host_routed 派单可区分', () => {
    dbMock.getVoiceMessagesInWindow.mockReturnValue([
      {
        id: 'm1', sessionId: NEO_SESSION, role: 'user', content: '帮我整理下载目录',
        timestamp: START + 1000, metadata: { source: 'voice', voiceCallId: CALL_ID },
      },
      {
        // 宽限重连边界上混进窗口的另一通电话——必须剔除，不能算进本通
        id: 'm2', sessionId: NEO_SESSION, role: 'user', content: '别通电话的话',
        timestamp: START + 2000, metadata: { source: 'voice', voiceCallId: 'voice-9999-2' },
      },
      {
        id: 'm3', sessionId: NEO_SESSION, role: 'user', content: '（改写指令）',
        timestamp: START + 3000,
        metadata: { voiceCallId: CALL_ID, voiceDispatch: { title: '整理下载', workItemId: 'voice-work-1', origin: 'host_routed' } },
      },
      {
        id: 'm4', sessionId: NEO_SESSION, role: 'system', content: '[任务结果] 整理下载｜completed｜已完成',
        timestamp: START + 8000,
        metadata: {
          source: 'voice', voiceCallId: CALL_ID,
          voiceWorkSettled: { workItemId: 'voice-work-1', title: '整理下载', outcome: 'done' },
          backgroundTaskResult: {
            source: 'agent-result', taskId: 'voice-work-1', shortName: '整理下载', status: 'completed', summary: '已完成',
            artifacts: [{ kind: 'file', label: '12.md', path: '/repo/12.md' }],
          },
        },
      },
    ]);
    dbMock.getPermissionDecisionsBySession.mockReturnValue([
      {
        recordedAt: START + 5000, toolName: 'bash', summary: 'mv ~/Downloads/*',
        finalOutcome: 'allow', reason: '权限档 bypassPermissions', waitMs: null,
      },
      {
        // 挂断后（run 寿命跟 run 走）：进 after_call，不丢
        recordedAt: END + 60_000, toolName: 'write_file', summary: 'x',
        finalOutcome: 'deny', reason: 'no-approval-ui', waitMs: 1200,
      },
    ]);

    const t = getVoiceCallTimeline(CALL_ID)!;
    expect(t.sections.transcript.events).toHaveLength(1);
    // 终态审计事件转录同消息上的产物账本（N-L7-ARTIFACT 接线）
    expect(t.sections.outcomes.events).toEqual([
      expect.objectContaining({
        kind: 'work_settled',
        detail: expect.objectContaining({
          workItemId: 'voice-work-1',
          artifacts: [{ label: '12.md', path: '/repo/12.md' }],
        }),
      }),
    ]);
    expect(t.sections.transcript.events[0]!.keyMatch).toBe('exact');
    expect(t.sections.dispatches.events).toEqual([
      expect.objectContaining({ workItemId: 'voice-work-1', origin: 'host_routed' }),
    ]);
    expect(t.sections.approvals.events.map((e) => e.phase)).toEqual(['during_call', 'after_call']);
    expect(t.cost.status).toBe('ok');
    expect(t.cost.tokens?.totalTokens).toBe(1000);
  });

  it('日志在但无判定事件 = none；日志已轮转 = unavailable——两种空长得不一样（判据 2）', () => {
    // 日志文件在、但没有本通的判定行
    writeLogFile([{ timestamp: new Date(START).toISOString(), level: 'info', message: 'unrelated', data: [{}] }]);
    const withLog = getVoiceCallTimeline(CALL_ID)!;
    expect(withLog.sections.decisions.status).toBe('none');

    // 日志文件整个不存在（>7 天被轮转删除）
    fs.rmSync(path.join(tmpDir, 'logs'), { recursive: true, force: true });
    const rotated = getVoiceCallTimeline(CALL_ID)!;
    expect(rotated.sections.decisions.status).toBe('unavailable');
    expect(rotated.sections.decisions.note).toContain('轮转');
  });

  it('日志里的打断判定与 say-do 干预按通话键捞出并分段', () => {
    writeLogFile([
      {
        timestamp: new Date(START + 4000).toISOString(), level: 'info',
        message: 'voice interrupt evidence',
        data: [{ voiceSessionId: CALL_ID, tier: 'strong', score: 3, decidedCancel: true }],
      },
      {
        timestamp: new Date(START + 8000).toISOString(), level: 'warn',
        message: 'voice say/do guard intervened',
        data: [{
          voiceSessionId: CALL_ID,
          responseId: 'resp-1',
          action: 'host_routed_delegate_task',
          decisionSource: 'deterministic_fallback',
          classificationFailure: 'rate_limited',
        }],
      },
      {
        timestamp: new Date(START + 8500).toISOString(), level: 'info',
        message: 'voice say/do context pollution removed',
        data: [{
          voiceSessionId: CALL_ID,
          responseId: 'resp-polluted',
          assistantItemId: 'item-polluted',
          summary: '本轮模型违规输出执行声称，已从上游对话上下文剔除',
          violation: 'execution_claim_with_tool_call',
          action: 'assistant_item_removed_from_upstream_context',
        }],
      },
      {
        // 别通电话的判定行不得混入
        timestamp: new Date(START + 9000).toISOString(), level: 'info',
        message: 'voice interrupt evidence',
        data: [{ voiceSessionId: 'voice-8888-3', tier: 'weak' }],
      },
    ]);
    const t = getVoiceCallTimeline(CALL_ID)!;
    expect(t.sections.decisions.events).toHaveLength(1);
    expect(t.sections.decisions.events[0]!.detail.tier).toBe('strong');
    expect(t.sections.sayDo.events).toHaveLength(2);
    expect(t.sections.sayDo.events[0]!.detail.action).toBe('host_routed_delegate_task');
    expect(t.sections.sayDo.events[0]!.detail.classificationFailure).toBe('rate_limited');
    expect(t.sections.sayDo.events[1]).toMatchObject({
      kind: 'voice say/do context pollution removed',
      detail: {
        summary: '本轮模型违规输出执行声称，已从上游对话上下文剔除',
        violation: 'execution_claim_with_tool_call',
        action: 'assistant_item_removed_from_upstream_context',
      },
    });
  });

  it('旧记录（无 voiceCallId）：日志段/费用/录音报 unavailable 并说明原因，字幕标窗推导', () => {
    dbMock.listVoiceCallSummaries.mockReturnValue([
      summaryMessage({ voiceCallId: undefined, tokens: undefined }),
    ]);
    dbMock.getVoiceMessagesInWindow.mockReturnValue([
      { id: 'm1', sessionId: NEO_SESSION, role: 'user', content: '旧通话', timestamp: START + 1000, metadata: { source: 'voice' } },
    ]);
    const t = getVoiceCallTimeline('msg-summary-1')!;
    expect(t.call.voiceCallId).toBeNull();
    expect(t.sections.transcript.events[0]!.keyMatch).toBe('window');
    expect(t.sections.decisions.status).toBe('unavailable');
    expect(t.cost.status).toBe('unavailable');
    expect(t.recording.status).toBe('unavailable');
  });

  it('markdown 导出把 fail-loud 注记带出来', () => {
    const t = getVoiceCallTimeline(CALL_ID)!;
    const md = formatVoiceCallTimelineMarkdown(t);
    expect(md).toContain('无记录可查');
    expect(md).toContain('token 共 1000');
  });

  it('查不到的通话返回 null', () => {
    expect(getVoiceCallTimeline('voice-nonexistent-0')).toBeNull();
  });
});
