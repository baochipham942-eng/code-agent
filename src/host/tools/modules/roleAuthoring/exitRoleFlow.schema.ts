// Schema-only file (single source of truth) — exit_role_flow 工具
import type { ToolSchema } from '../../../protocol/tools';

export const EXIT_ROLE_FLOW_TOOL_NAME = 'exit_role_flow';

export const exitRoleFlowSchema: ToolSchema = {
  name: EXIT_ROLE_FLOW_TOOL_NAME,
  description:
    'Exit the current role-authoring flow (create-role / edit-role) WITHOUT touching any pending role draft. ' +
    'Call this when the user asks for something unrelated to role authoring while the strict role-flow toolset is active: ' +
    'after it succeeds the full toolset is restored in this same turn, so you can continue with the user request immediately. ' +
    'Any pending draft stays on its confirmation card — the user can still confirm it later. ' +
    'Do NOT call this while the user is still iterating on the role definition.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'One short sentence on why the flow is being exited (e.g. the unrelated user request).',
      },
    },
    required: [],
  },
  category: 'skill',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
