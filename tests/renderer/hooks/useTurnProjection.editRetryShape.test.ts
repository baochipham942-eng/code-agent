// ============================================================================
// N-EDIT-RETRY-KEY-SHAPE — Edit 重试恢复（markRecoveredFailures/editKey）必须认
// 注册表的真实参数形状。注册的 Edit 工具（src/host/tools/modules/file/multiEdit.schema.ts）
// 参数是 { file_path, edits: [{ old_text, new_text, replace_all? }] }，没有顶层
// old_string/new_string；顶层平铺是 legacy edit_file 的形状。这里的用例全部用
// multiEditSchema 风格构造参数（legacy 平铺单独列名钉住不回归）。
// ============================================================================
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';

function editCall(id: string, name: string, args: Record<string, unknown>, success: boolean) {
  return {
    id,
    name,
    arguments: args,
    result: success
      ? { toolCallId: id, success: true, output: 'Edited /workspace/report.md: 1 edit(s) applied, 1 total replacement(s).' }
      : { toolCallId: id, success: false, error: 'File must be read before editing. Use Read first.' },
  };
}

/** 同一轮里先失败后重试：返回失败节点是否被判 recovered */
function failedEditRecovered(
  failedArgs: Record<string, unknown>,
  retryArgs: Record<string, unknown>,
  toolName = 'Edit',
): boolean {
  const messages: Message[] = [
    { id: 'u', role: 'user', content: '改一下报告', timestamp: 1 },
    {
      id: 'a', role: 'assistant', content: '', timestamp: 2,
      toolCalls: [
        editCall('failed', toolName, failedArgs, false),
        editCall('retry', toolName, retryArgs, true),
      ],
    },
  ];
  const nodes = projectTurns(messages, 'session-edit-shape', false, []).turns.flatMap((turn) => turn.nodes);
  return Boolean(nodes.find((node) => node.toolCall?.id === 'failed')?.toolCall?.recovered);
}

describe('projectTurns — Edit retry recovery keys on the registered edits[] shape', () => {
  const singleEdit = (
    oldText: string,
    newText: string,
    replaceAll?: boolean,
  ): { file_path: string; edits: Array<{ old_text: string; new_text: string; replace_all?: boolean }> } => ({
    file_path: '/workspace/report.md',
    edits: [{ old_text: oldText, new_text: newText, ...(replaceAll === undefined ? {} : { replace_all: replaceAll }) }],
  });

  it('recovers the failed row when the same edits[] retry succeeds', () => {
    expect(failedEditRecovered(singleEdit('old', 'new'), singleEdit('old', 'new'))).toBe(true);
  });

  it('does not recover when the retry edits different text', () => {
    expect(failedEditRecovered(singleEdit('old', 'new'), singleEdit('old', 'other'))).toBe(false);
  });

  it('does not recover when the retry targets a different file', () => {
    expect(
      failedEditRecovered(singleEdit('old', 'new'), { file_path: '/workspace/other.md', edits: [{ old_text: 'old', new_text: 'new' }] }),
    ).toBe(false);
  });

  it('recovers a two-item edits[] retry with the same items in the same order', () => {
    const twoItems = {
      file_path: '/workspace/report.md',
      edits: [
        { old_text: 'a', new_text: 'b' },
        { old_text: 'c', new_text: 'd' },
      ],
    };
    expect(failedEditRecovered(twoItems, { ...twoItems, edits: [...twoItems.edits] })).toBe(true);
  });

  it('does not recover a two-item edits[] retry with the items in a different order', () => {
    const failed = {
      file_path: '/workspace/report.md',
      edits: [
        { old_text: 'a', new_text: 'b' },
        { old_text: 'c', new_text: 'd' },
      ],
    };
    const reordered = {
      file_path: '/workspace/report.md',
      edits: [
        { old_text: 'c', new_text: 'd' },
        { old_text: 'a', new_text: 'b' },
      ],
    };
    expect(failedEditRecovered(failed, reordered)).toBe(false);
  });

  it('does not recover when replace_all differs between failure and retry', () => {
    expect(failedEditRecovered(singleEdit('old', 'new', false), singleEdit('old', 'new', true))).toBe(false);
  });

  it('normalizes a leading ./ on the path before comparing keys', () => {
    expect(
      failedEditRecovered(
        { file_path: 'workspace/report.md', edits: [{ old_text: 'old', new_text: 'new' }] },
        { file_path: './workspace/report.md', edits: [{ old_text: 'old', new_text: 'new' }] },
      ),
    ).toBe(true);
  });

  it('still recovers legacy flat edit_file-shaped args', () => {
    const flat = { file_path: '/workspace/report.md', old_string: 'old', new_string: 'new' };
    expect(failedEditRecovered(flat, flat, 'edit_file')).toBe(true);
  });

  it('still recovers legacy flat args under the registered Edit name', () => {
    const flat = { file_path: '/workspace/report.md', old_string: 'old', new_string: 'new' };
    expect(failedEditRecovered(flat, flat)).toBe(true);
  });

  it('accepts per-item legacy old_string/new_string inside edits[] (multiEdit compat)', () => {
    // multiEdit.ts normalizeEdits 对 edits[] 每项还收 legacy old_string/new_string
    const failed = { file_path: '/workspace/report.md', edits: [{ old_string: 'old', new_string: 'new' }] };
    const retry = { file_path: '/workspace/report.md', edits: [{ old_text: 'old', new_text: 'new' }] };
    expect(failedEditRecovered(failed, retry)).toBe(true);
  });

  it('does not recover when the retry shape is unusable', () => {
    expect(failedEditRecovered(singleEdit('old', 'new'), { file_path: '/workspace/report.md' })).toBe(false);
  });
});
