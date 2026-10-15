// ============================================================================
// 用户级 deny 规则在主 Bash 链的硬拒（N-PERMRULES-LOCAL-OWNER r1）
// ----------------------------------------------------------------------------
// 真实 ToolExecutor + 全局 PolicyEngine（settings permissions.deny 的装载目标）。
// 缺口：用户 deny 规则此前的消费点都不在主链放行捷径之前——已知安全命令白名单、
// exec-policy allow、lenient 档、skill 预授权全部先放行，非已知安全命令降级成可批的
// ask。本文件钉死：用户显式 deny 在所有自动放行捷径与 ask 分类链之前硬拒。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { PermissionRequestData } from '../../../src/host/tools/types';
import { getPermissionClassifier } from '../../../src/host/tools/permissionClassifier';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';

describe('ToolExecutor 用户级 deny 规则硬拒（主 Bash 链）', () => {
  let workspace: string;
  let permissionEvents: PermissionRequestData[];

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'user-deny-rule-'));
    permissionEvents = [];
    getToolCache().clear();
    resetPolicyEngine();
    getPermissionClassifier({ enableLlm: false });
    resetPermissionModeManager();
  });

  afterEach(async () => {
    getPermissionClassifier({ enableLlm: false }).clearCache();
    resetPermissionModeManager();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const createExecutor = () => {
    const executor = new ToolExecutor({
      workingDirectory: workspace,
      requestPermission: async (request) => {
        permissionEvents.push(request);
        return true;
      },
    });
    executor.setAuditEnabled(false);
    return executor;
  };

  it('已知安全命令命中用户 deny 规则：不执行、硬拒文案点名规则、不进审批', async () => {
    getPolicyEngine().loadUserRules({ deny: ['Bash(echo neo-deny-probe*)'] }, 'user-ui');
    const executor = createExecutor();

    const result = await executor.execute('Bash', { command: 'echo neo-deny-probe' }, { sessionId: 'user-deny-known-safe' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('User deny: Bash(echo neo-deny-probe*)');
    expect(result.error).toContain('user permission rule');
    // 硬拒不是可批的 ask：审批回调一次都不该被叫。
    expect(permissionEvents).toHaveLength(0);
  });

  it('非已知安全命令命中用户 deny 规则：同样硬拒，不降级成 ask/分类器，也不落盘', async () => {
    const target = path.join(os.tmpdir(), `neo-deny-probe-${process.pid}.txt`);
    getPolicyEngine().loadUserRules({ deny: [`Bash(touch ${target}*)`] }, 'user-ui');
    const executor = createExecutor();

    const result = await executor.execute('Bash', { command: `touch ${target}` }, { sessionId: 'user-deny-unsafe' });

    expect(result.success).toBe(false);
    expect(result.error).toContain(`User deny: Bash(touch ${target}*)`);
    expect(permissionEvents).toHaveLength(0);
    await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('已知安全命令不命中任何用户 deny 规则：照走安全命令捷径，免审批直接执行', async () => {
    getPolicyEngine().loadUserRules({ deny: ['Bash(echo neo-deny-probe*)'] }, 'user-ui');
    const executor = createExecutor();

    const result = await executor.execute('Bash', { command: 'echo hello' }, { sessionId: 'user-deny-unmatched' });

    expect(result.success).toBe(true);
    expect(permissionEvents).toHaveLength(0);
  });

  it('用户 allow 规则不产生新的放行捷径：非已知安全命令仍走审批后才执行', async () => {
    const target = path.join(workspace, 'neo-allow-probe.txt');
    getPolicyEngine().loadUserRules({ allow: [`Bash(touch ${target}*)`] }, 'user-ui');
    const executor = createExecutor();

    const result = await executor.execute('Bash', { command: `touch ${target}` }, { sessionId: 'user-allow-no-shortcut' });

    expect(permissionEvents).toHaveLength(1);
    expect(result.success).toBe(true);
    await expect(fs.access(target)).resolves.toBeUndefined();
  });
});
