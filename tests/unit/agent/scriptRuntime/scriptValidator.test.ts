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

  // ── Codex HIGH#3：动态 import() 能绕过 require/process shadow，必须拒 ──
  it('rejects a dynamic import() expression', () => {
    const res = validateScript("const fs = await import('node:fs');\nreturn 1;");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/import/i);
  });

  // ── Codex MED#4：用真实形参编译校验 → 与 worker 的 new AsyncFunction 语义一致 ──
  it('rejects a script that redeclares a runtime primitive parameter (param collision)', () => {
    // worker 把 agent/parallel/... 作为形参注入；脚本里 `const agent` 会在真实构造时抛 SyntaxError，
    // 包成无参函数体的旧校验法会漏掉。
    const res = validateScript('const agent = 1;\nreturn agent;');
    expect(res.ok).toBe(false);
  });

  it('still accepts a script that calls the injected primitives (they are real params, not collisions)', () => {
    const res = validateScript("await phase('x');\nconst r = await agent('hi', { schema: { type:'object', properties:{ a:{type:'string'} } } });\nreturn r;");
    expect(res).toEqual({ ok: true });
  });

  // ── P4-A 确定性加固：重放正确性依赖脚本确定性，非确定性调用会让缓存键错乱，必须 fail-fast ──
  it('rejects Date.now() (non-deterministic, breaks replay cache)', () => {
    const res = validateScript('const t = Date.now();\nreturn t;');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/确定性|Date\.now/);
  });

  it('rejects argless new Date() (current time)', () => {
    const res = validateScript('const d = new Date();\nreturn d.getFullYear();');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/确定性|Date/);
  });

  it('accepts new Date(arg) with arguments (deterministic)', () => {
    const res = validateScript("const d = new Date('2020-01-01');\nreturn d.getTime();");
    expect(res).toEqual({ ok: true });
  });

  it('rejects Date() called as a function (current time string)', () => {
    const res = validateScript('const s = Date();\nreturn s;');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/确定性|Date/);
  });

  it('rejects Math.random() (non-deterministic)', () => {
    const res = validateScript('const r = Math.random();\nreturn r;');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/确定性|Math\.random/);
  });

  it('rejects performance.now() (non-deterministic)', () => {
    const res = validateScript('const t = performance.now();\nreturn t;');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/确定性|performance\.now/);
  });

  it('still accepts deterministic Math methods (floor/max/min/ceil/round)', () => {
    const res = validateScript('const x = Math.floor(Math.max(1, 2) / Math.min(3, 4));\nreturn x;');
    expect(res).toEqual({ ok: true });
  });

  it('detects a non-deterministic call nested inside an agent() prompt', () => {
    const res = validateScript("const r = await agent('q ' + Date.now());\nreturn r;");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/确定性|Date\.now/);
  });

  // ── P4 Codex round1 MED#1：denylist 覆盖面太窄，补 crypto.* / globalThis.* / 可选链 ──
  it('rejects crypto.randomUUID() (non-deterministic id)', () => {
    const res = validateScript('const id = crypto.randomUUID();\nreturn id;');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/确定性|crypto/);
  });

  it('rejects crypto.getRandomValues()', () => {
    const res = validateScript('const a = crypto.getRandomValues(new Uint8Array(4));\nreturn a;');
    expect(res.ok).toBe(false);
  });

  it('rejects globalThis.Date.now() (member chain через globalThis)', () => {
    const res = validateScript('const t = globalThis.Date.now();\nreturn t;');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/确定性|Date\.now/);
  });

  it('rejects globalThis.performance.now()', () => {
    const res = validateScript('const t = globalThis.performance.now();\nreturn t;');
    expect(res.ok).toBe(false);
  });

  it('rejects new globalThis.Date() (no-arg via globalThis)', () => {
    const res = validateScript('const d = new globalThis.Date();\nreturn d.getTime();');
    expect(res.ok).toBe(false);
  });

  it('rejects optional-chained Math?.random()', () => {
    const res = validateScript('const r = Math?.random();\nreturn r;');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/确定性|Math\.random/);
  });

  it('still accepts non-suspicious member calls (e.g. a user object .now())', () => {
    // 用户自定义对象的 .now()/.random() 不该被误杀（只拦特定全局入口）。
    const res = validateScript('const clock = { now: () => 42 };\nconst t = clock.now();\nreturn t;');
    expect(res).toEqual({ ok: true });
  });

  // ── P4 Codex round2 MED#1：前缀剥离别误杀本地 window/self 对象（Node worker 无浏览器全局）──
  it('does not false-positive on a locally-shadowed window object', () => {
    const res = validateScript('const window = { Date: { now: () => 1 } };\nreturn window.Date.now();');
    expect(res).toEqual({ ok: true });
  });

  it('still rejects global.Date.now() (global is a real Node global)', () => {
    const res = validateScript('const t = global.Date.now();\nreturn t;');
    expect(res.ok).toBe(false);
  });

  // ── P4 Codex round2 MED#2：TaggedTemplateExpression 是同义调用路径，也要拦 ──
  it('rejects tagged-template Math.random`` (executes the banned fn as a tag)', () => {
    const res = validateScript('const r = Math.random`x`;\nreturn r;');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/确定性|Math\.random/);
  });

  it('rejects tagged-template Date`` (current time via tag call)', () => {
    const res = validateScript('const d = Date`x`;\nreturn d;');
    expect(res.ok).toBe(false);
  });

  it('rejects tagged-template globalThis.performance.now``', () => {
    const res = validateScript('const t = globalThis.performance.now`x`;\nreturn t;');
    expect(res.ok).toBe(false);
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

  // ── Codex MED#5：超大/超深/$ref schema → DoS/计费炸弹，必须有界 ──
  it('rejects a $ref anywhere in the schema', () => {
    const res = validateForcedSchema({ type: 'object', properties: { x: { $ref: '#/defs/Foo' } } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/\$ref/);
  });

  it('rejects an over-deep schema', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < SCRIPT_RUNTIME.MAX_SCHEMA_DEPTH + 3; i++) {
      deep = { type: 'object', properties: { nested: deep } };
    }
    expect(validateForcedSchema(deep).ok).toBe(false);
  });

  it('rejects an over-large schema (byte budget)', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) properties['field_with_a_longish_name_' + i] = { type: 'string', description: 'x'.repeat(20) };
    const res = validateForcedSchema({ type: 'object', properties });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/上限|字节|过大/);
  });

  // ── Codex R2 MED#3：循环 schema 不能在 $ref 扫描里爆栈，要优雅拒绝 ──
  it('rejects a cyclic schema without crashing', () => {
    const cyclic: Record<string, unknown> = { type: 'object', properties: { self: {} } };
    (cyclic.properties as Record<string, unknown>).self = cyclic; // 自引用
    const res = validateForcedSchema(cyclic);
    expect(res.ok).toBe(false);
  });
});
