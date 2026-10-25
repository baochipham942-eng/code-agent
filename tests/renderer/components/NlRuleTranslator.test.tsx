// ============================================================================
// NlRuleTranslator 组件测试（N-PERM-NL-RULES-K1 验收 ①⑤ renderer 侧）
// ----------------------------------------------------------------------------
// 复述卡形状、确认/取消的保存语义（确认 → 现有 settings set 路径；取消 → 零写入）、
// unrecognized 的固定话术与「没有确认按钮」、protected 只给「先问我/永不」。
// 路由返回一律用共享类型 PermissionTranslateResult 构造（真实形状，不手搓假形状）。
// ============================================================================

// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import {
  NL_RULE_TEXT,
  type PermissionTranslateResult,
} from '../../../src/shared/permissionRuleTranslate';

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain, on: vi.fn(), off: vi.fn() },
}));

import { NlRuleTranslator } from '../../../src/renderer/components/features/settings/permissions/NlRuleTranslator';

const SAVED = {
  permissions: {
    deny: ['Bash(rm -rf /)'],
    ask: ['Bash(git push *)'],
    allow: ['Read'],
  },
};

function okResult(overrides: Partial<PermissionTranslateResult> = {}): PermissionTranslateResult {
  return {
    status: 'ok',
    draft: {
      tool: 'Bash',
      pattern: 'rm *',
      behavior: 'ask',
      examples: { hit: ['rm -rf ./build', 'rm notes.txt'], miss: ['ls -la', 'cat a.txt'] },
    },
    rule: 'Bash(rm *)',
    behavior: 'ask',
    restatement: '用终端运行 rm 开头的命令时 → 先问你',
    examples: { hit: ['rm -rf ./build', 'rm notes.txt'], miss: ['ls -la', 'cat a.txt'] },
    ...overrides,
  };
}

function setCalls(): unknown[][] {
  return invokeDomain.mock.calls.filter((call) => call[1] === 'set');
}

async function translateWith(sentence: string, result: PermissionTranslateResult | { reject: Error }) {
  invokeDomain.mockImplementation((domain: string, action: string) => {
    if (domain === IPC_DOMAINS.SETTINGS && action === 'get') return Promise.resolve(SAVED);
    if (domain === IPC_DOMAINS.PERMISSION_TRANSLATE && action === 'translate') {
      return 'reject' in result ? Promise.reject(result.reject) : Promise.resolve(result);
    }
    return Promise.resolve(undefined);
  });
  render(<NlRuleTranslator />);
  fireEvent.change(screen.getByTestId('nl-rule-input'), { target: { value: sentence } });
  fireEvent.click(screen.getByTestId('nl-rule-translate'));
  await waitFor(() => {
    expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.PERMISSION_TRANSLATE, 'translate', { sentence });
  });
}

beforeEach(() => {
  invokeDomain.mockReset();
  invokeDomain.mockImplementation((domain: string, action: string) => {
    if (domain === IPC_DOMAINS.SETTINGS && action === 'get') return Promise.resolve(SAVED);
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('已保存规则的白话对照', () => {
  it('挂载即列出已存规则 + describeRule 白话', async () => {
    render(<NlRuleTranslator />);
    await waitFor(() => {
      expect(screen.getByTestId('nl-saved-rules').textContent).toContain('Bash(rm -rf /)');
    });
    expect(screen.getByTestId('nl-saved-rules').textContent).toContain('用终端运行 rm -rf / 这条命令时 → 一律禁止');
    expect(screen.getByTestId('nl-saved-rules').textContent).toContain('用终端运行 git push 开头的命令时 → 先问你');
    expect(screen.getByTestId('nl-saved-rules').textContent).toContain('读取任何文件时 → 直接执行，不再询问');
  });
});

describe('验收①：确认保存 / 取消零写入', () => {
  it('确认 → 经现有 settings set 路径把规则并入对应列表', async () => {
    await translateWith('删文件之前先问我', okResult());
    await waitFor(() => {
      expect(screen.getByTestId('nl-rule-card')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('nl-rule-confirm'));
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'set', {
        permissions: { ask: ['Bash(git push *)', 'Bash(rm *)'] },
      });
    });
    expect(setCalls()).toHaveLength(1);
  });

  it('同一规则已在列表里 → 不重复追加', async () => {
    await translateWith('强制推送先问我', okResult({ rule: 'Bash(git push *)' }));
    fireEvent.click(await screen.findByTestId('nl-rule-confirm'));
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'set', {
        permissions: { ask: ['Bash(git push *)'] },
      });
    });
  });

  it('切行为档后确认 → 按所选档位列表保存', async () => {
    await translateWith('删文件之前先问我', okResult());
    fireEvent.change(screen.getByTestId('nl-rule-behavior'), { target: { value: 'deny' } });
    // 换档后复述即时跟随
    expect(screen.getByTestId('nl-rule-restatement').textContent).toContain('一律禁止');
    fireEvent.click(screen.getByTestId('nl-rule-confirm'));
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'set', {
        permissions: { deny: ['Bash(rm -rf /)', 'Bash(rm *)'] },
      });
    });
  });

  it('取消 → 卡片关闭，零 set 调用', async () => {
    await translateWith('删文件之前先问我', okResult());
    fireEvent.click(screen.getByTestId('nl-rule-cancel'));
    expect(screen.queryByTestId('nl-rule-card')).toBeNull();
    expect(setCalls()).toEqual([]);
  });
});

describe('验收⑤：识别不了 / 受保护的用户话术', () => {
  it('unrecognized：固定话术逐字出现，且没有确认按钮', async () => {
    const unrecognized: PermissionTranslateResult = {
      status: 'unrecognized',
      reasonText: NL_RULE_TEXT.unrecognizedReason,
    };
    await translateWith('涉及客户隐私的事先问我', unrecognized);
    await waitFor(() => {
      expect(screen.getByTestId('nl-rule-unrecognized-reason').textContent).toBe(NL_RULE_TEXT.unrecognizedReason);
    });
    expect(screen.getByTestId('nl-rule-unrecognized-reason').textContent).toContain('这条我没法可靠识别');
    expect(screen.queryByTestId('nl-rule-confirm')).toBeNull();
    expect(screen.queryByTestId('nl-rule-cancel')).toBeNull();
    expect(setCalls()).toEqual([]);
  });

  it('protected：固定话术出现，行为档只剩「先问我 / 永不」，确认按所选档保存', async () => {
    const protectedResult: PermissionTranslateResult = {
      status: 'protected',
      draft: { tool: 'Bash', pattern: 'sudo *', behavior: 'allow', examples: { hit: ['sudo x'], miss: ['ls'] } },
      rule: 'Bash(sudo *)',
      reasonText: NL_RULE_TEXT.protectedReason,
    };
    await translateWith('sudo 命令直接放行', protectedResult);
    await waitFor(() => {
      expect(screen.getByTestId('nl-rule-reason').textContent).toBe(NL_RULE_TEXT.protectedReason);
    });
    expect(screen.getByTestId('nl-rule-reason').textContent).toContain('不会帮你设成自动放行');
    const behaviorSelect = screen.getByTestId('nl-rule-behavior') as HTMLSelectElement;
    const optionValues = [...behaviorSelect.querySelectorAll('option')].map((option) => option.value);
    expect(optionValues).toEqual(['ask', 'deny']);
    expect(behaviorSelect.value).toBe('ask');

    fireEvent.click(screen.getByTestId('nl-rule-confirm'));
    await waitFor(() => {
      expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.SETTINGS, 'set', {
        permissions: { ask: ['Bash(git push *)', 'Bash(sudo *)'] },
      });
    });
  });

  it('冲突：话术说明更严的生效，行为档默认已上调', async () => {
    const conflicted = okResult({
      behavior: 'deny',
      restatement: '用终端运行 rm 开头的命令时 → 一律禁止',
      conflict: { existingRule: 'Bash(rm -rf *)', existingBehavior: 'deny', effectiveBehavior: 'deny' },
      reasonText: NL_RULE_TEXT.conflictNote('Bash(rm -rf *)', 'deny'),
    });
    await translateWith('删文件之前先问我', conflicted);
    await waitFor(() => {
      expect(screen.getByTestId('nl-rule-reason').textContent).toContain('更严的那条会生效');
    });
    expect((screen.getByTestId('nl-rule-behavior') as HTMLSelectElement).value).toBe('deny');
  });
});

describe('通道故障呈现', () => {
  it('路由错误（模型不可用）→ 错误行展示 message，输入保留', async () => {
    await translateWith('删文件之前先问我', { reject: new Error(NL_RULE_TEXT.modelUnavailable) });
    await waitFor(() => {
      expect(screen.getByTestId('nl-rule-error').textContent).toBe(NL_RULE_TEXT.modelUnavailable);
    });
    expect(screen.queryByTestId('nl-rule-card')).toBeNull();
    expect(setCalls()).toEqual([]);
  });
});
