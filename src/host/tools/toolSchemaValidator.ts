/**
 * 工具入参 JSON Schema 校验器（executor 入口 fail-closed 护栏）。
 * 从 toolExecutor.ts 抽出：validator 属独立职责，且 executor 已顶 max-lines 债门。
 */

type JsonSchemaType = 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';

type JsonSchemaNode = {
  type?: JsonSchemaType | JsonSchemaType[];
  description?: string;
  enum?: unknown[];
  format?: 'uri' | 'email' | 'date' | 'date-time' | string;
  minLength?: number;
  pattern?: string;
  minimum?: number;
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
};

type ToolSchemaValidationCategory =
  | 'missing_required'
  | 'type_mismatch'
  | 'enum_mismatch'
  | 'format_mismatch'
  | 'constraint_violation'
  | 'additional_property';

interface ToolSchemaValidationIssue {
  field_path: string;
  expected: string;
  bad_value: string;
  category: ToolSchemaValidationCategory;
}

export function validateToolInputSchema(inputSchema: unknown, params: unknown): ToolSchemaValidationIssue[] {
  const issues: ToolSchemaValidationIssue[] = [];
  validateSchemaNode(inputSchema as JsonSchemaNode, params, '$', issues);
  return issues;
}

function validateSchemaNode(
  schema: JsonSchemaNode | undefined,
  value: unknown,
  path: string,
  issues: ToolSchemaValidationIssue[],
): void {
  if (!schema) return;

  if (schema.type && !matchesSchemaType(value, schema.type)) {
    issues.push({
      field_path: path,
      expected: formatExpectedType(schema.type),
      bad_value: formatBadValue(value),
      category: 'type_mismatch',
    });
    return;
  }

  if (schema.enum && !schema.enum.some((candidate) => jsonValueEquals(candidate, value))) {
    issues.push({
      field_path: path,
      expected: `one of ${schema.enum.map((item) => String(item)).join(', ')}`,
      bad_value: formatBadValue(value),
      category: 'enum_mismatch',
    });
  }

  if (schema.format && typeof value === 'string' && !matchesSimpleFormat(value, schema.format)) {
    issues.push({
      field_path: path,
      expected: `format ${schema.format}`,
      bad_value: formatBadValue(value),
      category: 'format_mismatch',
    });
  }

  // 约束类关键字（minLength / pattern / minimum）：type 已过但值越界，
  // 统一归 constraint_violation，与 type_mismatch 区分（值类型没错，是不满足约束）。
  if (schema.minLength !== undefined && typeof value === 'string' && value.length < schema.minLength) {
    issues.push({
      field_path: path,
      expected: `minLength ${schema.minLength}`,
      bad_value: formatBadValue(value),
      category: 'constraint_violation',
    });
  }

  if (schema.pattern !== undefined && typeof value === 'string' && !matchesPattern(value, schema.pattern)) {
    issues.push({
      field_path: path,
      expected: `pattern ${schema.pattern}`,
      bad_value: formatBadValue(value),
      category: 'constraint_violation',
    });
  }

  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    issues.push({
      field_path: path,
      expected: `minimum ${schema.minimum}`,
      bad_value: formatBadValue(value),
      category: 'constraint_violation',
    });
  }

  if (Array.isArray(value)) {
    if (schema.items) {
      value.forEach((item, index) => validateSchemaNode(schema.items, item, `${path}[${index}]`, issues));
    }
    return;
  }

  if (!isRecord(value)) return;

  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    const childValue = value[key];
    if (isMissingRequiredValue(childValue)) {
      issues.push({
        field_path: joinSchemaPath(path, key),
        expected: formatExpectedType(properties[key]?.type),
        bad_value: formatBadValue(childValue),
        category: 'missing_required',
      });
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        issues.push({
          field_path: joinSchemaPath(path, key),
          expected: 'no additional properties',
          bad_value: formatBadValue(value[key]),
          category: 'additional_property',
        });
      }
    }
  }

  for (const [key, childSchema] of Object.entries(properties)) {
    const childValue = value[key];
    if (childValue === undefined) continue;
    if ((schema.required ?? []).includes(key) && isMissingRequiredValue(childValue)) continue;
    validateSchemaNode(childSchema, childValue, joinSchemaPath(path, key), issues);
  }
}

function isMissingRequiredValue(value: unknown): boolean {
  return value === undefined || value === null;
}

function matchesSchemaType(value: unknown, expected: JsonSchemaType | JsonSchemaType[]): boolean {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => {
    switch (type) {
      case 'object':
        return isRecord(value);
      case 'array':
        return Array.isArray(value);
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
      case 'number':
        return typeof value === 'number' && Number.isFinite(value);
      case 'null':
        return value === null;
      case 'string':
      case 'boolean':
        return typeof value === type;
      default:
        return true;
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatExpectedType(expected: JsonSchemaType | JsonSchemaType[] | undefined): string {
  if (!expected) return 'any';
  return (Array.isArray(expected) ? expected : [expected]).join(' | ');
}

function formatBadValue(value: unknown): string {
  let formatted: string;
  try {
    const json = JSON.stringify(value);
    formatted = json === undefined ? String(value) : json;
  } catch {
    formatted = String(value);
  }
  return formatted.length > 120 ? `${formatted.slice(0, 117)}...` : formatted;
}

function joinSchemaPath(parent: string, key: string): string {
  return parent === '$' ? key : `${parent}.${key}`;
}

function jsonValueEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function matchesPattern(value: string, pattern: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    // 非法正则按不拦处理（schema 作者的错误不该把调用方 fail-closed 挡死）
    return true;
  }
}

function matchesSimpleFormat(value: string, format: string): boolean {
  switch (format) {
    case 'uri':
      try {
        const url = new URL(value);
        return Boolean(url.protocol);
      } catch {
        return false;
      }
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 'date':
      return isValidJsonDate(value);
    case 'date-time':
      return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
    default:
      return true;
  }
}

function isValidJsonDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function formatToolSchemaValidationError(toolName: string, issues: ToolSchemaValidationIssue[]): string {
  const lines = [`工具 "${toolName}" 参数校验失败（${issues.length} 处问题）：`];
  for (const issue of issues) {
    lines.push(
      `field_path=${issue.field_path}; expected=${issue.expected}; bad_value=${issue.bad_value}; category=${issue.category}`,
    );
  }
  return lines.join('\n');
}
