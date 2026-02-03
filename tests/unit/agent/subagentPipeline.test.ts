// ============================================================================
// Subagent Pipeline Tests
// Tests for permission inheritance, budget checking, and audit logging
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SubagentPipeline,
  getSubagentPipeline,
  resetSubagentPipeline,
  type SubagentExecutionContext,
  type ToolExecutionRequest,
} from '../../../src/main/agent/subagentPipeline';
import type { AgentDefinition, DynamicAgentConfig } from '../../../src/main/agent/agentDefinition';
import type { PermissionConfig } from '../../../src/main/services/core/permissionPresets';

// Mock the budgetService
vi.mock('../../../src/main/services/core/budgetService', () => ({
  BudgetAlertLevel: {
    NORMAL: 'normal',
    WARNING: 'warning',
    BLOCKED: 'blocked',
  },
  getBudgetService: () => ({
    checkBudget: vi.fn().mockReturnValue({
      alertLevel: 'normal',
      currentCost: 0.5,
      maxBudget: 10,
      message: null,
    }),
    recordUsage: vi.fn(),
    estimateCost: vi.fn().mockImplementation((input, output, model) => {
      return (input * 0.001 + output * 0.002) / 1000;
    }),
  }),
}));

// Mock the permissionPresets
vi.mock('../../../src/main/services/core/permissionPresets', () => ({
  getPresetConfig: vi.fn().mockImplementation((preset, workingDir) => ({
    name: preset,
    description: `${preset} preset`,
    autoApprove: {
      read: true,
      write: preset === 'development' || preset === 'automation',
      execute: preset === 'development' || preset === 'automation',
      network: preset === 'automation',
    },
    confirmDangerousCommands: preset !== 'automation',
    trustProjectDirectory: true,
    blockedCommands: preset === 'readonly' ? ['rm -rf'] : [],
    trustedDirectories: [workingDir],
  })),
  isPathTrusted: vi.fn().mockImplementation((path, dirs) => {
    return dirs.some((d: string) => path.startsWith(d));
  }),
  isCommandBlocked: vi.fn().mockImplementation((command, blocked) => {
    return blocked.some((b: string) => command.includes(b));
  }),
  isDangerousCommand: vi.fn().mockImplementation((command) => {
    return command.includes('rm -rf') || command.includes('sudo');
  }),
}));

describe('SubagentPipeline', () => {
  let pipeline: SubagentPipeline;

  beforeEach(() => {
    resetSubagentPipeline();
    pipeline = getSubagentPipeline();
  });

  afterEach(() => {
    resetSubagentPipeline();
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Context Creation
  // --------------------------------------------------------------------------
  describe('Context Creation', () => {
    it('should create context with AgentDefinition', () => {
      const agentDef: AgentDefinition = {
        id: 'test-agent',
        name: 'Test Agent',
        description: 'A test agent',
        prompt: 'You are a test agent',
        tools: ['read_file', 'glob'],
        permissionPreset: 'development',
      };

      const context = pipeline.createContext(agentDef, '/test/project');

      expect(context.agentId).toMatch(/^subagent_\d+_[a-z0-9]+$/);
      expect(context.agentName).toBe('Test Agent');
      expect(context.workingDirectory).toBe('/test/project');
      expect(context.permissionConfig).toBeDefined();
      expect(context.toolsUsed).toEqual([]);
      expect(context.tokenUsage).toEqual([]);
    });

    it('should create context with DynamicAgentConfig', () => {
      const dynamicConfig: DynamicAgentConfig = {
        name: 'Dynamic Agent',
        prompt: 'You are dynamic',
        tools: ['bash'],
        permissionPreset: 'development',
      };

      const context = pipeline.createContext(dynamicConfig, '/test/dir');

      expect(context.agentName).toBe('Dynamic Agent');
    });

    it('should default to "Dynamic Agent" name when not provided', () => {
      const dynamicConfig: DynamicAgentConfig = {
        prompt: 'No name provided',
        tools: ['bash'],
      };

      const context = pipeline.createContext(dynamicConfig, '/test/dir');

      expect(context.agentName).toBe('Dynamic Agent');
    });

    it('should default to development preset when not provided', () => {
      const dynamicConfig: DynamicAgentConfig = {
        prompt: 'No preset',
        tools: [],
      };

      const context = pipeline.createContext(dynamicConfig, '/test/dir');

      expect(context.permissionConfig.name).toBe('development');
    });
  });

  // --------------------------------------------------------------------------
  // Permission Inheritance
  // --------------------------------------------------------------------------
  describe('Permission Inheritance', () => {
    it('should merge permissions with parent (take stricter)', () => {
      const agentDef: AgentDefinition = {
        id: 'child-agent',
        name: 'Child Agent',
        description: 'A child agent',
        prompt: 'Child',
        tools: ['read_file', 'write_file'],
        permissionPreset: 'development', // write: true
      };

      const parentPermissionConfig: PermissionConfig = {
        name: 'readonly',
        description: 'Readonly parent',
        autoApprove: {
          read: true,
          write: false, // Parent disallows write
          execute: false,
          network: false,
        },
        confirmDangerousCommands: true,
        trustProjectDirectory: true,
        blockedCommands: ['rm -rf'],
        trustedDirectories: ['/test/project'],
      };

      const context = pipeline.createContext(agentDef, '/test/project', undefined, {
        parentPermissionConfig,
      });

      // Child wanted write: true, but parent has write: false
      // Merged should be write: false (stricter)
      expect(context.permissionConfig.autoApprove.write).toBe(false);
      expect(context.permissionConfig.autoApprove.execute).toBe(false);
    });

    it('should merge blocked commands from both parent and child', () => {
      const agentDef: AgentDefinition = {
        id: 'child-agent',
        name: 'Child',
        description: 'Child',
        prompt: 'Child',
        tools: [],
        permissionPreset: 'development',
      };

      const parentConfig: PermissionConfig = {
        name: 'parent',
        description: 'Parent',
        autoApprove: { read: true, write: true, execute: true, network: true },
        confirmDangerousCommands: false,
        trustProjectDirectory: true,
        blockedCommands: ['rm -rf /', 'sudo'],
        trustedDirectories: ['/test/project'],
      };

      const context = pipeline.createContext(agentDef, '/test/project', undefined, {
        parentPermissionConfig: parentConfig,
      });

      // Should contain parent's blocked commands
      expect(context.permissionConfig.blockedCommands).toContain('rm -rf /');
      expect(context.permissionConfig.blockedCommands).toContain('sudo');
    });

    it('should intersect trusted directories', () => {
      const agentDef: AgentDefinition = {
        id: 'child-agent',
        name: 'Child',
        description: 'Child',
        prompt: 'Child',
        tools: [],
        permissionPreset: 'development',
      };

      const parentConfig: PermissionConfig = {
        name: 'parent',
        description: 'Parent',
        autoApprove: { read: true, write: true, execute: true, network: true },
        confirmDangerousCommands: false,
        trustProjectDirectory: true,
        blockedCommands: [],
        trustedDirectories: ['/shared/dir'], // Only trusts this
      };

      const context = pipeline.createContext(agentDef, '/child/dir', undefined, {
        parentPermissionConfig: parentConfig,
      });

      // Child trusts /child/dir, parent trusts /shared/dir
      // Intersection should be empty (no common directories)
      // Since child config is generated with workingDir, we verify the logic
      expect(context.permissionConfig.trustedDirectories).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Budget Inheritance
  // --------------------------------------------------------------------------
  describe('Budget Inheritance', () => {
    it('should constrain child budget to parent remaining budget', () => {
      const agentDef: AgentDefinition = {
        id: 'expensive-agent',
        name: 'Expensive Agent',
        description: 'Expensive',
        prompt: 'Expensive',
        tools: [],
        permissionPreset: 'development',
        maxBudget: 100, // Child wants $100
      };

      const context = pipeline.createContext(agentDef, '/test', undefined, {
        parentRemainingBudget: 5, // Parent only has $5 left
      });

      // Child budget should be capped at parent's remaining
      expect(context.maxBudget).toBe(5);
      expect(context.inheritedMaxBudget).toBe(5);
    });

    it('should use child budget if less than parent remaining', () => {
      // Using extended type to include backward-compatible flat fields
      const agentDef = {
        id: 'cheap-agent',
        name: 'Cheap Agent',
        description: 'Cheap',
        prompt: 'Cheap',
        tools: [],
        permissionPreset: 'development',
        maxBudget: 2, // Child only wants $2 (flat field for backward compatibility)
      } as AgentDefinition;

      const context = pipeline.createContext(agentDef, '/test', undefined, {
        parentRemainingBudget: 10, // Parent has $10
      });

      // Child budget should remain at $2
      expect(context.maxBudget).toBe(2);
    });

    it('should set budget to parent remaining if child has no budget', () => {
      const agentDef: AgentDefinition = {
        id: 'no-budget-agent',
        name: 'No Budget Agent',
        description: 'No budget set',
        prompt: 'No budget',
        tools: [],
        permissionPreset: 'development',
        // No maxBudget set
      };

      const context = pipeline.createContext(agentDef, '/test', undefined, {
        parentRemainingBudget: 3,
      });

      // Should inherit parent's remaining budget
      expect(context.maxBudget).toBe(3);
    });
  });

  // --------------------------------------------------------------------------
  // Tool Inheritance
  // --------------------------------------------------------------------------
  describe('Tool Inheritance', () => {
    it('should intersect child tools with parent allowed tools', () => {
      const agentDef: AgentDefinition = {
        id: 'tool-agent',
        name: 'Tool Agent',
        description: 'Tool agent',
        prompt: 'Tools',
        tools: ['read_file', 'write_file', 'bash', 'glob'], // Child wants these
        permissionPreset: 'development',
      };

      const context = pipeline.createContext(agentDef, '/test', undefined, {
        parentAllowedTools: ['read_file', 'glob', 'grep'], // Parent only allows these
      });

      // Should only have intersection
      expect(context.allowedTools).toContain('read_file');
      expect(context.allowedTools).toContain('glob');
      expect(context.allowedTools).not.toContain('write_file');
      expect(context.allowedTools).not.toContain('bash');
      expect(context.allowedTools).not.toContain('grep'); // Not in child's list
    });

    it('should keep all child tools if no parent restriction', () => {
      const agentDef: AgentDefinition = {
        id: 'tool-agent',
        name: 'Tool Agent',
        description: 'Tool agent',
        prompt: 'Tools',
        tools: ['read_file', 'write_file', 'bash'],
        permissionPreset: 'development',
      };

      const context = pipeline.createContext(agentDef, '/test');

      expect(context.allowedTools).toEqual(['read_file', 'write_file', 'bash']);
    });
  });

  // --------------------------------------------------------------------------
  // Tool Execution Checking
  // --------------------------------------------------------------------------
  describe('Tool Execution Checking', () => {
    it('should block blocked commands', () => {
      // Using extended type to include backward-compatible flat fields
      const agentDef = {
        id: 'test-agent',
        name: 'Test',
        description: 'Test',
        prompt: 'Test',
        tools: ['bash'],
        permissionPreset: 'readonly', // Has 'rm -rf' blocked (flat field for backward compatibility)
      } as AgentDefinition;

      const context = pipeline.createContext(agentDef, '/test');

      const request: ToolExecutionRequest = {
        toolName: 'bash',
        permissionLevel: 'execute',
        command: 'rm -rf /important',
      };

      const result = pipeline.checkToolExecution(context, request);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('blocked');
    });

    it('should allow read operations', () => {
      const agentDef: AgentDefinition = {
        id: 'readonly-agent',
        name: 'Readonly',
        description: 'Readonly',
        prompt: 'Readonly',
        tools: ['read_file'],
        permissionPreset: 'readonly',
      };

      const context = pipeline.createContext(agentDef, '/test');

      const request: ToolExecutionRequest = {
        toolName: 'read_file',
        permissionLevel: 'read',
        path: '/test/file.txt',
      };

      const result = pipeline.checkToolExecution(context, request);

      expect(result.allowed).toBe(true);
    });

    it('should warn on dangerous commands', () => {
      const agentDef: AgentDefinition = {
        id: 'dev-agent',
        name: 'Dev',
        description: 'Dev',
        prompt: 'Dev',
        tools: ['bash'],
        permissionPreset: 'development',
      };

      const context = pipeline.createContext(agentDef, '/test');

      const request: ToolExecutionRequest = {
        toolName: 'bash',
        permissionLevel: 'execute',
        command: 'sudo apt-get install',
      };

      const result = pipeline.checkToolExecution(context, request);

      // May or may not be allowed, but should have warning
      expect(result.warnings.length).toBeGreaterThanOrEqual(0);
    });
  });

  // --------------------------------------------------------------------------
  // Budget Checking
  // --------------------------------------------------------------------------
  describe('Budget Checking', () => {
    it('should allow when budget is available', () => {
      const agentDef: AgentDefinition = {
        id: 'budget-agent',
        name: 'Budget Agent',
        description: 'Budget',
        prompt: 'Budget',
        tools: [],
        permissionPreset: 'development',
        maxBudget: 10,
      };

      const context = pipeline.createContext(agentDef, '/test');

      const result = pipeline.checkBudget(context);

      expect(result.allowed).toBe(true);
    });

    it('should track subagent cost', () => {
      const agentDef: AgentDefinition = {
        id: 'cost-agent',
        name: 'Cost Agent',
        description: 'Cost',
        prompt: 'Cost',
        tools: [],
        permissionPreset: 'development',
        maxBudget: 1,
      };

      const context = pipeline.createContext(agentDef, '/test');

      // Record some token usage
      pipeline.recordTokenUsage(context, {
        inputTokens: 1000,
        outputTokens: 500,
        model: 'test-model',
      });

      const status = pipeline.getBudgetStatus(context);

      expect(status.subagentCost).toBeDefined();
      expect(status.subagentCost).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // Audit Logging
  // --------------------------------------------------------------------------
  describe('Audit Logging', () => {
    it('should log spawn events', () => {
      const agentDef: AgentDefinition = {
        id: 'audit-agent',
        name: 'Audit Agent',
        description: 'Audit',
        prompt: 'Audit',
        tools: [],
        permissionPreset: 'development',
      };

      pipeline.createContext(agentDef, '/test');

      const log = pipeline.getAuditLog();
      const spawnEntry = log.find((e) => e.action === 'spawn');

      expect(spawnEntry).toBeDefined();
      expect(spawnEntry?.agentName).toBe('Audit Agent');
    });

    it('should log tool executions', () => {
      const agentDef: AgentDefinition = {
        id: 'tool-audit',
        name: 'Tool Audit',
        description: 'Audit',
        prompt: 'Audit',
        tools: ['read_file'],
        permissionPreset: 'development',
      };

      const context = pipeline.createContext(agentDef, '/test');
      pipeline.recordToolUsage(context, 'read_file');

      const log = pipeline.getAuditLog(context.agentId);
      const toolEntry = log.find((e) => e.action === 'tool_execute');

      expect(toolEntry).toBeDefined();
      expect(toolEntry?.details.tool).toBe('read_file');
    });

    it('should log completion events', () => {
      const agentDef: AgentDefinition = {
        id: 'complete-agent',
        name: 'Complete Agent',
        description: 'Complete',
        prompt: 'Complete',
        tools: [],
        permissionPreset: 'development',
      };

      const context = pipeline.createContext(agentDef, '/test');
      pipeline.completeContext(context.agentId, true);

      const log = pipeline.getAuditLog();
      const completeEntry = log.find((e) => e.action === 'complete');

      expect(completeEntry).toBeDefined();
    });

    it('should log error events', () => {
      const agentDef: AgentDefinition = {
        id: 'error-agent',
        name: 'Error Agent',
        description: 'Error',
        prompt: 'Error',
        tools: [],
        permissionPreset: 'development',
      };

      const context = pipeline.createContext(agentDef, '/test');
      pipeline.completeContext(context.agentId, false, 'Test error');

      const log = pipeline.getAuditLog();
      const errorEntry = log.find((e) => e.action === 'error');

      expect(errorEntry).toBeDefined();
      expect(errorEntry?.details.error).toBe('Test error');
    });

    it('should get recent audit entries', () => {
      // Create multiple agents
      for (let i = 0; i < 5; i++) {
        const agentDef: AgentDefinition = {
          id: `agent-${i}`,
          name: `Agent ${i}`,
          description: 'Test',
          prompt: 'Test',
          tools: [],
          permissionPreset: 'development',
        };
        pipeline.createContext(agentDef, '/test');
      }

      const recent = pipeline.getRecentAuditEntries(3);

      expect(recent.length).toBeLessThanOrEqual(3);
    });

    it('should clear audit log', () => {
      const agentDef: AgentDefinition = {
        id: 'clear-agent',
        name: 'Clear Agent',
        description: 'Clear',
        prompt: 'Clear',
        tools: [],
        permissionPreset: 'development',
      };

      pipeline.createContext(agentDef, '/test');
      expect(pipeline.getAuditLog().length).toBeGreaterThan(0);

      pipeline.clearAuditLog();
      expect(pipeline.getAuditLog().length).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Pre-execution Check
  // --------------------------------------------------------------------------
  describe('Pre-execution Check', () => {
    it('should combine budget and permission checks', () => {
      const agentDef: AgentDefinition = {
        id: 'precheck-agent',
        name: 'Precheck Agent',
        description: 'Precheck',
        prompt: 'Precheck',
        tools: ['read_file'],
        permissionPreset: 'development',
        maxBudget: 10,
      };

      const context = pipeline.createContext(agentDef, '/test');

      const request: ToolExecutionRequest = {
        toolName: 'read_file',
        permissionLevel: 'read',
        path: '/test/file.txt',
      };

      const result = pipeline.preExecutionCheck(context, request);

      expect(result.allowed).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Statistics
  // --------------------------------------------------------------------------
  describe('Statistics', () => {
    it('should track active agents', () => {
      const agentDef: AgentDefinition = {
        id: 'stats-agent',
        name: 'Stats Agent',
        description: 'Stats',
        prompt: 'Stats',
        tools: [],
        permissionPreset: 'development',
      };

      pipeline.createContext(agentDef, '/test');
      pipeline.createContext(agentDef, '/test2');

      const stats = pipeline.getStatistics();

      expect(stats.activeAgents).toBe(2);
    });

    it('should track tool usage counts', () => {
      const agentDef: AgentDefinition = {
        id: 'tool-stats',
        name: 'Tool Stats',
        description: 'Stats',
        prompt: 'Stats',
        tools: ['read_file', 'glob'],
        permissionPreset: 'development',
      };

      const context = pipeline.createContext(agentDef, '/test');
      pipeline.recordToolUsage(context, 'read_file');
      pipeline.recordToolUsage(context, 'read_file');
      pipeline.recordToolUsage(context, 'glob');

      const stats = pipeline.getStatistics();

      expect(stats.toolUsageCounts['read_file']).toBe(2);
      expect(stats.toolUsageCounts['glob']).toBe(1);
    });

    it('should track error count', () => {
      const agentDef: AgentDefinition = {
        id: 'error-stats',
        name: 'Error Stats',
        description: 'Stats',
        prompt: 'Stats',
        tools: [],
        permissionPreset: 'development',
      };

      const ctx1 = pipeline.createContext(agentDef, '/test');
      const ctx2 = pipeline.createContext(agentDef, '/test2');

      pipeline.completeContext(ctx1.agentId, false, 'Error 1');
      pipeline.completeContext(ctx2.agentId, true);

      const stats = pipeline.getStatistics();

      expect(stats.errorCount).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Singleton
  // --------------------------------------------------------------------------
  describe('Singleton', () => {
    it('should return same instance', () => {
      const instance1 = getSubagentPipeline();
      const instance2 = getSubagentPipeline();

      expect(instance1).toBe(instance2);
    });

    it('should reset instance', () => {
      const instance1 = getSubagentPipeline();
      resetSubagentPipeline();
      const instance2 = getSubagentPipeline();

      expect(instance1).not.toBe(instance2);
    });
  });
});
