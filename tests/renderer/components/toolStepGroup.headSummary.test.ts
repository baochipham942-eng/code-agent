// P0 接缝（工单 C）：单工具失败时组头摘要不再返回 null——
// 128 个工具里 101 个没有专属状态词，组头只剩「失败 + 执行了一个步骤」等于没说话。
// 降级链：code 文案 summary → 兜底分类 summary → 原始 error 首行（截断）。
import { describe, expect, it } from 'vitest';
import { buildToolGroupHeadSummary } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import type { ToolCall } from '../../../src/shared/contract/tool';
import { zh } from '../../../src/renderer/i18n/zh';

function failedCall(error: string | undefined, metadata?: Record<string, unknown>): ToolCall {
  return {
    id: 'call-1',
    name: 'Bash',
    arguments: {},
    result: { toolCallId: 'call-1', success: false, error, metadata },
  };
}

describe('buildToolGroupHeadSummary — 单工具失败不再返回 null', () => {
  it('未分类错误：截取原始 error 的首行', () => {
    const summary = buildToolGroupHeadSummary([failedCall('command failed with exit code 1')], zh);
    expect(summary).toBe('command failed with exit code 1');
  });

  it('多行 error 只取第一行人话（跳过协议标签行）', () => {
    const summary = buildToolGroupHeadSummary(
      [failedCall('<tool-args-validation-error>\n参数 path 缺失\n第二行细节')],
      zh,
    );
    expect(summary).toBe('参数 path 缺失');
  });

  it('error 首行超 80 字时截断（组头只有一行，必须能 truncate）', () => {
    const long = 'x'.repeat(120);
    const summary = buildToolGroupHeadSummary([failedCall(long)], zh);
    expect(summary).toBe('x'.repeat(77) + '...');
  });

  it('正则兜底分类命中时用分类文案的 summary', () => {
    const summary = buildToolGroupHeadSummary([failedCall('Error: HTTP 429 Too Many Requests')], zh);
    expect(summary).toBe(zh.toolErrors.rateLimit.summary);
  });

  it('metadata.code 命中登记表时优先用 code 文案的 summary', () => {
    const summary = buildToolGroupHeadSummary(
      [failedCall('tool blocked by current workbench scope: Bash', { code: 'WORKBENCH_SCOPE_DENIED' })],
      zh,
    );
    expect(summary).toBe(zh.toolErrors.codes.WORKBENCH_SCOPE_DENIED.summary);
  });

  it('失败但完全没有 error 文本时返回 null（组头仍有状态词，不空白）', () => {
    expect(buildToolGroupHeadSummary([failedCall(undefined)], zh)).toBeNull();
    expect(buildToolGroupHeadSummary([failedCall('')], zh)).toBeNull();
  });

  it('browser/computer 失败走专属脱敏摘要：原始 error 里的敏感文本不进组头', () => {
    const computerCall: ToolCall = {
      id: 'call-sec',
      name: 'computer_use',
      arguments: { action: 'smart_type', selector: '#missing-email', text: 'app-host-secret@example.com' },
      result: {
        toolCallId: 'call-sec',
        success: false,
        error: 'No element found after trying app-host-secret@example.com',
      },
    };
    const summary = buildToolGroupHeadSummary([computerCall], zh);
    expect(summary).not.toBeNull();
    expect(summary).not.toContain('app-host-secret@example.com');
  });
});

describe('buildToolGroupHeadSummary — 既有行为不变', () => {
  it('多工具失败仍是计数摘要', () => {
    const ok: ToolCall = {
      id: 'call-2',
      name: 'Bash',
      arguments: {},
      result: { toolCallId: 'call-2', success: true, output: 'ok' },
    };
    const summary = buildToolGroupHeadSummary([failedCall('boom'), ok], zh);
    expect(summary).toBe('1 失败, 1 完成');
  });

  it('单工具成功仍走 summarizeTool 的结果摘要', () => {
    const task: ToolCall = {
      id: 'call-3',
      name: 'task',
      arguments: {},
      result: { toolCallId: 'call-3', success: true, output: 'done' },
    };
    expect(buildToolGroupHeadSummary([task], zh)).toBe('Completed');
  });

  it('空组仍返回 null', () => {
    expect(buildToolGroupHeadSummary([], zh)).toBeNull();
  });
});
