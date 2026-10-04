// ============================================================================
// 路径形状参数覆盖不变量（N-TOOLRES-K2 r3）—— 三轮评审同一个缺陷类的收口门。
//
// 缺陷类：调度器给工具声明的访问集比工具真实读写的面窄，于是旧代码本会串行的
// 调用被并进同一并发段（r1: ~ 与内嵌参数；r2: 只声明输出 pathAuthority 的写工具
// 看不见 input_path 的读；Glob 只声明 path 而 pattern 可逃出 cwd）。
//
// 不变量：一个调用只有在其访问集被【证完】时才能进并发段；证完的判据是 schema 里
// 每个路径形状参数都被显式 accesses / pathAuthority / emission 覆盖。没证完 → 未知
// read+write（串行，与 pre-PR 一致）。
//
// 三道闸：
//   A. 全注册表扫描：存在未覆盖路径参数的工具，resolver 必须落 [readwrite:unknown]。
//      本文件自带一份与实现同形制的「路径形状参数」判据（钉子副本）：实现侧判据被
//      收窄（漏判某个路径参数）时这里先红；两边要改必须一起改、有意地改。
//   B. 并行度钉子：这批工具带真实参数必须解析出非 unknown 的有界访问集。删某个工具
//      的读声明（变异）会让它退回串行，这里变红——防止有人用「全串行」糊弄 A。
//   C. 行为探针：把评审点名参数的真实 schema 属性挂到裸探针工具上（无任何声明），
//      resolver 必须落未知域；Grep 的 type（扩展名词表）挂上去必须仍是 read:unscoped。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import {
  registerProtocolTool,
  unregisterProtocolTool,
} from '../../../src/host/tools/protocolToolRegistration';
import { resolveToolCallAccesses } from '../../../src/host/tools/dispatch/resolveToolCallAccess';
import type { ToolSchema } from '../../../src/host/protocol/tools';
import type { JSONSchemaProperty, ToolCall } from '../../../src/shared/contract';

const WORKSPACE = '/tmp/toolres-k2-invariant';
const OPTIONS = { workspace: WORKSPACE, cwd: WORKSPACE };

const UNKNOWN_READWRITE = [{ kind: 'readwrite' as const, domain: { type: 'unknown' as const } }];

// ---- 钉子副本：与 resolveToolCallAccess 的实现判据同形制（改动须两处同改） ----
const PATH_PARAM_NAME_TOKENS = new Set([
  'path', 'paths', 'file', 'files', 'filepath', 'file_path', 'dir', 'dirs',
  'directory', 'directories', 'folder', 'folders', 'cwd', 'filename', 'file_name',
  'input_path', 'output_path', 'input_file', 'output_file', 'input_files',
  'output_files', 'outdir', 'out_dir', 'workdir', 'work_dir', 'working_dir',
  'working_directory', 'notebook_path', 'template_path', 'data_path',
]);
const PATH_PARAM_DESC_RE = /path|directory|folder|glob|目录|路径|文件夹/i;
const FILE_TYPE_DESC_RE = /file[- ]type|文件类型/i;

function testPathTypedPropertyNames(schema: ToolSchema): string[] {
  const properties = (schema.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  const names: string[] = [];
  for (const [name, prop] of Object.entries(properties)) {
    const { type, items, enum: vocabulary, description } = prop as {
      type?: unknown;
      items?: { type?: unknown };
      enum?: unknown;
      description?: unknown;
    };
    if (vocabulary !== undefined) continue;
    const types = Array.isArray(type) ? type : [type];
    const stringLike = types.includes('string') || (type === 'array' && items?.type === 'string');
    if (!stringLike) continue;
    const token = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    if (PATH_PARAM_NAME_TOKENS.has(token)) {
      names.push(name);
      continue;
    }
    const desc = typeof description === 'string' ? description : '';
    if (PATH_PARAM_DESC_RE.test(desc) && !FILE_TYPE_DESC_RE.test(desc)) names.push(name);
  }
  return names;
}

function declaredPathParameterNames(schema: ToolSchema): Set<string> {
  const covered = new Set<string>();
  for (const declaration of schema.accesses ?? []) {
    for (const name of declaration.argumentNames ?? []) covered.add(name);
    if (declaration.expression) {
      for (const match of declaration.expression.matchAll(/args\.([A-Za-z0-9_]+)/g)) covered.add(match[1]);
    }
  }
  for (const authority of schema.pathAuthority ?? []) {
    if (authority.kind === 'path' || authority.kind === 'global-memory') covered.add(authority.pathParameter);
  }
  const emission = schema.emission;
  if (emission?.kind === 'external_file_write') covered.add(emission.targetParameter);
  if (emission?.kind === 'external_effect') for (const name of emission.targetParameters) covered.add(name);
  return covered;
}

function syntheticCall(schema: ToolSchema): ToolCall {
  const properties = (schema.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  const args: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(properties)) {
    const { type, items, enum: vocabulary } = prop as {
      type?: unknown;
      items?: { type?: unknown };
      enum?: unknown;
    };
    if (vocabulary !== undefined) continue;
    if (Array.isArray(type) ? type.includes('string') : type === 'string') args[name] = 'probe/x.txt';
    else if (type === 'array' && items?.type === 'string') args[name] = ['probe/x.txt'];
  }
  return { id: `probe-${schema.name}`, name: schema.name, arguments: args };
}

function resolvedFor(name: string, args: Record<string, unknown>) {
  return resolveToolCallAccesses({ id: 'c', name, arguments: args }, OPTIONS);
}

const isForcedUnknown = (resolved: readonly { kind: string; domain: { type: string } }[]) =>
  resolved.length === 1 && resolved[0].domain.type === 'unknown' && resolved[0].kind === 'readwrite';

describe('tool access coverage invariant (r3: a call may join a concurrent segment only when its access set is proven complete)', () => {
  it('every registered schema with an uncovered path-shaped parameter resolves to unknown read+write', () => {
    const violations: string[] = [];
    for (const schema of getProtocolRegistry().getSchemas()) {
      const uncovered = testPathTypedPropertyNames(schema)
        .filter((name) => !declaredPathParameterNames(schema).has(name));
      if (uncovered.length === 0) continue;
      const resolved = resolveToolCallAccesses(syntheticCall(schema), OPTIONS);
      if (!isForcedUnknown(resolved)) {
        violations.push(`${schema.name}: uncovered=[${uncovered.join(',')}] but resolved ${JSON.stringify(resolved)}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps the parallel-capable file tools concurrency-eligible (deleting a declaration must go red here)', () => {
    const pins: Array<[name: string, args: Record<string, unknown>]> = [
      ['Read', { file_path: 'a.txt' }],
      ['Write', { file_path: 'a.txt', content: 'x' }],
      ['Edit', { file_path: 'a.txt', old_string: 'x', new_string: 'y' }],
      ['Append', { file_path: 'a.txt', content: 'x' }],
      ['Blob', { file_path: 'a.txt' }],
      ['ListDirectory', { path: '.' }],
      ['Glob', { pattern: 'src/**/*.ts' }],
      ['Grep', { pattern: 'needle', path: 'docs', include: '*.js' }],
      ['git_diff', { files: ['a.txt'] }],
      ['image_analyze', { path: 'a.png', prompt: 'what' }],
      ['read_pdf', { file_path: 'a.pdf' }],
      ['read_docx', { file_path: 'a.docx' }],
      ['read_xlsx', { file_path: 'a.xlsx' }],
      ['ReadDocument', { file_path: 'a.pdf' }],
      ['local_speech_to_text', { file_path: 'a.wav' }],
      ['diagnostics', { file_path: 'a.ts' }],
      ['lsp', { file_path: 'a.ts' }],
      ['pdf_generate', { title: 't', content: 'c', output_path: 'out.pdf' }],
      ['pdf_compress', { input_path: 'in.pdf', output_path: 'small.pdf' }],
      ['ppt_generate', { title: 't', content: 'c', output_path: 'out.pptx' }],
      ['chart_generate', { title: 't', data: [{ x: 1 }], output_path: 'out.png' }],
      ['docx_generate', { title: 't', content: 'c', output_path: 'out.docx' }],
      ['excel_generate', { title: 't', data: 'a,b', output_path: 'out.xlsx' }],
      ['qrcode_generate', { text: 'hi', output_path: 'out.png' }],
      ['mermaid_export', { code: 'graph TD', output_path: 'out.svg' }],
      ['screenshot_page', { url: 'https://example.com', output_path: 'out.png' }],
      ['WebSearch', { query: 'q', save_to: 'out.md' }],
      ['DocEdit', { file_path: 'a.docx', actions: [] }],
      ['notebook_edit', { notebook_path: 'a.ipynb', new_source: 'x' }],
      ['visual_edit', { file: 'a.png', prompt: 'p' }],
      ['ppt_edit', { file_path: 'a.pptx', action: 'replace_title', slide: 1, title: 't' }],
      ['MemoryWrite', { filename: 'm.md', content: 'x' }],
      ['space_create', { name: 'ws', workspacePath: 'ws' }],
      ['Task', { subagent_type: 'coder', prompt: 'p' }],
      ['spawn_agent', { prompt: 'p', ownedPaths: ['src/**'] }],
      ['task_update', { task_id: 'T1', status: 'completed' }],
    ];
    const serial = pins
      .map(([name, args]) => {
        const resolved = resolvedFor(name, args);
        return resolved.some((access) => access.domain.type === 'unknown')
          ? `${name}: ${JSON.stringify(resolved)}`
          : null;
      })
      .filter((line): line is string => line !== null);
    expect(serial).toEqual([]);
  });

  it('flags the review-named path-shaped parameters (bare probes carrying the real schema properties go serial)', () => {
    const byName = new Map(getProtocolRegistry().getSchemas().map((schema) => [schema.name, schema]));
    const probe = (toolName: string, paramName: string): ToolSchema => {
      const source = byName.get(toolName);
      expect(source, toolName).toBeDefined();
      const property = (source!.inputSchema as { properties?: Record<string, JSONSchemaProperty> }).properties?.[paramName];
      expect(property, `${toolName}.${paramName}`).toBeDefined();
      // 裸探针：只带这一个真实属性，不带任何 accesses / pathAuthority / emission。
      // readOnly:true 保证「参数没被认成路径」时折叠结果是 read:unscoped 而非未知域。
      return {
        name: 'PathShapeProbe',
        description: 'probe',
        outputSchema: { type: 'string' },
        inputSchema: { type: 'object', properties: { [paramName]: property } },
        category: 'fs',
        permissionLevel: 'read',
        readOnly: true,
      } as ToolSchema;
    };
    const critical: Array<[tool: string, param: string]> = [
      ['Glob', 'pattern'],
      ['Grep', 'include'],
      ['pdf_compress', 'input_path'],
      ['PdfAutomate', 'input_path'],
      ['PdfAutomate', 'file_path'],
      ['PdfAutomate', 'input_files'],
      ['ExcelAutomate', 'file_path'],
      ['ExcelAutomate', 'output_path'],
      ['ppt_generate', 'template_path'],
      ['ppt_generate', 'data_source'],
      ['mail_send', 'attachments'],
      ['spawn_agent', 'ownedPaths'],
      ['SessionManager', 'workingDirectory'],
      ['findings_write', 'source'],
      ['declare_deliverables', 'scratch_dir'],
      ['git_commit', 'files'],
      ['MemoryRead', 'filename'],
      ['Bash', 'working_directory'],
    ];
    registerProtocolTool(probe(critical[0][0], critical[0][1]), async () => ({}) as never);
    try {
      for (const [tool, param] of critical) {
        registerProtocolTool(probe(tool, param), async () => ({}) as never);
        expect(resolvedFor('PathShapeProbe', { [param]: 'probe/x.txt' }), `${tool}.${param}`).toEqual(UNKNOWN_READWRITE);
      }
      // 反钉：Grep.type 是扩展名词表，不是路径——裸探针必须仍是 read:unscoped。
      registerProtocolTool(probe('Grep', 'type'), async () => ({}) as never);
      expect(resolvedFor('PathShapeProbe', { type: 'ts' })).toEqual([
        { kind: 'read', domain: { type: 'unscoped' } },
      ]);
    } finally {
      unregisterProtocolTool('PathShapeProbe');
    }
  });

  it('forces a tool with a brand-new undeclared path parameter back to serial (the tomorrow-accident gate)', () => {
    // 模拟「给已覆盖工具加了新路径参数但没声明 accesses」的未来事故：
    // 注册一个 Read 的演化体，多一个未声明的 archive_dir。resolver 必须落未知域串行；
    // 同一形状声明了 archive_dir 后恢复有界（证明串行确实来自覆盖判据而非形状误判）。
    const toolName = 'PathCoverageProbe';
    const base = getProtocolRegistry().getSchemas().find((schema) => schema.name === 'Read');
    expect(base).toBeDefined();
    const withUndeclared: ToolSchema = {
      ...base!,
      name: toolName,
      inputSchema: {
        ...base!.inputSchema,
        properties: {
          ...((base!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}),
          archive_dir: { type: 'string', description: 'Directory to also scan' },
        },
      },
    };
    registerProtocolTool(withUndeclared, async () => ({ schema: withUndeclared, createHandler: () => ({ schema: withUndeclared, execute: async () => 'probe' }) }) as never);
    try {
      expect(resolvedFor(toolName, { file_path: 'a.txt', archive_dir: 'arch' })).toEqual(UNKNOWN_READWRITE);
      const declared: ToolSchema = {
        ...withUndeclared,
        accesses: [...(withUndeclared.accesses ?? []), { kind: 'read', argumentNames: ['archive_dir'] }],
      };
      registerProtocolTool(declared, async () => ({ schema: declared, createHandler: () => ({ schema: declared, execute: async () => 'probe' }) }) as never);
      const bounded = resolvedFor(toolName, { file_path: 'a.txt', archive_dir: 'arch' });
      expect(bounded.every((access) => access.domain.type !== 'unknown')).toBe(true);
    } finally {
      unregisterProtocolTool(toolName);
    }
  });
});
