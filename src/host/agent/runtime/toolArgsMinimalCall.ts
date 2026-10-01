// ============================================================================
// Tool Args Minimal Call — 校验失败/修复耗尽回灌里的「最小合法调用」示例
// ============================================================================
// 背景（N-EXCEL-ARGS-ECHO / FB-285，夜巡 2026-09-28）：ExcelAutomate 缺 action、
// read_xlsx 缺 file_path 反复出现，模型对着纯文字 schema 清单反复猜参数形状。
// 这里给每个工具生成一条可直接照抄的 compact JSON 调用：高频踩坑工具走显式表，
// 其余工具按 required 逐字段给类型占位值（enum 取第一个值）。
// ============================================================================

import type { JSONSchema, JSONSchemaProperty } from '../../../shared/contract';

const EXCEL_FILE_PLACEHOLDER = '<absolute path to the .xlsx file>';

// 显式表：夜巡实测缺参死循环的工具，给最常用 action 的完整最小调用。
const EXPLICIT_MINIMAL_CALLS: Record<string, Record<string, unknown>> = {
  ExcelAutomate: { action: 'read', file_path: EXCEL_FILE_PLACEHOLDER },
  read_xlsx: { file_path: EXCEL_FILE_PLACEHOLDER },
};

/**
 * 返回该工具的最小合法调用（compact JSON 字符串）。
 * 显式表命中直接返回；否则按 inputSchema.required 逐字段生成类型占位值。
 */
export function minimalCallExample(toolName: string, inputSchema: JSONSchema | undefined): string {
  const explicit = EXPLICIT_MINIMAL_CALLS[toolName];
  if (explicit) return JSON.stringify(explicit);

  const properties = inputSchema?.properties ?? {};
  const example: Record<string, unknown> = {};
  for (const field of inputSchema?.required ?? []) {
    example[field] = placeholderFor(properties[field]);
  }
  return JSON.stringify(example);
}

function placeholderFor(prop: JSONSchemaProperty | undefined): unknown {
  if (prop?.enum && prop.enum.length > 0) return prop.enum[0];
  const type = Array.isArray(prop?.type) ? prop?.type[0] : prop?.type;
  switch (type) {
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return '<field>';
  }
}
