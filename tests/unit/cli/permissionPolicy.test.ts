import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import {
  createCLIPermissionHandler,
  resolveCLIPermissionModeFlag,
  setInteractiveApprovalProvider,
} from '../../../src/cli/permissionPolicy';
import { getPermissionClassifier } from '../../../src/host/tools/permissionClassifier';
import { setCommandPolicyRulesForTest } from '../../../src/host/tools/modules/shell/commandPolicy';
import type { PermissionRequestData } from '../../../src/host/tools/types';
import type { DecisionTrace } from '../../../src/shared/contract/decisionTrace';

/** N-PERMTRACE：CLI/headless 拒的是「环境没有审批界面」，不是用户——处理器必须自报。 */
const DENIED_BY_ENV = { approved: false, denialSource: 'no-approval-ui' };

function makeRequest(overrides: Partial<PermissionRequestData> = {}): PermissionRequestData {
  return {
    type: 'command',
    tool: 'Bash',
    details: { command: 'ls' },
    ...overrides,
  };
}

describe('createCLIPermissionHandler', () => {
  it('denies every ask by default because CLI mode has no approval surface', async () => {
    const handler = createCLIPermissionHandler();
    await expect(handler(makeRequest({ type: 'file_write' }))).resolves.toEqual(DENIED_BY_ENV);
    await expect(handler(makeRequest({ type: 'command' }))).resolves.toEqual(DENIED_BY_ENV);
    await expect(handler(makeRequest({ type: 'network' }))).resolves.toEqual(DENIED_BY_ENV);
  });

  it('denies dangerous_command type in non-interactive mode', async () => {
    const handler = createCLIPermissionHandler();
    await expect(
      handler(makeRequest({ type: 'dangerous_command', details: { command: 'rm -rf /tmp/x' } })),
    ).resolves.toEqual(DENIED_BY_ENV);
  });

  it('denies requests flagged forceConfirm (需要人工确认)', async () => {
    const handler = createCLIPermissionHandler();
    await expect(handler(makeRequest({ forceConfirm: true }))).resolves.toEqual(DENIED_BY_ENV);
  });

  it('denies requests with dangerLevel danger', async () => {
    const handler = createCLIPermissionHandler();
    await expect(handler(makeRequest({ dangerLevel: 'danger' }))).resolves.toEqual(DENIED_BY_ENV);
  });

  it('denies an external file write when no person can answer the ask', async () => {
    const handler = createCLIPermissionHandler();

    await expect(handler(makeRequest({
      type: 'file_write',
      tool: 'Write',
      details: { path: '/Users/linchen/boundary_probe.txt' },
      boundary: {
        id: 'file.external_write',
        reason: '写入文件内容会修改工作区外的目标路径。',
      },
    }))).resolves.toEqual(DENIED_BY_ENV);
  });

  it('approves everything when dangerouslySkipPermissions is set', async () => {
    const handler = createCLIPermissionHandler({ dangerouslySkipPermissions: true });
    await expect(handler(makeRequest({ type: 'dangerous_command' }))).resolves.toEqual({ approved: true });
    await expect(handler(makeRequest({ forceConfirm: true }))).resolves.toEqual({ approved: true });
    await expect(handler(makeRequest({ dangerLevel: 'danger' }))).resolves.toEqual({ approved: true });
  });

  it('emits a warning explaining the deny and the escape hatch', async () => {
    const warn = vi.fn();
    const handler = createCLIPermissionHandler({ warn });
    await handler(makeRequest({ type: 'dangerous_command', details: { command: 'rm -rf /' } }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('--dangerously-skip-permissions');
  });

  it('does not warn on approvals', async () => {
    const warn = vi.fn();
    const handler = createCLIPermissionHandler({ warn, dangerouslySkipPermissions: true });
    await handler(makeRequest());
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('交互审批注册点（P4 Ink TUI）', () => {
  it('注册 provider 后走交互通道，注销后回落 no-approval-ui', async () => {
    const handler = createCLIPermissionHandler();
    try {
      setInteractiveApprovalProvider(async () => ({ approved: true }));
      await expect(handler(makeRequest({ type: 'dangerous_command' }))).resolves.toEqual({ approved: true });
    } finally {
      setInteractiveApprovalProvider(null);
    }
    await expect(handler(makeRequest({ type: 'dangerous_command' }))).resolves.toEqual(DENIED_BY_ENV);
  });

  it('--dangerously-skip-permissions 优先于交互通道', async () => {
    const handler = createCLIPermissionHandler({ dangerouslySkipPermissions: true });
    try {
      setInteractiveApprovalProvider(async () => ({ approved: false, denialSource: 'user' }));
      await expect(handler(makeRequest())).resolves.toEqual({ approved: true });
    } finally {
      setInteractiveApprovalProvider(null);
    }
  });
});


describe('resolveCLIPermissionModeFlag', () => {
  it('未传标志时返回 undefined（现有行为不变）', () => {
    expect(resolveCLIPermissionModeFlag(undefined)).toBeUndefined();
    expect(resolveCLIPermissionModeFlag(undefined, true)).toBeUndefined();
  });

  it('接受 auto', () => {
    expect(resolveCLIPermissionModeFlag('auto')).toBe('auto');
  });

  it('拒绝未知取值', () => {
    expect(() => resolveCLIPermissionModeFlag('strict')).toThrow(/--permission-mode/);
  });

  it('与 --dangerously-skip-permissions 互斥', () => {
    expect(() => resolveCLIPermissionModeFlag('auto', true)).toThrow(/互斥/);
  });
});

describe('createCLIPermissionHandler --permission-mode auto', () => {
  const cwd = process.cwd();
  const AUTO_APPROVED = { approved: true, approvalSource: 'cli-auto-approve' };

  beforeEach(() => {
    // 与用户机 exec-policy/命令规则隔离，分类器缓存不跨用例串味
    getPermissionClassifier().clearCache();
    setCommandPolicyRulesForTest([]);
  });

  function autoHandler(warn = vi.fn()) {
    return { handler: createCLIPermissionHandler({ permissionMode: 'auto', workingDirectory: cwd, warn }), warn };
  }

  function makeTrace(steps: Array<{ layer: DecisionTrace['steps'][number]['layer']; rule: string }>): DecisionTrace {
    return {
      toolName: 'Bash',
      finalOutcome: 'ask',
      steps: steps.map((step) => ({
        layer: step.layer,
        rule: step.rule,
        result: 'ask' as const,
        reason: 'test',
        durationMs: 0,
        timestamp: Date.now(),
      })),
      totalDurationMs: 0,
    };
  }

  it('只读工具请求由分类器放行，并以 cli-auto-approve 自报机器批准来源', async () => {
    const { handler, warn } = autoHandler();
    await expect(handler(makeRequest({
      type: 'file_read',
      tool: 'Read',
      details: { path: path.join(cwd, 'package.json') },
    }))).resolves.toEqual(AUTO_APPROVED);
    expect(warn).not.toHaveBeenCalled();
  });

  it('安全命令（ls）自动批准并入账标记', async () => {
    const { handler } = autoHandler();
    await expect(handler(makeRequest({
      type: 'command',
      tool: 'Bash',
      details: { command: 'ls -la' },
    }))).resolves.toEqual(AUTO_APPROVED);
  });

  it('工作区内写入自动批准', async () => {
    const { handler } = autoHandler();
    await expect(handler(makeRequest({
      type: 'file_write',
      tool: 'Write',
      details: { path: path.join(cwd, 'scratch-auto-mode.txt') },
    }))).resolves.toEqual(AUTO_APPROVED);
  });

  it('工作区与临时目录外的写入 fail-closed 拒绝，reason 可转述', async () => {
    const { handler, warn } = autoHandler();
    const result = await handler(makeRequest({
      type: 'file_write',
      tool: 'Write',
      details: { path: path.join(os.homedir(), 'neo-auto-boundary-probe.txt') },
    }));
    expect(result.approved).toBe(false);
    expect(result.denialSource).toBe('no-approval-ui');
    expect(result.message).toContain('--permission-mode auto');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('分类器判 deny 的危险命令拒绝', async () => {
    const { handler } = autoHandler();
    const result = await handler(makeRequest({
      type: 'dangerous_command',
      tool: 'Bash',
      details: { command: 'rm -rf /' },
    }));
    expect(result.approved).toBe(false);
    expect(result.denialSource).toBe('no-approval-ui');
  });

  it('分类器无法判定的命令（ask）拒绝', async () => {
    const { handler } = autoHandler();
    const result = await handler(makeRequest({
      type: 'command',
      tool: 'Bash',
      details: { command: 'some-unrecognized-daemon --frobnicate' },
    }));
    expect(result.approved).toBe(false);
  });

  it('forceConfirm 请求即使是安全命令也不放行', async () => {
    const { handler } = autoHandler();
    const result = await handler(makeRequest({
      forceConfirm: true,
      details: { command: 'ls' },
    }));
    expect(result.approved).toBe(false);
    expect(result.denialSource).toBe('no-approval-ui');
  });

  it.each([
    ['policy_enforcer', 'tools.always_confirm'],
    ['guard_fabric', 'some_guard'],
    ['permission_classifier', 'command_analysis_failed'],
    ['permission_classifier', 'skill.allowed-tools-boundary'],
    ['permission_classifier', 'shell_desktop_automation'],
  ] as const)('decisionTrace 含硬门步骤（%s/%s）时不放行', async (layer, rule) => {
    const { handler } = autoHandler();
    const result = await handler(makeRequest({
      details: { command: 'ls' },
      decisionTrace: makeTrace([{ layer, rule }]),
    }));
    expect(result.approved).toBe(false);
    expect(result.message).toContain('硬性审批门');
  });

  it('交互审批通道优先于 auto 档', async () => {
    const { handler } = autoHandler();
    try {
      setInteractiveApprovalProvider(async () => ({ approved: false, denialSource: 'user' }));
      const result = await handler(makeRequest({ details: { command: 'ls' } }));
      expect(result).toEqual({ approved: false, denialSource: 'user' });
    } finally {
      setInteractiveApprovalProvider(null);
    }
  });
});
