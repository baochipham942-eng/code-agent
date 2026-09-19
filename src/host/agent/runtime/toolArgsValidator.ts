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
  /** 给日志/遥测看的字段级摘要，不包含参数值 */
  issues: ValidationIssue[];
}

export interface ValidationSuccess {
  ok: true;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export interface ValidationIssue {
  field: string;
  reason: 'missing' | 'wrong_type' | 'unknown_field';
  expected?: string;
  actual?: string;
  description?: string;
}

/**
 * 校验 args 是否符合 inputSchema 的 required + 顶层 type 约束。
 *
 * - missing required：required 数组里列了但 args 没有（或为 null/undefined；空字符串是合法值，不算 missing）
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
  const issues: ValidationIssue[] = [];
  // 未识别参数名只在 schema 显式 additionalProperties === false 时拒（JSON Schema
  // 默认允许额外键，全仓多数 schema 没声明全，按默认放行才不会误伤）。
  const rejectUnknownFields = inputSchema.additionalProperties === false;

  // 1. missing required
  // 注意：空字符串 '' 不算 missing —— 对 type: string 的必填参数，"" 是合法值
  // （如 Write.content 传 "" 表示"我就是要建/清空一个空文件"）。之前把 '' 等同
  // missing 会把模型明确传的合法空值打回去，还谎报"缺少"（其实传了）。
  // 真正"这个字符串不能为空"的语义要求由各工具 handler 自己校验并给出对应错误。
  for (const key of required) {
    const v = safeArgs[key];
    if (v === undefined || v === null) {
      const prop = properties[key];
      issues.push({
        field: key,
        reason: 'missing',
        expected: formatTypeDeclaration(prop?.type ?? 'any'),
        description: prop?.description,
      });
    }
  }

  // 2. wrong type（仅顶层，仅 args 实际传了的字段）
  for (const [key, value] of Object.entries(safeArgs)) {
    const propSchema = properties[key];
    // 未识别的参数名：此前静默跳过，工具端再静默回落默认值，两头都不吭声——
    // 模型拿不到"参数名不存在"的事实，只能反复猜（2026-09-18 夜跑实测 6 连拒）。
    if (propSchema === undefined) {
      if (rejectUnknownFields) {
        issues.push({ field: key, reason: 'unknown_field' });
      }
      continue;
    }
    if (value === undefined || value === null) continue;
    if (!propSchema.type) continue;
    const actualType = typeOfValue(value);
    if (!isTypeCompatible(actualType, propSchema.type)) {
      issues.push({
        field: key,
        reason: 'wrong_type',
        expected: formatTypeDeclaration(propSchema.type),
        actual: actualType,
        description: propSchema.description,
      });
    }
  }

  if (issues.length === 0) return { ok: true };

  return {
    ok: false,
    message: formatValidationError(toolName, issues, properties, required),
    issues,
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
 * union type（数组）任一命中即通过，integer 兼容 number 的规则对每个成员同样适用。
 */
function isTypeCompatible(actual: string, expected: string | string[]): boolean {
  const expectedList = Array.isArray(expected) ? expected : [expected];
  return expectedList.some((e) => actual === e || (e === 'integer' && actual === 'number'));
}

/**
 * 渲染 type 声明给人/模型看：union 用 " | " 连接（与 toolSchemaValidator.formatExpectedType 同口径）。
 */
function formatTypeDeclaration(type: string | string[]): string {
  if (Array.isArray(type)) {
    return type.length > 0 ? type.join(' | ') : 'any';
  }
  return type;
}

/**
 * 把工具的 inputSchema 渲染成模型可读的字段清单（人话 schema）。
 * 校验失败分支和 parse-error 分支共用，避免"先报语法→再报字段"的连环重试。
 *
 * @param requiredOnly 字段过多时只列必填，防止 schema 回灌膨胀 token。
 *   省略时默认全列（保持 formatValidationError 原有行为不变）。
 */
export function formatSchemaForModel(
  properties: Record<string, JSONSchemaProperty>,
  required: string[],
  requiredOnly = false,
): string[] {
  const entries = Object.entries(properties);
  const shown = requiredOnly ? entries.filter(([key]) => required.includes(key)) : entries;
  const lines: string[] = [];
  lines.push(
    requiredOnly
      ? `参数 schema（共 ${entries.length} 个参数，只列必填）：`
      : `完整参数 schema：`,
  );
  for (const [key, propSchema] of shown) {
    const isRequired = required.includes(key);
    lines.push(`  - \`${key}\`: ${formatTypeDeclaration(propSchema.type ?? 'any')} ${isRequired ? '(必填)' : '(可选)'}${propSchema.description ? ` — ${propSchema.description}` : ''}`);
  }
  return lines;
}

function formatValidationError(
  toolName: string,
  issues: ValidationIssue[],
  properties: Record<string, JSONSchemaProperty>,
  required: string[],
): string {
  const lines: string[] = [];
  lines.push(`<tool-args-validation-error>`);
  lines.push(`工具 "${toolName}" 参数校验失败（${issues.length} 处问题）：`);
  for (const issue of issues) {
    if (issue.reason === 'missing') {
      lines.push(`  - 缺少必填参数 \`${issue.field}\` (${issue.expected})${issue.description ? ` — ${issue.description}` : ''}`);
    } else if (issue.reason === 'unknown_field') {
      lines.push(`  - 未识别的参数 \`${issue.field}\`，本工具只接受：${Object.keys(properties).join(', ')}`);
    } else {
      lines.push(`  - 参数 \`${issue.field}\` 类型错误：期望 ${issue.expected}，实际是 ${issue.actual}${issue.description ? ` — ${issue.description}` : ''}`);
    }
  }
  lines.push(``);
  lines.push(...formatSchemaForModel(properties, required));
  lines.push(`</tool-args-validation-error>`);
  return lines.join('\n');
}
