// Schema-only file (P1 Wave 3 — planning native migration)
import type { ToolSchema } from '../../../protocol/tools';

export const planRecoverRecentWorkSchema: ToolSchema = {
  name: 'plan_recover_recent_work',
  description:
    'Recover recent desktop/workspace-derived signals into the current plan. ' +
    'Use this when the user asks to continue previous work or when the next task is ambiguous.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Optional focused query used to pull merged workspace activity into the plan.',
      },
      sinceHours: {
        type: 'number',
        description: 'How far back to recover recent work signals. Default: 24.',
      },
      desktopLimit: {
        type: 'number',
        description: 'Maximum desktop-derived recovered tasks to sync. Default: 3.',
      },
      workspaceLimit: {
        type: 'number',
        description: 'Maximum merged workspace activity items to anchor into the plan. Default: 4.',
      },
      refreshDesktop: {
        type: 'boolean',
        description: 'If true or omitted, refresh desktop-derived signals before recovering them.',
      },
      refreshArtifacts: {
        type: 'boolean',
        description: 'If true, refresh indexed workspace artifacts before searching them.',
      },
    },
  },
  category: 'planning',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
