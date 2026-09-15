// @vitest-environment jsdom
// N-EVAL-ATTRIBUTION-CODEBOOK-K3 验收④：feedbackHookCommand 有界面可填。
// 刀 2 只加了配置键与读取方（feedbackHook.ts），没有输入框 = 抽屉里那个一键永远
// 退化成「复制 fb add 命令」——装好没接电。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { zh } from '../../../src/renderer/i18n/zh';

const invokeDomain = vi.hoisted(() => vi.fn());
const isWebMode = vi.hoisted(() => vi.fn(() => false));

vi.mock('../../../src/renderer/utils/platform', () => ({ isWebMode }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));
const isAdmin = vi.hoisted(() => ({ value: true }));
vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { isAdmin: boolean } }) => unknown) => selector({ user: { isAdmin: isAdmin.value } }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain, on: vi.fn() },
}));

import PrivacySettings from '../../../src/renderer/components/features/settings/tabs/PrivacySettings';

afterEach(() => {
  cleanup();
  isWebMode.mockReturnValue(false);
  isAdmin.value = true;
});

function mockIpc(settings: Record<string, unknown>): void {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  invokeDomain.mockImplementation((domain: string, action: string) => {
    if (domain === IPC_DOMAINS.SETTINGS && action === 'get') return Promise.resolve(settings);
    if (domain === IPC_DOMAINS.SETTINGS && action === 'set') return Promise.resolve(undefined);
    if (domain === IPC_DOMAINS.PII && action === 'setup:status') {
      return Promise.resolve({ state: 'idle', startedAt: null, error: null, logTail: [] });
    }
    if (domain === IPC_DOMAINS.PII && action === 'setup:isReady') {
      return Promise.resolve({ ready: false, envFile: { exists: false, hasPiiKeys: false }, pythonPath: null, modelOnnx: null });
    }
    throw new Error(`Unexpected call ${domain}:${action}`);
  });
}

describe('PrivacySettings 评测反馈池钩子命令', () => {
  it('没配过时为空，填完离焦落进 settings.evaluation.feedbackHookCommand', async () => {
    mockIpc({});
    render(<PrivacySettings />);

    const input = await screen.findByTestId('eval-feedback-hook-command');
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));

    fireEvent.change(input, { target: { value: '  fb add --from-dir "$NEO_EVAL_FEEDBACK_DIR"  ' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'set',
        { evaluation: { feedbackHookCommand: 'fb add --from-dir "$NEO_EVAL_FEEDBACK_DIR"' } },
      );
    });
  });

  it('已配置的命令回显，清空后落空串（退回复制命令文本那条路）', async () => {
    mockIpc({ evaluation: { feedbackHookCommand: 'fb add' } });
    render(<PrivacySettings />);

    const input = await screen.findByTestId('eval-feedback-hook-command');
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('fb add'));

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'set',
        { evaluation: { feedbackHookCommand: '' } },
      );
    });
  });

  it('说明文案写明证据先落盘、目录经环境变量传入', () => {
    expect(zh.settings.privacy.evaluation.body).toContain('NEO_EVAL_FEEDBACK_DIR');
    expect(zh.settings.privacy.evaluation.body).toContain('证据');
  });

  // FB-155：web 模式下 PrivacySettings 整页短路成横幅，钩子段被短路在后面永远不渲染。
  // 组件级直渲染（上面两条）走的是 isWebMode()=false 分支，绿了也不代表 web 上能配。
  it('web 模式下钩子段照样渲染，能回显已配命令并保存', async () => {
    isWebMode.mockReturnValue(true);
    mockIpc({ evaluation: { feedbackHookCommand: 'fb add' } });
    render(<PrivacySettings />);

    const input = await screen.findByTestId('eval-feedback-hook-command');
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('fb add'));

    fireEvent.change(input, { target: { value: 'fb add --from-dir "$NEO_EVAL_FEEDBACK_DIR"' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(
        IPC_DOMAINS.SETTINGS,
        'set',
        { evaluation: { feedbackHookCommand: 'fb add --from-dir "$NEO_EVAL_FEEDBACK_DIR"' } },
      );
    });
  });

  // 命令由宿主用系统 shell 执行：web 上的非管理员看得到但改不了（host 侧 adminOnlyKeys 也拦一道）。
  it('非管理员在 web 上只读：输入框 disabled 并给出管理员提示', async () => {
    isWebMode.mockReturnValue(true);
    isAdmin.value = false;
    mockIpc({ evaluation: { feedbackHookCommand: 'fb add' } });
    render(<PrivacySettings />);

    const input = await screen.findByTestId('eval-feedback-hook-command');
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(true));
    expect(screen.getByText(zh.settings.privacy.evaluation.adminHint)).toBeTruthy();
  });
});
