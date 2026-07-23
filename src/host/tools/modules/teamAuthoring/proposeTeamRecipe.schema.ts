import { SKILL_CATEGORIES } from '../../../../shared/constants/skillCatalog';
import type { ToolSchema } from '../../../protocol/tools';

const categoryIds = SKILL_CATEGORIES.map((category) => category.id);

export const proposeTeamRecipeSchema: ToolSchema = {
  name: 'propose_team_recipe',
  description:
    'Draft a persistent team recipe from a "build a team / create a recipe" conversation and queue it for user confirmation. ' +
    'Use after a short interview, or after reading a user-provided document, workflow, or prompt: extract roles, responsibilities, and any coordinator; replace document-specific subjects with {topic}. ' +
    'Set lead for an expert team where the lead synthesizes and finalizes; omit lead for an expert group where members answer independently without synthesis. ' +
    'Do not save automatically. If validation reports unknown local roles, explicitly tell the user which document roles have no matching expert and offer to substitute an existing expert or create that role first. ' +
    'When the user revises the definition, call this tool again with the full revised definition.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short recipe name.' },
      description: { type: 'string', description: 'What this team is for. State expert team vs expert group when useful.' },
      category: { type: 'string', enum: categoryIds, description: 'Product category for grouping.' },
      lead: {
        type: 'object',
        properties: {
          roleId: { type: 'string', description: 'Existing local expert who synthesizes the final answer.' },
          briefTemplate: { type: 'string', description: 'Lead brief template containing {topic}.' },
        },
        required: ['roleId', 'briefTemplate'],
      },
      members: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Optional unique member key when a role appears more than once.' },
            roleId: { type: 'string', description: 'Existing local expert id.' },
            taskTemplate: { type: 'string', description: 'This member task, replacing document-specific subjects with {topic}.' },
          },
          required: ['roleId', 'taskTemplate'],
        },
      },
    },
    required: ['name', 'description', 'category', 'members'],
  },
  category: 'fs',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
