// ============================================================================
// Schema Validator - 轻量级 JSON Schema 验证器
// ============================================================================

/**
 * JSON Schema 验证错误
 */
export interface SchemaValidationError {
  path: string;
  message: string;
}

/**
 * JSON Schema 验证结果
 */
export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaValidationError[];
}

/**
 * 简化的 JSON Schema 类型定义
 */
export interface JSONSchema {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  additionalProperties?: boolean | JSONSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  description?: string;
}

/**
 * 验证数据是否符合 JSON Schema
 */
export function validateSchema(data: unknown, schema: JSONSchema): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];
  validate(data, schema, '', errors);
  return { valid: errors.length === 0, errors };
}

function validate(
  data: unknown,
  schema: JSONSchema,
  path: string,
  errors: SchemaValidationError[]
): void {
  // 类型检查
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actualType = getJSONType(data);
    if (!types.includes(actualType)) {
      errors.push({
        path: path || '/',
        message: `期望类型 ${types.join(' | ')}，实际为 ${actualType}`,
      });
      return; // 类型不匹配，跳过后续验证
    }
  }

  // enum 检查
  if (schema.enum !== undefined) {
    if (!schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(data))) {
      errors.push({
        path: path || '/',
        message: `值必须是 [${schema.enum.map((v) => JSON.stringify(v)).join(', ')}] 之一，实际为 ${JSON.stringify(data)}`,
      });
    }
  }

  // object 类型验证
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;

    // required 字段检查
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          errors.push({
            path: joinPath(path, key),
            message: `缺少必填字段 "${key}"`,
          });
        }
      }
    }

    // properties 嵌套验证
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          validate(obj[key], propSchema, joinPath(path, key), errors);
        }
      }
    }
  }

  // array 类型验证
  if (Array.isArray(data)) {
    // minItems / maxItems
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      errors.push({
        path: path || '/',
        message: `数组长度至少为 ${schema.minItems}，实际为 ${data.length}`,
      });
    }
    if (schema.maxItems !== undefined && data.length > schema.maxItems) {
      errors.push({
        path: path || '/',
        message: `数组长度最多为 ${schema.maxItems}，实际为 ${data.length}`,
      });
    }

    // items 元素类型验证
    if (schema.items) {
      for (let i = 0; i < data.length; i++) {
        validate(data[i], schema.items, `${path}[${i}]`, errors);
      }
    }
  }

  // string 约束
  if (typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errors.push({
        path: path || '/',
        message: `字符串长度至少为 ${schema.minLength}，实际为 ${data.length}`,
      });
    }
    if (schema.maxLength !== undefined && data.length > schema.maxLength) {
      errors.push({
        path: path || '/',
        message: `字符串长度最多为 ${schema.maxLength}，实际为 ${data.length}`,
      });
    }
  }

  // number 约束
  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) {
      errors.push({
        path: path || '/',
        message: `值不能小于 ${schema.minimum}，实际为 ${data}`,
      });
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      errors.push({
        path: path || '/',
        message: `值不能大于 ${schema.maximum}，实际为 ${data}`,
      });
    }
  }
}

/**
 * 获取值的 JSON 类型名称
 */
function getJSONType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer'; // 同时匹配 number
  return typeof value; // string, number, boolean, object
}

/**
 * 拼接 JSON Path
 */
function joinPath(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

/**
 * 格式化验证错误为可读字符串
 */
export function formatValidationErrors(errors: SchemaValidationError[]): string {
  return errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n');
}
