import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ToolCall, Message } from '../../../src/shared/contract';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { zh, en } from '../../../src/renderer/i18n';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { getToolPreflightKind, toolPreflightCopy } from '../../../src/renderer/utils/toolPreflightPresentation';
import { humanizeToolFailureReason } from '../../../src/renderer/utils/toolExecutionPresentation';
import { wrapFilePathsInBackticks } from '../../../src/renderer/components/features/chat/MessageBubble/filePathProcessor';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh, language: 'zh' }) }));
const failed = (name: string, error: string, metadata = {}): ToolCall => ({ id: 'x', name, arguments: { file_path: '/workspace/report.md' }, result: { toolCallId: 'x', success: false, error, metadata } });

describe('demo acceptance: truthful historical presentation', () => {
  it('explains repair scope without exposing paths or claiming an absent error', () => {
    const tool = failed('Read', 'Artifact repair mode is active for /workspace/report.html. Read is limited to the target artifact file during repair.', { artifactRepairGuard: { blocked: true } });
    expect(humanizeToolFailureReason(tool, zh)).toBe(zh.deliveryExperience.repairReason);
    expect(humanizeToolFailureReason(tool, en)).toBe(en.deliveryExperience.repairReason);
    expect(tool.result?.error).toContain('/workspace/report.html');
  });
  it('distinguishes automatic approval failure from a user denial', () => {
    const tool = failed('Write', 'not approved', { failureCode: 'permission-denied', hostReason: { code: 'PERMISSION_DENIED_NO_APPROVAL_UI' } });
    expect(toolPreflightCopy(tool, zh)).toEqual({ action: '未写入 · report.md', reason: zh.deliveryExperience.approvalUnavailable });
    expect(getToolPreflightKind(failed('Bash', 'Approval denied by user'))).toBeNull();
  });
  it('does not mark an undelivered question as answered or successful', () => {
    const tool: ToolCall = { id: 'q', name: 'AskUserQuestion', arguments: {}, result: { toolCallId: 'q', success: true, output: '[用户未响应 - CLI 模式无法交互]', metadata: { permissionDecision: 'deny', permissionDecisionReason: '当前运行环境没有可投递的交互界面' } } };
    expect(getToolPreflightKind(tool)).toBe('question');
    expect(toolPreflightCopy(tool, zh)?.action).toBe('未能向你提问');
    expect(tool.result?.success).toBe(true); // immutable historic transport result
    expect(getToolPreflightKind({ ...tool, result: { toolCallId: 'q', success: true, output: 'User responses:\n[Choice]: Yes' } })).toBeNull();
  });
  it('mixed group counts executed reads separately from unexecuted commands', () => {
    const nodes = [
      { id: 'r', name: 'Read', args: {}, success: true, result: 'read content' },
      { id: 'b', name: 'Bash', args: {}, success: false, result: 'auto 档不放行', metadata: { failureCode: 'permission-denied' } },
    ].map((toolCall, i) => ({ id: toolCall.id, type: 'tool_call', content: '', timestamp: i, toolCall } as TraceNode));
    const html = renderToStaticMarkup(<ToolStepGroup nodes={nodes} />);
    expect(html).toContain('查看了 1 次内容');
    expect(html).toContain('1 条命令未执行');
    expect(html).not.toContain('运行了 1 条命令');
    expect(html).not.toContain('审批被拒绝');
  });
  it('preserves a quoted command link without nested path formatting', () => {
    const content = '[python3 "/workspace/演示/build_ppt.py"](!run)';
    expect(wrapFilePathsInBackticks(content)).toBe(content);
    expect(wrapFilePathsInBackticks('Inspect /workspace/report.md')).toContain('`/workspace/report.md`');
  });
  it('known precondition errors explain Read first; unclassified recorded errors do not become missing', () => {
    expect(humanizeToolFailureReason(failed('Edit', 'NOT_READ'), zh)).toBe(zh.deliveryExperience.readRequired);
    expect(humanizeToolFailureReason(failed('Read', 'custom error'), zh)).toBe(zh.toolStepHumanize.failureReasonMissing);
    expect(humanizeToolFailureReason(failed('Read', ''), zh)).toBe(zh.toolStepHumanize.failureReasonMissing);
  });
  it.each([true, false])('only the same successful edit recovers the failure: same=%s', (same) => {
    const args = { file_path: '/workspace/report.md', old_string: 'old', new_string: 'new' };
    const messages: Message[] = [
      { id: 'u', role: 'user', content: 'Edit report', timestamp: 1 },
      { id: 'a', role: 'assistant', content: '', timestamp: 2, toolCalls: [{ ...failed('Edit', 'NOT_READ'), arguments: args }] },
      { id: 'b', role: 'assistant', content: '', timestamp: 3, toolCalls: [{ id: 'success', name: 'Edit', arguments: { ...args, new_string: same ? 'new' : 'other' }, result: { toolCallId: 'success', success: true, output: 'ok' } }] },
    ];
    const nodes = projectTurns(messages, 'session', false, []).turns.flatMap((turn) => turn.nodes);
    expect(Boolean(nodes.find((node) => node.toolCall?.id === 'x')?.toolCall?.recovered)).toBe(same);
  });
  it('links batch Edit NOT_READ to the same later successful batch, ignoring JSON key order', () => {
    const first = { file_path: '/workspace/report.md', edits: [{ old_text: 'a', new_text: 'b', old_text_length: 1 }] };
    const later = { edits: [{ new_text: 'b', old_text: 'a' }], file_path: '/workspace/report.md' };
    const messages: Message[] = [
      { id: 'u', role: 'user', content: 'Repair document', timestamp: 1 },
      { id: 'a', role: 'assistant', content: '', timestamp: 2, toolCalls: [{ ...failed('Edit', 'NOT_READ'), arguments: first }] },
      { id: 'r', role: 'assistant', content: '', timestamp: 3, toolCalls: [{ id: 'read', name: 'Read', arguments: { file_path: '/workspace/report.md' }, result: { toolCallId: 'read', success: true, output: 'a' } }] },
      { id: 'b', role: 'assistant', content: '', timestamp: 4, toolCalls: [{ id: 'success', name: 'Edit', arguments: later, result: { toolCallId: 'success', success: true, output: 'ok' } }] },
    ];
    expect(projectTurns(messages, 'session', false, []).turns.flatMap((turn) => turn.nodes).find((node) => node.toolCall?.id === 'x')?.toolCall?.recovered).toBe(true);
  });

});
