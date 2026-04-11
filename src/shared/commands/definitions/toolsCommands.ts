// ============================================================================
// Tools Commands - /tools, /skills
// ============================================================================

import type { CommandDefinition } from '../types';

export const toolsCommand: CommandDefinition = {
  id: 'tools',
  name: '工具列表',
  description: '列出已加载工具',
  category: 'tools',
  surfaces: ['cli'],
  handler: async (ctx) => {
    // 工具列表依赖 CLI bootstrap 的 toolExecutor，保留在 CLI fallback
    // 这里提供一个基础实现
    const getToolExecutor = ctx.getToolExecutor as (() => {
      toolRegistry: {
        getAllTools(): Array<{ name: string; description: string }>;
      };
    } | null) | undefined;

    if (!getToolExecutor) {
      ctx.output.info('Tool executor not available');
      return { success: false, message: 'Tool executor not available' };
    }

    try {
      const executor = getToolExecutor();
      if (!executor) {
        ctx.output.info('Tool executor not available');
        return { success: false };
      }

      const allTools = executor.toolRegistry.getAllTools();
      const mcpTools = allTools.filter(t => t.name.startsWith('mcp_') || t.name.startsWith('mcp__'));
      const builtinTools = allTools.filter(t => !t.name.startsWith('mcp_') && !t.name.startsWith('mcp__'));

      const lines: string[] = [];
      lines.push(`Tools (${allTools.length} total)`);

      if (builtinTools.length > 0) {
        lines.push(`  Built-in (${builtinTools.length}):`);
        const names = builtinTools.map(t => t.name).sort();
        for (let i = 0; i < names.length; i += 4) {
          const row = names.slice(i, i + 4).map(n => n.padEnd(22)).join('');
          lines.push(`    ${row}`);
        }
      }

      if (mcpTools.length > 0) {
        lines.push(`  MCP (${mcpTools.length}):`);
        for (const t of mcpTools.sort((a, b) => a.name.localeCompare(b.name))) {
          const desc = t.description ? t.description.substring(0, 50) : '';
          lines.push(`    🔌 ${t.name}${desc ? `  ${desc}` : ''}`);
        }
      }

      ctx.output.info(lines.join('\n'));
      return { success: true, data: { total: allTools.length } };
    } catch {
      ctx.output.error('Failed to list tools');
      return { success: false, message: 'Failed to list tools' };
    }
  },
};

export const skillsCommand: CommandDefinition = {
  id: 'skills',
  name: '技能列表',
  description: '列出已激活技能',
  category: 'tools',
  surfaces: ['cli'],
  handler: async (ctx) => {
    const getSessionSkillService = ctx.getSessionSkillService as (() => {
      getMountedSkills(sessionId: string): Array<{ skillName: string; source: string }>;
    }) | undefined;
    const agent = ctx.agent as { getSessionId?: () => string | null } | undefined;

    if (!getSessionSkillService || !agent?.getSessionId) {
      ctx.output.info('Skill service not available');
      return { success: false };
    }

    try {
      const skillService = getSessionSkillService();
      const sessionId = agent.getSessionId();
      if (!sessionId) {
        ctx.output.info('No active session');
        return { success: true, message: 'No active session' };
      }

      const mounted = skillService.getMountedSkills(sessionId);
      if (mounted.length === 0) {
        ctx.output.info('No skills mounted');
      } else {
        const lines = [`Active skills (${mounted.length})`];
        for (const s of mounted) {
          const marker = s.source === 'auto' ? ' [auto]' : '';
          lines.push(`  ✦ ${s.skillName}${marker}`);
        }
        ctx.output.info(lines.join('\n'));
      }
      return { success: true, data: { count: mounted.length } };
    } catch {
      ctx.output.error('Failed to list skills');
      return { success: false, message: 'Failed to list skills' };
    }
  },
};

export const toolsCommands: CommandDefinition[] = [
  toolsCommand,
  skillsCommand,
];
