import type { UntrustedContentToolSchema } from '../../../protocol/tools';

export const externalSearchSchema: UntrustedContentToolSchema = {
  name: 'ExternalSearch',
  description: 'Searches a configured external search service and returns structured title, URL, snippet, and date results.',
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1, description: 'Search query.' } },
    required: ['query'],
  },
  category: 'network',
  permissionLevel: 'network',
  readsUntrustedContent: 'block',
  readOnly: true,
  allowInPlanMode: true,
};
