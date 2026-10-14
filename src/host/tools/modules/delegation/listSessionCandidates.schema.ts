import type { ToolSchema } from '../../../protocol/tools';

export const listSessionCandidatesSchema: ToolSchema = {
  name: 'list_session_candidates',
  description: 'List opaque candidate references for delegating work to another chat session. The model never supplies session ids or workspace paths.',
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  category: 'planning',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
  accesses: [{ kind: 'read', expression: 'resource(session, candidates)' }],
};
