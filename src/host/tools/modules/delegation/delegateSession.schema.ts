import type { ToolSchema } from '../../../protocol/tools';

export const delegateSessionSchema: ToolSchema = {
  name: 'delegate_session',
  description: 'Delegate a task to another chat session or create a new session, or operate on an existing delegation. The model never supplies session ids or workspace paths; use list_session_candidates first.',
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['delegate_existing', 'create_new', 'correct', 'stop', 'resume'] },
      candidateSetId: { type: 'string' },
      candidateRef: { type: 'string' },
      text: { type: 'string' },
      delegationId: { type: 'string' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  category: 'planning',
  permissionLevel: 'execute',
  accesses: [{ kind: 'write', expression: 'resource(session, delegation)' }],
};
