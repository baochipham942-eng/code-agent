// ============================================================================
// PolicyEnforcer Integration Tests (GAP-002)
// ============================================================================
//
// 验证 code-agent-policy.toml 硬规则真正接入了 toolExecutor 执行链：
// - deny 不可被 skill 预授权 / 安全命令白名单 / classifier 放行推翻
// - always_confirm 强制用户审批
// - 无 policy 文件时零干预
//
// 课程依据：《Claude Code 工程化实战》第 20 讲 "绝对底线必须落到 deny 硬拦截"

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolExecutor } from '../../src/host/tools/toolExecutor';
import { resetPolicyEnforcer } from '../../src/host/security/policyEnforcer';
import { getDecisionHistory, resetDecisionHistory } from '../../src/host/security/decisionHistory';

// Mock tool resolver — bash + write_file 两个工具
vi.mock('../../src/host/tools/dispatch/toolResolver', () => {
  const bashDef = {
    name: 'bash',
    description: 'Execute bash commands',
    inputSchema: {
      type: 'object' as const,
      properties: { command: { type: 'string' as const } },
      required: ['command'],
    },
    requiresPermission: true,
    permissionLevel: 'execute' as const,
  };
  const writeDef = {
    name: 'write_file',
    description: 'Write a file',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string' as const },
        content: { type: 'string' as const },
      },
      required: ['file_path', 'content'],
    },
    requiresPermission: true,
    permissionLevel: 'write' as const,
  };
  const defs: Record<string, unknown> = { bash: bashDef, write_file: writeDef };
  const fakeResolver = {
    list: () => Object.keys(defs),
    getDefinition: (name: string) => defs[name],
    listDefinitions: () => Object.values(defs),
    has: (name: string) => name in defs,
    execute: vi.fn().mockResolvedValue({ success: true, output: '' }),
  };
  return {
    getToolResolver: () => fakeResolver,
    resetToolResolver: () => {},
  };
});

// Mock security barrel：隔离 exec policy / audit，但保留真实的 PolicyEnforcer
vi.mock('../../src/host/security', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/host/security')>();
  return {
    ...original,
    getAuditLogger: () => ({
      logToolUsage: vi.fn(),
      logSecurityIncident: vi.fn(),
      log: vi.fn(),
    }),
    maskSensitiveData: (s: string) => s,
    getExecPolicyStore: () => ({
      match: () => null,
      learnFromApproval: () => false,
    }),
    // getPolicyEnforcer / resetPolicyEnforcer 走真实实现（被测对象）
  };
});

vi.mock('../../src/host/services', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
  }),
}));

vi.mock('../../src/host/agent/confirmationGate', () => ({
  getConfirmationGate: () => ({
    buildPreview: () => null,
    assessRiskLevel: () => 'low',
  }),
}));

vi.mock('../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn(),
}));

// classifier 永远放行 — 用来证明 policy deny 优先级高于 classifier approve
vi.mock('../../src/host/tools/permissionClassifier', () => ({
  classifyPermission: vi.fn().mockResolvedValue({
    decision: 'approve',
    reason: 'test auto-approve',
    confidence: 1,
    cached: false,
  }),
}));

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeTempProject(policyToml?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-test-'));
  if (policyToml !== undefined) {
    fs.writeFileSync(path.join(dir, 'code-agent-policy.toml'), policyToml, 'utf-8');
  }
  return dir;
}

function makeExecutor(workingDirectory: string, onPermissionRequest?: () => void): ToolExecutor {
  const executor = new ToolExecutor({
    requestPermission: async () => {
      onPermissionRequest?.();
      return true;
    },
    workingDirectory,
  });
  executor.setAuditEnabled(false);
  return executor;
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('PolicyEnforcer integration (GAP-002)', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    resetPolicyEnforcer();
    resetDecisionHistory();
  });

  afterEach(() => {
    resetPolicyEnforcer();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function project(policyToml?: string): string {
    const dir = makeTempProject(policyToml);
    tempDirs.push(dir);
    return dir;
  }

  describe('denied_commands 正则拦截', () => {
    const POLICY = `
[execution]
allow_shell = true
denied_commands = ["^docker"]
`;

    it('blocks command matching denied pattern even though classifier approves', async () => {
      const executor = makeExecutor(project(POLICY));
      const result = await executor.execute('bash', { command: 'docker ps' }, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Blocked by policy');
    });

    it('policy deny cannot be bypassed by skill pre-approval', async () => {
      const executor = makeExecutor(project(POLICY));
      const result = await executor.execute('bash', { command: 'docker ps' }, {
        preApprovedTools: new Set(['Bash(docker:*)']),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Blocked by policy');
    });

    it('policy deny cannot be bypassed by safe command whitelist', async () => {
      // git status 在 commandSafety 安全白名单里，正常会自动放行；
      // policy 显式 deny 后必须被拦。
      const executor = makeExecutor(project(`
[execution]
allow_shell = true
denied_commands = ["^git status"]
`));
      const result = await executor.execute('bash', { command: 'git status' }, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Blocked by policy');
    });

    it('allows commands not matching any denied pattern', async () => {
      const executor = makeExecutor(project(POLICY));
      const result = await executor.execute('bash', { command: 'ls -la' }, {});

      expect(result.success).toBe(true);
    });
  });

  describe('filesystem 路径拦截', () => {
    // 任何 policy 文件存在即激活默认 denied_paths（/etc/** 等）
    const POLICY = `
[filesystem]
denied_paths = ["/opt/secret/**"]
`;

    it('blocks write to default denied path /etc/**', async () => {
      const executor = makeExecutor(project(POLICY));
      const result = await executor.execute('write_file', {
        file_path: '/etc/hosts',
        content: 'hacked',
      }, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Blocked by policy');
    });

    it('blocks write to custom denied path', async () => {
      const executor = makeExecutor(project(POLICY));
      const result = await executor.execute('write_file', {
        file_path: '/opt/secret/config.json',
        content: 'data',
      }, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Blocked by policy');
    });

    it('blocks write matching denied file pattern (*.pem from defaults)', async () => {
      const executor = makeExecutor(project(POLICY));
      const dir = tempDirs[tempDirs.length - 1];
      const result = await executor.execute('write_file', {
        file_path: path.join(dir, 'server.pem'),
        content: 'key data',
      }, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Blocked by policy');
    });
  });

  describe('tools.disabled 拦截', () => {
    it('blocks disabled tool entirely', async () => {
      const executor = makeExecutor(project(`
[tools]
disabled = ["write_file"]
`));
      const dir = tempDirs[tempDirs.length - 1];
      const result = await executor.execute('write_file', {
        file_path: path.join(dir, 'ok.txt'),
        content: 'hello',
      }, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Blocked by policy');
    });
  });

  describe('tools.always_confirm 强制审批', () => {
    it('safe command still requires user approval when tool in always_confirm', async () => {
      let permissionRequested = false;
      const executor = makeExecutor(
        project(`
[tools]
always_confirm = ["bash"]
`),
        () => { permissionRequested = true; },
      );

      // ls 是安全命令，正常会跳过审批；always_confirm 强制弹审批
      const result = await executor.execute('bash', { command: 'ls' }, {});

      expect(permissionRequested).toBe(true);
      expect(result.success).toBe(true); // requestPermission mock 返回 true
    });
  });

  describe('无 policy 文件', () => {
    it('no enforcement when no policy file exists', async () => {
      let permissionRequested = false;
      const executor = makeExecutor(project(undefined), () => { permissionRequested = true; });

      const result = await executor.execute('bash', { command: 'ls' }, {});

      expect(result.success).toBe(true);
      // 安全命令白名单正常生效（未被 policy 干预）
      expect(permissionRequested).toBe(false);
    });
  });

  describe('decision trace', () => {
    it('blocked call records policy_enforcer layer in decision history', async () => {
      const executor = makeExecutor(project(`
[execution]
denied_commands = ["^docker"]
`));
      await executor.execute('bash', { command: 'docker ps' }, {});

      const entries = getDecisionHistory().getAll();
      const blocked = entries.find(e => e.outcome === 'policy-deny');
      expect(blocked).toBeDefined();
      expect(blocked?.decisionTrace?.steps.some(s => s.layer === 'policy_enforcer')).toBe(true);
    });
  });
});
