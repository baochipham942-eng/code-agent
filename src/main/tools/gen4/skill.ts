// ============================================================================
// Skill Tool - Execute predefined skills/workflows
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';
import type { SkillDefinition, ModelConfig } from '../../../shared/types';
import { getSubagentExecutor } from '../../agent/SubagentExecutor';
import { getCloudConfigService } from '../../services/cloud';

// ----------------------------------------------------------------------------
// Skill Management - 从云端配置服务获取
// ----------------------------------------------------------------------------

/**
 * 获取所有可用的 Skills
 * 优先从云端获取，失败时使用内置配置
 */
function getSkillsMap(): Record<string, SkillDefinition> {
  const skills = getCloudConfigService().getSkills();
  const map: Record<string, SkillDefinition> = {};
  for (const skill of skills) {
    map[skill.name] = skill;
  }
  return map;
}

export const skillTool: Tool = {
  name: 'skill',
  description: 'Execute a predefined skill or workflow. Use getAvailableSkills() to see available skills.',
  generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'The skill name to execute. Common skills: file-organizer, commit, code-review, test, feature-dev',
      },
      args: {
        type: 'string',
        description: 'Optional arguments or context for the skill',
      },
    },
    required: ['skill'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const skillName = params.skill as string;
    const args = params.args as string | undefined;

    // 从云端配置获取 skills
    const skillsMap = getSkillsMap();
    const skill = skillsMap[skillName];

    if (!skill) {
      const availableSkills = Object.keys(skillsMap).join(', ');
      return {
        success: false,
        error: `Unknown skill: ${skillName}. Available skills: ${availableSkills}`,
      };
    }

    // Check if we have the required context for subagent execution
    if (!context.toolRegistry || !context.modelConfig) {
      // Fallback to returning skill info if context not available
      let prompt = skill.prompt;
      if (args) {
        prompt += `\n\nUser context: ${args}`;
      }

      return {
        success: true,
        output:
          `Skill: ${skill.name}\n` +
          `Description: ${skill.description}\n\n` +
          `Instructions:\n${prompt}\n\n` +
          `(Execute these steps manually - subagent context not available)`,
      };
    }

    // Build the prompt with user arguments
    let fullPrompt = skill.prompt;
    if (args) {
      fullPrompt += `\n\n---\nUser request: ${args}`;
    }

    console.log(`[Skill:${skillName}] Starting execution...`);

    try {
      const executor = getSubagentExecutor();
      const result = await executor.execute(
        fullPrompt,
        {
          name: `Skill:${skillName}`,
          systemPrompt: `You are executing the "${skill.name}" skill. ${skill.description}. Follow the instructions carefully and provide clear output.`,
          availableTools: skill.tools || [],
          maxIterations: 15,
        },
        {
          modelConfig: context.modelConfig as ModelConfig,
          toolRegistry: new Map(
            context.toolRegistry.getAllTools().map((t) => [t.name, t])
          ),
          toolContext: context,
        }
      );

      if (result.success) {
        return {
          success: true,
          output:
            `✅ Skill "${skill.name}" completed\n` +
            `Iterations: ${result.iterations}\n` +
            `Tools used: ${result.toolsUsed.join(', ') || 'none'}\n\n` +
            `Result:\n${result.output}`,
        };
      } else {
        return {
          success: false,
          error: `Skill "${skill.name}" failed: ${result.error}`,
          output: result.output,
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Skill execution error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
};

// Export function to get available skills (从云端配置获取)
export function getAvailableSkills(): SkillDefinition[] {
  return getCloudConfigService().getSkills();
}

// Export function to get skill by name (从云端配置获取)
export function getSkill(name: string): SkillDefinition | undefined {
  return getCloudConfigService().getSkill(name);
}
