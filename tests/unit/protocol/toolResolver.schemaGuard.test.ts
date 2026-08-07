import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../src/host/tools/types';
import { notebookEditSchema } from '../../../src/host/tools/modules/file/notebookEdit.schema';
import { mcpInvokeSchema } from '../../../src/host/tools/modules/mcp/mcpInvoke.schema';
import { visualEditSchema } from '../../../src/host/tools/modules/vision/visualEdit.schema';
import { toolSearchSchema } from '../../../src/host/tools/modules/search/toolSearch.schema';
import { recommendCapabilitySchema } from '../../../src/host/tools/modules/planning/recommendCapability.schema';
import { webSearchSchema } from '../../../src/host/tools/modules/network/webSearch.schema';

// 钉住 §1.1 护栏：docEdit.ts 等路径直接 resolver.execute(...) 绕过 ToolExecutor，
// resolver 层必须自己重做 schema 校验，否则删掉工具内部手写校验后就是真漏洞。

const guardedSchema = {
  name: 'GuardedWrite',
  description: 'schema guard test tool',
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },
  requiresPermission: true,
  permissionLevel: 'write' as const,
};

const mocks = vi.hoisted(() => ({
  getSchemas: vi.fn(),
  has: vi.fn(),
  resolve: vi.fn(),
  handlerExecute: vi.fn(),
}));

vi.mock('../../../src/host/tools/protocolRegistry', () => ({
  getProtocolRegistry: () => ({
    getSchemas: mocks.getSchemas,
    has: mocks.has,
    resolve: mocks.resolve,
  }),
  isProtocolToolName: vi.fn(() => false),
  resetProtocolRegistry: vi.fn(),
}));

vi.mock('../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({
    getAllToolMeta: () => ({}),
  }),
}));

vi.mock('../../../src/host/mcp', () => ({
  getMCPClient: () => ({
    getToolDefinitions: () => [],
    parseMCPToolName: () => null,
    callTool: vi.fn(),
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { setProtocolToolRegistryPort } = await import('../../../src/host/tools/protocolToolRegistration');
const { getToolResolver, resetToolResolver } = await import('../../../src/host/tools/dispatch/toolResolver');

function makeCtx(): ToolContext {
  const controller = new AbortController();
  return {
    workingDirectory: '/tmp',
    requestPermission: async () => true,
    currentToolCallId: 'tool-call-1',
    abortSignal: controller.signal,
  };
}

describe('ToolResolver.execute schema guardrail', () => {
  beforeEach(() => {
    resetToolResolver();
    mocks.getSchemas.mockReturnValue([guardedSchema]);
    mocks.has.mockReturnValue(true);
    // protocolRegistry 被整体 mock（避免加载真实工具），其 setProtocolToolRegistryPort
    // 副作用随之消失，这里显式把 port 指到 mocks 上。
    setProtocolToolRegistryPort({
      register: vi.fn(),
      unregister: vi.fn(() => false),
      has: mocks.has,
      getSchemas: mocks.getSchemas,
      resolve: mocks.resolve,
    });
    mocks.handlerExecute.mockReset();
    mocks.handlerExecute.mockResolvedValue({ ok: true, output: 'done' });
    mocks.resolve.mockReset();
    mocks.resolve.mockResolvedValue({ execute: mocks.handlerExecute });
  });

  it('blocks a missing-required-param call that bypasses ToolExecutor', async () => {
    const resolver = getToolResolver();

    const result = await resolver.execute('GuardedWrite', {}, makeCtx());

    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('ARG_VALIDATION_FAILED');
    expect(result.error).toContain('path');
    // handler 绝不允许被触达
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.handlerExecute).not.toHaveBeenCalled();
  });

  it('blocks a wrong-type param', async () => {
    const resolver = getToolResolver();

    const result = await resolver.execute('GuardedWrite', { path: 42 }, makeCtx());

    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('ARG_VALIDATION_FAILED');
    expect(mocks.handlerExecute).not.toHaveBeenCalled();
  });

  it('lets schema-valid calls through to the handler', async () => {
    const resolver = getToolResolver();

    const result = await resolver.execute('GuardedWrite', { path: '/tmp/x' }, makeCtx());

    expect(result.success).toBe(true);
    expect(mocks.handlerExecute).toHaveBeenCalledTimes(1);
  });
});

// §4.2 变异验证的锚点：§1.3 删掉手写校验的 6 个真实工具的坏输入，必须被
// resolver 这层 schema 门拦住（不是"没报错"，是"换到 schema 层报"）。
// 把 §1.1 那道校验注释掉后，本组必须整体报红；全绿说明门是摆设。
describe('ToolResolver.execute schema guardrail — §1.3 真实工具的坏输入', () => {
  beforeEach(() => {
    resetToolResolver();
    mocks.getSchemas.mockReturnValue([
      notebookEditSchema,
      mcpInvokeSchema,
      visualEditSchema,
      toolSearchSchema,
      recommendCapabilitySchema,
      webSearchSchema,
    ]);
    mocks.has.mockReturnValue(true);
    setProtocolToolRegistryPort({
      register: vi.fn(),
      unregister: vi.fn(() => false),
      has: mocks.has,
      getSchemas: mocks.getSchemas,
      resolve: mocks.resolve,
    });
    mocks.handlerExecute.mockReset();
    mocks.handlerExecute.mockResolvedValue({ ok: true, output: 'done' });
    mocks.resolve.mockReset();
    mocks.resolve.mockResolvedValue({ execute: mocks.handlerExecute });
  });

  const badCalls: Array<[string, Record<string, unknown>]> = [
    // #1/#2 notebook_edit：缺必填
    ['notebook_edit', { new_source: 'x' }],
    // #3 mcp（mcpInvoke）：缺必填
    ['mcp', {}],
    // #4/#5 visual_edit：缺 file / line 非正整数
    ['visual_edit', { line: 1, userIntent: '改色' }],
    ['visual_edit', { file: '/tmp/a.ts', line: 0, userIntent: 'x' }],
    ['visual_edit', { file: '/tmp/a.ts', line: 1.5, userIntent: 'x' }],
    // #6 visual_edit：userIntent 纯空白
    ['visual_edit', { file: '/tmp/a.ts', line: 1, userIntent: '   ' }],
    // #7 ToolSearch：query 空串/纯空白
    ['ToolSearch', { query: '' }],
    ['ToolSearch', { query: '   ' }],
    // #8 recommend_capability：requiredCapability 空串
    ['recommend_capability', { requiredCapability: '' }],
    // #9 WebSearch：缺 query / query 空串
    ['WebSearch', {}],
    ['WebSearch', { query: '' }],
  ];

  it.each(badCalls)('%s %j 被 schema 门拦住，handler 不触达', async (name, args) => {
    const resolver = getToolResolver();

    const result = await resolver.execute(name, args, makeCtx());

    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('ARG_VALIDATION_FAILED');
    expect(mocks.handlerExecute).not.toHaveBeenCalled();
  });
});
