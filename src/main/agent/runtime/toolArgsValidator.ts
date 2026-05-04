// ============================================================================
// Tool Args Validator — 工具参数 schema 前置校验
//
// 历史背景：mimo / 部分模型调媒体类工具（speech_to_text、image_analyze 等）
// 时反复传空 args 或缺关键字段，工具内部抛 native error（如 fs 的 "path argument
// must be of type string"），模型看到这种 error 后误诊（怀疑底层依赖没装）然后
// 放弃整条路径。
//
// 解法：在 toolExecutionEngine.executeSingleTool 真正 dispatch 前，用工具自身
// 的 inputSchema (JSON Schema) 做一次轻量校验：missing required + 顶层 type
// 检查。失败时把"缺啥/类型/schema"作为事实回灌给模型，让它下一轮自我修正。
//
// 不引入 ajv 等重量级 JSON Schema 库（包 200KB+，且要支持 draft-07 全特性
// 没必要），只做最高 ROI 的两类校验。
// ============================================================================

import type { JSONSchema, JSONSchemaProperty } from '../../../shared/contract';

export interface ValidationFailure {
  ok: false;
  /** 给模型看的人话错误，可直接拼到 system message */
  message: string;
}

export interface ValidationSuccess {
  ok: true;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

interface FieldIssue {
  field: string;
  reason: 'missing' | 'wrong_type';
  expected?: string;
  actual?: string;
  description?: string;
}

/**
 * 校验 args 是否符合 inputSchema 的 required + 顶层 type 约束。
 *
 * - missing required：required 数组里列了但 args 没有（或为 null/undefined/空字符串）
 * - wrong_type：properties[k].type 与 typeof args[k] 不匹配（顶层字段，不递归 nested）
 *
 * 不校验：嵌套对象内部字段、enum、pattern、min/max — 这些工具自己处理更合适
 */
export function validateToolArgs(
  toolName: string,
  inputSchema: JSONSchema | undefined,
  args: Record<string, unknown> | undefined,
): ValidationResult {
  // 没 schema 不校验（向后兼容，避免误伤）
  if (!inputSchema) return { ok: true };

  const properties = inputSchema.properties ?? {};
  const required = inputSchema.required ?? [];

  // 既无 properties 也无 required，没什么可校验的
  if (Object.keys(properties).length === 0 && required.length === 0) {
    return { ok: true };
  }

  const safeArgs = args && typeof args === 'object' ? args : {};
  const issues: FieldIssue[] = [];

  // 1. missing required
  for (const key of required) {
    const v = safeArgs[key];
    if (v === undefined || v === null || v === '') {
      const prop = properties[key];
      issues.push({
        field: key,
        reason: 'missing',
        expected: prop?.type ?? 'any',
        description: prop?.description,
      });
    }
  }

  // 2. wrong type（仅顶层，仅 args 实际传了的字段）
  for (const [key, value] of Object.entries(safeArgs)) {
    if (value === undefined || value === null) continue;
    const propSchema = properties[key];
    if (!propSchema?.type) continue;
    const actualType = typeOfValue(value);
    if (!isTypeCompatible(actualType, propSchema.type)) {
      issues.push({
        field: key,
        reason: 'wrong_type',
        expected: propSchema.type,
        actual: actualType,
        description: propSchema.description,
      });
    }
  }

  if (issues.length === 0) return { ok: true };

  return {
    ok: false,
    message: formatValidationError(toolName, issues, properties, required),
  };
}

function typeOfValue(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

/**
 * JSON Schema type 与 typeof 结果的兼容关系。
 * "integer" 是 JSON Schema 特有的，typeof 是 number；其余基本对齐。
 */
function isTypeCompatible(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  if (expected === 'integer' && actual === 'number') return true;
  return false;
}

function formatValidationError(
  toolName: string,
  issues: FieldIssue[],
  properties: Record<string, JSONSchemaProperty>,
  required: string[],
): string {
  const lines: string[] = [];
  lines.push(`<tool-args-validation-error>`);
  lines.push(`工具 "${toolName}" 参数校验失败（${issues.length} 处问题）：`);
  for (const issue of issues) {
    if (issue.reason === 'missing') {
      lines.push(`  - 缺少必填参数 \`${issue.field}\` (${issue.expected})${issue.description ? ` — ${issue.description}` : ''}`);
    } else {
      lines.push(`  - 参数 \`${issue.field}\` 类型错误：期望 ${issue.expected}，实际是 ${issue.actual}${issue.description ? ` — ${issue.description}` : ''}`);
    }
  }
  lines.push(``);
  lines.push(`完整参数 schema：`);
  for (const [key, propSchema] of Object.entries(properties)) {
    const isRequired = required.includes(key);
    lines.push(`  - \`${key}\`: ${propSchema.type ?? 'any'} ${isRequired ? '(必填)' : '(可选)'}${propSchema.description ? ` — ${propSchema.description}` : ''}`);
  }
  lines.push(`</tool-args-validation-error>`);
  return lines.join('\n');
}
