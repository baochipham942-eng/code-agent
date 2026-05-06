// Schema-only file (P0-7 方案 A — single source of truth)
// Pure type-only — does not pull legacy tool code at import time.
import type { ToolSchema } from '../../../protocol/tools';

export const screenshotSchema: ToolSchema = {
  name: 'screenshot',
  description: `Capture a screenshot of the screen or a specific window, with optional AI analysis.

IMPORTANT — visibility caveat: by default the assistant only gets back a file path. The image bytes are NOT injected into the conversation. To actually see what's on screen you must either:
  (a) call this tool with analyze=true (and optionally a prompt), or
  (b) chain the image_analyze tool on the returned path afterward.
Without one of those two, do NOT claim you observed UI state, success, or content — you only have a saved PNG you cannot read.

Use this tool to:
- Capture the full screen for visual context
- Capture a specific application window
- Save screenshots for documentation or debugging
- Analyze screen content with AI (OCR, UI understanding)

Parameters:
- target (optional): 'screen' (default) or 'window'
- windowName (optional): Name of window to capture (if target is 'window')
- outputPath (optional): Where to save the screenshot
- analyze (optional): Enable AI analysis (default: false). REQUIRED if you intend to verify what is on screen.
- prompt (optional): Custom analysis prompt (default: describe content)

Returns the path to the saved screenshot file, plus AI analysis if analyze=true.`,
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['screen', 'window'],
        description: 'What to capture: full screen or specific window',
      },
      windowName: {
        type: 'string',
        description: 'Name of the window to capture (for window target)',
      },
      outputPath: {
        type: 'string',
        description: 'Path to save the screenshot (default: temp directory)',
      },
      region: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        description: 'Specific region to capture (x, y, width, height)',
      },
      analyze: {
        type: 'boolean',
        description: 'Enable AI analysis of screenshot content (default: false)',
      },
      prompt: {
        type: 'string',
        description: 'Custom prompt for AI analysis (default: describe and analyze the screenshot)',
      },
    },
  },
  category: 'vision',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
