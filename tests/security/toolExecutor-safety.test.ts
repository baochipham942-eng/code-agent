import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolExecutor } from '../../src/main/tools/toolExecutor';
import { resetToolResolver } from '../../src/main/protocol/dispatch/toolResolver';

// Mock tool resolver — register a fake 'bash' tool with permission required
vi.mock('../../src/main/protocol/dispatch/toolResolver', () => {
  const bashDef = {
    name: 'bash',
    description: 'Execute bash commands',
    inputSchema: {
      type: 'object' as const,
      properties: { command: { type: 'string' as const } },
      required: ['command'],
    },
    requiresPermission: true,
    permissionLevel: 'write' as const,
  };
  const fakeResolver = {
    list: () => ['bash'],
    getDefinition: (name: string) => (name === 'bash' ? bashDef : undefined),
    listDefinitions: () => [bashDef],
    has: (name: string) => name === 'bash',
    execute: vi.fn().mockResolvedValue({ success: true, output: '' }),
  };
  return {
    getToolResolver: () => fakeResolver,
    resetToolResolver: () => {},
  };
});

// Mock security modules
vi.mock('../../src/main/security', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/security')>();
  return {
    ...original,
    getCommandMonitor: () => ({
      preExecute: () => ({ allowed: true, riskLevel: 'low' as const, securityFlags: [] }),
    }),
    getAuditLogger: () => ({
      logToolUsage: vi.fn(),
      logSecurityIncident: vi.fn(),
      log: vi.fn(),
    }),
    maskSensitiveData: (s: string) => s,
    // 隔离 exec policy — 返回空 store，避免加载磁盘上的持久化规则
    getExecPolicyStore: () => ({
      match: () => null,
      learnFromApproval: () => false,
    }),
  };
});

// Mock services
vi.mock('../../src/main/services', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
  }),
}));

// Mock confirmation gate
vi.mock('../../src/main/agent/confirmationGate', () => ({
  getConfirmationGate: () => ({
    buildPreview: () => null,
    assessRiskLevel: () => 'low',
  }),
}));

// Mock file checkpoint
vi.mock('../../src/main/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn(),
}));

// Mock permission classifier — 强制走 ask 路径，让 mockRequestPermission 生效
vi.mock('../../src/main/tools/permissionClassifier', () => ({
  classifyPermission: vi.fn().mockResolvedValue({ decision: 'ask', reason: 'test' }),
}));

describe('ToolExecutor safety integration', () => {
  let executor: ToolExecutor;
  let permissionRequested: boolean;

  beforeEach(() => {
    permissionRequested = false;
    resetToolResolver();

    executor = new ToolExecutor({
      requestPermission: async () => {
        permissionRequested = true;
        return true; // always approve
      },
      workingDirectory: '/tmp',
    });
    executor.setAuditEnabled(false);
  });

  const execOptions = {};

  describe('safe commands skip permission', () => {
    it('ls does not request permission', async () => {
      await executor.execute('bash', { command: 'ls' }, execOptions);
      expect(permissionRequested).toBe(false);
    });

    it('git status does not request permission', async () => {
      await executor.execute('bash', { command: 'git status' }, execOptions);
      expect(permissionRequested).toBe(false);
    });

    it('cat file.txt does not request permission', async () => {
      await executor.execute('bash', { command: 'cat /etc/hostname' }, execOptions);
      expect(permissionRequested).toBe(false);
    });

    it('grep pattern does not request permission', async () => {
      await executor.execute('bash', { command: 'grep "test" /tmp/file.txt' }, execOptions);
      expect(permissionRequested).toBe(false);
    });

    it('git log does not request permission', async () => {
      await executor.execute('bash', { command: 'git log --oneline -5' }, execOptions);
      expect(permissionRequested).toBe(false);
    });
  });

  describe('unsafe commands still request permission', () => {
    it('npm install requests permission', async () => {
      await executor.execute('bash', { command: 'npm install lodash' }, execOptions);
      expect(permissionRequested).toBe(true);
    });

    it('rm requests permission', async () => {
      await executor.execute('bash', { command: 'rm file.txt' }, execOptions);
      expect(permissionRequested).toBe(true);
    });

    it('git push requests permission', async () => {
      await executor.execute('bash', { command: 'git push origin main' }, execOptions);
      expect(permissionRequested).toBe(true);
    });

    it('python3 script requests permission', async () => {
      await executor.execute('bash', { command: 'python3 process_data.py' }, execOptions);
      expect(permissionRequested).toBe(true);
    });

    it('mkdir requests permission', async () => {
      await executor.execute('bash', { command: 'mkdir -p new_dir' }, execOptions);
      expect(permissionRequested).toBe(true);
    });
  });

  describe('compound commands', () => {
    it('safe && safe does not request permission', async () => {
      await executor.execute('bash', { command: 'ls && pwd' }, execOptions);
      expect(permissionRequested).toBe(false);
    });

    it('safe && unsafe requests permission', async () => {
      await executor.execute('bash', { command: 'ls && npm install' }, execOptions);
      expect(permissionRequested).toBe(true);
    });
  });
});
