// ============================================================================
// Skill allowed-tools 限权边界测试 (GAP-001)
// ============================================================================
//
// 验证 skill 的 allowed-tools 是"限权边界"而不只是"自动扩权"：
// - 边界外的工具调用强制用户审批（红队 case：只读 skill 留 Bash 不能静默写）
// - 边界外的工具不能被安全命令白名单 / classifier / 预授权自动放行
// - 边界内的工具走正常流程（builtin/plugin 预授权依然生效）
//
// 课程依据：《Claude Code 工程化实战》第 13 讲
// "工具隔离的价值不在'能做什么'而在明确'不能做什么'——是安全设计不是功能设计"

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolExecutor } from '../../src/host/tools/toolExecutor';
import { resetPolicyEnforcer } from '../../src/host/security/policyEnforcer';
import { resetDecisionHistory } from '../../src/host/security/decisionHistory';

// Mock tool resolver — bash + write_file + read_file
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
  const readDef = {
    name: 'read_file',
    description: 'Read a file',
    inputSchema: {
      type: 'object' as const,
      properties: { file_path: { type: 'string' as const } },
      required: ['file_path'],
    },
    requiresPermission: false,
    permissionLevel: 'read' as const,
  };
  const defs: Record<string, unknown> = { bash: bashDef, write_file: writeDef, read_file: readDef };
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

// classifier 永远放行 — 用来证明边界违规优先级高于 classifier approve
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

function makeExecutor(onPermissionRequest?: (toolName: string) => void): ToolExecutor {
  const executor = new ToolExecutor({
    requestPermission: async (request) => {
      onPermissionRequest?.(request.tool);
      return true;
    },
    workingDirectory: '/tmp',
  });
  executor.setAuditEnabled(false);
  return executor;
}

// 只读分析 skill 的边界：只允许 read_file / grep
const READ_ONLY_BOUNDARY = {
  skillName: 'code-review',
  allowedTools: ['read_file', 'grep'],
};

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('Skill allowed-tools boundary (GAP-001)', () => {
  beforeEach(() => {
    resetPolicyEnforcer();
    resetDecisionHistory();
  });

  describe('红队：只读 skill 不能静默执行边界外操作', () => {
    it('safe bash command (ls) outside boundary forces user approval', async () => {
      let permissionRequested = false;
      const executor = makeExecutor(() => { permissionRequested = true; });

      // ls 在安全命令白名单里，正常会自动放行；
      // 在只读 skill 边界激活时必须弹审批。
      const result = await executor.execute('bash', { command: 'ls' }, {
        skillToolBoundary: READ_ONLY_BOUNDARY,
      });

      expect(permissionRequested).toBe(true);
      expect(result.success).toBe(true); // 用户批准后可以执行
    });

    it('write_file outside boundary forces user approval despite classifier approve', async () => {
      let permissionRequested = false;
      const executor = makeExecutor(() => { permissionRequested = true; });

      // classifier mock 永远 approve，但边界违规必须强制审批
      await executor.execute('write_file', {
        file_path: '/tmp/out.txt',
        content: 'data',
      }, {
        skillToolBoundary: READ_ONLY_BOUNDARY,
      });

      expect(permissionRequested).toBe(true);
    });

    it('boundary violation cannot be bypassed by pre-approved tools', async () => {
      let permissionRequested = false;
      const executor = makeExecutor(() => { permissionRequested = true; });

      // 即使 bash 在预授权集合里（比如来自之前的 skill），
      // 当前边界不含 bash 就必须审批。
      await executor.execute('bash', { command: 'ls' }, {
        skillToolBoundary: READ_ONLY_BOUNDARY,
        preApprovedTools: new Set(['bash']),
      });

      expect(permissionRequested).toBe(true);
    });

    it('permission request reason mentions the skill boundary', async () => {
      let capturedToolName = '';
      const executor = new ToolExecutor({
        requestPermission: async (request) => {
          capturedToolName = request.tool;
          // 验证 decision trace 里有边界规则
          const hasBoundaryStep = request.decisionTrace?.steps.some(
            s => s.rule === 'skill.allowed-tools-boundary',
          );
          expect(hasBoundaryStep).toBe(true);
          return false; // 拒绝
        },
        workingDirectory: '/tmp',
      });
      executor.setAuditEnabled(false);

      const result = await executor.execute('bash', { command: 'ls' }, {
        skillToolBoundary: READ_ONLY_BOUNDARY,
      });

      expect(capturedToolName).toBe('bash');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
    });
  });

  describe('边界内工具正常流程', () => {
    it('read-only tools (requiresPermission=false) are not gated by boundary', async () => {
      let permissionRequested = false;
      const executor = makeExecutor(() => { permissionRequested = true; });

      const result = await executor.execute('read_file', { file_path: '/tmp/a.txt' }, {
        skillToolBoundary: READ_ONLY_BOUNDARY,
      });

      expect(result.success).toBe(true);
      expect(permissionRequested).toBe(false);
    });

    it('in-boundary tool with pre-approval skips permission (builtin skill 扩权保留)', async () => {
      let permissionRequested = false;
      const executor = makeExecutor(() => { permissionRequested = true; });

      // 边界含 bash 且 bash 被预授权 → 免审批（builtin/plugin skill 的原有行为）
      const result = await executor.execute('bash', { command: 'npm install' }, {
        skillToolBoundary: { skillName: 'deploy', allowedTools: ['bash'] },
        preApprovedTools: new Set(['bash']),
      });

      expect(result.success).toBe(true);
      expect(permissionRequested).toBe(false);
    });

    it('boundary supports Bash(prefix:*) scoped patterns', async () => {
      let permissionRequested = false;
      const executor = makeExecutor(() => { permissionRequested = true; });

      // 边界是 Bash(git:*)：git 命令在边界内，npm 不在
      const boundary = { skillName: 'git-helper', allowedTools: ['Bash(git:*)'] };

      // git 命令在边界内（且是安全命令）→ 无需审批
      const gitResult = await executor.execute('bash', { command: 'git status' }, {
        skillToolBoundary: boundary,
      });
      expect(gitResult.success).toBe(true);
      expect(permissionRequested).toBe(false);

      // npm 命令在边界外 → 强制审批
      await executor.execute('bash', { command: 'npm install' }, {
        skillToolBoundary: boundary,
      });
      expect(permissionRequested).toBe(true);
    });
  });

  describe('无边界时行为不变', () => {
    it('no boundary: safe commands auto-approved as before', async () => {
      let permissionRequested = false;
      const executor = makeExecutor(() => { permissionRequested = true; });

      const result = await executor.execute('bash', { command: 'ls' }, {});

      expect(result.success).toBe(true);
      expect(permissionRequested).toBe(false);
    });
  });
});
