// ============================================================================
// scriptValidator Tests (P2-A 输入加固 + forced-schema 校验)
//
// 主线程在把模型脚本送进 worker 之前做 fail-fast：
//   - validateScript：体积上限 + acorn 语法校验（按 worker 的 AsyncFunction body 形态解析，
//     return/await 合法、import/export 非法）。
//   - validateForcedSchema：模型给的 schema 必须是可用的对象型 JSON Schema 才能直传 forced
//     tool_choice inputSchema（堵 deferred 审计：runForcedStructured 零校验直传）。
// ============================================================================

import { describe, it, expect } from 'vitest';
import { validateScript, validateForcedSchema } from '../../../../src/main/agent/scriptRuntime/scriptValidator';
import { SCRIPT_RUNTIME } from '../../../../src/shared/constants';

describe('validateScript', () => {
  it('accepts a valid script using top-level await and return (mirrors worker AsyncFunction body)', () => {
    const script = `
      phase('go');
      const r = await agent('hi', { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } });
      return r;
    `;
    expect(validateScript(script)).toEqual({ ok: true });
  });

  it('rejects a script with a syntax error and reports it', () => {
    const res = validateScript('const x = ;');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/语法/);
  });

  it('rejects an import declaration', () => {
    const res = validateScript("import fs from 'fs';\nreturn 1;");
    expect(res.ok).toBe(false);
  });

  it('rejects an export declaration (meta format deferred to P3)', () => {
    const res = validateScript('export const meta = { name: "x" };\nreturn 1;');
    expect(res.ok).toBe(false);
  });

  it('rejects a script over the byte limit', () => {
    const huge = `// ${'x'.repeat(SCRIPT_RUNTIME.MAX_SCRIPT_BYTES + 10)}\nreturn 1;`;
    const res = validateScript(huge);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/上限|字节/);
  });
});

describe('validateForcedSchema', () => {
  it('accepts an object schema with properties', () => {
    expect(
      validateForcedSchema({ type: 'object', properties: { x: { type: 'string' } }, required: ['x'] }),
    ).toEqual({ ok: true });
  });

  it('rejects null / non-object', () => {
    expect(validateForcedSchema(null).ok).toBe(false);
    expect(validateForcedSchema('nope').ok).toBe(false);
  });

  it('rejects an array value', () => {
    expect(validateForcedSchema([]).ok).toBe(false);
  });

  it('rejects a non-object top-level type', () => {
    expect(validateForcedSchema({ type: 'array', items: { type: 'string' } }).ok).toBe(false);
  });

  it('rejects a missing top-level type', () => {
    expect(validateForcedSchema({ properties: { x: { type: 'string' } } }).ok).toBe(false);
  });

  it('rejects object schema without properties', () => {
    expect(validateForcedSchema({ type: 'object' }).ok).toBe(false);
  });

  it('rejects properties that is not an object', () => {
    expect(validateForcedSchema({ type: 'object', properties: 'nope' }).ok).toBe(false);
  });
});
