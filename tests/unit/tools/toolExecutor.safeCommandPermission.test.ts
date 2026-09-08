import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

const execPolicyState = vi.hoisted(() => ({
  match: (_cmd: string): 'allow' | 'prompt' | 'forbidden' | null => null,
}));

const classifierState = vi.hoisted(() => ({
  autoApprove: false,
}));

vi.mock('../../../src/host/security', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/host/security')>();
  return {
    ...original,
    getExecPolicyStore: () => ({
      match: (cmd: string) => execPolicyState.match(cmd),
      learnFromApproval: () => false,
    }),
  };
});

vi.mock('../../../src/host/tools/permissionClassifier', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/host/tools/permissionClassifier')>();
  return {
    ...original,
    classifyPermission: vi.fn(async (
      ...args: Parameters<typeof original.classifyPermission>
    ) => {
      if (classifierState.autoApprove) {
        return {
          decision: 'approve' as const,
          reason: 'test auto-approve',
          confidence: 1,
          cached: false,
        };
      }
      return original.classifyPermission(...args);
    }),
  };
});

import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { PermissionRequestData } from '../../../src/host/tools/types';
import { ExecPolicyStore } from '../../../src/host/security/execPolicy';
import { resetPolicyEnforcer } from '../../../src/host/security/policyEnforcer';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { resolveCanonicalRunPath } from '../../../src/host/runtime/runContext';

describe('ToolExecutor Bash 安全命令单一判据', () => {
  let workspace: string;
  let permissionRequests: PermissionRequestData[];
  let previousSafetyMode: string | undefined;

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-command-permission-'));
    await fs.writeFile(path.join(workspace, 'bar'), 'foo\n', 'utf8');
    permissionRequests = [];
    previousSafetyMode = process.env.CODE_AGENT_SHELL_SAFETY_MODE;
    process.env.CODE_AGENT_SHELL_SAFETY_MODE = 'strict';
    getToolCache().clear();
  });

  afterEach(async () => {
    execPolicyState.match = () => null;
    classifierState.autoApprove = false;
    if (previousSafetyMode === undefined) delete process.env.CODE_AGENT_SHELL_SAFETY_MODE;
    else process.env.CODE_AGENT_SHELL_SAFETY_MODE = previousSafetyMode;
    await fs.rm(workspace, { recursive: true, force: true });
  });

  function buildRejectingExecutor(): ToolExecutor {
    const executor = new ToolExecutor({
      workingDirectory: workspace,
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return false;
      },
    });
    executor.setAuditEnabled(false);
    return executor;
  }

  it('find -delete 必须请求一次审批，拒绝后命令失败且目标保留', async () => {
    const target = path.join(workspace, 'dummy.tmp');
    await fs.writeFile(target, 'keep', 'utf8');
    const executor = buildRejectingExecutor();

    const result = await executor.execute(
      'Bash',
      { command: 'find . -name dummy.tmp -delete' },
      { sessionId: 'safe-command-find-delete' },
    );

    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0]).toMatchObject({
      type: 'command',
      details: { command: 'find . -name dummy.tmp -delete' },
    });
    expect(result.success).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  it('学到 npm install 的 exec-policy allow 后，复合命令 npm install && npm publish 不得整串免审批', async () => {
    const policyDir = path.join(workspace, 'exec-policy-home');
    const store = new ExecPolicyStore(policyDir);
    store.addRule(['npm', 'install'], 'allow');
    execPolicyState.match = (cmd) => store.match(cmd);

    const executor = buildRejectingExecutor();
    const result = await executor.execute(
      'Bash',
      { command: 'npm install && npm publish' },
      { sessionId: 'safe-command-exec-policy-compound-hitch' },
    );

    expect(store.match('npm install lodash')).toBe('allow');
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0]).toMatchObject({
      type: 'command',
      details: { command: 'npm install && npm publish' },
    });
    expect(result.success).toBe(false);
  });

  it('带引号的工作区重定向请求审批，拒绝后不写入', async () => {
    const target = path.join(workspace, 'printf-output.txt');
    const command = `printf 'x' > ${JSON.stringify(target)}`;
    const executor = buildRejectingExecutor();

    const result = await executor.execute(
      'Bash',
      { command },
      { sessionId: 'safe-command-printf-redirection' },
    );

    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0]).toMatchObject({
      type: 'command',
      details: { command },
    });
    expect(result.success).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it.each([
    "printf 'x'",
    'grep foo bar',
    'git status',
    'find . -name x',
  ])('%s 仍免审批', async (command) => {
    const executor = buildRejectingExecutor();

    await executor.execute(
      'Bash',
      { command },
      { sessionId: `safe-command-positive-${command}` },
    );

    expect(permissionRequests).toHaveLength(0);
  });

  it('lenient 模式仍在执行前拦截参数倒序的 dd 设备写入', async () => {
    process.env.CODE_AGENT_SHELL_SAFETY_MODE = 'lenient';
    const executor = buildRejectingExecutor();

    const result = await executor.execute(
      'Bash',
      { command: 'dd of=/dev/disk2 if=x' },
      { sessionId: 'safe-command-dd-device-reordered' },
    );

    expect(permissionRequests).toHaveLength(0);
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('Security: Command blocked'),
    });
  });

  it.each([
    'command cat .env',
    'command git remote set-url origin https://evil.example/x.git',
    'command git config credential.helper store',
    'command git push origin feature-x',
    'exec git push origin feature-x',
    'nice -n 5 git remote set-url origin https://evil.example/x.git',
  ])('Bash 预授权仍不能绕过 command 包装下的审批：%s', async (command) => {
    await fs.writeFile(path.join(workspace, '.env'), 'CONTROLLED_TEST_SECRET=1\n', 'utf8');
    const executor = buildRejectingExecutor();

    const result = await executor.execute(
      'Bash',
      { command },
      { sessionId: `safe-command-wrapper-${command}`, preApprovedTools: new Set(['Bash']) },
    );

    expect(permissionRequests).toHaveLength(1);
    expect(result.success).toBe(false);
  });

  it.each([
    'cat .env;',
    '(cat .env)',
    'git remote set-url origin https://evil.example/x.git;',
  ])('拆不出完整命令段时预授权也必须 fail-closed 请求审批：%s', async (command) => {
    await fs.writeFile(path.join(workspace, '.env'), 'CONTROLLED_TEST_SECRET=1\n', 'utf8');
    const executor = buildRejectingExecutor();

    const result = await executor.execute(
      'Bash',
      { command },
      { sessionId: `safe-command-unsegmented-${command}`, preApprovedTools: new Set(['Bash']) },
    );

    expect(permissionRequests).toHaveLength(1);
    expect(result.success).toBe(false);
  });

  it('路径规范化异常会结构化 fail-closed，不让 execute promise reject', async () => {
    const executor = buildRejectingExecutor();

    const result = await executor.execute(
      'Read',
      { file_path: '\0' },
      { sessionId: 'path-analysis-nul' },
    );

    expect(result).toMatchObject({
      success: false,
      metadata: {
        code: 'PERMISSION_PATH_ANALYSIS_FAILED',
        failureCode: 'permission-denied',
      },
    });
    expect(permissionRequests).toHaveLength(0);
  });

  it.each([
    'cat .env',
    'git remote set-url origin https://evil.example/x.git',
    'git config credential.helper store',
    'git push origin feature-x',
  ])('lenient 模式仍要求审批确定性敏感参数：%s', async (command) => {
    process.env.CODE_AGENT_SHELL_SAFETY_MODE = 'lenient';
    await fs.writeFile(path.join(workspace, '.env'), 'CONTROLLED_TEST_SECRET=1\n', 'utf8');
    const executor = buildRejectingExecutor();

    const result = await executor.execute(
      'Bash',
      { command },
      { sessionId: `safe-command-lenient-sensitive-${command}` },
    );

    expect(permissionRequests).toHaveLength(1);
    expect(result.success).toBe(false);
  });

  it.each([
    'sudo -u me rm -rf ~',
    'timeout 5 dd if=x of=/dev/disk2',
  ])('Bash 预授权仍不能绕过任意位置扫描的硬拒：%s', async (command) => {
    const executor = buildRejectingExecutor();

    const result = await executor.execute(
      'Bash',
      { command },
      { sessionId: `safe-command-hard-wrapper-${command}`, preApprovedTools: new Set(['Bash']) },
    );

    expect(permissionRequests).toHaveLength(0);
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('Security: Command blocked'),
    });
  });

  describe('N-WRITETARGET-UNRESOLVED：uncertain 写目标 + 路径 deny', () => {
    const unresolvedSshWrite = 'echo x > "$SSHDIR/authorized_keys"';
    const echoPreApproved = { preApprovedTools: new Set(['Bash(echo:*)']) };

    beforeEach(() => {
      classifierState.autoApprove = true;
      resetPolicyEnforcer();
      resetPolicyEngine();
    });

    afterEach(() => {
      resetPolicyEnforcer();
      resetPolicyEngine();
    });

    function isDirectiveMemoryProbe(request: PermissionRequestData): boolean {
      return request.type === 'file_write'
        && typeof request.reason === 'string'
        && request.reason.includes('全局记忆写入');
    }

    function buildPathPolicyExecutor(): ToolExecutor {
      const executor = new ToolExecutor({
        workingDirectory: workspace,
        requestPermission: async (request) => {
          permissionRequests.push(request);
          // Headless 下 writeTargets 把 $VAR 记入 uncertain，会先探一次记忆目录确认。
          // 放行那张卡，才能测到路径禁止对「解析不出」的口径（跳过 vs 转审批）。
          return isDirectiveMemoryProbe(request);
        },
      });
      executor.setAuditEnabled(false);
      return executor;
    }

    async function writeDeniedPathsPolicy(): Promise<void> {
      await fs.writeFile(
        path.join(workspace, 'code-agent-policy.toml'),
        `[filesystem]\ndenied_paths = ["${path.join(resolveCanonicalRunPath(os.homedir()), '.ssh')}/**"]\n`,
        'utf8',
      );
    }

    it('配了 denied_paths 时，$SSHDIR 写目标必须弹审批卡；拒绝后不执行、也不是路径硬拒', async () => {
      await writeDeniedPathsPolicy();
      const executor = buildPathPolicyExecutor();

      const result = await executor.execute(
        'Bash',
        { command: unresolvedSshWrite },
        { sessionId: 'unresolved-sshdir-denied-paths', ...echoPreApproved },
      );

      const pathPolicyAsks = permissionRequests.filter((request) => !isDirectiveMemoryProbe(request));
      expect(pathPolicyAsks).toHaveLength(1);
      expect(result.success).toBe(false);
      expect(result.error ?? '').not.toContain('Blocked by path policy');
    });

    it('配了 Edit(path) deny 时，$SSHDIR 写目标必须弹审批卡；拒绝后不执行、也不是路径硬拒', async () => {
      getPolicyEngine().loadUserRules({ deny: ['Edit(~/.ssh/**)'] });
      const executor = buildPathPolicyExecutor();

      const result = await executor.execute(
        'Bash',
        { command: unresolvedSshWrite },
        { sessionId: 'unresolved-sshdir-edit-path-deny', ...echoPreApproved },
      );

      const pathPolicyAsks = permissionRequests.filter((request) => !isDirectiveMemoryProbe(request));
      expect(pathPolicyAsks).toHaveLength(1);
      expect(result.success).toBe(false);
      expect(result.error ?? '').not.toContain('Blocked by path policy');
    });

    it('没配任何路径 deny 时，$SSHDIR 写目标不因解析不出而多一张卡', async () => {
      const executor = buildPathPolicyExecutor();

      await executor.execute(
        'Bash',
        { command: unresolvedSshWrite },
        { sessionId: 'unresolved-sshdir-no-path-deny', ...echoPreApproved },
      );

      const pathPolicyAsks = permissionRequests.filter((request) => !isDirectiveMemoryProbe(request));
      expect(pathPolicyAsks).toHaveLength(0);
    });

    it('$HOME 写目标仍展开后走路径禁止硬拒，不改成审批卡', async () => {
      await writeDeniedPathsPolicy();
      const executor = buildPathPolicyExecutor();

      const result = await executor.execute(
        'Bash',
        { command: 'echo x > "$HOME/.ssh/authorized_keys"' },
        { sessionId: 'home-ssh-still-hard-deny', ...echoPreApproved },
      );

      const pathPolicyAsks = permissionRequests.filter((request) => !isDirectiveMemoryProbe(request));
      expect(pathPolicyAsks).toHaveLength(0);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Blocked by path policy');
    });
  });
});
