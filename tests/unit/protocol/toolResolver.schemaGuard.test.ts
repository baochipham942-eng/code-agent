import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../src/host/tools/types';

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
