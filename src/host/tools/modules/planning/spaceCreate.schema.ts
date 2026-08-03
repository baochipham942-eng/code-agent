import type { ToolSchema } from '../../../protocol/tools';

export const spaceCreateSchema: ToolSchema = {
  name: 'space_create',
  description:
    'Create a Neo collaboration space for durable shared work, configured capabilities, activity, and artifacts. ' +
    'Use this only when the user explicitly wants a new collaboration space. This is a write operation and requires approval.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Human-readable collaboration space name.',
      },
      description: {
        type: 'string',
        description: 'Optional purpose and scope of the collaboration space.',
      },
      workspacePath: {
        type: 'string',
        description: 'Optional absolute project directory to bind and trust for this space.',
      },
      trustAcknowledged: {
        type: 'boolean',
        description: 'Set true only after the user acknowledges risky files reported by the folder trust gate.',
      },
    },
    required: ['name'],
  },
  category: 'planning',
  permissionLevel: 'write',
  readOnly: false,
};
