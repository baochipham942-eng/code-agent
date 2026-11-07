// ============================================================================
// settings 域 getOutboundMaskRecords 路由单测（N-PROMPT-SECRET-MASK-FU2 ④）
// 走真实 registerSettingsHandlers 装配的 domain:settings 表：返回 { success: true,
// data } 包裹的占位符形态回执（kind + placeholder + timestamp + provider/model），
// 不需要 admin（只读、无原值），data 里不含任何原值。
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({}) }),
}));

import { registerSettingsHandlers } from '../../../../src/host/ipc/settings.ipc';
import { recordOutboundMaskedRequest } from '../../../../src/host/security/outboundSecretMaskRecorder';
import type { IpcMain } from '../../../../src/host/platform/ipcTypes';
import { IPC_DOMAINS } from '../../../../src/shared/ipc';

type DomainHandler = (event: unknown, request: unknown) => Promise<unknown>;

function createIpcMain(): { registered: Map<string, DomainHandler>; ipcMain: IpcMain } {
  const registered = new Map<string, DomainHandler>();
  const ipcMain = {
    handle: (channel: string, handler: DomainHandler) => {
      registered.set(channel, handler);
    },
  } as unknown as IpcMain;
  return { registered, ipcMain };
}

describe('settings domain route: getOutboundMaskRecords', () => {
  let invoke: DomainHandler;

  beforeEach(() => {
    const { registered, ipcMain } = createIpcMain();
    registerSettingsHandlers(ipcMain, () => null);
    const handler = registered.get(IPC_DOMAINS.SETTINGS);
    if (!handler) throw new Error('domain:settings handler not registered');
    invoke = handler;
  });

  it('空回执 → success + 空数组（不需要 admin 门）', async () => {
    await expect(invoke(undefined, { action: 'getOutboundMaskRecords' })).resolves.toEqual({
      success: true,
      data: [],
    });
  });

  it('有记录 → data 逐条带回占位符形态，无原值', async () => {
    recordOutboundMaskedRequest(
      [
        { kind: 'OPENAI_KEY', placeholder: '{{SECRET_OPENAI_KEY_ab12cd34}}' },
        { kind: 'ENV_SECRET', placeholder: '{{SECRET_ENV_SECRET_deadbeef}}' },
      ],
      { provider: 'deepseek', model: 'deepseek-chat' },
    );
    const response = await invoke(undefined, { action: 'getOutboundMaskRecords' }) as {
      success: boolean;
      data: Array<{ timestamp: number; provider?: string; model?: string; replacements: Array<{ kind: string; placeholder: string }> }>;
    };
    expect(response.success).toBe(true);
    expect(response.data).toHaveLength(1);
    const record = response.data[0];
    expect(typeof record.timestamp).toBe('number');
    expect(record.provider).toBe('deepseek');
    expect(record.model).toBe('deepseek-chat');
    expect(record.replacements).toEqual([
      { kind: 'OPENAI_KEY', placeholder: '{{SECRET_OPENAI_KEY_ab12cd34}}' },
      { kind: 'ENV_SECRET', placeholder: '{{SECRET_ENV_SECRET_deadbeef}}' },
    ]);
    // 只回占位符：响应里不出现任何疑似原值的字段
    expect(JSON.stringify(response)).not.toContain('sk-');
    expect(Object.keys(record).sort()).toEqual(['model', 'provider', 'replacements', 'timestamp']);
  });
});
