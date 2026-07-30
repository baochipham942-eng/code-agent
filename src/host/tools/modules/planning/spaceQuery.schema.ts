import type { ToolSchema } from '../../../protocol/tools';

export const spaceQuerySchema: ToolSchema = {
  name: 'space_query',
  description:
    'Read one Neo collaboration space as an aggregate: cloud members, selected experts, skills, connectors, automations, recent activity, and artifacts. ' +
    'Use it after space_list when you need the configured people, capabilities, work history, or deliverables for a specific space.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The collaboration space projectId returned by space_list.',
      },
    },
    required: ['projectId'],
  },
  category: 'planning',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
