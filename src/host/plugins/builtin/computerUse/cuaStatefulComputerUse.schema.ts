import type { UntrustedContentToolSchema } from '../../../protocol/tools';
import { isCuaJevStepEnabled } from '../../../../shared/constants/jevQuestions';

export const cuaStatefulComputerUseSchema: UntrustedContentToolSchema = {
  name: 'computer_use',
  description: `Stateful macOS computer use backed by cua-driver 0.14.2+.

Use one operation at a time:
1. list_roots to discover pid/windowId.
2. observe with targetApp from list_roots appName to obtain an immutable stateId, opaque element refs, and screenshotId.
3. act with the same targetApp and that stateId and exactly one mutation. The state is single-use.

Element mutations must use elementRef from the state. Pixel mutations must use a point whose screenshotId exactly matches the state. Never reuse a state after act, a new observe, expiry, or provider restart. An act result reports delivery and verification separately and returns a full successor state when available. A satisfied postcondition never upgrades rejected or unknown delivery to confirmed. Treat overall=ambiguous as non-retriable until you inspect the successor state; never replay click/type/drag automatically.`,
  outputSchema: { type: 'string' },
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
      targetApp: {
        type: 'string',
        description: '[observe, act] Required. Use the appName shown by list_roots for the selected window.',
      },
      bundleId: {
        type: 'string',
        description: '[observe, act] Optional application bundle identifier; targetApp must still match list_roots appName.',
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
  readsUntrustedContent: 'block',
};

const CUA_JEV_STEP_DESCRIPTION_SUFFIX = `

## Goal execution (execute_goal):
- execute_goal: Run a natural-language \`task\` through the Host-verified desktop step loop over accessibility candidates. Every act still goes through the existing confirmation gate; Jev can never skip or pre-approve it. If this operation returns fallback=true, continue yourself with list_roots / observe / act from the returned observation (point+screenshotId is only available after an empty_ax fallback). Jev done is only a signal; the loop stops on its own evidence.
- task: Natural-language desktop goal for execute_goal
- target: Optional {pid, windowId} root for execute_goal; without it the loop matches the task against window titles, and 0 or multiple matches hand back with the roots listed
- jevBudgetUsd: Optional per-task Jev USD budget`;

/** execute_goal 专属参数：与 operation 枚举同步绑开关，关时从 schema 面一并裁掉（与浏览器步选同形）。 */
const CUA_JEV_STEP_PARAM_KEYS: readonly string[] = ['task', 'jevBudgetUsd'];

/**
 * N-JEV-CU-STEP-LOOP：仅在调用方确认 armed（V2 + CODE_AGENT_CUA_JEV_STEP=1 +
 * typesafe key 可解析）时给 operation 枚举加 execute_goal 并补 task/jevBudgetUsd
 * 参数与描述后缀；开关关时返回的 schema 与既有静态 schema 逐字节一致。
 * 镜像 withBrowserJevStepActionEnum 的裁剪语义。
 */
export function withCuaJevStepOperation(
  schema: UntrustedContentToolSchema,
  env: NodeJS.ProcessEnv = process.env,
): UntrustedContentToolSchema {
  const input = schema.inputSchema;
  const operation = input.properties?.operation;
  if (!operation || !Array.isArray(operation.enum)) return schema;
  const enabled = isCuaJevStepEnabled(env);
  const without = operation.enum.filter((value) => value !== 'execute_goal');
  const properties = { ...input.properties };
  if (!enabled) {
    for (const key of CUA_JEV_STEP_PARAM_KEYS) delete properties[key];
  } else {
    properties.task = {
      type: 'string',
      description: '[execute_goal] Natural-language desktop goal for the Host-verified step loop.',
    };
    properties.jevBudgetUsd = {
      type: 'number',
      description: '[execute_goal] Optional per-task Jev USD budget.',
    };
    if (properties.target && typeof properties.target === 'object') {
      properties.target = {
        ...properties.target,
        description:
          '[observe] Root returned by list_roots. [execute_goal] Optional preselected root; otherwise the loop matches the task against window titles and hands back with roots listed on 0 or multiple matches.',
      };
    }
  }
  return {
    ...schema,
    ...(enabled
      ? { description: `${schema.description}${CUA_JEV_STEP_DESCRIPTION_SUFFIX}` }
      : {}),
    inputSchema: {
      ...input,
      properties: {
        ...properties,
        operation: {
          ...operation,
          enum: enabled ? [...without, 'execute_goal'] : without,
        },
      },
    },
  };
}
