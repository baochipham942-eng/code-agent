// ============================================================================
// Agent Definition Tests
// Tests for predefined agent definitions and utility functions
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  PREDEFINED_AGENTS,
  AGENT_ALIASES,
  getPredefinedAgent,
  listPredefinedAgentIds,
  listPredefinedAgents,
  isPredefinedAgent,
  getAgentsByTag,
  resolveAgentAlias,
  type AgentDefinition,
} from '../../../src/main/agent/agentDefinition';

describe('AgentDefinition', () => {
  // --------------------------------------------------------------------------
  // PREDEFINED_AGENTS Structure
  // --------------------------------------------------------------------------
  describe('PREDEFINED_AGENTS structure', () => {
    it('should have all core code agents (6 built-in roles)', () => {
      expect(PREDEFINED_AGENTS['coder']).toBeDefined();
      expect(PREDEFINED_AGENTS['reviewer']).toBeDefined();
      expect(PREDEFINED_AGENTS['tester']).toBeDefined();
      expect(PREDEFINED_AGENTS['architect']).toBeDefined();
      expect(PREDEFINED_AGENTS['debugger']).toBeDefined();
      expect(PREDEFINED_AGENTS['documenter']).toBeDefined();
    });

    it('should have extended code agents', () => {
      expect(PREDEFINED_AGENTS['refactorer']).toBeDefined();
    });

    it('should have devops agents', () => {
      expect(PREDEFINED_AGENTS['devops']).toBeDefined();
    });

    it('should have vision agents', () => {
      expect(PREDEFINED_AGENTS['visual-understanding']).toBeDefined();
      expect(PREDEFINED_AGENTS['visual-processing']).toBeDefined();
    });

    it('should have meta agents (code-explore, plan, bash-executor, general-purpose)', () => {
      expect(PREDEFINED_AGENTS['code-explore']).toBeDefined();
      expect(PREDEFINED_AGENTS['plan']).toBeDefined();
      expect(PREDEFINED_AGENTS['bash-executor']).toBeDefined();
      expect(PREDEFINED_AGENTS['general-purpose']).toBeDefined();
    });

    it('should have external resource agents', () => {
      expect(PREDEFINED_AGENTS['web-search']).toBeDefined();
      expect(PREDEFINED_AGENTS['mcp-connector']).toBeDefined();
      expect(PREDEFINED_AGENTS['doc-reader']).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Agent Aliases
  // --------------------------------------------------------------------------
  describe('Agent Aliases', () => {
    it('should have code-reviewer alias pointing to reviewer', () => {
      expect(AGENT_ALIASES['code-reviewer']).toBe('reviewer');
    });

    it('should have test-writer alias pointing to tester', () => {
      expect(AGENT_ALIASES['test-writer']).toBe('tester');
    });

    it('should have explore/explorer aliases pointing to code-explore', () => {
      expect(AGENT_ALIASES['explore']).toBe('code-explore');
      expect(AGENT_ALIASES['explorer']).toBe('code-explore');
    });

    it('should have web-researcher alias pointing to web-search', () => {
      expect(AGENT_ALIASES['web-researcher']).toBe('web-search');
    });

    it('should have doc-retriever alias pointing to doc-reader', () => {
      expect(AGENT_ALIASES['doc-retriever']).toBe('doc-reader');
    });

    it('resolveAgentAlias should resolve aliases correctly', () => {
      expect(resolveAgentAlias('code-reviewer')).toBe('reviewer');
      expect(resolveAgentAlias('explore')).toBe('code-explore');
      expect(resolveAgentAlias('coder')).toBe('coder'); // non-alias returns as-is
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
        expect(agent.systemPrompt).toBeDefined();
        expect(agent.tools).toBeDefined();
        expect(agent.permissionPreset).toBeDefined();
      }
    });

    it('all agent IDs should match their keys', () => {
      for (const [key, agent] of Object.entries(PREDEFINED_AGENTS)) {
        expect(agent.id).toBe(key);
      }
    });

    it('all agents should have valid permission presets', () => {
      const validPresets = ['readonly', 'development', 'automation', 'admin'];
      for (const agent of allAgents) {
        expect(validPresets).toContain(agent.permissionPreset);
      }
    });

    it('all agents should have tags array (optional)', () => {
      for (const agent of allAgents) {
        if (agent.tags) {
          expect(Array.isArray(agent.tags)).toBe(true);
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // Specific Agent Configurations
  // --------------------------------------------------------------------------
  describe('Specific Agent Configurations', () => {
    describe('code-explore agent', () => {
      const agent = PREDEFINED_AGENTS['code-explore'];

      it('should have read-only tools', () => {
        expect(agent.tools).toContain('glob');
        expect(agent.tools).toContain('grep');
        expect(agent.tools).toContain('read_file');
        expect(agent.tools).toContain('list_directory');
        // Should NOT have write tools
        expect(agent.tools).not.toContain('write_file');
        expect(agent.tools).not.toContain('edit_file');
      });

      it('should not be able to spawn subagents', () => {
        expect(agent.canSpawnSubagents).toBe(false);
      });

      it('should have readonly tag', () => {
        expect(agent.tags).toContain('readonly');
      });
    });

    describe('plan agent', () => {
      const agent = PREDEFINED_AGENTS['plan'];

      it('should have exploration tools (read-only, no bash)', () => {
        expect(agent.tools).toContain('glob');
        expect(agent.tools).toContain('grep');
        expect(agent.tools).toContain('read_file');
        expect(agent.tools).toContain('list_directory');
        // Plan agent should be readonly
        expect(agent.tools).not.toContain('bash');
      });

      it('should not be able to spawn subagents', () => {
        expect(agent.canSpawnSubagents).toBe(false);
      });

      it('should have planning tag', () => {
        expect(agent.tags).toContain('planning');
      });
    });

    describe('bash-executor agent', () => {
      const agent = PREDEFINED_AGENTS['bash-executor'];

      it('should only have bash tool', () => {
        expect(agent.tools).toEqual(['bash']);
      });

      it('should not be able to spawn subagents', () => {
        expect(agent.canSpawnSubagents).toBe(false);
      });

      it('should have command tag', () => {
        expect(agent.tags).toContain('command');
      });
    });

    describe('general-purpose agent', () => {
      const agent = PREDEFINED_AGENTS['general-purpose'];

      it('should have full tool set', () => {
        expect(agent.tools).toContain('bash');
        expect(agent.tools).toContain('read_file');
        expect(agent.tools).toContain('write_file');
        expect(agent.tools).toContain('edit_file');
        expect(agent.tools).toContain('glob');
        expect(agent.tools).toContain('grep');
        expect(agent.tools).toContain('list_directory');
      });

      it('should have external capabilities', () => {
        expect(agent.tools).toContain('web_search');
        expect(agent.tools).toContain('web_fetch');
        expect(agent.tools).toContain('skill');
        expect(agent.tools).toContain('mcp');
        expect(agent.tools).toContain('mcp_list_tools');
      });

      it('should be able to spawn subagents', () => {
        expect(agent.canSpawnSubagents).toBe(true);
      });

      it('should have high max iterations', () => {
        expect(agent.maxIterations).toBe(30);
      });
    });

    describe('visual-understanding agent', () => {
      const agent = PREDEFINED_AGENTS['visual-understanding'];

      it('should have image_analyze tool', () => {
        expect(agent.tools).toContain('image_analyze');
      });

      it('should have model override for vision', () => {
        expect(agent.modelOverride).toBeDefined();
        expect(agent.modelOverride?.provider).toBe('zhipu');
        expect(agent.modelOverride?.model).toBe('glm-4v-plus');
      });

      it('should have vision-related tags', () => {
        expect(agent.tags).toContain('vision');
        expect(agent.tags).toContain('analysis');
      });
    });

    describe('visual-processing agent', () => {
      const agent = PREDEFINED_AGENTS['visual-processing'];

      it('should have image processing tools', () => {
        expect(agent.tools).toContain('image_annotate');
        expect(agent.tools).toContain('image_process');
      });

      it('should NOT have model override (uses main model for tool calls)', () => {
        expect(agent.modelOverride).toBeUndefined();
      });

      it('should have processing-related tags', () => {
        expect(agent.tags).toContain('vision');
        expect(agent.tags).toContain('processing');
      });
    });

    describe('web-search agent', () => {
      const agent = PREDEFINED_AGENTS['web-search'];

      it('should have web search tools', () => {
        expect(agent.tools).toContain('web_search');
        expect(agent.tools).toContain('web_fetch');
      });

      it('should have external and web tags', () => {
        expect(agent.tags).toContain('external');
        expect(agent.tags).toContain('web');
      });
    });

    describe('mcp-connector agent', () => {
      const agent = PREDEFINED_AGENTS['mcp-connector'];

      it('should have all MCP tools', () => {
        expect(agent.tools).toContain('mcp');
        expect(agent.tools).toContain('mcp_list_tools');
        expect(agent.tools).toContain('mcp_list_resources');
        expect(agent.tools).toContain('mcp_read_resource');
        expect(agent.tools).toContain('mcp_get_status');
      });

      it('should have mcp tag', () => {
        expect(agent.tags).toContain('mcp');
      });
    });

    describe('doc-reader agent', () => {
      const agent = PREDEFINED_AGENTS['doc-reader'];

      it('should have document reading tools', () => {
        expect(agent.tools).toContain('read_pdf');
        expect(agent.tools).toContain('read_docx');
        expect(agent.tools).toContain('read_xlsx');
        expect(agent.tools).toContain('read_file');
      });

      it('should have documentation tag', () => {
        expect(agent.tags).toContain('documentation');
      });
    });
  });

  // --------------------------------------------------------------------------
  // Utility Functions
  // --------------------------------------------------------------------------
  describe('Utility Functions', () => {
    describe('getPredefinedAgent', () => {
      it('should return agent definition for valid ID', () => {
        const agent = getPredefinedAgent('code-explore');
        expect(agent).toBeDefined();
        expect(agent?.id).toBe('code-explore');
      });

      it('should return agent definition for alias', () => {
        const agent = getPredefinedAgent('explore');
        expect(agent).toBeDefined();
        expect(agent?.id).toBe('code-explore');
      });

      it('should return undefined for invalid ID', () => {
        const agent = getPredefinedAgent('nonexistent');
        expect(agent).toBeUndefined();
      });
    });

    describe('listPredefinedAgentIds', () => {
      it('should return array of canonical agent IDs (no aliases)', () => {
        const ids = listPredefinedAgentIds();
        expect(Array.isArray(ids)).toBe(true);
        expect(ids).toContain('code-explore');
        expect(ids).toContain('plan');
        expect(ids).toContain('general-purpose');
        // Should not contain aliases
        expect(ids).not.toContain('explore');
      });

      it('should match number of agents in PREDEFINED_AGENTS', () => {
        const ids = listPredefinedAgentIds();
        expect(ids.length).toBe(Object.keys(PREDEFINED_AGENTS).length);
      });
    });

    describe('listPredefinedAgents', () => {
      it('should return array of agent summaries', () => {
        const agents = listPredefinedAgents();
        expect(Array.isArray(agents)).toBe(true);

        const agent = agents.find((a) => a.id === 'code-explore');
        expect(agent).toBeDefined();
        expect(agent?.name).toBe('Code Explore Agent');
        expect(agent?.description).toBeDefined();
      });
    });

    describe('isPredefinedAgent', () => {
      it('should return true for predefined agent IDs', () => {
        expect(isPredefinedAgent('code-explore')).toBe(true);
        expect(isPredefinedAgent('plan')).toBe(true);
        expect(isPredefinedAgent('coder')).toBe(true);
      });

      it('should return true for aliases', () => {
        expect(isPredefinedAgent('explore')).toBe(true);
        expect(isPredefinedAgent('code-reviewer')).toBe(true);
      });

      it('should return false for unknown IDs', () => {
        expect(isPredefinedAgent('unknown')).toBe(false);
        expect(isPredefinedAgent('')).toBe(false);
      });
    });

    describe('getAgentsByTag', () => {
      it('should return agents with matching tag', () => {
        const visionAgents = getAgentsByTag('vision');
        expect(visionAgents.length).toBeGreaterThanOrEqual(2);

        const ids = visionAgents.map((a) => a.id);
        expect(ids).toContain('visual-understanding');
        expect(ids).toContain('visual-processing');
      });

      it('should return empty array for unknown tag', () => {
        const agents = getAgentsByTag('nonexistent-tag');
        expect(agents).toEqual([]);
      });

      it('should return meta agents', () => {
        const metaAgents = getAgentsByTag('meta');
        expect(metaAgents.length).toBeGreaterThanOrEqual(3);

        const ids = metaAgents.map((a) => a.id);
        expect(ids).toContain('code-explore');
        expect(ids).toContain('plan');
        expect(ids).toContain('general-purpose');
      });

      it('should return external agents', () => {
        const externalAgents = getAgentsByTag('external');
        expect(externalAgents.length).toBeGreaterThanOrEqual(2);

        const ids = externalAgents.map((a) => a.id);
        expect(ids).toContain('web-search');
        expect(ids).toContain('mcp-connector');
      });
    });
  });

  // --------------------------------------------------------------------------
  // Agent Tool Sets Validation
  // --------------------------------------------------------------------------
  describe('Agent Tool Sets Validation', () => {
    it('readonly agents should not have write tools', () => {
      const readonlyAgents = getAgentsByTag('readonly');

      for (const agent of readonlyAgents) {
        expect(agent.tools).not.toContain('write_file');
        expect(agent.tools).not.toContain('edit_file');
      }
    });

    it('code agents should have file access tools', () => {
      const codeAgents = getAgentsByTag('code');

      for (const agent of codeAgents) {
        // At minimum, should be able to read files or have glob
        const hasFileAccess =
          agent.tools.includes('read_file') ||
          agent.tools.includes('glob');
        expect(hasFileAccess).toBe(true);
      }
    });

    it('debugging agent should have comprehensive tools', () => {
      const debugger_ = getPredefinedAgent('debugger');
      expect(debugger_?.tools).toContain('bash');
      expect(debugger_?.tools).toContain('read_file');
      expect(debugger_?.tools).toContain('grep');
    });
  });

  // --------------------------------------------------------------------------
  // Permission and Budget Constraints
  // --------------------------------------------------------------------------
  describe('Permission and Budget Constraints', () => {
    it('all agents should have permissionPreset', () => {
      const agents = Object.values(PREDEFINED_AGENTS);
      for (const agent of agents) {
        expect(agent.permissionPreset).toBeDefined();
      }
    });

    it('agents with maxBudget should have reasonable values', () => {
      const agents = Object.values(PREDEFINED_AGENTS);
      for (const agent of agents) {
        if (agent.maxBudget !== undefined) {
          expect(agent.maxBudget).toBeGreaterThan(0);
          expect(agent.maxBudget).toBeLessThan(100); // Reasonable budget limit
        }
      }
    });

    it('agents with maxIterations should have reasonable values', () => {
      const agents = Object.values(PREDEFINED_AGENTS);
      for (const agent of agents) {
        if (agent.maxIterations !== undefined) {
          expect(agent.maxIterations).toBeGreaterThanOrEqual(1);
          expect(agent.maxIterations).toBeLessThanOrEqual(50); // Reasonable iteration limit
        }
      }
    });
  });
});
