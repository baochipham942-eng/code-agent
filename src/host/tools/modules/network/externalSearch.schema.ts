import type { ToolSchema } from '../../../protocol/tools';

export const externalSearchSchema: ToolSchema = {
  name: 'ExternalSearch',
  description: 'Searches a configured external search service and returns structured title, URL, snippet, and date results.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1, description: 'Search query.' } },
    required: ['query'],
  },
  category: 'network',
  permissionLevel: 'network',
  readOnly: true,
  allowInPlanMode: true,
};
