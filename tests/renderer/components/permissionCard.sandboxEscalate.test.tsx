import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest as ContractPermissionRequest } from '../../../src/shared/contract/permission';
import type { ToolCall } from '../../../src/shared/contract/tool';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { humanizeToolFailureReason } from '../../../src/renderer/utils/toolExecutionPresentation';

// 沙盒放宽卡必须和普通命令卡分开。PermissionCard 是 store 连接型组件
// （permissionCard.peerOrigin.test.tsx 同款 mock）。

const storeState = vi.hoisted(() => ({
  request: null as ContractPermissionRequest | null,
  language: 'zh' as 'zh' | 'en',
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const [{ zh: zhMessages }, { en: enMessages }] = await Promise.all([
    import('../../../src/renderer/i18n/zh'),
    import('../../../src/renderer/i18n/en'),
  ]);
  return {
    useI18n: () => ({
      t: storeState.language === 'en' ? enMessages : zhMessages,
      language: storeState.language,
    }),
  };
});

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: storeState.request,
    pendingPermissionSessionId: null,
    setPendingPermissionRequest: vi.fn(),
    developerMode: false,
  }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (s: { currentSessionId: string | null }) => unknown) =>
    selector({ currentSessionId: null }),
}));

vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => false, invoke: vi.fn() },
}));

const { PermissionCard } = await import('../../../src/renderer/components/PermissionDialog/PermissionCard');

const FILE_REASON = '沙盒拦截了这一步：它想写入文件 /tmp/neo-sandbox/neo-x.txt。允许仅这一次写入这个文件并重跑？';
const DIR_REASON = '沙盒拦截了这一步：它想写入目录 /tmp/neo-sandbox/neo-dir（含其中全部内容）。允许仅这一次写入这个目录及其中内容并重跑？（其中已有的凭据与配置类文件仍不可写）';
const GENERIC_CONSEQUENCE = '将执行有风险命令，可能覆盖本机系统或项目状态。';

function render(request: ContractPermissionRequest): string {
  storeState.request = request;
  return renderToStaticMarkup(React.createElement(PermissionCard));
}

function baseRequest(overrides: Partial<ContractPermissionRequest>): ContractPermissionRequest {
  return {
    id: 'req-sandbox-1',
    tool: 'Bash',
    type: 'command',
    timestamp: 1,
    ...overrides,
    details: {
      command: 'echo hello-neo > /tmp/neo-sandbox/neo-x.txt',
      ...overrides.details,
    },
  };
}

function buttonLabel(html: string, label: string, shortcut: string): boolean {
  const pattern = new RegExp(`${label}\\s*<kbd[^>]*>${shortcut}</kbd>`);
  return pattern.test(html);
}

describe('sandbox escalation approval card', () => {
  afterEach(() => {
    storeState.language = 'zh';
    storeState.request = null;
  });

  it('renders the file card from the host reason, path, and one-time buttons', () => {
    const html = render(baseRequest({
      forceConfirm: true,
      dangerLevel: 'warning',
      reason: FILE_REASON,
      details: {
        command: 'echo hello-neo > /tmp/neo-sandbox/neo-x.txt',
        deniedPath: '/tmp/neo-sandbox/neo-x.txt',
        action: 'sandbox_escalate_once',
      },
    }));

    expect(html).toContain('沙盒拦截了这一步');
    expect(html).toContain(FILE_REASON);
    expect(html).toMatch(/<p class="[^"]*font-mono[^"]*" data-testid="sandbox-escalation-path">\/tmp\/neo-sandbox\/neo-x\.txt<\/p>/);
    expect(buttonLabel(html, '允许仅这一次', 'y')).toBe(true);
    expect(buttonLabel(html, '拒绝', 'n')).toBe(true);
    expect(html).not.toContain(GENERIC_CONSEQUENCE);
    expect(html).not.toContain('允许执行这条命令？');
    expect(html).not.toContain('允许一次');
    expect(html).not.toContain('本会话允许');
    expect(html).not.toContain('始终允许');
    expect(html).not.toContain('到这次做完为止');
    expect(html).not.toContain('24 小时内允许');
    expect(html).not.toContain('仍然执行');
  });

  it('renders the directory card with the same buttons and its own path line', () => {
    const html = render(baseRequest({
      forceConfirm: true,
      dangerLevel: 'warning',
      reason: DIR_REASON,
      details: {
        command: 'mkdir -p /tmp/neo-sandbox/neo-dir/sub',
        deniedPath: '/tmp/neo-sandbox/neo-dir',
        action: 'sandbox_escalate_dir_once',
      },
    }));

    expect(html).toContain('沙盒拦截了这一步');
    expect(html).toContain(DIR_REASON);
    expect(html).toMatch(/<p class="[^"]*font-mono[^"]*" data-testid="sandbox-escalation-path">\/tmp\/neo-sandbox\/neo-dir<\/p>/);
    expect(buttonLabel(html, '允许仅这一次', 'y')).toBe(true);
    expect(buttonLabel(html, '拒绝', 'n')).toBe(true);
    expect(html).not.toContain(GENERIC_CONSEQUENCE);
    expect(html).not.toContain('允许一次');
  });

  it('redacts credentials on the blocked-path line and falls back when reason is empty', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const redacted = render(baseRequest({
      forceConfirm: true,
      dangerLevel: 'warning',
      reason: FILE_REASON,
      details: {
        deniedPath: `/tmp/${secret}/neo-x.txt`,
        action: 'sandbox_escalate_once',
      },
    }));
    const pathHtml = redacted.match(/data-testid="sandbox-escalation-path"[^>]*>([^<]*)</)?.[1] ?? '';
    expect(pathHtml).toContain('[REDACTED]');
    expect(pathHtml).not.toContain(secret);
    expect(redacted).toMatch(/<p class="[^"]*font-mono[^"]*" data-testid="sandbox-escalation-path">/);

    const fallback = render(baseRequest({
      forceConfirm: true,
      dangerLevel: 'warning',
      reason: '   ',
      details: {
        deniedPath: '/tmp/neo-sandbox/neo-x.txt',
        action: 'sandbox_escalate_once',
      },
    }));
    expect(fallback).toContain('沙盒拦截了这一步');
    expect(fallback).toContain('允许执行这条命令？');
    expect(fallback).not.toContain(GENERIC_CONSEQUENCE);
    expect(buttonLabel(fallback, '允许仅这一次', 'y')).toBe(true);
  });

  it('redacts credentials embedded in the host reason question line (review r1: reason 内嵌被拦路径原文)', () => {
    // 宿主 reason 模板把被拦路径原文嵌进问句（bash.ts），路径来自沙盒失败输出、
    // 模型可控；命令行与路径行都脱敏，问句不能是例外。夹具让 secret 同时进
    // reason / deniedPath / command，和真实链路一致，不许再解耦盖住。
    const secret = 'sk-ant-api03-DeadBeef1234567890';
    const reason = `沙盒拦截了这一步：它想写入文件 /tmp/${secret}/neo-x.txt。允许仅这一次写入这个文件并重跑？`;
    const html = render(baseRequest({
      forceConfirm: true,
      dangerLevel: 'warning',
      reason,
      details: {
        command: `echo hi > /tmp/${secret}/neo-x.txt`,
        deniedPath: `/tmp/${secret}/neo-x.txt`,
        action: 'sandbox_escalate_once',
      },
    }));
    expect(html).not.toContain(secret);
    expect(html).toContain('沙盒拦截了这一步：它想写入文件 /tmp/sk-[REDACTED]/neo-x.txt。允许仅这一次写入这个文件并重跑？');
  });

  it('uses the English title and buttons while showing the host reason redacted the same way', () => {
    storeState.language = 'en';
    const html = render(baseRequest({
      forceConfirm: true,
      dangerLevel: 'warning',
      reason: FILE_REASON,
      details: {
        deniedPath: '/tmp/neo-sandbox/neo-x.txt',
        action: 'sandbox_escalate_once',
      },
    }));
    expect(html).toContain('The sandbox blocked this step');
    expect(html).toContain(FILE_REASON);
    expect(buttonLabel(html, 'Allow just this once', 'y')).toBe(true);
    expect(buttonLabel(html, 'Deny', 'n')).toBe(true);
    expect(html).not.toContain('Runs a risky command');
    expect(html).not.toContain('Allow once');
  });

  it('replaces the FS_ERROR code line after the user declines', () => {
    const declined: ToolCall = {
      id: 'tool-1',
      name: 'Bash',
      arguments: { command: 'echo hello-neo > /tmp/neo-sandbox/neo-x.txt' },
      result: {
        toolCallId: 'tool-1',
        success: false,
        error: 'Operation not permitted\n\nThe user declined to widen the sandbox for this command.',
        metadata: {
          code: 'FS_ERROR',
          sandboxEscalation: { path: '/tmp/neo-sandbox/neo-x.txt', decision: 'declined' },
        },
      },
    };
    expect(humanizeToolFailureReason(declined, zh)).toBe(zh.decisionCard.permission.sandboxEscalationDeclined);
    expect(humanizeToolFailureReason(declined, zh)).toBe('已拒绝放宽沙盒。可改写到工作目录内，或换一个目标路径');
    expect(humanizeToolFailureReason(declined, zh)).not.toContain('错误码 FS_ERROR');
    expect(humanizeToolFailureReason(declined, en)).toBe(
      'Sandbox widening declined. Write inside the working folder, or pick another target path',
    );

    const directoryDeclined: ToolCall = {
      ...declined,
      result: {
        ...declined.result!,
        metadata: {
          code: 'FS_ERROR',
          sandboxEscalation: { path: '/tmp/neo-sandbox/neo-dir', decision: 'declined', granularity: 'directory' },
        },
      },
    };
    expect(humanizeToolFailureReason(directoryDeclined, zh)).toBe('已拒绝放宽沙盒。可改写到工作目录内，或换一个目标路径');

    const plainFsError: ToolCall = {
      ...declined,
      result: {
        ...declined.result!,
        metadata: { code: 'FS_ERROR' },
      },
    };
    expect(humanizeToolFailureReason(plainFsError, zh)).toBe('错误码 FS_ERROR');
  });
});

describe('other approval cards stay word-for-word', () => {
  afterEach(() => {
    storeState.language = 'zh';
    storeState.request = null;
  });

  it('renders a normal command card with the generic risky-command copy', () => {
    const html = render(baseRequest({
      id: 'req-command',
      type: 'command',
      details: { command: 'echo hi' },
    }));
    expect(html).toContain('data-view-mode="expanded"');
    expect(html).toContain('执行命令');
    expect(html).toContain('允许执行这条命令？');
    expect(html).toContain(GENERIC_CONSEQUENCE);
    expect(html).toContain('>echo hi<');
    expect(buttonLabel(html, '允许一次', 'y')).toBe(true);
    expect(buttonLabel(html, '到这次做完为止', 's')).toBe(true);
    expect(buttonLabel(html, '24 小时内允许', 'a')).toBe(true);
    expect(buttonLabel(html, '拒绝', 'n')).toBe(true);
    expect(html).not.toContain('沙盒拦截了这一步');
    expect(html).not.toContain('允许仅这一次');
    expect(html).not.toContain('data-testid="sandbox-escalation-path"');
  });

  it('renders a dangerous_command card with the danger actions', () => {
    const html = render(baseRequest({
      id: 'req-danger',
      type: 'dangerous_command',
      dangerLevel: 'danger',
      forceConfirm: true,
      details: { command: 'rm -rf /tmp/x' },
    }));
    expect(html).toContain('data-view-mode="expanded"');
    expect(html).toContain('执行命令');
    expect(html).toContain('危险');
    expect(html).toContain('允许执行这条命令？');
    expect(html).toContain('将永久删除 /tmp/x（约 1 个文件），不进回收站。');
    expect(buttonLabel(html, '仍然执行', 'y')).toBe(true);
    expect(buttonLabel(html, '拒绝', 'n')).toBe(true);
    expect(html).not.toContain('允许一次');
    expect(html).not.toContain('本会话允许');
    expect(html).not.toContain('到这次做完为止');
    expect(html).not.toContain('24 小时内允许');
    expect(html).not.toContain('沙盒拦截了这一步');
    expect(html).not.toContain(GENERIC_CONSEQUENCE);
  });

  it('renders a file_write card in the compact form', () => {
    const html = render(baseRequest({
      id: 'req-write',
      tool: 'Write',
      type: 'file_write',
      details: { path: 'notes.md' },
    }));
    expect(html).toContain('data-view-mode="compact"');
    expect(html).toContain('允许写入 notes.md？');
    expect(buttonLabel(html, '允许一次', 'y')).toBe(true);
    expect(buttonLabel(html, '到这次做完为止', 's')).toBe(true);
    expect(buttonLabel(html, '24 小时内允许', 'a')).toBe(true);
    expect(buttonLabel(html, '拒绝', 'n')).toBe(true);
    expect(html).not.toContain('将写入 notes.md');
    expect(html).not.toContain('沙盒拦截了这一步');
    expect(html).not.toContain('允许仅这一次');
    expect(html).not.toContain(GENERIC_CONSEQUENCE);
  });
});
