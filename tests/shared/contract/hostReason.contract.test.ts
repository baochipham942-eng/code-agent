import { describe, expect, it } from 'vitest';
import {
  createHostReason,
  HostReasonCode,
} from '../../../src/shared/contract/permission';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { resolveHostReasonCopy } from '../../../src/renderer/utils/hostReasonPresentation';

describe('HostReason contract', () => {
  it('每个 HostReasonCode 都在同一张 agentError zh/en 登记表有非空文案', () => {
    const codes = Object.values(HostReasonCode).sort();
    const hostReasonZh = zh.agentError.hostReasons;
    const hostReasonEn = en.agentError.hostReasons;
    expect(Object.keys(hostReasonZh).sort()).toEqual(codes);
    expect(Object.keys(hostReasonEn).sort()).toEqual(codes);
    for (const code of codes) {
      expect(hostReasonZh[code].summary.trim()).not.toBe('');
      expect(hostReasonEn[code].summary.trim()).not.toBe('');
    }
  });

  it('结构化载荷只查登记表，绝不把 modelText 渲染出来', () => {
    const modelText = 'MODEL_TEXT_LEAK_SENTINEL: Too Many Requests';
    const payload = createHostReason(
      HostReasonCode.PermissionDeniedNoApprovalUi,
      modelText,
      { toolName: 'Bash' },
    );
    const copy = resolveHostReasonCopy(payload, zh);
    expect(copy?.summary).toContain('当前运行环境无法显示审批');
    expect(JSON.stringify(copy)).not.toContain(modelText);
    expect(JSON.stringify(copy)).not.toContain('Too Many Requests');
  });

  it('metadata 插值：工具名走 humanize，路径只取 basename，zh/en 都成立', () => {
    const toolPayload = createHostReason(
      HostReasonCode.PermissionDeniedByUser,
      'Permission denied by user',
      { toolName: 'Bash' },
    );
    expect(resolveHostReasonCopy(toolPayload, zh)?.summary).not.toContain('Bash');
    expect(resolveHostReasonCopy(toolPayload, en)?.summary).not.toContain('Bash');

    const pathPayload = createHostReason(
      HostReasonCode.PermissionFileOutsideWorkspaceConfirmationRequired,
      'write outside workspace: /Users/private/projects/secret-plan.md',
      { path: '/Users/private/projects/secret-plan.md' },
    );
    expect(resolveHostReasonCopy(pathPayload, zh)?.summary).toBe('写入 secret-plan.md 需要你的确认');
    expect(resolveHostReasonCopy(pathPayload, en)?.summary).toBe('Writing secret-plan.md needs your confirmation');
  });

  it('旧载荷没有 code 时退回原有 message，不崩、不空白', () => {
    expect(resolveHostReasonCopy('legacy host message', zh)).toEqual({
      summary: 'legacy host message',
      structured: false,
    });
    expect(resolveHostReasonCopy('', zh)).toBeNull();
    expect(resolveHostReasonCopy(undefined, zh)).toBeNull();
  });
});
