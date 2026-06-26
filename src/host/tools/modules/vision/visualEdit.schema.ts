// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const visualEditSchema: ToolSchema = {
  name: 'visual_edit',
  description:
    'Edit a source file driven by a Live Preview click (file + line + component) + natural-language ' +
    'user intent + optional screenshot. Calls a vision LLM to generate a minimal diff and applies it ' +
    'atomically. Use when user has clicked on a rendered UI element and described a change.\n\n' +
    'Behavior:\n' +
    '- Reads file at (line ± contextRadius) as visual grounding context\n' +
    '- Sends {screenshot?, surrounding_code, selected_element, user_intent} to vision LLM (GLM-4.6V)\n' +
    '- LLM returns strict JSON {old_text, new_text, summary} describing minimal replacement\n' +
    '- Validates old_text uniquely matches file content, then atomic writes the change\n\n' +
    'Permission: write. User sees intent + file + diff preview before applying.',
  inputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'Absolute path of the source file. Comes from Live Preview click-to-source.',
      },
      line: {
        type: 'number',
        description: '1-indexed line where the selected element is rendered.',
      },
      column: {
        type: 'number',
        description: '1-indexed column (optional).',
      },
      componentName: {
        type: 'string',
        description: 'React component name if known (e.g. "PrimaryButton").',
      },
      tag: {
        type: 'string',
        description: 'DOM tag (e.g. "button", "div").',
      },
      text: {
        type: 'string',
        description: 'Visible text content of the selected element, if any.',
      },
      userIntent: {
        type: 'string',
        description: 'Natural-language description of what to change. Example: "把选中按钮改成红色"',
      },
      screenshotBase64: {
        type: 'string',
        description:
          'Optional base64-encoded screenshot of the iframe at click time (PNG/JPEG). ' +
          'If omitted, tool falls back to text-only reasoning.',
      },
      screenshotMimeType: {
        type: 'string',
        description: 'MIME type of screenshotBase64. Default: image/png',
      },
      contextRadius: {
        type: 'number',
        description: 'Lines before/after the target line to include as grounding. Default 10, max 40.',
      },
    },
    required: ['file', 'line', 'userIntent'],
  },
  category: 'vision',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
