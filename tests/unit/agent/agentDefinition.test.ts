// ============================================================================
// Agent Definition Tests - 混合架构
// Tests for 4 core agents and hybrid architecture
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  PREDEFINED_AGENTS,
  CORE_AGENT_IDS,
  getPredefinedAgent,
  listPredefinedAgentIds,
  listPredefinedAgents,
  isPredefinedAgent,
  getAgentsByTag,
  getAgentTools,
  isCoreAgent,
  type CoreAgentId,
} from '../../../src/main/agent/agentDefinition';

describe('AgentDefinition - Hybrid Architecture', () => {
  // --------------------------------------------------------------------------
  // Core Agents Structure
  // --------------------------------------------------------------------------
  describe('PREDEFINED_AGENTS structure', () => {
    it('should have exactly 7 core agents', () => {
      expect(Object.keys(PREDEFINED_AGENTS)).toHaveLength(7);
    });

    it('should have all 7 core agents defined', () => {
      expect(PREDEFINED_AGENTS['coder']).toBeDefined();
      expect(PREDEFINED_AGENTS['reviewer']).toBeDefined();
      expect(PREDEFINED_AGENTS['explore']).toBeDefined();
      expect(PREDEFINED_AGENTS['plan']).toBeDefined();
      expect(PREDEFINED_AGENTS['awaiter']).toBeDefined();
      expect(PREDEFINED_AGENTS['dream']).toBeDefined();
      expect(PREDEFINED_AGENTS['distill']).toBeDefined();
    });

    it('CORE_AGENT_IDS should match PREDEFINED_AGENTS keys', () => {
      expect(CORE_AGENT_IDS).toHaveLength(7);
      for (const id of CORE_AGENT_IDS) {
        expect(PREDEFINED_AGENTS[id]).toBeDefined();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Agent Definition Properties
  // --------------------------------------------------------------------------
  describe('Agent Definition Properties', () => {
    const allAgents = Object.values(PREDEFINED_AGENTS);

    it('all agents should have required properties', () => {
      for (const agent of allAgents) {
        expect(agent.id).toBeDefined();
        expect(agent.name).toBeDefined();
        expect(agent.description).toBeDefined();
        expect(agent.prompt).toBeDefined();
        expect(agent.tools).toBeDefined();
        expect(Array.isArray(agent.tools)).toBe(true);
      }
    });

    it('all agent IDs should match their keys', () => {
      for (const [key, agent] of Object.entries(PREDEFINED_AGENTS)) {
        expect(agent.id).toBe(key);
      }
    });

    it('all agents should have runtime config', () => {
      for (const agent of allAgents) {
        expect(agent.runtime).toBeDefined();
        expect(agent.runtime?.maxIterations).toBeGreaterThan(0);
      }
    });

    it('all agents should have security config', () => {
      for (const agent of allAgents) {
        expect(agent.security).toBeDefined();
        expect(agent.security?.permissionPreset).toBe('development');
      }
    });

    it('all agents should have coordination config', () => {
      for (const agent of allAgents) {
        expect(agent.coordination).toBeDefined();
        expect(agent.coordination?.layer).toBeDefined();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Specific Agent Configurations
  // --------------------------------------------------------------------------
  describe('Specific Agent Configurations', () => {
    describe('coder agent', () => {
      const agent = PREDEFINED_AGENTS['coder'];

      it('should have write tools', () => {
        // 工具名与真实注册名对齐（PascalCase，1b27ea9eb）
        expect(agent.tools).toContain('Bash');
        expect(agent.tools).toContain('Read');
        expect(agent.tools).toContain('Write');
        expect(agent.tools).toContain('Edit');
      });

      it('should be in execution layer', () => {
        expect(agent.coordination?.layer).toBe('execution');
      });

      it('should not be readonly', () => {
        expect(agent.coordination?.readonly).toBeFalsy();
      });
    });

    describe('reviewer agent', () => {
      const agent = PREDEFINED_AGENTS['reviewer'];

      it('should have review tools', () => {
        expect(agent.tools).toContain('Bash');
        expect(agent.tools).toContain('Read');
        expect(agent.tools).toContain('Glob');
        expect(agent.tools).toContain('Grep');
      });

      it('should be in execution layer (can write tests)', () => {
        expect(agent.coordination?.layer).toBe('execution');
      });
    });

    describe('explore agent', () => {
      const agent = PREDEFINED_AGENTS['explore'];

      it('should have read-only tools', () => {
        expect(agent.tools).toContain('Glob');
        expect(agent.tools).toContain('Grep');
        expect(agent.tools).toContain('Read');
        expect(agent.tools).toContain('ListDirectory');
        // Should NOT have write tools
        expect(agent.tools).not.toContain('Write');
        expect(agent.tools).not.toContain('Edit');
        expect(agent.tools).not.toContain('Bash');
      });

      it('should be in exploration layer', () => {
        expect(agent.coordination?.layer).toBe('exploration');
      });

      it('should be readonly', () => {
        expect(agent.coordination?.readonly).toBe(true);
      });

      it('should have readonly tag', () => {
        expect(agent.tags).toContain('readonly');
      });
    });

    describe('plan agent', () => {
      const agent = PREDEFINED_AGENTS['plan'];

      it('should have planning tools (read-only + write for plans + task management)', () => {
        expect(agent.tools).toContain('Glob');
        expect(agent.tools).toContain('Grep');
        expect(agent.tools).toContain('Read');
        expect(agent.tools).toContain('ListDirectory');
        expect(agent.tools).toContain('Write'); // Can write plan documents
        // task_list/get/update/create 已合并为单一 TaskManager 工具
        expect(agent.tools).toContain('TaskManager');
      });

      it('should be in exploration layer (primarily read-only)', () => {
        expect(agent.coordination?.layer).toBe('exploration');
      });

      it('should be readonly', () => {
        expect(agent.coordination?.readonly).toBe(true);
      });
    });

    describe('dream agent', () => {
      const agent = PREDEFINED_AGENTS['dream'];

      it('should constrain memory consolidation to History-verified evidence', () => {
        const prompt = String(agent.prompt);
        expect(agent.tools).toEqual(expect.arrayContaining(['History', 'MemoryRead', 'MemoryWrite']));
        expect(agent.tools).not.toContain('Bash');
        expect(prompt).toContain('Phase 3');
        expect(prompt).toContain('History');
        expect(prompt).toContain('轨迹库为权威');
        expect(prompt).toContain('不要直接查询 SQLite');
      });

      it('should run as a focused execution agent because it can write memory', () => {
        expect(agent.coordination?.readonly).toBe(false);
        expect(agent.coordination?.layer).toBe('execution');
      });
    });

    describe('distill agent', () => {
      const agent = PREDEFINED_AGENTS['distill'];

      it('should constrain proposal investigation to read-only evidence tools', () => {
        const prompt = String(agent.prompt);
        expect(agent.tools).toEqual(expect.arrayContaining(['History', 'MemoryRead', 'Read', 'Glob', 'Grep']));
        expect(agent.tools).not.toContain('Bash');
        expect(agent.tools).not.toContain('Write');
        expect(agent.tools).not.toContain('MemoryWrite');
        expect(agent.tools).not.toContain('SkillCreate');
        expect(prompt).toContain('结构化提案');
        expect(prompt).toContain('至少出现 2 次');
        expect(prompt).toContain('不要直接查询 SQLite');
      });

      it('should be readonly because emission happens in the deterministic service layer', () => {
        expect(agent.coordination?.readonly).toBe(true);
        expect(agent.coordination?.layer).toBe('exploration');
      });
    });
  });

  // --------------------------------------------------------------------------
  // Utility Functions
  // --------------------------------------------------------------------------
  describe('Utility Functions', () => {
    describe('isCoreAgent', () => {
      it('should return true for core agent IDs', () => {
        expect(isCoreAgent('coder')).toBe(true);
        expect(isCoreAgent('reviewer')).toBe(true);
        expect(isCoreAgent('explore')).toBe(true);
        expect(isCoreAgent('plan')).toBe(true);
        expect(isCoreAgent('dream')).toBe(true);
        expect(isCoreAgent('distill')).toBe(true);
      });

      it('should return false for non-core agent IDs', () => {
        expect(isCoreAgent('debugger')).toBe(false);
        expect(isCoreAgent('tester')).toBe(false);
        expect(isCoreAgent('unknown')).toBe(false);
      });
    });

    describe('getPredefinedAgent', () => {
      it('should return agent definition for valid ID', () => {
        const agent = getPredefinedAgent('coder');
        expect(agent).toBeDefined();
        expect(agent.id).toBe('coder');
      });

      it('should throw for invalid ID', () => {
        expect(() => getPredefinedAgent('nonexistent')).toThrow();
      });

      it('exposes nested delegation tools to core subagents that may offload context', () => {
        for (const id of ['coder', 'reviewer', 'explore', 'plan'] as const) {
          const tools = getAgentTools(getPredefinedAgent(id));
          expect(tools).toContain('Task');
          expect(tools).toContain('spawn_agent');
        }
      });
    });

    describe('listPredefinedAgentIds', () => {
      it('should return array of 7 core agent IDs', () => {
        const ids = listPredefinedAgentIds();
        expect(Array.isArray(ids)).toBe(true);
        expect(ids).toHaveLength(7);
        expect(ids).toContain('coder');
        expect(ids).toContain('reviewer');
        expect(ids).toContain('explore');
        expect(ids).toContain('plan');
        expect(ids).toContain('awaiter');
        expect(ids).toContain('dream');
        expect(ids).toContain('distill');
      });
    });

    describe('listPredefinedAgents', () => {
      it('should return array of agent summaries', () => {
        const agents = listPredefinedAgents();
        expect(Array.isArray(agents)).toBe(true);
        expect(agents).toHaveLength(7);

        const coder = agents.find((a) => a.id === 'coder');
        expect(coder).toBeDefined();
        expect(coder?.name).toBe('Coder');
        expect(coder?.description).toBeDefined();
      });
    });

    describe('isPredefinedAgent', () => {
      it('should return true for core agent IDs', () => {
        expect(isPredefinedAgent('coder')).toBe(true);
        expect(isPredefinedAgent('reviewer')).toBe(true);
        expect(isPredefinedAgent('explore')).toBe(true);
        expect(isPredefinedAgent('plan')).toBe(true);
      });

      it('should return false for legacy agent IDs', () => {
        expect(isPredefinedAgent('debugger')).toBe(false);
        expect(isPredefinedAgent('tester')).toBe(false);
        expect(isPredefinedAgent('code-explore')).toBe(false);
      });

      it('should return false for unknown IDs', () => {
        expect(isPredefinedAgent('unknown')).toBe(false);
        expect(isPredefinedAgent('')).toBe(false);
      });
    });

    describe('getAgentsByTag', () => {
      it('should return agents with readonly tag', () => {
        const readonlyAgents = getAgentsByTag('readonly');
        expect(readonlyAgents.length).toBeGreaterThanOrEqual(1);

        const ids = readonlyAgents.map((a) => a.id);
        expect(ids).toContain('explore');
      });

      it('should return empty array for unknown tag', () => {
        const agents = getAgentsByTag('nonexistent-tag');
        expect(agents).toEqual([]);
      });
    });
  });

  // --------------------------------------------------------------------------
  // Model Tier Configuration
  // --------------------------------------------------------------------------
  describe('Model Tier Configuration', () => {
    it('explore agent should use fast model tier', () => {
      const agent = PREDEFINED_AGENTS['explore'];
      expect(agent.model).toBe('fast');
    });

    it('coder agent should use powerful model tier', () => {
      const agent = PREDEFINED_AGENTS['coder'];
      expect(agent.model).toBe('powerful');
    });

    it('reviewer and plan agents should use balanced model tier', () => {
      expect(PREDEFINED_AGENTS['reviewer'].model).toBe('balanced');
      expect(PREDEFINED_AGENTS['plan'].model).toBe('balanced');
    });
  });
});
