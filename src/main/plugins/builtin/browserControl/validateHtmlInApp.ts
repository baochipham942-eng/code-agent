// ============================================================================
// validate_html_in_app
// ----------------------------------------------------------------------------
// LLM 工具壳：调用 inAppValidationService 驱动 renderer panel 跑一段交互脚本。
// ============================================================================

import { readFile } from 'fs/promises';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import type {
  BrowserInteractionStep,
  BrowserInteractionStepResult,
} from '../../../../shared/contract/browserInteraction';
import { runInAppValidation } from '../../../services/inAppValidationService';
import { validateHtmlInAppSchema as schema } from './validateHtmlInApp.schema';

const VALID_ACTION_TYPES = new Set([
  'click',
  'click-selector',
  'hover',
  'type',
  'press',
  'wait',
]);

function isStringArrayField(v: unknown): v is BrowserInteractionStep[] {
  return Array.isArray(v);
}

function validateSteps(input: unknown): { ok: true; steps: BrowserInteractionStep[] } | { ok: false; error: string } {
  if (!isStringArrayField(input)) return { ok: false, error: 'steps must be an array' };
  if (input.length === 0) return { ok: false, error: 'steps must not be empty' };
  for (let i = 0; i < input.length; i += 1) {
    const step = input[i] as { action?: { type?: string } };
    if (!step || typeof step !== 'object') return { ok: false, error: `steps[${i}] must be an object` };
    if (!step.action || typeof step.action !== 'object') return { ok: false, error: `steps[${i}].action is required` };
    if (!step.action.type || !VALID_ACTION_TYPES.has(step.action.type)) {
      return { ok: false, error: `steps[${i}].action.type must be one of: ${[...VALID_ACTION_TYPES].join(', ')}` };
    }
  }
  return { ok: true, steps: input };
}

function formatResults(results: BrowserInteractionStepResult[]): string {
  const passedCount = results.filter((r) => r.passed).length;
  const totalCount = results.length;
  const heading =
    passedCount === totalCount
      ? `in-app validation passed: ${passedCount}/${totalCount} steps`
      : `in-app validation failed: ${passedCount}/${totalCount} steps passed`;

  const lines = results.map((r) => {
    const marker = r.passed ? '✓' : '✗';
    const labelOrAction = r.label || r.action.type;
    const checks = r.checks.join('; ');
    const failures = r.failures.join('; ');
    const tail = r.passed ? checks : failures || checks;
    return `- [${marker}] ${labelOrAction} (${r.durationMs}ms): ${tail || '(no details)'}`;
  });

  return `${heading}\n${lines.join('\n')}`;
}

export async function executeValidateHtmlInApp(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const inlineHtml = typeof args.html === 'string' ? args.html : undefined;
  const htmlPath = typeof args.htmlPath === 'string' ? args.htmlPath : undefined;
  const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;

  if (!inlineHtml && !htmlPath) {
    return { ok: false, error: 'either "html" or "htmlPath" is required', code: 'INVALID_ARGS' };
  }
  if (inlineHtml && htmlPath) {
    return { ok: false, error: 'pass only one of "html" or "htmlPath", not both', code: 'INVALID_ARGS' };
  }

  const stepsValidation = validateSteps(args.steps);
  if (!stepsValidation.ok) {
    return { ok: false, error: stepsValidation.error, code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  let html: string;
  if (inlineHtml) {
    html = inlineHtml;
  } else {
    try {
      html = await readFile(htmlPath as string, 'utf8');
    } catch (error) {
      return {
        ok: false,
        error: `failed to read htmlPath "${htmlPath}": ${error instanceof Error ? error.message : String(error)}`,
        code: 'DOMAIN_ERROR',
      };
    }
  }

  try {
    onProgress?.({ stage: 'running', detail: `driving panel · ${stepsValidation.steps.length} step(s)` });
    const results = await runInAppValidation(html, stepsValidation.steps, timeoutMs);
    onProgress?.({ stage: 'completing', percent: 100 });
    const passedAll = results.every((r) => r.passed);
    return {
      ok: true,
      output: formatResults(results),
      ...(passedAll ? {} : { warnings: results.filter((r) => !r.passed).flatMap((r) => r.failures) }),
    };
  } catch (error) {
    return {
      ok: false,
      error: `in-app validation failed: ${error instanceof Error ? error.message : String(error)}`,
      code: 'DOMAIN_ERROR',
    };
  }
}

class ValidateHtmlInAppHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeValidateHtmlInApp(args, ctx, canUseTool, onProgress);
  }
}

export const validateHtmlInAppModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ValidateHtmlInAppHandler();
  },
};
