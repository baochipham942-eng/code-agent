import { beforeEach, describe, expect, it, vi } from 'vitest';

import { emitCommandCenterToolStart } from '../../../src/host/agent/runtime/contextAssembly/sessionCommandCenterPreannounce';

describe('session command center renderer-visible preannounce', () => {
  it('emits non-empty task-bound assistant text before the delegate_task row', () => {
    const events: Array<{ type: string; text?: string }> = [];
    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task',
      commandCenterEnabled: true,
      streamedContent: '',
      existingPreannounce: '',
      userMessage: '<session_command_center>internal</session_command_center>\n<user_request>研究 React 的最新版本</user_request>',
      emitPreview: (text) => events.push({ type: 'message_delta', text }),
      emitToolStart: () => events.push({ type: 'stream_tool_call_start' }),
    });

    expect(preview).toContain('研究 React 的最新版本');
    expect(events).toEqual([
      { type: 'message_delta', text: preview },
      { type: 'stream_tool_call_start' },
    ]);
    expect(events[0].text?.trim()).not.toBe('');
  });

  it('does not duplicate a model-provided preamble', () => {
    const emitPreview = vi.fn();
    const emitToolStart = vi.fn();
    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task',
      commandCenterEnabled: true,
      streamedContent: '我先去研究。',
      existingPreannounce: '',
      userMessage: '研究 React',
      emitPreview,
      emitToolStart,
    });
    expect(preview).toBe('');
    expect(emitPreview).not.toHaveBeenCalled();
    expect(emitToolStart).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// N-FIX-DELEGATE-PREANNOUNCE-GARBLED（realrun35 / FB-596）端到端管线：
// 真实 buildCapabilityCandidateNotice（块内 prose 含行中 <user_request>）→
// wrapWithTurnSystemContext 包装 → emitCommandCenterToolStart。
// 修复前 preannounce 把「 里的用户原话。）统计内容：…」当用户任务转述。
// 候选数据按 capabilityCandidateNotice.test.ts 的方式喂真实 detector/store。
// ---------------------------------------------------------------------------

import * as os from 'os';
import * as path from 'path';

const tmpConfigDir = path.join(os.tmpdir(), `cap-notice-preannounce-${process.pid}`);
vi.mock('../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => tmpConfigDir,
}));

import { buildCapabilityCandidateNotice } from '../../../src/host/agent/capabilityCandidateNotice';
import { extractUserRequest, wrapWithTurnSystemContext } from '../../../src/shared/utils/turnScaffold';
import { getCapabilityCandidateStore } from '../../../src/host/services/skills/capabilityCandidateStore';
import { observeTurn } from '../../../src/host/services/skills/capabilityGapDetector';

const T0 = Date.now();

function step(toolName: string, command?: string) {
  return {
    toolCallId: `${toolName}-${Math.random()}`,
    toolName,
    args: command ? { command } : {},
    success: true,
    outputPreview: '',
    duration: 10,
    timestamp: T0,
  };
}

/** 攒一条真的进首屏的候选（与 capabilityCandidateNotice.test.ts 同款夹具）。 */
function seedAboveFoldCandidate(): void {
  const steps = [
    step('bash', 'screencapture -x a.png'),
    step('bash', 'tesseract a.png out'),
    step('write_file'),
  ];
  observeTurn({ userMessage: '把截图里的表格转成 Excel', steps, tokens: 30_000 }, T0);
  observeTurn({ userMessage: '再转一批', steps, tokens: 30_000 }, T0 + 1000);
}

describe('delegate_task preannounce 端到端管线（真实候选能力块 + 真实包装）', () => {
  beforeEach(() => {
    getCapabilityCandidateStore().resetForTests();
  });

  it('preannounce 引用的是用户原话，不是候选能力块的残句', () => {
    seedAboveFoldCandidate();
    const notice = buildCapabilityCandidateNotice('s-preannounce-pipeline');
    expect(notice).not.toBeNull();
    expect(notice).toContain('<user_request>'); // 块内 prose 确实带同名标签（病灶来源）

    const userRequest = '帮我研究 React 的最新版本';
    const wrapped = wrapWithTurnSystemContext([notice as string], userRequest);
    expect(extractUserRequest(wrapped)).toBe(userRequest);

    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task',
      commandCenterEnabled: true,
      streamedContent: '',
      existingPreannounce: '',
      userMessage: wrapped,
      emitPreview: () => {},
      emitToolStart: () => {},
    });

    // 证据 ③：直接把 preview 打进测试输出
    console.log('[preannounce-pipeline-preview]', preview);

    expect(preview).toContain(userRequest);
    expect(preview).not.toContain('统计内容');
    expect(preview).not.toContain('里的用户原话');
    expect(preview).not.toContain('background_capability_stats');
  });

  it('对照：同一管线在无候选（无注入块）时行为不变', () => {
    const wrapped = wrapWithTurnSystemContext([], '研究 React 的最新版本');
    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task',
      commandCenterEnabled: true,
      streamedContent: '',
      existingPreannounce: '',
      userMessage: wrapped,
      emitPreview: () => {},
      emitToolStart: () => {},
    });
    expect(preview).toContain('研究 React 的最新版本');
  });

  // 台账②三种形状（rework r2）：extractUserRequest 取不出可靠原话时，preannounce
  // 只能说固定句，不得拿脚手架片段凑数。三个形状都走真实 notice + 真实包装管线。
  const FIXED_SENTENCE = '我先把这项任务交给后台执行，完成后回到这里交付结果。';

  function expectNoScaffoldFragment(preview: string): void {
    expect(preview).not.toContain('统计内容');
    expect(preview).not.toContain('里的用户原话');
    expect(preview).not.toContain('background_capability_stats');
  }

  it('形状a：</user_request> 结束标签后还带内容 → 固定句，不引用脚手架', () => {
    seedAboveFoldCandidate();
    const notice = buildCapabilityCandidateNotice('s-shape-trailing');
    expect(notice).not.toBeNull();
    const wrapped = wrapWithTurnSystemContext([notice as string], '帮我研究 React 的最新版本');
    // 生产面不会产出这种形状（所有生产者都把包装体放在最末），这是防御形状：
    // 结束标签之后又被拼了一段脚手架内容。
    const withTrailing = `${wrapped}\n\n<turn_workbench_context>工作台偏好原文</turn_workbench_context>`;

    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task',
      commandCenterEnabled: true,
      streamedContent: '',
      existingPreannounce: '',
      userMessage: withTrailing,
      emitPreview: () => {},
      emitToolStart: () => {},
    });
    console.log('[preannounce-shape-a-trailing]', preview);
    expect(preview).toBe(FIXED_SENTENCE);
    expectNoScaffoldFragment(preview);
  });

  it('形状b：嵌套包装（已包装消息再被整条包一层）→ 固定句', () => {
    seedAboveFoldCandidate();
    const notice = buildCapabilityCandidateNotice('s-shape-nested');
    expect(notice).not.toBeNull();
    const once = wrapWithTurnSystemContext([notice as string], '帮我研究 React 的最新版本');
    const twice = wrapWithTurnSystemContext(['<turn_workbench_context>工作台偏好原文</turn_workbench_context>'], once);

    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task',
      commandCenterEnabled: true,
      streamedContent: '',
      existingPreannounce: '',
      userMessage: twice,
      emitPreview: () => {},
      emitToolStart: () => {},
    });
    console.log('[preannounce-shape-b-nested]', preview);
    expect(preview).toBe(FIXED_SENTENCE);
    expectNoScaffoldFragment(preview);
  });

  it('形状c：没有包装但脚手架块在 → 固定句', () => {
    seedAboveFoldCandidate();
    const notice = buildCapabilityCandidateNotice('s-shape-unwrapped');
    expect(notice).not.toBeNull();
    // 块直接拼在原话前、没有 <user_request> 包装（未走 wrap 的防御形状）
    const bare = `${notice}\n\n帮我研究 React 的最新版本`;

    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task',
      commandCenterEnabled: true,
      streamedContent: '',
      existingPreannounce: '',
      userMessage: bare,
      emitPreview: () => {},
      emitToolStart: () => {},
    });
    console.log('[preannounce-shape-c-unwrapped]', preview);
    expect(preview).toBe(FIXED_SENTENCE);
    expectNoScaffoldFragment(preview);
  });
});

describe('session command center renderer-visible preannounce', () => {
  it('emits non-empty task-bound assistant text before the delegate_task row', () => {
    const events: Array<{ type: string; text?: string }> = [];
    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task',
      commandCenterEnabled: true,
      streamedContent: '',
      existingPreannounce: '',
      userMessage: '<session_command_center>internal</session_command_center>\n<user_request>研究 React 的最新版本</user_request>',
      emitPreview: (text) => events.push({ type: 'message_delta', text }),
      emitToolStart: () => events.push({ type: 'stream_tool_call_start' }),
    });

    expect(preview).toContain('研究 React 的最新版本');
    expect(events).toEqual([
      { type: 'message_delta', text: preview },
      { type: 'stream_tool_call_start' },
    ]);
    expect(events[0].text?.trim()).not.toBe('');
  });

  it('does not duplicate a model-provided preamble', () => {
    const emitPreview = vi.fn();
    const emitToolStart = vi.fn();
    const preview = emitCommandCenterToolStart({
      toolName: 'delegate_task',
      commandCenterEnabled: true,
      streamedContent: '我先去研究。',
      existingPreannounce: '',
      userMessage: '研究 React',
      emitPreview,
      emitToolStart,
    });
    expect(preview).toBe('');
    expect(emitPreview).not.toHaveBeenCalled();
    expect(emitToolStart).toHaveBeenCalledOnce();
  });
});
