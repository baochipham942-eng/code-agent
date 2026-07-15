import type { ToolSchema } from '../../../protocol/tools';

export const cuaStatefulComputerUseSchema: ToolSchema = {
  name: 'computer_use',
  description: `Stateful macOS computer use backed by cua-driver 0.8.1+.

Use one operation at a time:
1. list_roots to discover pid/windowId.
2. observe to obtain an immutable stateId, opaque element refs, and screenshotId.
3. act with that stateId and exactly one mutation. The state is single-use.

Element mutations must use elementRef from the state. Pixel mutations must use a point whose screenshotId exactly matches the state. Never reuse a state after act, a new observe, expiry, or provider restart. An act result reports delivery and verification separately and returns a full successor state when available. A satisfied postcondition never upgrades rejected or unknown delivery to confirmed. Treat overall=ambiguous as non-retriable until you inspect the successor state; never replay click/type/drag automatically.`,
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['list_roots', 'observe', 'act'],
        description: 'Discover roots, create an immutable observation, or perform one state-bound mutation.',
      },
      onScreenOnly: {
        type: 'boolean',
        description: '[list_roots] Only return windows on the current visible Space.',
      },
      target: {
        type: 'object',
        properties: {
          pid: { type: 'number' },
          windowId: { type: 'number' },
        },
        required: ['pid', 'windowId'],
        additionalProperties: false,
        description: '[observe] Root returned by list_roots.',
      },
      query: { type: 'string', description: '[observe] Optional accessibility-tree filter.' },
      includeScreenshot: {
        type: 'boolean',
        description: '[observe] Include a grounding screenshot. Default true.',
      },
      maxElements: { type: 'number', description: '[observe] Accessibility node cap.' },
      maxDepth: { type: 'number', description: '[observe] Accessibility depth cap.' },
      stateId: { type: 'string', description: '[act] Immutable stateId returned by observe.' },
      mutation: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: [
              'click', 'double_click', 'right_click', 'set_value', 'type_text',
              'press_key', 'hotkey', 'scroll', 'drag',
            ],
          },
          elementRef: { type: 'string', description: 'Opaque ref from state.elements.' },
          point: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              screenshotId: { type: 'string' },
            },
            required: ['x', 'y', 'screenshotId'],
            additionalProperties: false,
          },
          toPoint: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              screenshotId: { type: 'string' },
            },
            required: ['x', 'y', 'screenshotId'],
            additionalProperties: false,
          },
          value: { type: 'string', description: 'Text for set_value/type_text.' },
          key: { type: 'string', description: 'Key for press_key.' },
          keys: { type: 'array', items: { type: 'string' }, description: 'Keys for hotkey.' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'number' },
          deliveryMode: {
            type: 'string',
            enum: ['background', 'foreground'],
            description: 'Input delivery rung. macOS drag requires explicit foreground.',
          },
        },
        required: ['kind'],
        additionalProperties: false,
        description: '[act] Exactly one mutation.',
      },
      expect: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: [
              'element_exists', 'element_absent', 'element_value_equals',
              'text_present', 'window_present',
            ],
          },
          elementRef: { type: 'string' },
          text: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['kind'],
        additionalProperties: false,
        description: '[act] Optional semantic postcondition.',
      },
    },
    required: ['operation'],
    additionalProperties: false,
  },
  category: 'vision',
  permissionLevel: 'execute',
};
