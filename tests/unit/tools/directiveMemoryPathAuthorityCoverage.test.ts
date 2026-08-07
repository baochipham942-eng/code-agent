// ============================================================================
// 记忆路径权威（ADR-054 / #1005）的**覆盖面**门
//
// #1005 建了边界本身：工具声明 pathAuthority，命中记忆目录就强制确认，且排在
// Skill 预授权 / 安全命令 / classifier 之前。但覆盖面是按名字枚举的两层：
//   1) 工具层：只有 write / bash / memoryWrite 三个显式声明；
//   2) 参数层：通用扫描原先门在 permissionLevel === 'write'，且只认参数名后缀
//      file/path/directory/destination/target。
// 实测（2026-08-07）129 个工具里，'network' 档的 screenshot_page / ppt_generate
// 带 output_path、'execute' 档的 git_worktree 带 path——三个都能把文件落进记忆目录
// 而完全不触发确认。落盘能力根本不跟 permissionLevel 走。
//
// 本门守两件事，都从**真实注册表**取数而不是手抄清单：
//   A. 任何非 read 工具，只要参数名是路径形态且值指向记忆目录，就必须要求确认
//      （表驱动：新增这类工具自动多一条用例）；
//   B. 把路径藏在命令字符串里的工具（bash / terminal_write），通用扫描按参数名
//      匹配抓不住，必须有显式 shell 声明。
//
// 门的自曝盲区：注册表扫到 0 个工具时报红（见第一条用例）。零候选静默通过是本仓
// 反复栽过的假绿形态。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

const MEMORY_DIR = path.join(os.tmpdir(), 'neo-path-authority-gate', 'memory');

vi.mock('../../../src/host/lightMemory/indexLoader', () => ({
  getMemoryDir: () => MEMORY_DIR,
}));

import type { ToolDefinition } from '../../../src/shared/contract';
import type { ToolSchema } from '../../../src/host/protocol/tools';
import { registerMigratedTools } from '../../../src/host/tools/modules';
import { sameToolName } from '../../../src/host/tools/toolNames';
import { assessDirectiveMemoryWrite } from '../../../src/host/memory/directiveMemoryPathAuthority';

// 与 directiveMemoryPathAuthority.isPathLikeParameter 同口径。这里刻意复写一份而不是
// 导出复用：两边同时改错才会一起绿，单边漂移会被下面的用例照出来。
const PATH_LIKE_SUFFIXES = new Set(['file', 'path', 'directory', 'destination', 'target']);
function isPathLikeParameter(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return PATH_LIKE_SUFFIXES.has(normalized.split('_').at(-1) ?? '');
}

function collectSchemas(): ToolSchema[] {
  const out: ToolSchema[] = [];
  registerMigratedTools({ register: (schema: ToolSchema) => { out.push(schema); } } as never);
  return out;
}

function paramNames(schema: ToolSchema): string[] {
  const props = (schema.inputSchema as { properties?: Record<string, unknown> })?.properties;
  return props ? Object.keys(props) : [];
}

function toDefinition(schema: ToolSchema): ToolDefinition {
  return {
    name: schema.name,
    description: schema.description,
    inputSchema: schema.inputSchema,
    requiresPermission: schema.permissionLevel !== 'read',
    permissionLevel: schema.permissionLevel === 'dangerous' ? 'execute' : schema.permissionLevel,
    pathAuthority: schema.pathAuthority,
  } as ToolDefinition;
}

const SCHEMAS = collectSchemas();

/** 非 read 档 + 至少一个路径形态参数 —— 通用扫描必须覆盖到的那批。 */
const PATH_PARAM_TOOLS = SCHEMAS
  .filter((s) => s.permissionLevel !== 'read')
  .map((s) => ({ schema: s, pathParams: paramNames(s).filter(isPathLikeParameter) }))
  .filter((row) => row.pathParams.length > 0);

/**
 * 把路径藏在命令字符串里的工具：参数名匹配抓不住，只能显式声明。
 * 用 sameToolName 而不是字面量比较——Bash 在本仓有 Bash/bash 等多种写法，
 * 写死字面量的话工具改名会让这条静默变成「找不到就跳过」。
 */
const COMMAND_STRING_TOOLS = ['Bash', 'terminal_write'];

describe('记忆路径权威的覆盖面', () => {
  it('注册表非空且确实扫到候选——扫 0 个就是门瞎了', () => {
    expect(SCHEMAS.length).toBeGreaterThan(0);
    expect(PATH_PARAM_TOOLS.length).toBeGreaterThan(0);
  });

  it.each(PATH_PARAM_TOOLS.map((row) => [row.schema.name, row] as const))(
    '%s 的路径参数指向记忆目录时要求确认',
    (_name, row) => {
      for (const param of row.pathParams) {
        const assessment = assessDirectiveMemoryWrite({
          definition: toDefinition(row.schema),
          params: { [param]: path.join(MEMORY_DIR, 'planted.md') },
          workingDirectory: os.tmpdir(),
        });
        expect(
          assessment.requiresConfirmation,
          `${row.schema.name}.${param} 指向记忆目录却没要求确认`,
        ).toBe(true);
      }
    },
  );

  it.each(COMMAND_STRING_TOOLS)('%s 必须显式声明 shell 类 pathAuthority', (toolName) => {
    const schema = SCHEMAS.find((s) => sameToolName(s.name, toolName));
    expect(schema, `${toolName} 不在注册表里——工具改名了就来更新这条，别删`).toBeDefined();
    const descriptors = schema?.pathAuthority ?? [];
    expect(
      descriptors.some((d) => d.kind === 'shell'),
      `${toolName} 能把路径藏在命令字符串里，通用参数扫描抓不住，必须显式声明`,
    ).toBe(true);
  });

  it('命令字符串里的重定向目标真的会被拦下', () => {
    const terminalWrite = SCHEMAS.find((s) => s.name === 'terminal_write');
    const assessment = assessDirectiveMemoryWrite({
      definition: toDefinition(terminalWrite!),
      params: { input: `echo pwned > ${path.join(MEMORY_DIR, 'foo.md')}` },
      workingDirectory: os.tmpdir(),
    });
    expect(assessment.requiresConfirmation).toBe(true);
    expect(assessment.targets.join()).toContain('foo.md');
  });

  it('read 档不进扫描面——它不写盘，扫了只是徒增误报', () => {
    const readTool = SCHEMAS.find((s) => s.permissionLevel === 'read'
      && paramNames(s).some(isPathLikeParameter));
    expect(readTool, 'read 档带路径参数的工具一个都没有？先核实是不是取数取错了').toBeDefined();
    const assessment = assessDirectiveMemoryWrite({
      definition: toDefinition(readTool!),
      params: { [paramNames(readTool!).find(isPathLikeParameter)!]: path.join(MEMORY_DIR, 'x.md') },
      workingDirectory: os.tmpdir(),
    });
    expect(assessment.requiresConfirmation).toBe(false);
  });
});
