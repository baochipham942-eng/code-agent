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
  // N-DEMOACCEPT-0909-STORY-A ai-review Important: a Bash command that actually ran (real exit
  // code, no host permission denial) must never be presented as "not executed" just because the
  // executed program's own stderr happens to contain approval-shaped words. `gh pr merge` hitting
  // branch protection is real: it ran, exited 1, and GitHub's own message says
  // "requires approval from a reviewer" — none of that is our host denying permission.
  it('a real exit≠0 Bash run is never mistaken for an unexecuted approval gate, even when stderr says "requires approval"', () => {
    const tool = failed(
      'Bash',
      'remote: - Changes must be made through a pull request.\nremote: - Waiting on code owner review: requires approval from a reviewer\nerror: failed to push some refs',
      { exitCode: 1 },
    );
    expect(getToolPreflightKind(tool)).toBeNull();
    expect(toolPreflightCopy(tool, zh)).toBeNull();
    expect(humanizeToolFailureReason(tool, zh)).toBe(zh.toolStepHumanize.failureCode.replace('{code}', '1'));
    expect(humanizeToolFailureReason(tool, zh)).not.toBe(zh.deliveryExperience.approvalRequired);
  });
  it('does not mark an undelivered question as answered or successful', () => {
    const tool: ToolCall = { id: 'q', name: 'AskUserQuestion', arguments: {}, result: { toolCallId: 'q', success: true, output: '[用户未响应 - CLI 模式无法交互]', metadata: { permissionDecision: 'deny', permissionDecisionReason: '当前运行环境没有可投递的交互界面' } } };
    expect(getToolPreflightKind(tool)).toBe('question');
    expect(toolPreflightCopy(tool, zh)?.action).toBe('未能向你提问');
    expect(tool.result?.success).toBe(true); // immutable historic transport result
    expect(getToolPreflightKind({ ...tool, result: { toolCallId: 'q', success: true, output: 'User responses:\n[Choice]: Yes' } })).toBeNull();
  });
  // ai-review #1741 Important：组头 label 的分桶必须和 status 判定同口径，把 recovered /
  // isAutoLoadedRetry 排除掉。否则「Edit 失败 → Read → 同参数 Edit 成功」这一轮里，status
  // 判 ok（无红点、无原因行、「已恢复」pill 还要 hover 才浮出），组头却写「…未成功」——
  // 一句没有任何错误标识、也没有原因说明的失败断言，正是那道闸要防的「把成功的一轮演成翻车」。
  it('a recovered failure is not re-announced in the collapsed group head', () => {
    const args = { file_path: '/workspace/report.md', old_string: 'old', new_string: 'new' };
    const messages: Message[] = [
      { id: 'u', role: 'user', content: 'Edit report', timestamp: 1 },
      { id: 'a', role: 'assistant', content: '', timestamp: 2, toolCalls: [
        { ...failed('Edit', 'Existing file must be read before editing', { code: 'NOT_READ' }), arguments: args },
        { id: 'read', name: 'Read', arguments: { file_path: args.file_path }, result: { toolCallId: 'read', success: true, output: 'contents' } },
        { id: 'redo', name: 'Edit', arguments: args, result: { toolCallId: 'redo', success: true, output: 'ok' } },
      ] },
    ];
    const nodes = projectTurns(messages, 'session', false, []).turns.flatMap((turn) => turn.nodes);
    expect(nodes.find((node) => node.toolCall?.id === 'x')?.toolCall?.recovered).toBe(true);
    const html = renderToStaticMarkup(<ToolStepGroup nodes={nodes.filter((node) => node.toolCall)} defaultExpanded={false} />);
    expect(html).not.toContain('未成功');
    expect(html).not.toContain(zh.deliveryExperience.blockedSteps.replace('{count}', '1'));
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
    // 真实生产形状（multiEdit.ts）是结构化 code，不是塞进 error 自由文本——preflight 只认前者。
    expect(humanizeToolFailureReason(failed('Edit', 'Existing file must be read before editing', { code: 'NOT_READ' }), zh)).toBe(zh.deliveryExperience.readRequired);
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
});
