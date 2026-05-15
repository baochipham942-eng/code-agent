import type { ToolSchema } from '../../../protocol/tools';

export const validateHtmlInAppSchema: ToolSchema = {
  name: 'validate_html_in_app',
  description: `Validate an AI-generated HTML artifact by driving it inside the app's In-App Validation panel (right side of the chat window).

The panel embeds the HTML in a sandboxed iframe and runs a sequence of interaction steps (clicks / hovers / typing / key presses / waits) against it, asserting expected UI state changes after each step. The user can watch the validation happen in real time.

USE THIS WHEN:
- You generated an HTML file (game, prototype, dashboard, demo) and want to verify it not only renders but also responds correctly to interaction.
- You want a human-visible audit trail of what was clicked and what was observed.

DO NOT USE FOR:
- Public websites you didn't generate yourself — cross-origin / X-Frame-Options will block the iframe, and JS-dispatched events have event.isTrusted=false (anti-bot sites won't honor them).
- Heavy interaction with native menus, real :hover effects, drag-and-drop — those are OS-event-level and not faithfully reproduced here. Use a Playwright-based path for that.

INPUT:
- html (string, required if no htmlPath): inline HTML source.
- htmlPath (string, required if no html): absolute path to a local HTML file.
- steps (array, required): interaction steps. Each step has:
    - action: one of {type:'click', x, y} | {type:'click-selector', selector} | {type:'hover', x, y} | {type:'type', text} | {type:'press', key} | {type:'wait', ms}
    - expect (optional): {textVisible?, textHidden?, selectorVisible?, selectorHidden?, nonblankCanvasMin?, timeoutMs?}
    - label (optional): human description of the step
- timeoutMs (number, optional, default 30000): total deadline for the whole script.

OUTPUT: a structured pass/fail summary listing each step's result.`,
  inputSchema: {
    type: 'object',
    properties: {
      html: {
        type: 'string',
        description: 'Inline HTML source to load. Required if htmlPath is not provided.',
      },
      htmlPath: {
        type: 'string',
        description: 'Absolute path to a local HTML file to load. Required if html is not provided.',
      },
      steps: {
        type: 'array',
        description: 'Interaction steps to run against the iframe in order. Must have at least one step.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            viewport: { type: 'string', enum: ['desktop', 'mobile', 'both'] },
            action: {
              type: 'object',
              description:
                'One of: {type:"click",x,y} | {type:"click-selector",selector} | {type:"hover",x,y} | {type:"type",text} | {type:"press",key} | {type:"wait",ms}',
            },
            expect: {
              type: 'object',
              properties: {
                textVisible: { type: 'string' },
                textHidden: { type: 'string' },
                selectorVisible: { type: 'string' },
                selectorHidden: { type: 'string' },
                nonblankCanvasMin: { type: 'number' },
                timeoutMs: { type: 'number' },
              },
            },
          },
          required: ['action'],
        },
      },
      timeoutMs: {
        type: 'number',
        description: 'Overall timeout for the full validation in milliseconds. Default 30000.',
      },
    },
    required: ['steps'],
  },
  category: 'vision',
  permissionLevel: 'execute',
  readOnly: false,
  allowInPlanMode: false,
};
