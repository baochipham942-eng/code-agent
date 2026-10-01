// N-EXCEL-ARGS-ECHO (FB-285): ExcelAutomate 缺 action 23x/9 sessions、
// read_xlsx 缺 file_path 21x/10 sessions、repair 耗尽 16x/5 sessions（夜巡 2026-09-28）。
// 本文件钉住三件事：
//   1. 两个真实 schema 的描述里带可照抄的最小调用示例，required 不变（防漂移）；
//   2. 校验失败 / repair 耗尽的回灌带缺失字段名 + Minimal valid call 一行；
//   3. 三条回放夹具（按报告中的错误形状合成——原始 bad call 在 mini 库，本地不可取）。
import { describe, expect, it } from 'vitest';
import { minimalCallExample } from '../../../src/host/agent/runtime/toolArgsMinimalCall';
import { validateToolArgs } from '../../../src/host/agent/runtime/toolArgsValidator';
import {
  ToolArgsRepairGate,
  buildRepairExhaustedMessage,
} from '../../../src/host/agent/runtime/toolArgsRepairGate';
import { excelAutomateSchema } from '../../../src/host/tools/modules/excel/excelAutomate.schema';
import { readXlsxSchema } from '../../../src/host/tools/modules/network/readXlsx.schema';
import type { JSONSchema } from '../../../src/shared/contract';

const EXCEL_MINIMAL = '{"action":"read","file_path":"<absolute path to the .xlsx file>"}';
const READ_XLSX_MINIMAL = '{"file_path":"<absolute path to the .xlsx file>"}';

describe('minimalCallExample', () => {
  it('ExcelAutomate has an explicit minimal call (action + file_path)', () => {
    expect(minimalCallExample('ExcelAutomate', excelAutomateSchema.inputSchema)).toBe(EXCEL_MINIMAL);
  });

  it('read_xlsx has an explicit minimal call (file_path)', () => {
    expect(minimalCallExample('read_xlsx', readXlsxSchema.inputSchema)).toBe(READ_XLSX_MINIMAL);
  });

  it('falls back to a generic object built from required (enum -> first value, per-type placeholders)', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fast', 'slow'] },
        path: { type: 'string' },
        count: { type: 'number' },
        verbose: { type: 'boolean' },
        items: { type: 'array' },
        options: { type: 'object' },
      },
      required: ['mode', 'path', 'count', 'verbose', 'items', 'options'],
    };
    expect(JSON.parse(minimalCallExample('some_tool', schema))).toEqual({
      mode: 'fast',
      path: '<field>',
      count: 0,
      verbose: false,
      items: [],
      options: {},
    });
  });

  it('drift guard: every example from the explicit table passes validateToolArgs against the real schema', () => {
    const excel = validateToolArgs(
      'ExcelAutomate',
      excelAutomateSchema.inputSchema,
      JSON.parse(minimalCallExample('ExcelAutomate', excelAutomateSchema.inputSchema)),
    );
    expect(excel.ok).toBe(true);
    const readXlsx = validateToolArgs(
      'read_xlsx',
      readXlsxSchema.inputSchema,
      JSON.parse(minimalCallExample('read_xlsx', readXlsxSchema.inputSchema)),
    );
    expect(readXlsx.ok).toBe(true);
  });
});

describe('tool descriptions carry copy-pasteable minimal calls; required unchanged', () => {
  it('excelAutomateSchema keeps required=[action], no oneOf/anyOf, description leads with the action rule + 3 examples', () => {
    expect(excelAutomateSchema.inputSchema.required).toEqual(['action']);
    expect(excelAutomateSchema.inputSchema.additionalProperties).toBe(false);
    const desc = excelAutomateSchema.description;
    expect(desc).toContain('Every call MUST include `action`.');
    expect(desc).toContain('{"action":"read","file_path"');
    expect(desc).toContain('{"action":"list_sheets","file_path"');
    expect(desc).toContain('{"action":"edit","file_path"');
  });

  it('readXlsxSchema keeps required=[file_path] and description states file_path is required + one example', () => {
    expect(readXlsxSchema.inputSchema.required).toEqual(['file_path']);
    expect(readXlsxSchema.inputSchema.additionalProperties).toBe(false);
    expect(readXlsxSchema.description).toContain('`file_path` is required');
    expect(readXlsxSchema.description).toContain('{"file_path"');
  });
});

// 回放夹具按夜巡报告中的错误形状合成（原始 bad call 存在 mini 库，本地 DB 无记录）。
describe('replay: bad calls get the missing field name + minimal call line', () => {
  it('replay 1: ExcelAutomate {} -> missing action + minimal call', () => {
    const result = validateToolArgs('ExcelAutomate', excelAutomateSchema.inputSchema, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('缺少必填参数 `action`');
    expect(result.message).toContain(`Minimal valid call: ExcelAutomate ${EXCEL_MINIMAL}`);
  });

  it('replay 2: ExcelAutomate {file_path} only -> still missing action + minimal call', () => {
    const result = validateToolArgs('ExcelAutomate', excelAutomateSchema.inputSchema, {
      file_path: '/a.xlsx',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('缺少必填参数 `action`');
    expect(result.message).toContain(`Minimal valid call: ExcelAutomate ${EXCEL_MINIMAL}`);
  });

  it('replay 3: read_xlsx {path} -> names unknown path + missing file_path + minimal call', () => {
    const result = validateToolArgs('read_xlsx', readXlsxSchema.inputSchema, {
      path: '/a.xlsx',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('未识别的参数 `path`');
    expect(result.message).toContain('缺少必填参数 `file_path`');
    expect(result.message).toContain(`Minimal valid call: read_xlsx ${READ_XLSX_MINIMAL}`);
  });

  it('no missing issue -> no minimal call line (wrong-type-only failures unchanged)', () => {
    const result = validateToolArgs('read_xlsx', readXlsxSchema.inputSchema, {
      file_path: '/a.xlsx',
      max_rows: 'lots',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('参数 `max_rows` 类型错误');
    expect(result.message).not.toContain('Minimal valid call:');
  });
});

describe('repair exhausted message', () => {
  it('with hint: names missing fields, prints the example, points at Glob/ListDirectory or the user', () => {
    const gate = new ToolArgsRepairGate(1);
    expect(gate.recordFailure('ExcelAutomate').exhausted).toBe(false);
    expect(gate.recordFailure('ExcelAutomate').exhausted).toBe(true);

    const msg = buildRepairExhaustedMessage('ExcelAutomate', 2, {
      missingFields: ['action'],
      example: EXCEL_MINIMAL,
    });
    expect(msg).toContain('action');
    expect(msg).toContain(`Minimal valid call: ExcelAutomate ${EXCEL_MINIMAL}`);
    expect(msg).toContain('Glob/ListDirectory');
    expect(msg).toContain('ask the user');
  });

  it('without hint: byte-identical to the pre-ticket text', () => {
    expect(buildRepairExhaustedMessage('write_file', 3)).toBe(
      [
        `<tool-args-repair-exhausted>`,
        `工具 "write_file" 已连续 3 次入参校验失败。`,
        `停止再用同样的方式重试该工具——继续重试只会浪费轮次。请改换策略：`,
        `  - 换一条能达成目标的不同路径（别的工具 / 别的方法）；或`,
        `  - 若确实缺少必要信息，直接向用户说明卡点并询问。`,
        `</tool-args-repair-exhausted>`,
      ].join('\n'),
    );
  });
});
