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
import { PermissionRequestReason } from '../../../src/shared/contract/permission';
import { resetPolicyEnforcer } from '../../../src/host/security/policyEnforcer';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { resolveCanonicalRunPath } from '../../../src/host/runtime/runContext';
import { getSandboxManager } from '../../../src/host/sandbox';

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

  it('受保护路径不被 allow 放行：Edit(**)+预批写 settings.json 仍要审批且 forceConfirm', async () => {
    const { getPolicyEngine, resetPolicyEngine } = await import('../../../src/host/permissions/policyEngine');
    const previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    const dataDir = path.join(workspace, 'neo-data');
    await fs.mkdir(dataDir, { recursive: true });
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    resetPolicyEngine();
    getPolicyEngine().loadUserRules({ allow: ['Edit(**)', 'Write(**)'] });
    try {
      const target = path.join(dataDir, 'settings.json');
      const executor = buildRejectingExecutor();
      const result = await executor.execute(
        'Write',
        { file_path: target, content: 'pwned' },
        { sessionId: 'protected-write-settings-allow', preApprovedTools: new Set(['Write', 'Edit']) },
      );
      expect(permissionRequests).toHaveLength(1);
      expect(permissionRequests[0].forceConfirm).toBe(true);
      expect(result.success).toBe(false);
      expect(existsSync(target)).toBe(false);
    } finally {
      resetPolicyEngine();
      if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
      else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    }
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
      expect(pathPolicyAsks[0]?.reasonCode).toBe(PermissionRequestReason.UncertainWriteTargetWithPathDeny);
      expect(pathPolicyAsks[0]?.forceConfirm).toBe(true);
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
      expect(pathPolicyAsks[0]?.reasonCode).toBe(PermissionRequestReason.UncertainWriteTargetWithPathDeny);
      expect(pathPolicyAsks[0]?.forceConfirm).toBe(true);
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

    it('chmod -R 777 配路径 deny 且写目标解析不出时，仍硬拒不可批，不降成审批卡', async () => {
      classifierState.autoApprove = false;
      await writeDeniedPathsPolicy();
      const executor = buildPathPolicyExecutor();

      const result = await executor.execute(
        'Bash',
        { command: 'chmod -R 777 /Applications > "$LOG/out.txt"' },
        { sessionId: 'unresolved-chmod-777-still-deny' },
      );

      const pathPolicyAsks = permissionRequests.filter((request) => !isDirectiveMemoryProbe(request));
      expect(pathPolicyAsks).toHaveLength(0);
      expect(result.success).toBe(false);
      expect(result.error ?? '').toContain('Denied');
      expect(result.error ?? '').toContain('危险权限变更');
    });
  });

  describe('N-WRITETARGET-EXECTIME：围栏内项目写入免确认', () => {
    function fenceAvailable(): boolean {
      return process.platform !== 'win32' && getSandboxManager().isAvailable();
    }

    function buildGrantingExecutor(): ToolExecutor {
      const executor = new ToolExecutor({
        workingDirectory: workspace,
        requestPermission: async (request) => {
          permissionRequests.push(request);
          return true;
        },
      });
      executor.setAuditEnabled(false);
      return executor;
    }

    it.each([
      ['benign-redirect-truncate', (root: string) => `printf ok > ${root}/out.txt`, 'out.txt'],
      ['benign-redirect-append', (root: string) => `printf ok >> ${root}/out.txt`, 'out.txt'],
      ['benign-redirect-both', (root: string) => `printf ok &> ${root}/out.txt`, 'out.txt'],
      ['benign-assignment-mode-tee', (root: string) => `MODE=1 tee ${root}/mode.txt`, 'mode.txt'],
      ['benign-assignment-multiple', (root: string) => `A=1 B=2 tee ${root}/multi.txt`, 'multi.txt'],
    ])('%s 在围栏可用时免确认并写入项目内', async (_id, commandFor, relative) => {
      const executor = buildRejectingExecutor();
      const result = await executor.execute(
        'Bash',
        { command: commandFor(workspace) },
        { sessionId: `exectime-benign-${relative}` },
      );

      if (fenceAvailable()) {
        expect(permissionRequests).toHaveLength(0);
        expect(result.success).toBe(true);
        expect(existsSync(path.join(workspace, relative))).toBe(true);
      } else {
        expect(permissionRequests.length).toBeGreaterThan(0);
        expect(result.success).toBe(false);
        expect(existsSync(path.join(workspace, relative))).toBe(false);
      }
    });

    it('围栏不可用时不假装免确认，退回弹卡', async () => {
      const manager = getSandboxManager();
      const spy = vi.spyOn(manager, 'isAvailable').mockReturnValue(false);
      try {
        const executor = buildRejectingExecutor();
        const result = await executor.execute(
          'Bash',
          { command: `printf ok > ${workspace}/no-fence.txt` },
          { sessionId: 'exectime-fence-unavailable' },
        );
        expect(permissionRequests.length).toBeGreaterThan(0);
        expect(result.success).toBe(false);
        expect(existsSync(path.join(workspace, 'no-fence.txt'))).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('引号拼接不得把区外路径当成区内免确认', async () => {
      const outside = path.join(os.tmpdir(), `exectime-quote-${process.pid}.txt`);
      const executor = buildRejectingExecutor();
      await executor.execute(
        'Bash',
        { command: `printf ok > ${JSON.stringify(path.dirname(outside))}/"${path.basename(outside)}"` },
        { sessionId: 'exectime-bypass-quote' },
      );
      expect(permissionRequests.length).toBeGreaterThan(0);
      expect(existsSync(outside)).toBe(false);
    });

    it('Unicode 同形路径不得免确认放行到区外', async () => {
      const outside = path.join(os.tmpdir(), `exectime-homo-${process.pid}.txt`);
      const executor = buildRejectingExecutor();
      await executor.execute(
        'Bash',
        { command: `printf ok > ..\u2215${path.basename(outside)}` },
        { sessionId: 'exectime-bypass-homoglyph' },
      );
      expect(permissionRequests.length).toBeGreaterThan(0);
      expect(existsSync(outside)).toBe(false);
      expect(existsSync(path.join(workspace, '..', path.basename(outside)))).toBe(false);
    });

    it('Unicode 空白后的第二命令不得被当成注释而免确认', async () => {
      const outside = path.join(os.tmpdir(), `exectime-nbsp-${process.pid}.txt`);
      const executor = buildRejectingExecutor();
      await executor.execute(
        'Bash',
        { command: `printf ok > ${workspace}/nbsp.txt\u00a0; printf pwned > ${JSON.stringify(outside)}` },
        { sessionId: 'exectime-bypass-nbsp' },
      );
      expect(permissionRequests.length).toBeGreaterThan(0);
      expect(existsSync(outside)).toBe(false);
    });

    it('-- 后横线文件名不得当选项丢掉后免确认', async () => {
      const executor = buildRejectingExecutor();
      await executor.execute(
        'Bash',
        { command: 'cp -- bar -locked.txt' },
        { sessionId: 'exectime-bypass-dash-operand' },
      );
      expect(permissionRequests.length).toBeGreaterThan(0);
      expect(existsSync(path.join(workspace, '-locked.txt'))).toBe(false);
    });

    it('软链跨界：字面在区内的写入不得静默写到区外', async () => {
      const sub = path.join(workspace, 'link-sub');
      const outsideDir = await fs.mkdtemp(path.join('/tmp', 'exectime-link-'));
      const outsideFile = path.join(outsideDir, 'out.txt');
      await fs.symlink(outsideDir, sub, process.platform === 'win32' ? 'junction' : 'dir');

      const executor = buildGrantingExecutor();
      await executor.execute(
        'Bash',
        { command: `printf ok > ${path.join(sub, 'out.txt')}` },
        { sessionId: 'exectime-bypass-symlink' },
      );

      const outsideContents = existsSync(outsideFile)
        ? await fs.readFile(outsideFile, 'utf8')
        : '';
      expect(outsideContents).not.toContain('ok');
      await fs.rm(outsideDir, { recursive: true, force: true });
    });

    it('printf -v 改查找路径不得当「只是写文件」免确认', async () => {
      const executor = buildRejectingExecutor();
      await executor.execute(
        'Bash',
        { command: `printf -v PATH '%s' '/tmp/exectime-bin' > ${workspace}/printf-v.txt` },
        { sessionId: 'exectime-bypass-printf-v' },
      );
      expect(permissionRequests.length).toBeGreaterThan(0);
      expect(existsSync(path.join(workspace, 'printf-v.txt'))).toBe(false);
    });

    it('TOCTOU：批准区内写入后把目录换成区外软链，不得复用批准写出去', async () => {
      const sub = path.join(workspace, 'toctou-sub');
      await fs.mkdir(sub);
      const command = `printf ok > ${path.join(sub, 'out.txt')}`;
      const executor = buildGrantingExecutor();

      const first = await executor.execute(
        'Bash',
        { command },
        { sessionId: 'exectime-toctou-1' },
      );
      expect(first.success).toBe(true);

      const outsideDir = await fs.mkdtemp(path.join('/tmp', 'exectime-toctou-'));
      const outsideFile = path.join(outsideDir, 'out.txt');
      await fs.rm(sub, { recursive: true, force: true });
      await fs.symlink(outsideDir, sub, process.platform === 'win32' ? 'junction' : 'dir');

      permissionRequests.length = 0;
      await executor.execute(
        'Bash',
        { command },
        { sessionId: 'exectime-toctou-2' },
      );

      const outsideContents = existsSync(outsideFile)
        ? await fs.readFile(outsideFile, 'utf8')
        : '';
      expect(outsideContents).not.toContain('ok');
      await fs.rm(outsideDir, { recursive: true, force: true });
    });
  });
});
