// Schema-only file (P0-7 方案 A — single source of truth)
// Pure type-only — does not pull legacy tool code at import time.
import type { ToolSchema } from '../../../protocol/tools';

export const guiAgentSchema: ToolSchema = {
  name: 'gui_agent',
  description: `Run an AI-driven GUI automation task on the desktop.

Uses UI-TARS SDK with Doubao vision model to: screenshot → analyze → execute actions → repeat.

When to use:
- Automate desktop application interactions (open app, click buttons, fill forms)
- E2E testing of Electron/desktop UI
- Cross-application workflows that can't be done via CLI

Parameters:
- task (required): Natural language description of what to do
- model (optional): Vision model ID (default: doubao-seed-1-6-vision-250815)
- max_steps (optional): Maximum action steps (default: 25)
- timeout_ms (optional): Timeout in milliseconds (default: 120000)

IMPORTANT:
- Requires screen access permission on macOS
- Only works with Volcengine Doubao vision models (GUI grounding trained)
- Uses doubao-seed-1-6-vision-250815 by default (only model with native UI-TARS coordinate format)
- Costs ~84K tokens (~¥0.30) per typical task`,
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'Natural language task description (e.g. "打开计算器，计算 123+456")',
      },
      model: {
        type: 'string',
        description: 'Vision model ID (default: doubao-seed-1-6-vision-250815)',
      },
      max_steps: {
        type: 'number',
        description: 'Maximum action steps (default: 25)',
      },
      timeout_ms: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 120000)',
      },
    },
    required: ['task'],
  },
  category: 'vision',
  permissionLevel: 'execute',
  readOnly: false,
  allowInPlanMode: false,
};
