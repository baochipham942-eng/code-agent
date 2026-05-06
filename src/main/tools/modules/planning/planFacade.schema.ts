// Schema-only file (P1 Wave 3 — planning native migration)
// Note: this is the unified `Plan` facade tool (read/update/recover_recent_work).
// Distinct from the plan_mode facade in planModeFacade.schema.ts (PlanMode).
import type { ToolSchema } from '../../../protocol/tools';

export const planFacadeSchema: ToolSchema = {
  name: 'Plan',
  description: `Creates and manages execution plans for complex multi-step tasks.

Actions:
- read: Inspect the current plan
- update: Update a plan step status or add a phase note
- recover_recent_work: Recover recent desktop/workspace-derived signals into plan/task orchestration when continuing previous work

Examples:
- Read: { "action": "read", "summary": true }
- Update step: { "action": "update", "stepContent": "Implement login", "status": "completed" }
- Recover work: { "action": "recover_recent_work", "query": "issue #42 memory plan" }`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['read', 'update', 'recover_recent_work'],
        description: 'The plan action to perform',
      },
      // read action
      includeCompleted: {
        type: 'boolean',
        description: '[read] Include completed steps in output (default: false)',
      },
      summary: {
        type: 'boolean',
        description: '[read] Return a brief summary instead of full plan (default: false)',
      },
      // update action
      stepContent: {
        type: 'string',
        description: '[update] Content of the step to update (matches by content)',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'skipped'],
        description: '[update] New status for the step',
      },
      phaseTitle: {
        type: 'string',
        description: '[update] Title of the phase (optional, helps narrow down if steps have similar names)',
      },
      addNote: {
        type: 'string',
        description: '[update] Add a note to the phase (optional)',
      },
      query: {
        type: 'string',
        description: '[recover_recent_work] Optional focused query used to pull merged workspace activity into the plan.',
      },
      sinceHours: {
        type: 'number',
        description: '[recover_recent_work] How far back to recover work signals. Default: 24.',
      },
      desktopLimit: {
        type: 'number',
        description: '[recover_recent_work] Maximum desktop-derived recovered tasks to sync. Default: 3.',
      },
      workspaceLimit: {
        type: 'number',
        description: '[recover_recent_work] Maximum merged workspace activity items to anchor into the plan. Default: 4.',
      },
      refreshDesktop: {
        type: 'boolean',
        description: '[recover_recent_work] Whether to refresh desktop-derived signals before recovery.',
      },
      refreshArtifacts: {
        type: 'boolean',
        description: '[recover_recent_work] Whether to refresh indexed workspace artifacts before searching them.',
      },
    },
    required: ['action'],
  },
  category: 'planning',
  permissionLevel: 'write',
  allowInPlanMode: true,
};
